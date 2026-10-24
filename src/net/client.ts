// Клиент: показывает бой, который считает хост. Свой корабль предсказывается локально
// и подтягивается к авторитетному состоянию; чужие интерполируются между снимками.
import { Quat, Vec3, clamp, qaxis, qmul, qnorm, qrot, v3, vadd, vdot, vlen, vlen2, vmad, vnorm, vscale, vsub } from '../engine/math';
import type { RGB } from '../engine/mesh';
import { ARENA_R, BOLT_LIFE, BOLT_SPEED } from '../game/constants';
import { FIRE_CD, MISSILE_LAUNCH, MISSILE_MAX, MISSILE_TURN, Sim, VOLLEY_COST } from '../game/sim';
import type { Ship, ShipInput, SimEvent } from '../game/types';
import type { Upgrades } from '../meta/upgrades';
import { statsFor } from '../meta/upgrades';
import {
  F_ALIVE, F_HIT, F_INVULN, F_OOB, KINDS, MODES, NET, ShipWire, Wire, cleanName, decodeEvent, decodeShip,
  encodeInput, packUpgrades, unpackUpgrades,
} from './protocol';
import type { NetSession, NetStatus } from './session';
import type { Transport } from './transport';

const STEP = 1 / 60;

interface Sample { t: number; pos: Vec3; rot: Quat; speed: number }

function nlerp(a: Quat, b: Quat, t: number): Quat {
  const d = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  const s = d < 0 ? -1 : 1;
  return qnorm({
    x: a.x + (s * b.x - a.x) * t, y: a.y + (s * b.y - a.y) * t,
    z: a.z + (s * b.z - a.z) * t, w: a.w + (s * b.w - a.w) * t,
  });
}

export class NetClient implements NetSession {
  readonly role = 'client' as const;
  status: NetStatus = 'waiting';
  endReason: string | null = null;
  sim: Sim | null = null;

  onChange: () => void = () => {};
  private hostName = '';
  private helloTimer = 0;
  private tick = 0;
  private history: { tick: number; input: ShipInput }[] = [];
  private bufs = new Map<number, Sample[]>();
  private rt = 0;
  private haveTime = false;
  private events: SimEvent[] = [];
  private lastSnapAt = 0;
  private clock = 0;
  private rosterAsk = 0;
  private lastLock = -1;
  private ownAlive = false;
  private recvBytes = 0;
  private recvRate = 0;
  private rateTimer = 0;
  private snapGap = 0;
  private lastSnapT = 0;

  constructor(private tr: Transport, private upgrades: Upgrades) {
    tr.onMessage = (from, d) => this.onMessage(from, d);
    tr.onMembers = () => this.onMembers();
    tr.onReady = () => this.sendHello();
    if (tr.name) this.sendHello();
  }

  private sendHello(): void {
    this.tr.send({ k: 'h', u: packUpgrades(this.upgrades) });
  }

  get members(): string[] { return this.tr.members; }

  private onMembers(): void {
    this.onChange();
    if (this.status === 'ended') return;
    if (this.hostName && !this.tr.members.includes(this.hostName)) {
      this.status = 'ended';
      this.endReason = 'host-left';
      this.onChange();
    }
  }

  // ---------- входящие ----------

  private onMessage(from: string, d: Wire): void {
    if (!d || typeof d !== 'object' || this.status === 'ended') return;
    this.recvBytes += JSON.stringify(d).length;
    switch (d.k) {
      case 'c': this.onConfig(from, d); break;
      case 'r': this.onRoster(d); break;
      case 's': this.onSnapshot(d); break;
      case 'e': this.onEvents(d); break;
      case 't': this.onStats(d); break;
    }
  }

  private onConfig(from: string, d: Wire): void {
    if (this.sim) return;
    const p = d.p as [string, number[]][] | undefined;
    const mode = MODES[Number(d.m)];
    if (!Array.isArray(p) || !mode) return;
    const humans = p.map((h) => ({ name: String(h[0]), upgrades: unpackUpgrades(h[1]) }));
    const mine = humans.findIndex((h) => h.name === cleanName(this.tr.name));
    this.hostName = from;
    if (mine < 0) { this.status = 'ended'; this.endReason = 'late'; this.onChange(); return; }
    this.sim = new Sim({
      mode, seed: Number(d.sd), upgrades: this.upgrades, bots: Number(d.b), difficulty: Number(d.d) / 100,
      humans, localId: mine, replica: true,
    });
    for (let i = 0; i < humans.length; i++) {
      const s = this.sim.replicaShip(i, humans[i].name, 0, true, 'fighter', [200, 200, 200]);
      s.stats = statsFor(humans[i].upgrades);
    }
    this.status = 'playing';
    this.onChange();
  }

  private onRoster(d: Wire): void {
    const sim = this.sim;
    const rows = d.s as unknown[][] | undefined;
    if (!sim || !Array.isArray(rows)) return;
    for (const r of rows) {
      if (!Array.isArray(r) || r.length < 11) continue;
      const id = Number(r[0]);
      const color: RGB = [Number(r[5]), Number(r[6]), Number(r[7])];
      let s = sim.shipById(id);
      if (!s) s = sim.replicaShip(id, '', 0, false, 'fighter', color);
      s.name = String(r[1]);
      s.team = Number(r[2]);
      s.isPlayer = Number(r[3]) === 1;
      s.kind = KINDS[Number(r[4])] ?? 'fighter';
      s.radius = s.kind === 'heavy' ? 6.5 : 4.5;
      s.color = color;
      if (id !== sim.localId) {
        s.stats = { ...s.stats, maxHp: Number(r[8]), maxSpeed: Number(r[9]), maxMissiles: Number(r[10]) };
      }
    }
    // убранные у хоста боты прошлой волны
    if (Array.isArray(d.l)) {
      const live = new Set((d.l as unknown[]).map(Number));
      for (const sh of sim.ships.slice()) {
        if (!live.has(sh.id) && sh.id !== sim.localId) { sim.removeShip(sh.id); this.bufs.delete(sh.id); }
      }
    }
  }

  private onSnapshot(d: Wire): void {
    const sim = this.sim;
    const rows = d.s as unknown[] | undefined;
    if (!sim || !Array.isArray(rows)) return;
    const T = Number(d.t) / 1000;
    if (T !== this.lastSnapT) {
      if (this.lastSnapT) this.snapGap = T - this.lastSnapT;
      this.lastSnapT = T;
    }
    this.lastSnapAt = this.clock;
    const target = T - NET.interpDelay;
    if (!this.haveTime || Math.abs(target - this.rt) > 0.5) { this.rt = target; this.haveTime = true; }
    else this.rt += (target - this.rt) * 0.1;

    for (const row of rows) {
      const w = decodeShip(row);
      if (!w) continue;
      const s = sim.shipById(w.id);
      if (!s) { this.askRoster(); continue; }
      if (w.id === sim.localId) { this.onOwn(s, w); continue; }
      const alive = (w.flags & F_ALIVE) !== 0;
      if (alive !== s.alive) {
        s.alive = alive;
        this.bufs.delete(w.id);
        if (alive) { s.pos = v3(w.x, w.y, w.z); s.rot = w.q; }
      }
      s.hp = w.hp;
      s.lock = w.lock;
      s.invuln = (w.flags & F_INVULN) ? 1 : 0;
      s.outOfBounds = (w.flags & F_OOB) !== 0;
      if (w.flags & F_HIT) s.hitFlash = 0.25;
      let buf = this.bufs.get(w.id);
      if (!buf) { buf = []; this.bufs.set(w.id, buf); }
      buf.push({ t: T, pos: v3(w.x, w.y, w.z), rot: w.q, speed: w.speed });
      if (buf.length > 10) buf.shift();
    }
  }

  private askRoster(): void {
    if (this.clock - this.rosterAsk < 1) return;
    this.rosterAsk = this.clock;
    this.tr.send({ k: 'q' });
  }

  /** Авторитетное состояние моего корабля: предсказываем вперёд по неподтверждённому вводу. */
  private onOwn(s: Ship, w: ShipWire): void {
    const sim = this.sim!;
    const alive = (w.flags & F_ALIVE) !== 0;
    const jump = alive !== this.ownAlive;
    this.ownAlive = alive;
    s.alive = alive;
    s.hp = w.hp;
    s.invuln = (w.flags & F_INVULN) ? 1 : 0;
    s.outOfBounds = (w.flags & F_OOB) !== 0;
    if (w.flags & F_HIT) s.hitFlash = 0.25;
    if (w.lock !== this.lastLock && w.lock >= 0) this.events.push({ type: 'lock', id: w.lock });
    this.lastLock = w.lock;
    s.lock = w.lock;
    if (!alive || jump) {
      s.pos = v3(w.x, w.y, w.z); s.rot = w.q; s.speed = w.speed;
      s.bump = v3(); s.av = { p: 0, y: 0, r: 0 };
      this.history = [];
      return;
    }
    const scratch: Ship = {
      ...s, pos: v3(w.x, w.y, w.z), rot: w.q, speed: w.speed, bump: { ...s.bump }, av: { ...s.av },
      input: { ...s.input },
    };
    for (const h of this.history) {
      if (h.tick <= w.ack) continue;
      scratch.input = h.input;
      sim.predictMove(scratch, STEP);
    }
    this.history = this.history.filter((h) => h.tick > w.ack);
    const err = vlen(vsub(scratch.pos, s.pos));
    if (err > 60) {
      s.pos = scratch.pos; s.rot = scratch.rot; s.speed = scratch.speed; s.bump = scratch.bump;
    } else {
      s.pos = vmad(s.pos, vsub(scratch.pos, s.pos), 0.3);
      s.rot = nlerp(s.rot, scratch.rot, 0.3);
      s.speed += (scratch.speed - s.speed) * 0.3;
    }
  }

  private onEvents(d: Wire): void {
    const sim = this.sim;
    const rows = d.e as unknown[] | undefined;
    if (!sim || !Array.isArray(rows)) return;
    for (const row of rows) {
      const e = decodeEvent(row);
      if (!e) continue;
      switch (e.type) {
        case 'laser': {
          // свои выстрелы уже показаны предсказанием
          if (e.owner === sim.localId) break;
          const s = sim.shipById(e.owner);
          if (s) { this.spawnBolts(s); e.pos = s.pos; this.events.push(e); }
          break;
        }
        case 'missile': {
          const s = sim.shipById(e.owner);
          if (s) { this.spawnMissile(s); e.pos = s.pos; this.events.push(e); }
          break;
        }
        case 'hit': {
          this.dropNearest(sim.bolts, e.pos, e.shooter, 90);
          this.events.push(e);
          break;
        }
        case 'explode':
          this.dropNearest(sim.missiles, e.pos, -1, 60);
          this.events.push(e);
          break;
        case 'wave': sim.wave = e.wave; this.events.push(e); break;
        default: this.events.push(e);
      }
    }
  }

  private dropNearest<T extends { pos: Vec3; owner: number }>(list: T[], pos: Vec3, owner: number, maxDist: number): void {
    let best = -1;
    let bd = maxDist * maxDist;
    list.forEach((b, i) => {
      if (owner >= 0 && b.owner !== owner) return;
      const d = vlen2(vsub(b.pos, pos));
      if (d < bd) { bd = d; best = i; }
    });
    if (best >= 0) list.splice(best, 1);
  }

  private onStats(d: Wire): void {
    const sim = this.sim;
    const rows = d.s as number[][] | undefined;
    if (!sim || !Array.isArray(rows)) return;
    for (const r of rows) {
      const s = sim.shipById(Number(r[0]));
      if (!s) continue;
      s.kills = r[1]; s.deaths = r[2]; s.lives = r[5];
      if (s.id === sim.localId) {
        s.energy = r[3]; s.missiles = r[4]; s.respawn = r[6] / 10;
      }
    }
    if (typeof d.w === 'number') sim.wave = d.w;
    if (Array.isArray(d.tk)) sim.teamKills = (d.tk as number[]).map(Number);
    const o = d.o as number[] | undefined;
    if (Array.isArray(o) && !sim.result.over) sim.finish(o[2] === 1, o[0], o[1]);
  }

  // ---------- снаряды (только картинка) ----------

  private spawnBolts(s: Ship): void {
    const sim = this.sim!;
    const fwd = qrot(s.rot, v3(0, 0, 1));
    for (const side of [-1, 1]) {
      const muzzle = vadd(s.pos, qrot(s.rot, v3(side * 2.0, -0.15, 2.4)));
      sim.bolts.push({
        owner: s.id, team: s.team, prev: muzzle, pos: muzzle, vel: vscale(fwd, BOLT_SPEED + s.speed),
        life: BOLT_LIFE, dmg: 0,
      });
    }
  }

  private spawnMissile(s: Ship): void {
    const sim = this.sim!;
    const fwd = qrot(s.rot, v3(0, 0, 1));
    sim.missiles.push({
      owner: s.id, team: s.team, pos: vadd(s.pos, vscale(fwd, 6)), dir: fwd,
      speed: MISSILE_LAUNCH + s.speed * 0.5, life: 6, age: 0, target: s.lock, dmg: 0,
    });
  }

  private advanceProjectiles(dt: number): void {
    const sim = this.sim!;
    const keepB = [];
    for (const b of sim.bolts) {
      b.prev = b.pos;
      b.pos = vmad(b.pos, b.vel, dt);
      b.life -= dt;
      if (b.life <= 0 || vlen(b.pos) > ARENA_R * 1.3) continue;
      if (sim.rocks.some((r) => vlen2(vsub(r.pos, b.pos)) < r.r * r.r)
        || sim.structures.some((st) => vlen2(vsub(st.pos, b.pos)) < st.r * st.r)) {
        sim.events.push({ type: 'spark', pos: b.pos });
        continue;
      }
      keepB.push(b);
    }
    sim.bolts = keepB;
    const keepM = [];
    for (const m of sim.missiles) {
      m.age += dt; m.life -= dt;
      const tgt = sim.shipById(m.target);
      if (tgt && tgt.alive) {
        const want = vnorm(vsub(tgt.pos, m.pos));
        const ang = Math.acos(clamp(vdot(m.dir, want), -1, 1));
        if (ang > 1e-4) {
          const k = Math.min(1, (MISSILE_TURN * dt) / ang);
          m.dir = vnorm(vadd(vscale(m.dir, 1 - k), vscale(want, k)));
        }
      }
      m.speed = Math.min(MISSILE_MAX, m.speed + 160 * dt);
      m.pos = vmad(m.pos, m.dir, m.speed * dt);
      if (m.life > 0) keepM.push(m);
    }
    sim.missiles = keepM;
  }

  // ---------- шаг ----------

  step(dt: number, input: ShipInput): void {
    this.clock += dt;
    if (this.status === 'waiting') {
      this.helloTimer += dt;
      if (this.helloTimer >= 1) { this.helloTimer = 0; if (this.tr.name) this.sendHello(); }
      return;
    }
    const sim = this.sim;
    if (!sim || this.status !== 'playing') return;
    sim.time += dt;
    this.tick++;
    this.rt += dt;
    this.history.push({ tick: this.tick, input: { ...input } });
    if (this.history.length > 180) this.history.shift();
    const every = Math.max(1, Math.round(1 / (NET.inputHz * STEP)));
    if (this.tick % every === 0) this.tr.send(encodeInput(this.tick, input));

    const me = sim.player;
    if (me.alive) {
      Object.assign(me.input, input);
      sim.predictMove(me, dt);
      this.predictFire(me);
    }
    me.hitFlash = Math.max(0, me.hitFlash - dt);
    for (const rock of sim.rocks) rock.rot = qnorm(qmul(qaxis(rock.axis, rock.spin * dt), rock.rot));
    for (const s of sim.ships) {
      if (s === me) continue;
      s.hitFlash = Math.max(0, s.hitFlash - dt);
      this.interpolate(s);
    }
    this.advanceProjectiles(dt);
    this.events.push(...sim.drainEvents());

    this.rateTimer += dt;
    if (this.rateTimer >= 1) { this.recvRate = Math.round(this.recvBytes / this.rateTimer); this.recvBytes = 0; this.rateTimer = 0; }
  }

  private predictFire(me: Ship): void {
    const inp = me.input;
    if (inp.fire && me.fireCd <= 0 && me.energy >= VOLLEY_COST) {
      me.fireCd = FIRE_CD;
      me.energy -= VOLLEY_COST;
      this.spawnBolts(me);
      this.events.push({ type: 'laser', pos: me.pos, owner: me.id });
    }
  }

  private interpolate(s: Ship): void {
    const buf = this.bufs.get(s.id);
    if (!buf || !buf.length || !s.alive) return;
    const rt = this.rt;
    let a = buf[0];
    let b = buf[buf.length - 1];
    for (let i = 0; i < buf.length - 1; i++) {
      if (buf[i].t <= rt && rt <= buf[i + 1].t) { a = buf[i]; b = buf[i + 1]; break; }
    }
    if (rt >= buf[buf.length - 1].t) { a = b; }
    else if (rt <= buf[0].t) { b = a; }
    const span = b.t - a.t;
    let k = span > 1e-6 ? clamp((rt - a.t) / span, 0, 1) : 1;
    if (vlen(vsub(b.pos, a.pos)) > 250) k = k >= 1 ? 1 : 0;
    s.pos = vmad(a.pos, vsub(b.pos, a.pos), k);
    s.rot = nlerp(a.rot, b.rot, k);
    s.speed = a.speed + (b.speed - a.speed) * k;
  }

  drainEvents(): SimEvent[] { const e = this.events; this.events = []; return e; }
  close(): void { this.status = 'ended'; this.tr.close(); }

  debug(): Record<string, number | string> {
    return {
      role: 'client', 'in B/s': this.recvRate, 'snap gap ms': Math.round(this.snapGap * 1000),
      'snap age ms': Math.round((this.clock - this.lastSnapAt) * 1000), 'max msg': this.tr.stats.maxMsg,
    };
  }
}
