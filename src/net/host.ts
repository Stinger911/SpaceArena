// Хост: браузер владельца комнаты. Считает весь бой, принимает ввод клиентов,
// рассылает снимки состояния через реле.
import { Sim } from '../game/sim';
import type { Mode, ShipInput, SimEvent } from '../game/types';
import { neutralInput } from '../game/types';
import type { Upgrades } from '../meta/upgrades';
import {
  MODES, NET, Wire, chunkItems, cleanName, decodeInput, encodeEvent, encodeRoster, encodeShip,
  packUpgrades, unpackUpgrades,
} from './protocol';
import type { NetSession, NetStatus } from './session';
import type { Transport } from './transport';

export interface HostConfig {
  mode: Mode;
  bots: number;
  difficulty: number;
  upgrades: Upgrades;
  seed: number;
  /** сколько секунд ждать приветствий от остальных */
  gatherTimeout?: number;
  /** false — ждать вызова launch() (экран настройки хоста) */
  autoStart?: boolean;
}

const STEP = 1 / 60;

export class NetHost implements NetSession {
  readonly role = 'host' as const;
  status: NetStatus = 'waiting';
  endReason: string | null = null;
  sim: Sim | null = null;

  /** вызывается при входе/выходе игроков и смене состояния */
  onChange: () => void = () => {};
  private armed: boolean;
  private hellos = new Map<string, Upgrades>();
  private ids = new Map<string, number>();
  private ack = new Map<number, number>();
  private lastInput = new Map<number, number>();
  private gather = 0;
  private tick = 0;
  private snapSeq = 0;
  private evBuf: number[][] = [];
  private local: SimEvent[] = [];
  private deadSent = new Set<number>();
  private rosterTimer = 0;
  private rosterSig = '';
  private overSent = false;
  private bytes0 = 0;
  private lastBps = 0;
  private bpsTimer = 0;

  constructor(private tr: Transport, private cfg: HostConfig) {
    this.armed = cfg.autoStart !== false;
    this.hellos.set(tr.name, cfg.upgrades);
    tr.onMessage = (from, d) => this.onMessage(from, d);
    tr.onMembers = () => this.onMembers();
    tr.onReady = () => {};
  }

  // ---------- вход ----------

  private onMessage(from: string, d: Wire): void {
    if (!d || typeof d !== 'object') return;
    switch (d.k) {
      case 'h': {
        const name = from;
        if (this.status === 'waiting') {
          this.hellos.set(name, unpackUpgrades(d.u));
        } else if (this.status === 'playing' && this.ids.has(name)) {
          this.sendConfig(); // клиент перезагрузил страницу или пропустил конфиг
        }
        break;
      }
      case 'i': {
        const id = this.ids.get(from);
        const inp = decodeInput(d);
        if (id === undefined || !inp || !this.sim) break;
        const prev = this.ack.get(id) ?? -1;
        if (inp.tick <= prev) break;
        this.ack.set(id, inp.tick);
        this.lastInput.set(id, this.sim.time);
        this.sim.setInput(id, inp.input);
        break;
      }
      case 'q': this.sendRoster(); break;
    }
  }

  /** Хост выбрал режим и жмёт «В бой». */
  launch(mode: Mode, bots: number, difficulty: number, seed: number): void {
    this.cfg = { ...this.cfg, mode, bots, difficulty, seed };
    this.armed = true;
    this.gather = 0;
  }

  get members(): string[] { return this.tr.members; }

  private onMembers(): void {
    this.onChange();
    if (!this.sim) return;
    const present = new Set(this.tr.members);
    for (const [name, id] of this.ids) {
      if (!present.has(name) && name !== this.tr.name) {
        this.sim.dropHuman(id);
        this.ids.delete(name);
      }
    }
  }

  // ---------- старт ----------

  private tryStart(dt: number): void {
    if (!this.armed) return;
    this.gather += dt;
    const others = this.tr.members.filter((n) => n !== this.tr.name);
    const all = others.every((n) => this.hellos.has(n));
    if (!(all || this.gather >= (this.cfg.gatherTimeout ?? 4))) return;
    const names = [this.tr.name, ...others.filter((n) => this.hellos.has(n))];
    const humans = names.map((n) => ({ name: cleanName(n), upgrades: this.hellos.get(n)! }));
    names.forEach((n, i) => this.ids.set(n, i));
    this.sim = new Sim({
      mode: this.cfg.mode, seed: this.cfg.seed, upgrades: this.cfg.upgrades,
      bots: this.cfg.bots, difficulty: this.cfg.difficulty, humans, localId: 0,
    });
    this.status = 'playing';
    this.onChange();
    this.sendConfig();
    this.sendRoster();
  }

  private sendConfig(): void {
    const sim = this.sim;
    if (!sim) return;
    this.tr.send({
      k: 'c', m: MODES.indexOf(this.cfg.mode), sd: this.cfg.seed, b: this.cfg.bots,
      d: Math.round(this.cfg.difficulty * 100),
      p: sim.humans.map((h) => [h.name, packUpgrades(h.upgrades)]),
    });
  }

  private sendRoster(): void {
    const sim = this.sim;
    if (!sim) return;
    for (const m of chunkItems({ k: 'r', l: sim.ships.map((s) => s.id) }, 's', sim.ships.map(encodeRoster), 5)) this.tr.send(m);
  }

  // ---------- шаг ----------

  step(dt: number, input: ShipInput): void {
    if (this.status === 'waiting') { this.tryStart(dt); return; }
    const sim = this.sim;
    if (!sim || this.status !== 'playing') return;
    // у отключившегося или замолчавшего клиента гасим стрельбу
    for (const id of this.ack.keys()) {
      const last = this.lastInput.get(id) ?? 0;
      if (sim.time - last > 1) sim.setInput(id, neutralInput());
    }
    sim.step(dt, input);
    this.tick++;
    const ev = sim.drainEvents();
    for (const e of ev) {
      this.local.push(e);
      const w = encodeEvent(e);
      if (w) this.evBuf.push(w);
    }

    const every = Math.max(1, Math.round(1 / (NET.snapHz * STEP)));
    if (this.tick % every === 0) this.sendSnapshot();
    const statEvery = Math.max(1, Math.round(1 / (NET.statHz * STEP)));
    if (this.tick % statEvery === 0) this.sendStats();

    this.rosterTimer += dt;
    const sig = sim.ships.map((s) => s.id).join(',');
    if (sig !== this.rosterSig || this.rosterTimer >= NET.rosterEvery) {
      this.rosterSig = sig;
      this.rosterTimer = 0;
      this.sendRoster();
    }

    if (sim.result.over && !this.overSent) {
      this.overSent = true;
      this.sendStats();
    }
    this.bpsTimer += dt;
    if (this.bpsTimer >= 1) {
      this.lastBps = Math.round((this.tr.stats.bytesOut - this.bytes0) / this.bpsTimer);
      this.bytes0 = this.tr.stats.bytesOut;
      this.bpsTimer = 0;
    }
  }

  private sendSnapshot(): void {
    const sim = this.sim!;
    const items: number[][] = [];
    for (const s of sim.ships) {
      if (!s.alive && !s.isPlayer) {
        if (this.deadSent.has(s.id)) continue;
        this.deadSent.add(s.id);
      } else this.deadSent.delete(s.id);
      items.push(encodeShip(s, this.ack.get(s.id) ?? 0));
    }
    const hdr = { k: 's', n: this.snapSeq++, t: Math.round(sim.time * 1000) };
    for (const m of chunkItems(hdr, 's', items)) this.tr.send(m);
    if (this.evBuf.length) {
      for (const m of chunkItems({ k: 'e' }, 'e', this.evBuf, 40)) this.tr.send(m);
      this.evBuf = [];
    }
  }

  private sendStats(): void {
    const sim = this.sim!;
    const rows = sim.ships.map((s) => [
      s.id, s.kills, s.deaths, Math.round(s.energy), s.missiles, s.lives, Math.round(Math.max(0, s.respawn) * 10),
    ]);
    const r = sim.result;
    const hdr: Wire = { k: 't', t: Math.round(sim.time * 1000), w: sim.wave, tk: sim.teamKills };
    if (r.over) hdr.o = [r.winnerTeam, r.winnerId, r.win ? 1 : 0];
    for (const m of chunkItems(hdr, 's', rows, 8)) this.tr.send(m);
  }

  drainEvents(): SimEvent[] { const e = this.local; this.local = []; return e; }
  close(): void { this.status = 'ended'; this.tr.close(); }

  debug(): Record<string, number | string> {
    return {
      role: 'host', players: this.sim?.humans.length ?? 0, 'out B/s': this.lastBps,
      'max msg': this.tr.stats.maxMsg,
    };
  }
}

