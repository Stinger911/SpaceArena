import { describe, expect, it } from 'vitest';
import { vlen, vsub } from '../src/engine/math';
import { neutralInput } from '../src/game/types';
import type { ShipInput } from '../src/game/types';
import { emptyUpgrades } from '../src/meta/upgrades';
import { NetClient } from '../src/net/client';
import { NetHost } from '../src/net/host';
import { NET, chunkItems, decodeInput, decodeShip, encodeInput, encodeShip, wireSize } from '../src/net/protocol';
import { LoopbackHub } from '../src/net/transport';
import { Sim } from '../src/game/sim';

const STEP = 1 / 60;

function setup(n: number, mode: 'deathmatch' | 'team' | 'waves' = 'deathmatch', latency = 0.03) {
  const hub = new LoopbackHub();
  hub.latency = latency;
  const names = ['Alice', 'Bob', 'Carol', 'Dave'].slice(0, n);
  const eps = names.map((nm) => hub.add(nm));
  const host = new NetHost(eps[0], { mode, bots: 3, difficulty: 0.5, upgrades: emptyUpgrades(), seed: 77, gatherTimeout: 2 });
  const clients = eps.slice(1).map((e) => new NetClient(e, emptyUpgrades()));
  return { hub, host, clients };
}

function run(env: ReturnType<typeof setup>, seconds: number, inputs: (who: number, t: number) => ShipInput = () => neutralInput()): void {
  let t = 0;
  for (let i = 0; i < seconds * 60; i++) {
    t += STEP;
    env.hub.advance(STEP);
    env.host.step(STEP, inputs(0, t));
    env.clients.forEach((c, k) => c.step(STEP, inputs(k + 1, t)));
  }
}

const cruise = (who: number, t: number): ShipInput => ({
  pitch: Math.sin(t * 0.7 + who) * 0.5, yaw: Math.cos(t * 0.5 + who) * 0.4, roll: 0, throttle: 0.8, fire: Math.sin(t * 2 + who) > 0.3, missile: false,
});

describe('протокол', () => {
  it('ввод и корабль кодируются без потерь в пределах точности', () => {
    const inp: ShipInput = { pitch: 0.5, yaw: -0.25, roll: 1, throttle: 0.6, fire: true, missile: false };
    const d = decodeInput(JSON.parse(JSON.stringify(encodeInput(9, inp))))!;
    expect(d.tick).toBe(9);
    expect(d.input.pitch).toBeCloseTo(0.5, 2);
    expect(d.input.fire).toBe(true);
    expect(d.input.missile).toBe(false);
    const sim = new Sim({ mode: 'deathmatch', seed: 1, upgrades: emptyUpgrades(), bots: 2, difficulty: 0.5 });
    const w = decodeShip(JSON.parse(JSON.stringify(encodeShip(sim.ships[0], 5))))!;
    expect(w.ack).toBe(5);
    expect(Math.abs(w.x - sim.ships[0].pos.x)).toBeLessThan(0.51);
  });

  it('нарезка не превышает лимит', () => {
    const items = Array.from({ length: 40 }, (_, i) => [i, 'Очень длинное имя ' + i, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    const msgs = chunkItems({ k: 's', n: 1, t: 123456 }, 's', items, 6);
    expect(msgs.length).toBeGreaterThan(1);
    for (const m of msgs) expect(wireSize({ t: 'msg', d: m })).toBeLessThanOrEqual(1024);
  });
});

describe('мультиплеер через реле', () => {
  it('3 игрока: бой стартует, все видят одинаковый мир и друг друга', () => {
    const env = setup(3);
    run(env, 6, cruise);
    expect(env.host.status).toBe('playing');
    for (const c of env.clients) {
      expect(c.status).toBe('playing');
      expect(c.sim!.ships.length).toBe(env.host.sim!.ships.length);
      expect(c.sim!.rocks.length).toBe(env.host.sim!.rocks.length);
      expect(c.sim!.rocks[3].pos).toEqual(env.host.sim!.rocks[3].pos);
    }
    expect(env.host.sim!.humans.map((h) => h.name)).toEqual(['Alice', 'Bob', 'Carol']);
  });

  it('клиентские корабли совпадают с хостом (ошибка мала)', () => {
    const env = setup(3);
    run(env, 12, cruise);
    const hs = env.host.sim!;
    let worstOwn = 0, worstRemote = 0;
    env.clients.forEach((c) => {
      const cs = c.sim!;
      for (const s of cs.ships) {
        const h = hs.shipById(s.id);
        if (!h || !h.alive || !s.alive) continue;
        const e = vlen(vsub(h.pos, s.pos));
        if (s.id === cs.localId) worstOwn = Math.max(worstOwn, e); else worstRemote = Math.max(worstRemote, e);
      }
    });
    expect(worstOwn).toBeLessThan(40);
    expect(worstRemote).toBeLessThan(120);
  });

  it('ни одно сообщение не превышает 1 КБ, трафик хоста умеренный', () => {
    const env = setup(4, 'waves');
    run(env, 20, cruise);
    const sec = 20;
    const host = env.hub.endpoints[0].stats;
    expect(host.maxMsg).toBeLessThanOrEqual(1024);
    expect(host.bytesOut / sec).toBeLessThan(14000);
    for (const e of env.hub.endpoints.slice(1)) expect(e.stats.bytesOut / sec).toBeLessThan(2000);
  });

  it('статистика, команды и конец боя доходят до клиентов', () => {
    const env = setup(2, 'deathmatch', 0.02);
    run(env, 4, cruise);
    const hs = env.host.sim!;
    hs.finish(false, -1, 1); // победил Bob
    run(env, 1.5);
    const c = env.clients[0].sim!;
    expect(c.result.over).toBe(true);
    expect(c.viewerWon(c.localId)).toBe(true);
    expect(hs.viewerWon(0)).toBe(false);
  });

  it('отключившийся клиент заменяется ботом', () => {
    const env = setup(3);
    run(env, 3, cruise);
    env.hub.endpoints[2].close();
    run(env, 0.1);
    const bob = env.host.sim!.shipById(2)!;
    expect(bob.isPlayer).toBe(false);
    expect(bob.ai).not.toBeNull();
  });

  it('уход хоста завершает бой у клиентов', () => {
    const env = setup(2);
    run(env, 2, cruise);
    env.hub.endpoints[0].close();
    run(env, 0.1);
    expect(env.clients[0].status).toBe('ended');
    expect(env.clients[0].endReason).toBe('host-left');
  });

  it('ввод клиента реально двигает его корабль на хосте', () => {
    const env = setup(2);
    run(env, 1);
    const bob = env.host.sim!.shipById(1)!;
    const before = bob.speed;
    run(env, 3, (who) => (who === 1 ? { ...neutralInput(), throttle: 1 } : neutralInput()));
    expect(bob.speed).toBeGreaterThan(before);
  });

  it('частоты снимков соответствуют настройкам', () => {
    expect(NET.snapHz).toBeGreaterThan(5);
  });
});
