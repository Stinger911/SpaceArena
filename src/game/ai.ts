import { clamp, qrot, qrotInv, v3, vadd, vdot, vlen, vmad, vnorm, vscale, vsub, Vec3 } from '../engine/math';
import { ARENA_R, BOLT_SPEED } from './constants';
import type { Sim } from './sim';
import type { Ship } from './types';

function pickTarget(sim: Sim, s: Ship): Ship | undefined {
  let best: Ship | undefined;
  let bestScore = Infinity;
  for (const t of sim.ships) {
    if (!t.alive || !sim.hostile(s, t)) continue;
    const d = vlen(vsub(t.pos, s.pos));
    // в режиме волн боты охотнее выбирают игрока
    const score = d - (t.isPlayer && sim.opts.mode === 'waves' ? 350 : 0) + sim.rng.range(0, 150);
    if (score < bestScore) { bestScore = score; best = t; }
  }
  return best;
}

/** Решает, что делает бот в этом кадре, и записывает команды в s.input. */
export function botThink(sim: Sim, s: Ship, dt: number): void {
  const ai = s.ai;
  if (!ai) return;
  const rng = sim.rng;
  const inp = s.input;
  ai.retarget -= dt;

  let target = sim.shipById(ai.targetId);
  if (!target || !target.alive || !sim.hostile(s, target) || ai.retarget <= 0) {
    target = pickTarget(sim, s);
    ai.targetId = target ? target.id : -1;
    ai.retarget = rng.range(1.2, 3);
    ai.offset = vscale(rng.unit(), (1 - ai.skill) * 40);
  }

  const fwd = qrot(s.rot, v3(0, 0, 1));
  let aim: Vec3;
  let dist = 1e9;
  if (target) {
    const tf = qrot(target.rot, v3(0, 0, 1));
    const tv = vadd(vscale(tf, target.speed), target.bump);
    dist = vlen(vsub(target.pos, s.pos));
    const t = dist / (BOLT_SPEED + s.speed);
    aim = vadd(vmad(target.pos, tv, t * (0.5 + 0.5 * ai.skill)), ai.offset);
  } else {
    aim = vadd(s.pos, fwd);
  }

  // избегание препятствий и других кораблей
  let avoid = v3();
  let danger = 0;
  const consider = (pos: Vec3, r: number): void => {
    const off = vsub(pos, s.pos);
    const d = vlen(off);
    if (d < 1e-6) return;
    const clearance = d - r - s.radius;
    if (clearance > 240) return;
    if (vdot(fwd, off) / d < 0.15) return;
    const w = clamp(1 - clearance / 240, 0, 1);
    avoid = vadd(avoid, vscale(vsub(s.pos, pos), w / d));
    danger = Math.max(danger, w);
  };
  for (const r of sim.rocks) consider(r.pos, r.r);
  for (const st of sim.structures) consider(st.pos, st.r);
  for (const o of sim.ships) if (o !== s && o.alive) consider(o.pos, o.radius * 0.5);

  let dir = vnorm(vsub(aim, s.pos));
  if (danger > 0.05) {
    const k = clamp(danger * 1.6, 0, 1);
    dir = vnorm(vadd(vscale(dir, 1 - k), vscale(vnorm(avoid), k * 1.4)));
  }
  const dc = vlen(s.pos);
  if (dc > ARENA_R * 0.88) {
    const k = clamp((dc - ARENA_R * 0.88) / (ARENA_R * 0.16), 0, 1);
    dir = vnorm(vadd(vscale(dir, 1 - k), vscale(vnorm(vscale(s.pos, -1)), k)));
  }

  const local = qrotInv(s.rot, dir);
  let yaw = clamp(local.x * 3.2, -1, 1);
  let pitch = clamp(local.y * 3.2, -1, 1);
  if (local.z < 0) {
    yaw = local.x >= 0 ? 1 : -1;
    pitch = clamp(local.y * 3, -1, 1);
  }
  ai.phase += dt * (1.4 + ai.skill);
  const weave = target && dist < 600 ? Math.sin(ai.phase) * 0.22 * ai.skill : 0;
  inp.yaw = clamp(yaw + weave, -1, 1);
  inp.pitch = clamp(pitch + weave * 0.6, -1, 1);
  inp.roll = clamp(inp.yaw * 0.6, -1, 1);

  inp.throttle = !target ? 0.7 : dist > 500 ? 1 : dist > 160 ? 0.85 : 0.55;

  const toAim = vnorm(vsub(aim, s.pos));
  const c = vdot(fwd, toAim);
  const fireCos = 0.992 - 0.03 * (1 - ai.skill);
  inp.fire = !!target && c > fireCos && dist < 720 && danger < 0.35;
  inp.missile = !!target && s.lock >= 0 && s.missiles > 0 && dist > 250 && rng.next() < 0.004 + 0.02 * ai.skill;
}
