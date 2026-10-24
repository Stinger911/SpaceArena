// Сетевой протокол Space Arena поверх реле Cardputer.
// Реле пересылает JSON ≤ 1 КБ всем остальным в комнате и ничего не симулирует,
// поэтому бой считает браузер хоста (владельца комнаты), остальные шлют ему ввод
// и получают снимки состояния. Все сообщения — короткие массивы целых.

import type { Quat } from '../engine/math';
import type { Mode, Ship, ShipInput } from '../game/types';
import { UPGRADE_IDS, Upgrades } from '../meta/upgrades';

export const NET = {
  /** снимков состояния в секунду (хост → все) */
  snapHz: 15,
  /** пакетов ввода в секунду (клиент → хост) */
  inputHz: 15,
  /** статистика (убийства, энергия…) в секунду */
  statHz: 4,
  /** раз в сколько секунд повторять список кораблей */
  rosterEvery: 3,
  /** жёсткий предел реле — 1024 байта; оставляем запас */
  maxBytes: 900,
  /** кораблей в одном куске снимка */
  shipsPerChunk: 6,
  /** задержка показа чужих кораблей, секунды (≈ 2 интервала снимков) */
  interpDelay: 0.14,
};

export const MODES: Mode[] = ['deathmatch', 'team', 'waves'];
export const KINDS = ['fighter', 'heavy'] as const;

export type Wire = Record<string, unknown>;

export function utf8len(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

export const wireSize = (m: unknown): number => utf8len(JSON.stringify(m));

/** Режет список на сообщения {…header, [key]: части}, каждое ≤ maxBytes. */
export function chunkItems(header: Wire, key: string, items: unknown[], maxItems = NET.shipsPerChunk, maxBytes = NET.maxBytes): Wire[] {
  const out: Wire[] = [];
  let cur: unknown[] = [];
  const flush = (): void => { if (cur.length) { out.push({ ...header, [key]: cur }); cur = []; } };
  for (const it of items) {
    cur.push(it);
    if (cur.length > maxItems || wireSize({ ...header, [key]: cur }) > maxBytes) {
      cur.pop();
      flush();
      cur.push(it);
    }
  }
  flush();
  return out;
}

// ---------- ввод ----------

export function encodeInput(tick: number, i: ShipInput): Wire {
  const q = (v: number): number => Math.round(Math.max(-1, Math.min(1, v)) * 100);
  const flags = (i.fire ? 1 : 0) | (i.missile ? 2 : 0);
  return { k: 'i', n: tick, a: [q(i.pitch), q(i.yaw), q(i.roll), Math.round(Math.max(0, Math.min(1, i.throttle)) * 100), flags] };
}

export function decodeInput(m: Wire): { tick: number; input: ShipInput } | null {
  const a = m.a as number[] | undefined;
  if (!Array.isArray(a) || a.length < 5 || typeof m.n !== 'number') return null;
  const nums = a.map(Number);
  if (nums.some((v) => !Number.isFinite(v))) return null;
  return {
    tick: m.n,
    input: {
      pitch: nums[0] / 100, yaw: nums[1] / 100, roll: nums[2] / 100, throttle: nums[3] / 100,
      fire: (nums[4] & 1) !== 0, missile: (nums[4] & 2) !== 0,
    },
  };
}

// ---------- улучшения ----------

export const packUpgrades = (u: Upgrades): number[] => UPGRADE_IDS.map((id) => u[id] | 0);
export function unpackUpgrades(a: unknown): Upgrades {
  const out = {} as Upgrades;
  UPGRADE_IDS.forEach((id, i) => {
    const v = Array.isArray(a) ? Number(a[i]) : 0;
    out[id] = Number.isFinite(v) ? Math.max(0, Math.min(5, Math.floor(v))) : 0;
  });
  return out;
}

// ---------- снимок корабля ----------

export const F_ALIVE = 1;
export const F_INVULN = 2;
export const F_OOB = 4;
export const F_HIT = 8;

export interface ShipWire {
  id: number;
  x: number; y: number; z: number;
  q: Quat;
  speed: number;
  hp: number;
  flags: number;
  lock: number;
  ack: number;
}

const QS = 10000;

export function encodeShip(s: Ship, ack: number): number[] {
  let f = 0;
  if (s.alive) f |= F_ALIVE;
  if (s.invuln > 0) f |= F_INVULN;
  if (s.outOfBounds) f |= F_OOB;
  if (s.hitFlash > 0.2) f |= F_HIT;
  const r = Math.round;
  return [
    s.id, r(s.pos.x), r(s.pos.y), r(s.pos.z),
    r(s.rot.x * QS), r(s.rot.y * QS), r(s.rot.z * QS), r(s.rot.w * QS),
    r(s.speed), r(s.hp), f, s.lock, ack,
  ];
}

export function decodeShip(a: unknown): ShipWire | null {
  if (!Array.isArray(a) || a.length < 13) return null;
  const n = a.map(Number);
  if (n.some((v) => !Number.isFinite(v))) return null;
  const q = { x: n[4] / QS, y: n[5] / QS, z: n[6] / QS, w: n[7] / QS };
  const l = Math.hypot(q.x, q.y, q.z, q.w) || 1;
  return {
    id: n[0], x: n[1], y: n[2], z: n[3],
    q: { x: q.x / l, y: q.y / l, z: q.z / l, w: q.w / l },
    speed: n[8], hp: n[9], flags: n[10], lock: n[11], ack: n[12],
  };
}

// ---------- события ----------

import type { SimEvent } from '../game/types';

/** События, которые хост пересылает клиентам. spark и lock клиент строит сам. */
export function encodeEvent(e: SimEvent): number[] | null {
  const r = Math.round;
  switch (e.type) {
    case 'laser': return [0, e.owner];
    case 'missile': return [1, e.owner];
    case 'hit': return [2, r(e.pos.x), r(e.pos.y), r(e.pos.z), e.victim, e.shooter];
    case 'explode': return [3, r(e.pos.x), r(e.pos.y), r(e.pos.z), r(e.size), e.color[0], e.color[1], e.color[2]];
    case 'kill': return [4, e.killer, e.victim];
    case 'respawn': return [5, e.id];
    case 'wave': return [6, e.wave];
    case 'over': return null; // передаётся отдельным полем в статистике
    default: return null;
  }
}

export function decodeEvent(a: unknown): SimEvent | null {
  if (!Array.isArray(a)) return null;
  const n = a.map(Number);
  if (n.some((v) => !Number.isFinite(v))) return null;
  switch (n[0]) {
    case 0: return { type: 'laser', pos: { x: 0, y: 0, z: 0 }, owner: n[1] };
    case 1: return { type: 'missile', pos: { x: 0, y: 0, z: 0 }, owner: n[1] };
    case 2: return { type: 'hit', pos: { x: n[1], y: n[2], z: n[3] }, victim: n[4], shooter: n[5] };
    case 3: return { type: 'explode', pos: { x: n[1], y: n[2], z: n[3] }, size: n[4], color: [n[5], n[6], n[7]] };
    case 4: return { type: 'kill', killer: n[1], victim: n[2] };
    case 5: return { type: 'respawn', id: n[1] };
    case 6: return { type: 'wave', wave: n[1] };
    default: return null;
  }
}

// ---------- состав кораблей ----------

export const cleanName = (s: string): string => String(s).replace(/[\u0000-\u001f]/g, '').slice(0, 16);

export function encodeRoster(s: Ship): unknown[] {
  return [s.id, cleanName(s.name), s.team, s.isPlayer ? 1 : 0, s.kind === 'heavy' ? 1 : 0,
    s.color[0], s.color[1], s.color[2], Math.round(s.stats.maxHp), Math.round(s.stats.maxSpeed), s.stats.maxMissiles];
}
