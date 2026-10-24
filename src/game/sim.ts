import {
  Rng, Vec3, clamp, qaxis, qid, qlook, qmul, qnorm, qrot, qturn,
  v3, vadd, vdot, vlen, vlen2, vmad, vnorm, vscale, vsub,
} from '../engine/math';
import type { RGB, ShipKind } from '../engine/mesh';
import { ShipStats, statsFor } from '../meta/upgrades';
import { botThink } from './ai';
import { ARENA_R, BOLT_LIFE, BOLT_SPEED, LOCK_RANGE } from './constants';
import {
  AIState, Bolt, HumanSlot, Missile, Mode, Rock, Ship, ShipInput, SimEvent, SimOptions, SimResult, Structure, neutralInput,
} from './types';

export { ARENA_R, BOLT_SPEED, BOLT_LIFE, LOCK_RANGE };
const LOCK_COS = 0.93;
export const MISSILE_LAUNCH = 430;
export const MISSILE_MAX = 560;
export const MISSILE_TURN = 2.7;
export const VOLLEY_COST = 7;
export const FIRE_CD = 0.16;
const KILL_LIMIT: Record<Mode, number> = { deathmatch: 12, team: 20, waves: 0 };

export const TEAM_COLORS: RGB[] = [[60, 150, 255], [255, 85, 70]];
const FFA_COLORS: RGB[] = [
  [255, 85, 70], [255, 190, 60], [190, 90, 255], [255, 110, 190],
  [120, 255, 90], [255, 150, 60], [90, 220, 255], [220, 220, 90],
];
const PLAYER_COLOR: RGB = [80, 235, 205];
const CALLSIGNS = ['Рысь', 'Вихрь', 'Кобра', 'Сокол', 'Шторм', 'Призрак', 'Гром', 'Иней', 'Тигр', 'Ворон', 'Омега', 'Зенит', 'Клинок', 'Аспид'];

function segHitSphere(a: Vec3, b: Vec3, c: Vec3, r: number): boolean {
  const d = vsub(b, a);
  const l2 = vlen2(d);
  const t = l2 > 0 ? clamp(vdot(vsub(c, a), d) / l2, 0, 1) : 0;
  return vlen2(vsub(vmad(a, d, t), c)) <= r * r;
}

export class Sim {
  readonly opts: SimOptions;
  readonly rng: Rng;
  readonly arenaRadius = ARENA_R;
  time = 0;
  ships: Ship[] = [];
  bolts: Bolt[] = [];
  missiles: Missile[] = [];
  rocks: Rock[] = [];
  structures: Structure[] = [];
  events: SimEvent[] = [];
  result: SimResult = { over: false, win: false, winnerTeam: -1, winnerId: -1 };
  wave = 0;
  teamKills = [0, 0];
  localId: number;
  readonly humans: HumanSlot[];
  private nextId = 0;
  private byId = new Map<number, Ship>();
  private waveTimer = 0;
  private waveSpawning = false;

  constructor(opts: SimOptions) {
    this.opts = opts;
    this.rng = new Rng(opts.seed);
    this.humans = opts.humans ?? [{ name: 'Вы', upgrades: opts.upgrades }];
    this.localId = opts.localId ?? 0;
    this.buildWorld();
    if (opts.replica) return;
    this.addPlayers();
    this.populate();
  }

  /** Мой корабль. У реплики до первого снимка его может не быть — тогда заглушка. */
  get player(): Ship { return this.byId.get(this.localId) ?? this.ships[0] ?? this.dummy(); }
  private dummyShip: Ship | null = null;
  private dummy(): Ship {
    if (!this.dummyShip) {
      const keep = this.ships.length;
      this.dummyShip = this.newShip('…', 0, false, 'fighter', PLAYER_COLOR, statsFor(this.humans[0].upgrades), null, false);
      this.ships.length = keep; this.byId.delete(this.dummyShip.id); this.nextId--;
    }
    return this.dummyShip;
  }
  get humanCount(): number { return this.humans.length; }
  get killLimit(): number { return KILL_LIMIT[this.opts.mode]; }
  shipById(id: number): Ship | undefined { return this.byId.get(id); }
  drainEvents(): SimEvent[] { const e = this.events; this.events = []; return e; }
  hostile(a: Ship, b: Ship): boolean { return a.team !== b.team; }

  // ---------- создание мира ----------

  private buildWorld(): void {
    const R = ARENA_R;
    if (this.opts.mode === 'team') {
      for (const team of [0, 1]) {
        this.structures.push({
          kind: 'base', team, r: 62,
          pos: v3((team === 0 ? -1 : 1) * R * 0.72, 0, 0),
          rot: qaxis(v3(0, 1, 0), team === 0 ? 0 : Math.PI),
        });
      }
    } else {
      for (let i = 0; i < 2; i++) {
        this.structures.push({
          kind: 'station', team: -1, r: 34,
          pos: vscale(this.rng.unit(), R * this.rng.range(0.25, 0.55)),
          rot: qnorm(qaxis(this.rng.unit(), this.rng.range(0, 6))),
        });
      }
    }
    let guard = 0;
    while (this.rocks.length < 34 && guard++ < 600) {
      const r = this.rng.range(20, 95);
      const pos = vscale(this.rng.unit(), R * this.rng.range(0.1, 0.9));
      const ok = this.rocks.every((o) => vlen(vsub(o.pos, pos)) > o.r + r + 40)
        && this.structures.every((s) => vlen(vsub(s.pos, pos)) > s.r + r + 140);
      if (!ok) continue;
      this.rocks.push({
        pos, r, seed: this.rng.int(1, 1e9), rot: qid(),
        axis: this.rng.unit(), spin: this.rng.range(-0.25, 0.25),
      });
    }
  }

  private botStats(kind: ShipKind, skill: number, wave: number): ShipStats {
    const heavy = kind === 'heavy';
    return {
      maxHp: (heavy ? 200 : 80) * (1 + 0.05 * wave),
      laserDamage: (heavy ? 7 : 4.5) + 2.5 * skill,
      energyRegen: 12,
      maxSpeed: (heavy ? 175 : 205) + 45 * skill,
      maxMissiles: heavy ? 4 : 2,
      agility: 0.7 + 0.45 * skill,
    };
  }

  newShip(name: string, team: number, isPlayer: boolean, kind: ShipKind, color: RGB, stats: ShipStats, ai: AIState | null, doSpawn = true): Ship {
    const s: Ship = {
      id: this.nextId++, name, team, isPlayer, lives: 3, kind, color, pos: v3(), rot: qid(), speed: 0, bump: v3(),
      av: { p: 0, y: 0, r: 0 }, throttle: 0.6, hp: stats.maxHp, energy: 100, missiles: stats.maxMissiles,
      alive: false, respawn: 0, invuln: 0, kills: 0, deaths: 0, radius: kind === 'heavy' ? 6.5 : 4.5,
      fireCd: 0, missileCd: 0, resupply: 0, lock: -1, hitFlash: 0, lastAttacker: -1, outOfBounds: false,
      stats, input: neutralInput(), ai,
    };
    this.ships.push(s);
    this.byId.set(s.id, s);
    if (doSpawn) this.spawn(s);
    return s;
  }

  /** Корабль-реплика с заданным id (клиент). */
  replicaShip(id: number, name: string, team: number, isPlayer: boolean, kind: ShipKind, color: RGB): Ship {
    this.nextId = id;
    const s = this.newShip(name, team, isPlayer, kind, color, this.botStats(kind, 0.5, 0), null, false);
    this.nextId = Math.max(this.nextId, id + 1);
    s.alive = false;
    return s;
  }

  removeShip(id: number): void {
    this.ships = this.ships.filter((s) => s.id !== id);
    this.byId.delete(id);
  }

  /** Игрок отключился: его корабль переходит под управление бота. */
  dropHuman(id: number): void {
    const s = this.byId.get(id);
    if (!s || !s.isPlayer) return;
    s.isPlayer = false;
    s.name = `${s.name} (бот)`;
    s.ai = this.newAI(0.5);
    if (this.opts.mode === 'waves') this.checkWavesLost();
  }

  private newAI(skill: number): AIState {
    return {
      skill, targetId: -1, retarget: 0, phase: this.rng.range(0, 6.28), offset: v3(), jink: 0, jinkDir: 1,
    };
  }

  private addPlayers(): void {
    const mode = this.opts.mode;
    const solo = this.humans.length === 1;
    this.humans.forEach((h, i) => {
      const team = mode === 'team' ? i % 2 : mode === 'waves' ? 0 : i;
      const color = solo ? PLAYER_COLOR : mode === 'team' ? TEAM_COLORS[team] : FFA_COLORS[i % FFA_COLORS.length];
      this.newShip(h.name, team, true, 'fighter', color, statsFor(h.upgrades), null);
    });
  }

  private populate(): void {
    const { mode, bots, difficulty } = this.opts;
    if (mode === 'deathmatch') {
      for (let i = 0; i < bots; i++) {
        const id = this.nextId;
        this.newShip(CALLSIGNS[i % CALLSIGNS.length], id, false, 'fighter', FFA_COLORS[(i + this.humans.length - 1) % FFA_COLORS.length],
          this.botStats('fighter', difficulty, 0), this.newAI(difficulty));
      }
    } else if (mode === 'team') {
      const per = [0, 0];
      for (const s of this.ships) per[s.team]++;
      const size = Math.max(2, bots, per[0], per[1]);
      let n = 0;
      for (const team of [0, 1]) {
        for (let k = per[team]; k < size; k++) {
          this.newShip(CALLSIGNS[n++ % CALLSIGNS.length], team, false, 'fighter', TEAM_COLORS[team],
            this.botStats('fighter', difficulty, 0), this.newAI(difficulty));
        }
      }
    } else {
      this.waveSpawning = true;
      this.waveTimer = 1.5;
    }
  }

  private spawnWave(): void {
    // убираем погибших ботов, чтобы список не рос
    this.ships = this.ships.filter((s) => s.isPlayer || s.alive);
    this.byId.clear();
    for (const s of this.ships) this.byId.set(s.id, s);
    this.wave++;
    this.waveSpawning = false;
    const n = Math.min(2 + this.wave, 9);
    const skill = clamp(this.opts.difficulty * 0.5 + 0.2 + this.wave * 0.05, 0.2, 0.95);
    for (let i = 0; i < n; i++) {
      const heavy = this.wave % 3 === 0 && i === 0;
      const kind: ShipKind = heavy ? 'heavy' : 'fighter';
      const color: RGB = heavy ? [190, 90, 255] : TEAM_COLORS[1];
      this.newShip(CALLSIGNS[(i + this.wave) % CALLSIGNS.length], 1, false, kind, color,
        this.botStats(kind, skill, this.wave), this.newAI(skill));
    }
    for (const p of this.ships) {
      if (p.isPlayer && p.alive) {
        p.hp = Math.min(p.stats.maxHp, p.hp + 30);
        p.missiles = p.stats.maxMissiles;
      }
    }
    this.events.push({ type: 'wave', wave: this.wave });
  }

  private spawn(s: Ship): void {
    const R = ARENA_R;
    let pos: Vec3;
    if (this.opts.mode === 'team') {
      const base = this.structures.find((b) => b.kind === 'base' && b.team === s.team);
      pos = base ? vadd(base.pos, vscale(this.rng.unit(), 120)) : v3();
    } else if (this.opts.mode === 'waves') {
      pos = s.isPlayer ? vscale(this.rng.unit(), R * 0.2) : vscale(this.rng.unit(), R * this.rng.range(0.55, 0.8));
    } else {
      let best = -1;
      pos = v3();
      for (let i = 0; i < 14; i++) {
        const cand = vscale(this.rng.unit(), R * this.rng.range(0.4, 0.78));
        let clear = 1e9;
        for (const o of this.ships) if (o !== s && o.alive) clear = Math.min(clear, vlen(vsub(o.pos, cand)));
        for (const r of this.rocks) clear = Math.min(clear, vlen(vsub(r.pos, cand)) - r.r + 60);
        if (clear > best) { best = clear; pos = cand; }
      }
    }
    const toCenter = vnorm(vsub(v3(), pos));
    const dir = vnorm(vadd(toCenter, vscale(this.rng.unit(), 0.25)));
    s.pos = pos;
    s.rot = qlook(dir);
    s.speed = s.stats.maxSpeed * 0.4;
    s.bump = v3();
    s.av = { p: 0, y: 0, r: 0 };
    s.hp = s.stats.maxHp;
    s.energy = 100;
    s.missiles = s.stats.maxMissiles;
    s.alive = true;
    s.respawn = 0;
    s.invuln = 2.2;
    s.lock = -1;
    s.lastAttacker = -1;
    s.fireCd = 0;
    s.missileCd = 0;
  }

  // ---------- шаг симуляции ----------

  /** Ввод удалённого игрока (хост). */
  setInput(id: number, inp: ShipInput): void {
    const s = this.byId.get(id);
    if (s) Object.assign(s.input, inp);
  }

  step(dt: number, localInput?: ShipInput): void {
    if (this.result.over) return;
    this.time += dt;
    const p = this.player;
    if (localInput) Object.assign(p.input, localInput);

    for (const r of this.rocks) r.rot = qnorm(qmul(qaxis(r.axis, r.spin * dt), r.rot));

    this.updateLocks();
    for (const s of this.ships) {
      if (!s.alive) { s.hitFlash = Math.max(0, s.hitFlash - dt); continue; }
      if (s.ai) botThink(this, s, dt);
      this.moveShip(s, dt);
      this.handleWeapons(s, dt);
      this.environment(s, dt);
    }
    this.shipCollisions();
    this.updateBolts(dt);
    this.updateMissiles(dt);
    this.handleRespawns(dt);
    this.modeLogic(dt);
  }

  updateLocks(): void {
    for (const s of this.ships) {
      if (!s.alive) { s.lock = -1; continue; }
      const fwd = qrot(s.rot, v3(0, 0, 1));
      let best = -1;
      let bestScore = -1e9;
      for (const t of this.ships) {
        if (!t.alive || !this.hostile(s, t)) continue;
        const to = vsub(t.pos, s.pos);
        const d = vlen(to);
        if (d > LOCK_RANGE || d < 1) continue;
        const c = vdot(fwd, to) / d;
        if (c < LOCK_COS) continue;
        const score = c - d / 5000;
        if (score > bestScore) { bestScore = score; best = t.id; }
      }
      if (s.id === this.localId && best !== s.lock && best >= 0) this.events.push({ type: 'lock', id: best });
      s.lock = best;
    }
  }

  moveShip(s: Ship, dt: number): void {
    const inp = s.input;
    const a = s.stats.agility;
    const k = 1 - Math.exp(-10 * dt);
    s.av.p += (clamp(inp.pitch, -1, 1) * 1.7 * a - s.av.p) * k;
    s.av.y += (clamp(inp.yaw, -1, 1) * 1.3 * a - s.av.y) * k;
    s.av.r += (clamp(inp.roll, -1, 1) * 2.6 * a - s.av.r) * k;
    s.rot = qturn(s.rot, s.av.p * dt, s.av.y * dt, s.av.r * dt);
    s.throttle = clamp(inp.throttle, 0, 1);
    const target = s.throttle * s.stats.maxSpeed;
    const acc = 150 * dt;
    s.speed += clamp(target - s.speed, -acc, acc);
    const fwd = qrot(s.rot, v3(0, 0, 1));
    s.pos = vadd(s.pos, vscale(vadd(vscale(fwd, s.speed), s.bump), dt));
    s.bump = vscale(s.bump, Math.exp(-2.5 * dt));
    s.energy = Math.min(100, s.energy + s.stats.energyRegen * dt);
    s.fireCd = Math.max(0, s.fireCd - dt);
    s.missileCd = Math.max(0, s.missileCd - dt);
    s.invuln = Math.max(0, s.invuln - dt);
    s.hitFlash = Math.max(0, s.hitFlash - dt);
  }

  private handleWeapons(s: Ship, _dt: number): void {
    const inp = s.input;
    const fwd = qrot(s.rot, v3(0, 0, 1));
    if (inp.fire && s.fireCd <= 0 && s.energy >= VOLLEY_COST) {
      s.fireCd = FIRE_CD;
      s.energy -= VOLLEY_COST;
      for (const side of [-1, 1]) {
        const muzzle = vadd(s.pos, qrot(s.rot, v3(side * 2.0, -0.15, 2.4)));
        const vel = vscale(fwd, BOLT_SPEED + s.speed);
        this.bolts.push({ owner: s.id, team: s.team, prev: muzzle, pos: muzzle, vel, life: BOLT_LIFE, dmg: s.stats.laserDamage });
      }
      this.events.push({ type: 'laser', pos: s.pos, owner: s.id });
    }
    if (inp.missile && s.missiles > 0 && s.missileCd <= 0 && s.lock >= 0) {
      s.missiles--;
      s.missileCd = 1.1;
      this.missiles.push({
        owner: s.id, team: s.team, pos: vadd(s.pos, vscale(fwd, 6)), dir: fwd,
        speed: MISSILE_LAUNCH + s.speed * 0.5, life: 6, age: 0, target: s.lock, dmg: 60,
      });
      this.events.push({ type: 'missile', pos: s.pos, owner: s.id });
    }
  }

  /** Предсказание на клиенте: движение и упругие столкновения без урона и событий. */
  predictMove(s: Ship, dt: number): void {
    this.moveShip(s, dt);
    this.environment(s, dt, false);
  }

  private environment(s: Ship, dt: number, harm = true): void {
    // границы арены
    const d = vlen(s.pos);
    s.outOfBounds = d > ARENA_R;
    if (s.outOfBounds) {
      const dir = vscale(s.pos, 1 / d);
      s.bump = vmad(s.bump, dir, -(d - ARENA_R) * 3 * dt * 6);
      if (harm && d > ARENA_R * 1.12) this.damage(s, 8 * dt, -1, false);
    }
    // астероиды
    for (const r of this.rocks) {
      const off = vsub(s.pos, r.pos);
      const dist = vlen(off);
      const min = r.r + s.radius;
      if (dist >= min || dist < 1e-6) continue;
      const n = vscale(off, 1 / dist);
      s.pos = vmad(r.pos, n, min);
      const fwd = qrot(s.rot, v3(0, 0, 1));
      const vn = vdot(vadd(vscale(fwd, s.speed), s.bump), n);
      if (vn < 0) {
        s.bump = vmad(s.bump, n, -vn * 1.3);
        s.speed *= 0.55;
        if (harm) {
          this.damage(s, Math.max(2, -vn * 0.1), -1, true);
          this.events.push({ type: 'spark', pos: vmad(s.pos, n, -s.radius) });
        }
      }
    }
    // станции и базы
    for (const st of this.structures) {
      const off = vsub(s.pos, st.pos);
      const dist = vlen(off);
      const min = st.r + s.radius;
      if (dist < min && dist > 1e-6) {
        const n = vscale(off, 1 / dist);
        s.pos = vmad(st.pos, n, min);
        const fwd = qrot(s.rot, v3(0, 0, 1));
        const vn = vdot(vadd(vscale(fwd, s.speed), s.bump), n);
        if (vn < 0) {
          s.bump = vmad(s.bump, n, -vn * 1.2);
          s.speed *= 0.6;
          if (harm) this.damage(s, Math.max(1, -vn * 0.04), -1, true);
        }
      }
      // зона ремонта: нейтральные станции и своя база
      if (harm && (st.kind === 'station' || st.team === s.team) && dist < st.r + 150) {
        s.hp = Math.min(s.stats.maxHp, s.hp + 16 * dt);
        s.resupply += dt;
        if (s.resupply >= 3 && s.missiles < s.stats.maxMissiles) { s.missiles++; s.resupply = 0; }
      }
    }
  }

  private shipCollisions(): void {
    const n = this.ships.length;
    for (let i = 0; i < n; i++) {
      const a = this.ships[i];
      if (!a.alive) continue;
      for (let j = i + 1; j < n; j++) {
        const b = this.ships[j];
        if (!b.alive) continue;
        const off = vsub(b.pos, a.pos);
        const dist = vlen(off);
        const min = a.radius + b.radius;
        if (dist >= min || dist < 1e-6) continue;
        const dir = vscale(off, 1 / dist);
        const push = (min - dist) / 2;
        a.pos = vmad(a.pos, dir, -push);
        b.pos = vmad(b.pos, dir, push);
        a.bump = vmad(a.bump, dir, -60);
        b.bump = vmad(b.bump, dir, 60);
        a.speed *= 0.7;
        b.speed *= 0.7;
        this.damage(a, 10, b.id, true);
        this.damage(b, 10, a.id, true);
      }
    }
  }

  private updateBolts(dt: number): void {
    const keep: Bolt[] = [];
    for (const b of this.bolts) {
      b.prev = b.pos;
      b.pos = vmad(b.pos, b.vel, dt);
      b.life -= dt;
      if (b.life <= 0 || vlen(b.pos) > ARENA_R * 1.3) continue;
      let dead = false;
      for (const t of this.ships) {
        if (!t.alive || t.team === b.team || t.invuln > 0) continue;
        if (segHitSphere(b.prev, b.pos, t.pos, t.radius + 1)) {
          this.events.push({ type: 'hit', pos: b.pos, victim: t.id, shooter: b.owner });
          this.damage(t, b.dmg, b.owner, true);
          dead = true;
          break;
        }
      }
      if (!dead) {
        for (const r of this.rocks) {
          if (segHitSphere(b.prev, b.pos, r.pos, r.r)) { this.events.push({ type: 'spark', pos: b.pos }); dead = true; break; }
        }
      }
      if (!dead) {
        for (const st of this.structures) {
          if (segHitSphere(b.prev, b.pos, st.pos, st.r)) { this.events.push({ type: 'spark', pos: b.pos }); dead = true; break; }
        }
      }
      if (!dead) keep.push(b);
    }
    this.bolts = keep;
  }

  private updateMissiles(dt: number): void {
    const keep: Missile[] = [];
    for (const m of this.missiles) {
      m.age += dt;
      m.life -= dt;
      const tgt = this.byId.get(m.target);
      if (tgt && tgt.alive) {
        const want = vnorm(vsub(tgt.pos, m.pos));
        const ang = Math.acos(clamp(vdot(m.dir, want), -1, 1));
        if (ang > 1e-4) {
          const t = Math.min(1, (MISSILE_TURN * dt) / ang);
          m.dir = vnorm(vadd(vscale(m.dir, 1 - t), vscale(want, t)));
        }
      }
      m.speed = Math.min(MISSILE_MAX, m.speed + 160 * dt);
      m.pos = vmad(m.pos, m.dir, m.speed * dt);
      let boom = m.life <= 0;
      if (!boom && m.age > 0.25) {
        for (const t of this.ships) {
          if (!t.alive || t.team === m.team || t.invuln > 0) continue;
          if (vlen(vsub(t.pos, m.pos)) < t.radius + 9) {
            this.damage(t, m.dmg, m.owner, true);
            this.events.push({ type: 'hit', pos: m.pos, victim: t.id, shooter: m.owner });
            boom = true;
            break;
          }
        }
      }
      if (!boom) {
        for (const r of this.rocks) if (vlen(vsub(r.pos, m.pos)) < r.r) { boom = true; break; }
      }
      if (!boom) {
        for (const st of this.structures) if (vlen(vsub(st.pos, m.pos)) < st.r) { boom = true; break; }
      }
      if (boom) this.events.push({ type: 'explode', pos: m.pos, size: 24, color: [255, 190, 90] });
      else keep.push(m);
    }
    this.missiles = keep;
  }

  private damage(t: Ship, amount: number, attacker: number, flash: boolean): void {
    if (!t.alive || t.invuln > 0) return;
    t.hp -= amount;
    if (attacker >= 0) t.lastAttacker = attacker;
    if (flash) t.hitFlash = 0.25;
    if (t.hp <= 0) this.kill(t);
  }

  private kill(t: Ship): void {
    t.alive = false;
    t.hp = 0;
    t.deaths++;
    t.lock = -1;
    const killer = t.lastAttacker >= 0 ? this.byId.get(t.lastAttacker) : undefined;
    if (killer && killer !== t && this.hostile(killer, t)) {
      killer.kills++;
      if (this.opts.mode === 'team') this.teamKills[killer.team]++;
    }
    this.events.push({ type: 'explode', pos: t.pos, size: t.kind === 'heavy' ? 90 : 60, color: t.color });
    this.events.push({ type: 'kill', killer: killer ? killer.id : -1, victim: t.id });
    if (this.opts.mode === 'waves') {
      if (t.isPlayer) {
        t.lives--;
        if (t.lives > 0) t.respawn = 3;
        else { t.respawn = -1; this.checkWavesLost(); }
      } else {
        t.respawn = -1;
      }
    } else {
      t.respawn = 3;
    }
  }

  private checkWavesLost(): void {
    if (this.result.over) return;
    if (!this.ships.some((s) => s.isPlayer && (s.lives > 0))) this.finish(false, -1, -1);
  }

  private handleRespawns(dt: number): void {
    for (const s of this.ships) {
      if (s.alive || s.respawn <= 0) continue;
      s.respawn -= dt;
      if (s.respawn <= 0) {
        this.spawn(s);
        this.events.push({ type: 'respawn', id: s.id });
      }
    }
  }

  private modeLogic(dt: number): void {
    const mode = this.opts.mode;
    if (this.result.over) return;
    if (mode === 'deathmatch') {
      for (const s of this.ships) {
        if (s.kills >= this.killLimit) { this.finish(s.isPlayer, s.team, s.id); return; }
      }
    } else if (mode === 'team') {
      for (const t of [0, 1]) {
        if (this.teamKills[t] >= this.killLimit) { this.finish(t === 0, t, -1); return; }
      }
    } else {
      const botsAlive = this.ships.some((s) => !s.isPlayer && s.alive);
      if (!botsAlive && !this.waveSpawning) { this.waveSpawning = true; this.waveTimer = 3.5; }
      if (this.waveSpawning) {
        this.waveTimer -= dt;
        if (this.waveTimer <= 0) this.spawnWave();
      }
    }
  }

  /** Победил ли корабль с этим id (для итогов у каждого игрока своих). */
  viewerWon(id: number): boolean {
    const r = this.result;
    if (!r.over) return false;
    const mode = this.opts.mode;
    if (mode === 'waves') return false;
    if (mode === 'team') return this.byId.get(id)?.team === r.winnerTeam;
    return r.winnerId === id;
  }

  finish(win: boolean, winnerTeam: number, winnerId = -1): void {
    if (this.result.over) return;
    this.result = { over: true, win, winnerTeam, winnerId };
    this.events.push({ type: 'over', win });
  }

  /** Таблица результатов, по убыванию убийств. */
  scoreboard(): Ship[] {
    return this.ships.slice().sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
  }
}
