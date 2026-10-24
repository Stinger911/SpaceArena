// Прокачка корабля между боями и сохранение профиля.

export type UpgradeId = 'hull' | 'laser' | 'energy' | 'engine' | 'missiles' | 'agility';
export const UPGRADE_IDS: UpgradeId[] = ['hull', 'laser', 'energy', 'engine', 'missiles', 'agility'];
export const MAX_LEVEL = 5;

export type Upgrades = Record<UpgradeId, number>;

export interface Profile {
  credits: number;
  upgrades: Upgrades;
  bestWave: number;
  totalKills: number;
}

export interface ShipStats {
  maxHp: number;
  laserDamage: number;
  energyRegen: number;
  maxSpeed: number;
  maxMissiles: number;
  /** множитель скорости поворота */
  agility: number;
}

export const emptyUpgrades = (): Upgrades => ({ hull: 0, laser: 0, energy: 0, engine: 0, missiles: 0, agility: 0 });

export function statsFor(u: Upgrades): ShipStats {
  return {
    maxHp: 120 + 25 * u.hull,
    laserDamage: 6 + 2 * u.laser,
    energyRegen: 22 + 5 * u.energy,
    maxSpeed: 240 + 22 * u.engine,
    maxMissiles: 4 + u.missiles,
    agility: 1 + 0.09 * u.agility,
  };
}

export function upgradeCost(level: number): number {
  return Math.round((120 * Math.pow(level + 1, 1.45)) / 10) * 10;
}

const KEY = 'space-arena-profile-v1';

export function defaultProfile(): Profile {
  return { credits: 0, upgrades: emptyUpgrades(), bestWave: 0, totalKills: 0 };
}

export function loadProfile(): Profile {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaultProfile();
    const p = JSON.parse(raw) as Partial<Profile>;
    const d = defaultProfile();
    const up = emptyUpgrades();
    for (const id of UPGRADE_IDS) {
      const v = Number((p.upgrades as Partial<Upgrades> | undefined)?.[id] ?? 0);
      up[id] = Number.isFinite(v) ? Math.max(0, Math.min(MAX_LEVEL, Math.floor(v))) : 0;
    }
    return {
      credits: Math.max(0, Math.floor(Number(p.credits ?? d.credits)) || 0),
      upgrades: up,
      bestWave: Math.max(0, Math.floor(Number(p.bestWave ?? 0)) || 0),
      totalKills: Math.max(0, Math.floor(Number(p.totalKills ?? 0)) || 0),
    };
  } catch {
    return defaultProfile();
  }
}

export function saveProfile(p: Profile): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* хранилище недоступно — прогресс не сохранится, игра продолжится */
  }
}

/** Купить уровень улучшения. Возвращает true, если покупка прошла. */
export function buyUpgrade(p: Profile, id: UpgradeId): boolean {
  const lvl = p.upgrades[id];
  if (lvl >= MAX_LEVEL) return false;
  const cost = upgradeCost(lvl);
  if (p.credits < cost) return false;
  p.credits -= cost;
  p.upgrades[id] = lvl + 1;
  return true;
}
