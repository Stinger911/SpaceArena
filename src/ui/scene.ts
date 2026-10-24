import { Quat, Vec3, qlook, qrot, qturn, v3, vadd, vlen, vmad, vscale } from '../engine/math';
import { Mesh, RGB, makeAsteroid, makeBase, makeShip, makeStation } from '../engine/mesh';
import type { Renderer } from '../engine/render';
import { BOLT_LIFE, TEAM_COLORS } from '../game/sim';
import type { Sim } from '../game/sim';
import type { Ship } from '../game/types';
import type { Fx } from './fx';

const css = (c: RGB, a = 1): string => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;

/** Кэш моделей: корабли по типу и цвету, астероиды по зерну. */
export class MeshCache {
  private ships = new Map<string, Mesh>();
  private rocks = new Map<number, Mesh>();
  private bases = new Map<number, Mesh>();
  private station: Mesh | null = null;

  ship(s: Ship): Mesh {
    const key = `${s.kind}:${s.color.join(',')}`;
    let m = this.ships.get(key);
    if (!m) { m = makeShip(s.kind, s.color); this.ships.set(key, m); }
    return m;
  }
  rock(seed: number): Mesh {
    let m = this.rocks.get(seed);
    if (!m) { m = makeAsteroid(seed); this.rocks.set(seed, m); }
    return m;
  }
  base(team: number): Mesh {
    let m = this.bases.get(team);
    if (!m) { m = makeBase(TEAM_COLORS[team] ?? [200, 200, 200]); this.bases.set(team, m); }
    return m;
  }
  stationMesh(): Mesh {
    if (!this.station) this.station = makeStation();
    return this.station;
  }
}

export interface CameraRig {
  pos: Vec3;
  rot: Quat;
}

/** Камера игрока: из кабины или вид снаружи (автоматически снаружи после гибели). */
export function playerCamera(p: Ship, external: boolean, shake: number, t: number): CameraRig {
  const fwd = qrot(p.rot, v3(0, 0, 1));
  const up = qrot(p.rot, v3(0, 1, 0));
  let pos: Vec3;
  let rot: Quat;
  if (external || !p.alive) {
    pos = vadd(vmad(p.pos, fwd, -26), vscale(up, 7));
    rot = qlook(vadd(vscale(fwd, 70), vscale(up, -6)), up);
  } else {
    pos = vadd(vmad(p.pos, fwd, 1.2), vscale(up, 0.7));
    rot = p.rot;
  }
  if (shake > 0.001) {
    rot = qturn(rot, Math.sin(t * 91) * shake * 0.05, Math.sin(t * 77 + 1) * shake * 0.05, Math.sin(t * 63 + 2) * shake * 0.04);
  }
  return { pos, rot };
}

/** Облёт сцены для фона меню. */
export function orbitCamera(t: number, radius: number): CameraRig {
  const a = t * 0.12;
  const pos = v3(Math.cos(a) * radius, radius * 0.18, Math.sin(a) * radius);
  return { pos, rot: qlook(vscale(pos, -1)) };
}

export function drawScene(r: Renderer, sim: Sim, meshes: MeshCache, fx: Fx, cam: CameraRig, hidePlayer: boolean, t: number): void {
  r.cam.pos = cam.pos;
  r.cam.rot = cam.rot;
  r.begin();

  for (const rock of sim.rocks) r.addMesh(meshes.rock(rock.seed), rock.pos, rock.rot, rock.r / 1.1);
  for (const st of sim.structures) {
    const mesh = st.kind === 'base' ? meshes.base(st.team) : meshes.stationMesh();
    r.addMesh(mesh, st.pos, st.rot, st.r / mesh.radius);
  }

  for (const s of sim.ships) {
    if (!s.alive) continue;
    if (hidePlayer && s.id === sim.localId) continue;
    // после возрождения корабль мигает
    if (s.invuln > 0 && Math.floor(t * 12) % 2 === 0 && s.id === sim.localId) continue;
    r.addMesh(meshes.ship(s), s.pos, s.rot, s.kind === 'heavy' ? 1.25 : 1);
    const tail = vadd(s.pos, qrot(s.rot, v3(0, 0, s.kind === 'heavy' ? -4.2 : -3)));
    const flare = 0.5 + 0.9 * (s.speed / s.stats.maxSpeed);
    r.addDot(tail, flare, 'rgba(255,200,120,0.9)', 7);
    r.addDot(tail, flare * 2.2, 'rgba(255,140,60,0.25)', 16);
  }

  for (const b of sim.bolts) {
    const owner = sim.shipById(b.owner);
    const col: RGB = owner ? owner.color : [255, 255, 255];
    // свои только что выпущенные болты рядом с камерой кабины дают гигантские штрихи — пропускаем
    if (owner?.id === sim.localId && hidePlayer && BOLT_LIFE - b.life < 0.08) continue;
    r.addLine(b.pos, vmad(b.pos, b.vel, -0.025), css(col, 0.95), 2.5);
  }
  for (const m of sim.missiles) {
    r.addLine(m.pos, vmad(m.pos, m.dir, -9), 'rgba(255,220,160,0.95)', 3);
    r.addDot(vmad(m.pos, m.dir, -10), 1.6, 'rgba(255,120,40,0.6)', 10);
    r.addDot(m.pos, 1.2, 'rgba(255,255,230,1)', 6);
  }

  fx.draw(r);

  // граница арены проявляется при приближении
  const p = sim.player;
  const d = vlen(p.pos);
  const R = sim.arenaRadius;
  if (d > R * 0.72) {
    const a = Math.min(0.85, (d - R * 0.72) / (R * 0.28));
    const col = `rgba(255,${d > R ? 70 : 150},60,${a.toFixed(2)})`;
    const N = 64;
    for (let plane = 0; plane < 3; plane++) {
      let prev: Vec3 | null = null;
      for (let i = 0; i <= N; i++) {
        const ang = (i / N) * Math.PI * 2;
        const c = Math.cos(ang) * R, s = Math.sin(ang) * R;
        const q = plane === 0 ? v3(c, s, 0) : plane === 1 ? v3(0, c, s) : v3(c, 0, s);
        if (prev && vlen(vadd(q, vscale(p.pos, -1))) < R * 0.9) r.addLine(prev, q, col, 1.5);
        prev = q;
      }
    }
  }
  r.flush();
}
