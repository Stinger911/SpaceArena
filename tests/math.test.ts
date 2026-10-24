import { describe, expect, it } from 'vitest';
import { qaxis, qid, qlook, qrot, qrotInv, qturn, v3, vdot, vlen, vnorm, vsub } from '../src/engine/math';
import { clipNear } from '../src/engine/render';
import { makeAsteroid, makeBase, makeShip, makeStation } from '../src/engine/mesh';

const close = (a: number, b: number, e = 1e-6): void => expect(Math.abs(a - b)).toBeLessThan(e);

describe('кватернионы', () => {
  it('qrot и qrotInv взаимно обратны', () => {
    const q = qaxis(vnorm(v3(0.3, 0.8, 0.5)), 1.1);
    const v = v3(1, 2, 3);
    const w = qrotInv(q, qrot(q, v));
    close(vlen(vsub(v, w)), 0);
  });
  it('qlook направляет +Z на цель', () => {
    const d = v3(1, 2, -3);
    const f = qrot(qlook(d), v3(0, 0, 1));
    const l = vlen(d);
    close(f.x, d.x / l); close(f.y, d.y / l); close(f.z, d.z / l);
  });
  it('нос вверх: тангаж >0 поднимает вектор вперёд по Y', () => {
    const q = qturn(qid(), 0.3, 0, 0);
    expect(qrot(q, v3(0, 0, 1)).y).toBeGreaterThan(0);
  });
  it('рыскание вправо смещает нос в +X, крен вправо опускает правое крыло', () => {
    expect(qrot(qturn(qid(), 0, 0.3, 0), v3(0, 0, 1)).x).toBeGreaterThan(0);
    expect(qrot(qturn(qid(), 0, 0, 0.3), v3(1, 0, 0)).y).toBeLessThan(0);
  });
});

describe('отсечение по ближней плоскости', () => {
  it('полностью видимый полигон не меняется', () => {
    const poly = [v3(0, 0, 5), v3(1, 0, 5), v3(0, 1, 5)];
    expect(clipNear(poly, 1)).toHaveLength(3);
  });
  it('полигон за камерой исчезает', () => {
    expect(clipNear([v3(0, 0, -5), v3(1, 0, -5), v3(0, 1, -5)], 1)).toHaveLength(0);
  });
  it('пересекающий плоскость полигон обрезается по z=near', () => {
    const out = clipNear([v3(0, 0, -1), v3(1, 0, 3), v3(0, 1, 3)], 1);
    expect(out.length).toBeGreaterThanOrEqual(3);
    for (const p of out) expect(p.z).toBeGreaterThanOrEqual(1 - 1e-9);
  });
});

describe('модели', () => {
  const meshes = {
    fighter: makeShip('fighter', [100, 150, 255]),
    heavy: makeShip('heavy', [255, 100, 100]),
    rock: makeAsteroid(5),
    station: makeStation(),
    base: makeBase([60, 150, 255]),
  };
  for (const [name, m] of Object.entries(meshes)) {
    it(`${name}: индексы корректны, нормали единичные, радиус >0`, () => {
      expect(m.radius).toBeGreaterThan(0);
      for (const f of m.faces) {
        expect(f.idx.length).toBeGreaterThanOrEqual(3);
        for (const i of f.idx) expect(i).toBeLessThan(m.verts.length);
        close(vlen(f.n), 1, 1e-6);
      }
    });
  }
  it('астероид — выпуклый: все грани смотрят от центра', () => {
    for (const f of meshes.rock.faces) {
      const c = f.idx.reduce((a, i) => ({ x: a.x + meshes.rock.verts[i].x, y: a.y + meshes.rock.verts[i].y, z: a.z + meshes.rock.verts[i].z }), v3());
      expect(vdot(f.n, c)).toBeGreaterThan(0);
    }
  });
});
