import type { Quat, Vec3 } from '../engine/math';
import type { RGB, ShipKind } from '../engine/mesh';
import type { ShipStats, Upgrades } from '../meta/upgrades';

export type Mode = 'deathmatch' | 'team' | 'waves';

/** Единый набор команд управления. Его выдают и игрок, и боты (задел под сеть). */
export interface ShipInput {
  /** -1..1, >0 — нос вверх */
  pitch: number;
  /** -1..1, >0 — нос вправо */
  yaw: number;
  /** -1..1, >0 — крен вправо */
  roll: number;
  /** 0..1 целевая тяга */
  throttle: number;
  fire: boolean;
  missile: boolean;
}

export const neutralInput = (): ShipInput => ({ pitch: 0, yaw: 0, roll: 0, throttle: 0.6, fire: false, missile: false });

export interface AIState {
  skill: number;
  targetId: number;
  retarget: number;
  phase: number;
  offset: Vec3;
  jink: number;
  jinkDir: number;
}

export interface Ship {
  id: number;
  name: string;
  team: number;
  isPlayer: boolean;
  kind: ShipKind;
  color: RGB;
  pos: Vec3;
  rot: Quat;
  /** скорость вдоль курса */
  speed: number;
  /** дополнительная скорость от столкновений */
  bump: Vec3;
  /** текущая угловая скорость (сглаженный ввод) */
  av: { p: number; y: number; r: number };
  throttle: number;
  hp: number;
  energy: number;
  missiles: number;
  alive: boolean;
  respawn: number;
  invuln: number;
  kills: number;
  deaths: number;
  radius: number;
  fireCd: number;
  missileCd: number;
  resupply: number;
  /** id цели захвата или -1 */
  lock: number;
  hitFlash: number;
  /** кто последним нанёс урон (для зачёта убийств), -1 если никто */
  lastAttacker: number;
  outOfBounds: boolean;
  stats: ShipStats;
  input: ShipInput;
  ai: AIState | null;
}

export interface Bolt {
  owner: number;
  team: number;
  prev: Vec3;
  pos: Vec3;
  vel: Vec3;
  life: number;
  dmg: number;
}

export interface Missile {
  owner: number;
  team: number;
  pos: Vec3;
  dir: Vec3;
  speed: number;
  life: number;
  age: number;
  target: number;
  dmg: number;
}

export interface Rock {
  pos: Vec3;
  r: number;
  seed: number;
  rot: Quat;
  axis: Vec3;
  spin: number;
}

export interface Structure {
  kind: 'station' | 'base';
  pos: Vec3;
  r: number;
  team: number;
  rot: Quat;
}

export type SimEvent =
  | { type: 'laser'; pos: Vec3; own: boolean }
  | { type: 'missile'; pos: Vec3; own: boolean }
  | { type: 'hit'; pos: Vec3; onPlayer: boolean; byPlayer: boolean }
  | { type: 'spark'; pos: Vec3 }
  | { type: 'explode'; pos: Vec3; size: number; color: RGB }
  | { type: 'kill'; killer: number; victim: number }
  | { type: 'respawn'; id: number }
  | { type: 'wave'; wave: number }
  | { type: 'lock'; id: number }
  | { type: 'over'; win: boolean };

export interface SimOptions {
  mode: Mode;
  seed: number;
  upgrades: Upgrades;
  /** Число соперников (deathmatch/team: размер команды) */
  bots: number;
  /** 0..1 */
  difficulty: number;
}

export interface SimResult {
  over: boolean;
  win: boolean;
  /** победившая команда или -1 */
  winnerTeam: number;
}
