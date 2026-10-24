import { Rng, Vec3, vmad, vscale } from '../engine/math';
import type { RGB } from '../engine/mesh';
import type { Renderer } from '../engine/render';

interface Particle {
  pos: Vec3;
  vel: Vec3;
  life: number;
  max: number;
  color: RGB;
  size: number;
}

/** Визуальные частицы: взрывы и искры. Не влияют на игровую логику. */
export class Fx {
  private parts: Particle[] = [];
  private rng = new Rng(4242);

  explosion(pos: Vec3, size: number, color: RGB): void {
    const n = Math.min(70, 18 + Math.floor(size * 0.7));
    for (let i = 0; i < n; i++) {
      const dir = this.rng.unit();
      const sp = this.rng.range(0.2, 1) * size * 2.2;
      const hot = this.rng.next() < 0.45;
      this.add(pos, vscale(dir, sp), this.rng.range(0.5, 1.4), hot ? [255, 210, 120] : color, this.rng.range(0.4, 1.1) * (size / 40 + 0.4));
    }
  }

  spark(pos: Vec3): void {
    for (let i = 0; i < 6; i++) {
      this.add(pos, vscale(this.rng.unit(), this.rng.range(20, 90)), this.rng.range(0.15, 0.4), [255, 230, 160], 0.5);
    }
  }

  private add(pos: Vec3, vel: Vec3, life: number, color: RGB, size: number): void {
    if (this.parts.length > 900) this.parts.shift();
    this.parts.push({ pos, vel, life, max: life, color, size });
  }

  update(dt: number): void {
    const damp = Math.exp(-1.6 * dt);
    const keep: Particle[] = [];
    for (const p of this.parts) {
      p.life -= dt;
      if (p.life <= 0) continue;
      p.pos = vmad(p.pos, p.vel, dt);
      p.vel = vscale(p.vel, damp);
      keep.push(p);
    }
    this.parts = keep;
  }

  draw(r: Renderer): void {
    for (const p of this.parts) {
      const a = Math.max(0, p.life / p.max);
      r.addDot(p.pos, p.size, `rgba(${p.color[0] | 0},${p.color[1] | 0},${p.color[2] | 0},${(a * 0.9).toFixed(2)})`, 12);
    }
  }

  clear(): void { this.parts = []; }
}
