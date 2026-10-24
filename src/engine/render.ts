import { Mesh, RGB } from './mesh';
import { Quat, Vec3, clamp, qrot, qrotInv, vnorm, v3, Rng } from './math';

export interface Camera {
  pos: Vec3;
  rot: Quat;
  /** Вертикальный/горизонтальный угол обзора (по большей стороне экрана), рад. */
  fov: number;
}

type Cmd =
  | { t: 0; d: number; pts: number[]; css: string }
  | { t: 1; d: number; x0: number; y0: number; x1: number; y1: number; css: string; w: number }
  | { t: 2; d: number; x: number; y: number; r: number; css: string };

const BG: RGB = [0, 5, 9];
const LIGHT = vnorm(v3(0.45, 0.8, -0.35));

const rgb = (c: RGB, k = 1): string =>
  `rgb(${Math.min(255, (c[0] * k) | 0)},${Math.min(255, (c[1] * k) | 0)},${Math.min(255, (c[2] * k) | 0)})`;

export class Renderer {
  readonly ctx: CanvasRenderingContext2D;
  width = 1;
  height = 1;
  dpr = 1;
  cam: Camera = { pos: v3(), rot: { x: 0, y: 0, z: 0, w: 1 }, fov: 1.35 };
  private f = 1;
  private cmds: Cmd[] = [];
  private stars: Vec3[];
  fogStart = 500;
  fogEnd = 3200;
  /** Число отрисованных граней в прошлом кадре (для отладки). */
  faceCount = 0;

  constructor(private canvas: HTMLCanvasElement) {
    const c = canvas.getContext('2d', { alpha: false });
    if (!c) throw new Error('Canvas 2D недоступен');
    this.ctx = c;
    const rng = new Rng(777);
    this.stars = Array.from({ length: 260 }, () => rng.unit());
    this.resize();
  }

  resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(window.innerWidth));
    const h = Math.max(1, Math.floor(window.innerHeight));
    this.dpr = dpr;
    this.width = w;
    this.height = h;
    this.canvas.width = Math.floor(w * dpr);
    this.canvas.height = Math.floor(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  begin(): void {
    this.cmds.length = 0;
    this.faceCount = 0;
    this.f = Math.max(this.width, this.height) / 2 / Math.tan(this.cam.fov / 2);
    const ctx = this.ctx;
    ctx.fillStyle = rgb(BG);
    ctx.fillRect(0, 0, this.width, this.height);
    this.drawStars();
  }

  private drawStars(): void {
    const ctx = this.ctx;
    const cx = this.width / 2, cy = this.height / 2;
    ctx.fillStyle = '#9fd';
    for (const s of this.stars) {
      const v = qrotInv(this.cam.rot, s);
      if (v.z < 0.05) continue;
      const x = cx + (v.x / v.z) * this.f;
      const y = cy - (v.y / v.z) * this.f;
      if (x < 0 || y < 0 || x > this.width || y > this.height) continue;
      ctx.globalAlpha = 0.35 + 0.5 * ((s.x * 13.37) % 1 > 0.5 ? 1 : 0.4);
      ctx.fillRect(x, y, 1.4, 1.4);
    }
    ctx.globalAlpha = 1;
  }

  /** Проекция точки на экран. sx/sy осмысленны только при z > 0; vx/vy нужны для стрелок за кадром. */
  project(p: Vec3): { sx: number; sy: number; z: number; vx: number; vy: number } {
    const v = this.toView(p);
    const z = Math.max(v.z, 0.001);
    return {
      sx: this.width / 2 + (v.x / z) * this.f,
      sy: this.height / 2 - (v.y / z) * this.f,
      z: v.z, vx: v.x, vy: v.y,
    };
  }

  private toView(p: Vec3): Vec3 {
    return qrotInv(this.cam.rot, { x: p.x - this.cam.pos.x, y: p.y - this.cam.pos.y, z: p.z - this.cam.pos.z });
  }

  private fog(c: RGB, depth: number, k: number): RGB {
    const m = clamp((depth - this.fogStart) / (this.fogEnd - this.fogStart), 0, 0.88);
    return [c[0] * k * (1 - m) + BG[0] * m, c[1] * k * (1 - m) + BG[1] * m, c[2] * k * (1 - m) + BG[2] * m];
  }

  /** Добавить трёхмерную модель в очередь. */
  addMesh(mesh: Mesh, pos: Vec3, rot: Quat, scale: number): void {
    const near = 1;
    const vc = this.toView(pos);
    const r = mesh.radius * scale;
    if (vc.z + r < near || vc.z - r > this.fogEnd * 1.1) return;
    const cx = this.width / 2, cy = this.height / 2;
    if (vc.z > r) {
      const sr = (r / vc.z) * this.f;
      const sx = cx + (vc.x / vc.z) * this.f;
      const sy = cy - (vc.y / vc.z) * this.f;
      if (sx + sr < 0 || sx - sr > this.width || sy + sr < 0 || sy - sr > this.height) return;
      if (sr < 1.2) {
        const c = this.fog(mesh.faces[0].color, vc.z, 1);
        this.cmds.push({ t: 2, d: vc.z, x: sx, y: sy, r: 1.2, css: rgb(c) });
        return;
      }
    }
    const n = mesh.verts.length;
    const view: Vec3[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const v = mesh.verts[i];
      const w = qrot(rot, { x: v.x * scale, y: v.y * scale, z: v.z * scale });
      view[i] = this.toView({ x: w.x + pos.x, y: w.y + pos.y, z: w.z + pos.z });
    }
    for (const face of mesh.faces) {
      const idx = face.idx;
      const a = view[idx[0]], b = view[idx[1]], c = view[idx[2]];
      // нормаль в видовом пространстве; отбрасываем грани, повёрнутые от камеры
      const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z;
      const wx = c.x - a.x, wy = c.y - a.y, wz = c.z - a.z;
      const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
      if (nx * a.x + ny * a.y + nz * a.z >= 0) continue;
      let poly: Vec3[] = idx.map((k) => view[k]);
      poly = clipNear(poly, near);
      if (poly.length < 3) continue;
      const pts: number[] = [];
      let depth = 0;
      let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
      for (const p of poly) {
        const sx = cx + (p.x / p.z) * this.f;
        const sy = cy - (p.y / p.z) * this.f;
        pts.push(sx, sy);
        depth += p.z;
        if (sx < minX) minX = sx;
        if (sx > maxX) maxX = sx;
        if (sy < minY) minY = sy;
        if (sy > maxY) maxY = sy;
      }
      if (maxX < 0 || minX > this.width || maxY < 0 || minY > this.height) continue;
      depth /= poly.length;
      const wn = qrot(rot, face.n);
      const lit = 0.3 + 0.72 * Math.max(0, wn.x * LIGHT.x + wn.y * LIGHT.y + wn.z * LIGHT.z) + 0.08 * Math.max(0, -wn.y);
      this.cmds.push({ t: 0, d: depth, pts, css: rgb(this.fog(face.color, depth, lit)) });
      this.faceCount++;
    }
  }

  /** Светящийся отрезок в мировых координатах. */
  addLine(a: Vec3, b: Vec3, css: string, width = 2): void {
    let va = this.toView(a), vb = this.toView(b);
    const near = 1;
    if (va.z < near && vb.z < near) return;
    if (va.z < near) va = lerpV(va, vb, (near - va.z) / (vb.z - va.z));
    else if (vb.z < near) vb = lerpV(vb, va, (near - vb.z) / (va.z - vb.z));
    const cx = this.width / 2, cy = this.height / 2;
    this.cmds.push({
      t: 1, d: (va.z + vb.z) / 2,
      x0: cx + (va.x / va.z) * this.f, y0: cy - (va.y / va.z) * this.f,
      x1: cx + (vb.x / vb.z) * this.f, y1: cy - (vb.y / vb.z) * this.f,
      css, w: width,
    });
  }

  /** Светящаяся точка (частица, свечение двигателя). size — радиус в мировых единицах. */
  addDot(p: Vec3, size: number, css: string, maxPx = 1e9): void {
    const v = this.toView(p);
    if (v.z < 1) return;
    const cx = this.width / 2, cy = this.height / 2;
    const x = cx + (v.x / v.z) * this.f, y = cy - (v.y / v.z) * this.f;
    const r = Math.min(maxPx, Math.max(0.8, (size / v.z) * this.f));
    if (x < -r || y < -r || x > this.width + r || y > this.height + r) return;
    this.cmds.push({ t: 2, d: v.z, x, y, r, css });
  }

  /** Отрисовать накопленное от дальнего к ближнему. */
  flush(): void {
    const ctx = this.ctx;
    this.cmds.sort((p, q) => q.d - p.d);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const c of this.cmds) {
      if (c.t === 0) {
        ctx.fillStyle = c.css;
        ctx.strokeStyle = c.css;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(c.pts[0], c.pts[1]);
        for (let i = 2; i < c.pts.length; i += 2) ctx.lineTo(c.pts[i], c.pts[i + 1]);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      } else if (c.t === 1) {
        ctx.strokeStyle = c.css;
        ctx.lineWidth = c.w;
        ctx.beginPath();
        ctx.moveTo(c.x0, c.y0);
        ctx.lineTo(c.x1, c.y1);
        ctx.stroke();
      } else {
        ctx.fillStyle = c.css;
        ctx.beginPath();
        ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}

function lerpV(a: Vec3, b: Vec3, t: number): Vec3 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
}

/** Отсечение выпуклого многоугольника плоскостью z = near (Сазерленд–Ходжман). */
export function clipNear(poly: Vec3[], near: number): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const ain = a.z >= near, bin = b.z >= near;
    if (ain) out.push(a);
    if (ain !== bin) out.push(lerpV(a, b, (near - a.z) / (b.z - a.z)));
  }
  return out;
}
