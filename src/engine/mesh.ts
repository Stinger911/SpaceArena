import { Rng, TAU, Vec3, v3, vadd, vcross, vdot, vlen, vnorm, vscale, vsub } from './math';

export type RGB = [number, number, number];

export interface Face {
  idx: number[];
  color: RGB;
  /** Нормаль в системе координат меши, направлена наружу. */
  n: Vec3;
}

export interface Mesh {
  verts: Vec3[];
  faces: Face[];
  /** Радиус описанной сферы. */
  radius: number;
}

class Builder {
  verts: Vec3[] = [];
  faces: Face[] = [];

  /** Добавляет выпуклую часть. Обход граней автоматически ориентируется наружу. */
  convex(points: Vec3[], faces: number[][], color: RGB, tint = 0): void {
    const base = this.verts.length;
    let c = v3();
    for (const p of points) { this.verts.push(p); c = vadd(c, p); }
    c = vscale(c, 1 / points.length);
    faces.forEach((f, i) => {
      let idx = f.slice();
      const a = points[idx[0]], b = points[idx[1]], d = points[idx[2]];
      let n = vcross(vsub(b, a), vsub(d, a));
      let fc = v3();
      for (const k of idx) fc = vadd(fc, points[k]);
      fc = vscale(fc, 1 / idx.length);
      if (vdot(n, vsub(fc, c)) < 0) { idx = idx.reverse(); n = vscale(n, -1); }
      const t = tint ? 1 + (((i * 7919) % 13) / 13 - 0.5) * tint : 1;
      this.faces.push({
        idx: idx.map((k) => k + base),
        color: [Math.min(255, color[0] * t), Math.min(255, color[1] * t), Math.min(255, color[2] * t)],
        n: vnorm(n),
      });
    });
  }

  box(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, color: RGB): void {
    const h = [sx / 2, sy / 2, sz / 2];
    const p: Vec3[] = [];
    for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) p.push(v3(cx + x * h[0], cy + y * h[1], cz + z * h[2]));
    this.convex(p, [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]], color);
  }

  /** Правильная призма вдоль оси Y. */
  prism(n: number, radius: number, y0: number, y1: number, color: RGB, cx = 0, cz = 0, rot = 0): void {
    const p: Vec3[] = [];
    for (let i = 0; i < n; i++) {
      const a = rot + (i / n) * TAU;
      p.push(v3(cx + Math.cos(a) * radius, y0, cz + Math.sin(a) * radius));
    }
    for (let i = 0; i < n; i++) {
      const a = rot + (i / n) * TAU;
      p.push(v3(cx + Math.cos(a) * radius, y1, cz + Math.sin(a) * radius));
    }
    const f: number[][] = [Array.from({ length: n }, (_, i) => i), Array.from({ length: n }, (_, i) => n + i)];
    for (let i = 0; i < n; i++) f.push([i, (i + 1) % n, n + ((i + 1) % n), n + i]);
    this.convex(p, f, color);
  }

  /** Плоская треугольная призма (крыло). */
  wing(a: Vec3, b: Vec3, c: Vec3, t: number, color: RGB): void {
    const up = v3(0, t, 0);
    const p = [vadd(a, up), vadd(b, up), vadd(c, up), vsub(a, up), vsub(b, up), vsub(c, up)];
    this.convex(p, [[0, 1, 2], [3, 5, 4], [0, 3, 4, 1], [1, 4, 5, 2], [2, 5, 3, 0]], color);
  }

  build(): Mesh {
    let radius = 0;
    for (const v of this.verts) radius = Math.max(radius, vlen(v));
    return { verts: this.verts, faces: this.faces, radius };
  }
}

const shade = (c: RGB, k: number): RGB => [c[0] * k, c[1] * k, c[2] * k];

export type ShipKind = 'fighter' | 'heavy';

/** Корабль. Нос — по +Z. Единицы: корпус примерно 10 м в длину. */
export function makeShip(kind: ShipKind, color: RGB): Mesh {
  const b = new Builder();
  const dark = shade(color, 0.55);
  const light = shade(color, 1.15);
  const canopy: RGB = [120, 220, 255];
  if (kind === 'fighter') {
    b.convex(
      [v3(0, 0, 3), v3(-0.9, 0, -1.2), v3(0.9, 0, -1.2), v3(0, 0.55, -1), v3(0, -0.4, -1.2)],
      [[0, 3, 2], [0, 2, 4], [0, 4, 1], [0, 1, 3], [1, 4, 2, 3]],
      color, 0.18,
    );
    b.wing(v3(-0.7, 0, 0.2), v3(-2.5, -0.1, -1.7), v3(-0.7, 0, -1.2), 0.08, dark);
    b.wing(v3(0.7, 0, 0.2), v3(2.5, -0.1, -1.7), v3(0.7, 0, -1.2), 0.08, dark);
    b.wing(v3(0, 0.45, -0.6), v3(0, 1.3, -1.7), v3(0, 0.45, -1.2), 0.05, light);
    b.convex(
      [v3(0, 0.5, 1.4), v3(-0.3, 0.3, 0.3), v3(0.3, 0.3, 0.3), v3(0, 0.62, 0.1)],
      [[0, 2, 3], [0, 3, 1], [0, 1, 2], [1, 3, 2]],
      canopy,
    );
  } else {
    b.convex(
      [v3(0, 0, 3.4), v3(-1.5, 0, -1.4), v3(1.5, 0, -1.4), v3(0, 0.9, -1.2), v3(0, -0.7, -1.4)],
      [[0, 3, 2], [0, 2, 4], [0, 4, 1], [0, 1, 3], [1, 4, 2, 3]],
      color, 0.18,
    );
    b.wing(v3(-1.2, 0, 0.6), v3(-3.6, -0.2, -2.2), v3(-1.2, 0, -1.4), 0.14, dark);
    b.wing(v3(1.2, 0, 0.6), v3(3.6, -0.2, -2.2), v3(1.2, 0, -1.4), 0.14, dark);
    b.box(-3.5, -0.2, -2.0, 0.4, 0.4, 1.8, light);
    b.box(3.5, -0.2, -2.0, 0.4, 0.4, 1.8, light);
    b.convex(
      [v3(0, 0.85, 1.6), v3(-0.5, 0.5, 0.2), v3(0.5, 0.5, 0.2), v3(0, 1.0, 0.0)],
      [[0, 2, 3], [0, 3, 1], [0, 1, 2], [1, 3, 2]],
      canopy,
    );
  }
  return b.build();
}

/** Астероид: икосаэдр с одним разбиением и случайным радиусом вершин. */
export function makeAsteroid(seed: number): Mesh {
  const rng = new Rng(seed);
  const t = (1 + Math.sqrt(5)) / 2;
  let verts: Vec3[] = [
    v3(-1, t, 0), v3(1, t, 0), v3(-1, -t, 0), v3(1, -t, 0),
    v3(0, -1, t), v3(0, 1, t), v3(0, -1, -t), v3(0, 1, -t),
    v3(t, 0, -1), v3(t, 0, 1), v3(-t, 0, -1), v3(-t, 0, 1),
  ].map(vnorm);
  let tris: number[][] = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  const cache = new Map<string, number>();
  const mid = (a: number, c: number): number => {
    const k = a < c ? `${a}_${c}` : `${c}_${a}`;
    const hit = cache.get(k);
    if (hit !== undefined) return hit;
    verts.push(vnorm(vscale(vadd(verts[a], verts[c]), 0.5)));
    cache.set(k, verts.length - 1);
    return verts.length - 1;
  };
  const next: number[][] = [];
  for (const [a, c, d] of tris) {
    const ab = mid(a, c), bc = mid(c, d), ca = mid(d, a);
    next.push([a, ab, ca], [c, bc, ab], [d, ca, bc], [ab, bc, ca]);
  }
  tris = next;
  verts = verts.map((v) => vscale(v, rng.range(0.72, 1.18)));
  const base: RGB = [rng.range(90, 130), rng.range(80, 110), rng.range(70, 95)];
  const b = new Builder();
  // вся меш — один «выпуклый» объект относительно начала координат
  b.convex(verts, tris, base, 0.35);
  return b.build();
}

/** Нейтральная станция: башня, кольцо, панели. Масштаб ~ радиус 1 по башне. */
export function makeStation(): Mesh {
  const b = new Builder();
  const hull: RGB = [150, 160, 175];
  const accent: RGB = [90, 120, 160];
  b.prism(8, 1.0, -1.6, 1.6, hull);
  b.prism(8, 2.3, -0.2, 0.2, accent);
  b.prism(8, 0.55, 1.6, 2.6, shade(hull, 0.8));
  b.box(-3.2, 0, 0, 2.4, 0.08, 1.4, [60, 110, 200]);
  b.box(3.2, 0, 0, 2.4, 0.08, 1.4, [60, 110, 200]);
  b.convex([v3(0, 3.6, 0), v3(-0.25, 2.6, -0.25), v3(0.25, 2.6, -0.25), v3(0, 2.6, 0.3)], [[0, 2, 1], [0, 3, 2], [0, 1, 3], [1, 2, 3]], [255, 200, 90]);
  return b.build();
}

/** База команды: широкая платформа с башней. */
export function makeBase(color: RGB): Mesh {
  const b = new Builder();
  b.prism(12, 3.2, -0.5, 0.5, shade(color, 0.6));
  b.prism(12, 2.0, 0.5, 1.2, shade(color, 0.9));
  b.prism(6, 0.8, 1.2, 3.2, color);
  b.convex([v3(0, 4.4, 0), v3(-0.5, 3.2, -0.5), v3(0.5, 3.2, -0.5), v3(0, 3.2, 0.6)], [[0, 2, 1], [0, 3, 2], [0, 1, 3], [1, 2, 3]], [255, 255, 255]);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU + Math.PI / 4;
    b.box(Math.cos(a) * 3.2, 0.9, Math.sin(a) * 3.2, 0.6, 1.0, 0.6, shade(color, 1.2));
  }
  return b.build();
}
