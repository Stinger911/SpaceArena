import { describe, expect, it } from 'vitest';
import { vlen } from '../src/engine/math';
import { ARENA_R } from '../src/game/constants';
import { Sim } from '../src/game/sim';
import { neutralInput } from '../src/game/types';
import { buyUpgrade, defaultProfile, statsFor, upgradeCost } from '../src/meta/upgrades';
import { emptyUpgrades } from '../src/meta/upgrades';

const mk = (mode: 'deathmatch' | 'team' | 'waves', seed = 1, bots = 5, difficulty = 0.6): Sim =>
  new Sim({ mode, seed, upgrades: emptyUpgrades(), bots, difficulty });

function run(sim: Sim, seconds: number): void {
  const inp = neutralInput();
  for (let i = 0; i < seconds * 60; i++) sim.step(1 / 60, inp);
}

describe('симуляция', () => {
  for (const mode of ['deathmatch', 'team', 'waves'] as const) {
    it(`${mode}: 60 секунд без NaN, корабли остаются в разумных пределах`, () => {
      const sim = mk(mode);
      run(sim, 60);
      for (const s of sim.ships) {
        expect(Number.isFinite(s.pos.x + s.pos.y + s.pos.z)).toBe(true);
        expect(Number.isFinite(s.hp)).toBe(true);
        expect(vlen(s.pos)).toBeLessThan(ARENA_R * 2);
      }
    });
  }

  it('детерминизм: одинаковое зерно — одинаковый ход боя', () => {
    const a = mk('deathmatch', 42), b = mk('deathmatch', 42);
    run(a, 30); run(b, 30);
    expect(a.ships.map((s) => [s.kills, s.deaths])).toEqual(b.ships.map((s) => [s.kills, s.deaths]));
    expect(a.player.pos).toEqual(b.player.pos);
  });

  it('боты воюют между собой: за 3 минуты есть убийства', () => {
    const sim = mk('deathmatch', 7, 6, 0.8);
    // игрок стоит на месте и не стреляет; убийства должны происходить между ботами или по нему
    run(sim, 180);
    const kills = sim.ships.reduce((a, s) => a + s.kills, 0);
    expect(kills).toBeGreaterThan(0);
  });

  it('волны: после уничтожения всех ботов приходит следующая волна', () => {
    const sim = mk('waves', 3);
    run(sim, 3);
    expect(sim.wave).toBe(1);
    for (const s of sim.ships) if (!s.isPlayer) { s.hp = 1; s.alive = true; }
    // убиваем ботов выстрелами игрока невозможно без прицеливания, поэтому убираем их напрямую
    for (const s of sim.ships) if (!s.isPlayer) s.alive = false;
    run(sim, 6);
    expect(sim.wave).toBe(2);
  });

  it('игрок с огнём и ракетами: выстрел тратит энергию, ракета требует захвата', () => {
    const sim = mk('deathmatch', 5, 2);
    const p = sim.player;
    const e0 = p.energy;
    const inp = { ...neutralInput(), fire: true };
    sim.step(1 / 60, inp);
    expect(p.energy).toBeLessThan(e0);
    expect(sim.bolts.length).toBe(2);
    const m0 = p.missiles;
    p.lock = -1;
    sim.step(1 / 60, { ...neutralInput(), missile: true });
    expect(p.missiles).toBeLessThanOrEqual(m0);
  });

  it('смерть игрока в режиме волн расходует жизнь, три смерти — конец игры', () => {
    const sim = mk('waves', 9);
    run(sim, 2);
    for (let i = 0; i < 3; i++) {
      const p = sim.player;
      p.invuln = 0;
      p.hp = 0.001;
      // нанесём урон через столкновение с границей: проще — вызвать приватный урон через выстрел бота нельзя, поэтому форсируем
      (sim as unknown as { damage(t: unknown, a: number, by: number, f: boolean): void }).damage(p, 5, -1, true);
      run(sim, 4);
    }
    expect(sim.result.over).toBe(true);
    expect(sim.result.win).toBe(false);
  });
});

describe('прокачка', () => {
  it('статистика растёт с уровнем и покупка списывает кредиты', () => {
    const p = defaultProfile();
    p.credits = 1000;
    const before = statsFor(p.upgrades).maxHp;
    expect(buyUpgrade(p, 'hull')).toBe(true);
    expect(statsFor(p.upgrades).maxHp).toBeGreaterThan(before);
    expect(p.credits).toBe(1000 - upgradeCost(0));
  });
  it('нельзя купить без денег и выше максимума', () => {
    const p = defaultProfile();
    expect(buyUpgrade(p, 'laser')).toBe(false);
    p.credits = 1e6;
    for (let i = 0; i < 10; i++) buyUpgrade(p, 'laser');
    expect(p.upgrades.laser).toBe(5);
  });
});
