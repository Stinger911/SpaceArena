import { clamp, qrot, qrotInv, v3, vadd, vlen, vmad, vscale, vsub } from '../engine/math';
import type { Renderer } from '../engine/render';
import { BOLT_SPEED } from '../game/constants';
import type { Sim } from '../game/sim';
import type { Ship } from '../game/types';
import { t } from './i18n';

export interface HudState {
  banner: { text: string; ttl: number } | null;
  feed: { text: string; ttl: number }[];
  hitMarker: number;
  external: boolean;
  scoreboard: boolean;
  gyro: boolean;
}

const HOSTILE = '#ff6a5c';
const ALLY = '#6aff9a';
const GREEN = '#7fffd4';

export class Hud {
  draw(r: Renderer, sim: Sim, st: HudState): void {
    const ctx = r.ctx;
    const w = r.width, h = r.height;
    const u = clamp(Math.min(w, h) / 650, 0.8, 1.35);
    const p = sim.player;
    ctx.save();
    ctx.textBaseline = 'alphabetic';
    ctx.lineWidth = 1.5;

    if (p.hitFlash > 0) {
      const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.max(w, h) * 0.7);
      g.addColorStop(0, 'rgba(255,0,0,0)');
      g.addColorStop(1, `rgba(255,30,30,${(p.hitFlash * 1.6).toFixed(2)})`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }

    this.targets(r, sim, u);
    if (p.alive && !st.external) this.crosshair(r, st, u);
    this.bars(r, sim, u, st);
    this.radar(r, sim, u);
    this.status(r, sim, u);
    this.messages(r, sim, st, u);
    if (st.scoreboard) this.scoreboard(r, sim, u);
    ctx.restore();
  }

  private crosshair(r: Renderer, st: HudState, u: number): void {
    const ctx = r.ctx;
    const cx = r.width / 2, cy = r.height / 2;
    ctx.strokeStyle = GREEN;
    ctx.globalAlpha = 0.85;
    const a = 7 * u, b = 18 * u;
    ctx.beginPath();
    ctx.moveTo(cx - b, cy); ctx.lineTo(cx - a, cy);
    ctx.moveTo(cx + a, cy); ctx.lineTo(cx + b, cy);
    ctx.moveTo(cx, cy - b); ctx.lineTo(cx, cy - a);
    ctx.moveTo(cx, cy + a); ctx.lineTo(cx, cy + b);
    ctx.stroke();
    if (st.hitMarker > 0) {
      ctx.strokeStyle = '#fff';
      ctx.globalAlpha = Math.min(1, st.hitMarker * 6);
      const m = 11 * u;
      ctx.beginPath();
      ctx.moveTo(cx - m, cy - m); ctx.lineTo(cx - a, cy - a);
      ctx.moveTo(cx + m, cy - m); ctx.lineTo(cx + a, cy - a);
      ctx.moveTo(cx - m, cy + m); ctx.lineTo(cx - a, cy + a);
      ctx.moveTo(cx + m, cy + m); ctx.lineTo(cx + a, cy + a);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  private targets(r: Renderer, sim: Sim, u: number): void {
    const ctx = r.ctx;
    const p = sim.player;
    if (!p.alive) return;
    const w = r.width, h = r.height;
    ctx.font = `${11 * u}px "Courier New", monospace`;
    for (const s of sim.ships) {
      if (s === p || !s.alive) continue;
      const hostile = sim.hostile(p, s);
      const dist = vlen(vsub(s.pos, p.pos));
      const pr = r.project(s.pos);
      const col = hostile ? HOSTILE : ALLY;
      const locked = p.lock === s.id;
      if (pr.z > 0 && pr.sx > 0 && pr.sx < w && pr.sy > 0 && pr.sy < h) {
        const size = clamp(7000 / dist, 9, 52) * u * (locked ? 1.25 : 1);
        ctx.strokeStyle = col;
        ctx.fillStyle = col;
        ctx.globalAlpha = locked ? 1 : 0.7;
        const k = size * 0.35;
        const x0 = pr.sx - size / 2, y0 = pr.sy - size / 2, x1 = pr.sx + size / 2, y1 = pr.sy + size / 2;
        ctx.beginPath();
        ctx.moveTo(x0, y0 + k); ctx.lineTo(x0, y0); ctx.lineTo(x0 + k, y0);
        ctx.moveTo(x1 - k, y0); ctx.lineTo(x1, y0); ctx.lineTo(x1, y0 + k);
        ctx.moveTo(x0, y1 - k); ctx.lineTo(x0, y1); ctx.lineTo(x0 + k, y1);
        ctx.moveTo(x1 - k, y1); ctx.lineTo(x1, y1); ctx.lineTo(x1, y1 - k);
        ctx.stroke();
        if (locked || dist < 700) {
          ctx.textAlign = 'center';
          ctx.fillText(`${s.name} ${Math.round(dist)}`, pr.sx, y1 + 13 * u);
        }
        if (locked) {
          ctx.fillText(t('lock'), pr.sx, y0 - 6 * u);
          // упреждение для лазеров
          const tv = vadd(vscale(qrot(s.rot, v3(0, 0, 1)), s.speed), s.bump);
          const tt = dist / (BOLT_SPEED + p.speed);
          const lead = r.project(vmad(s.pos, tv, tt));
          if (lead.z > 0) {
            ctx.beginPath();
            ctx.arc(lead.sx, lead.sy, 5 * u, 0, Math.PI * 2);
            ctx.stroke();
          }
        }
        ctx.globalAlpha = 1;
      } else if (hostile) {
        // стрелка к врагу за пределами кадра
        const len = Math.hypot(pr.vx, pr.vy) || 1;
        const dx = pr.vx / len, dy = -pr.vy / len;
        const rx = w * 0.46, ry = h * 0.42;
        const k = 1 / Math.max(Math.abs(dx) / rx, Math.abs(dy) / ry);
        const ex = w / 2 + dx * k, ey = h / 2 + dy * k;
        ctx.fillStyle = col;
        ctx.globalAlpha = locked ? 1 : 0.65;
        ctx.save();
        ctx.translate(ex, ey);
        ctx.rotate(Math.atan2(dy, dx));
        ctx.beginPath();
        ctx.moveTo(10 * u, 0); ctx.lineTo(-7 * u, -7 * u); ctx.lineTo(-7 * u, 7 * u);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
        ctx.globalAlpha = 1;
      }
    }
  }

  private bar(r: Renderer, x: number, y: number, wd: number, hg: number, v: number, col: string, label: string, u: number): void {
    const ctx = r.ctx;
    ctx.strokeStyle = col;
    ctx.globalAlpha = 0.9;
    ctx.strokeRect(x, y, wd, hg);
    ctx.fillStyle = col;
    ctx.globalAlpha = 0.55;
    ctx.fillRect(x + 1, y + 1, Math.max(0, (wd - 2) * clamp(v, 0, 1)), hg - 2);
    ctx.globalAlpha = 1;
    ctx.fillStyle = col;
    ctx.textAlign = 'left';
    ctx.font = `${10 * u}px "Courier New", monospace`;
    ctx.fillText(label, x + 4, y + hg - 3 * u);
  }

  private bars(r: Renderer, sim: Sim, u: number, st: HudState): void {
    const p = sim.player;
    const x = 12 * u, wd = 150 * u, hg = 15 * u;
    let y = 12 * u;
    const hpFrac = p.hp / p.stats.maxHp;
    this.bar(r, x, y, wd, hg, hpFrac, hpFrac > 0.35 ? GREEN : '#ff5544', `${t('hull')} ${Math.ceil(p.hp)}`, u);
    y += hg + 5 * u;
    this.bar(r, x, y, wd, hg, p.energy / 100, '#6ad0ff', `${t('energy')} ${Math.floor(p.energy)}`, u);
    y += hg + 5 * u;
    this.bar(r, x, y, wd, hg, p.throttle, '#ffd166', `${t('speed')} ${Math.round(p.speed)}`, u);
    y += hg + 14 * u;
    const ctx = r.ctx;
    ctx.fillStyle = '#ffb86b';
    ctx.font = `${12 * u}px "Courier New", monospace`;
    ctx.textAlign = 'left';
    ctx.fillText(`${t('missiles')}: ${'▲'.repeat(p.missiles)}${'△'.repeat(Math.max(0, p.stats.maxMissiles - p.missiles))}`, x, y);
    y += 15 * u;
    ctx.fillStyle = '#9ab';
    ctx.font = `${10 * u}px "Courier New", monospace`;
    if (st.gyro) { ctx.fillText(t('gyroOn'), x, y); y += 13 * u; }
    for (const f of st.feed) {
      ctx.globalAlpha = Math.min(1, f.ttl);
      ctx.fillStyle = '#cfe';
      ctx.fillText(f.text, x, y);
      y += 13 * u;
    }
    ctx.globalAlpha = 1;
  }

  private radar(r: Renderer, sim: Sim, u: number): void {
    const ctx = r.ctx;
    const p = sim.player;
    const R = 62 * u;
    const cx = r.width / 2;
    const cy = r.height - R - 14 * u;
    const range = 1400;
    ctx.save();
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = 'rgba(0,25,20,0.45)';
    ctx.strokeStyle = 'rgba(127,255,212,0.7)';
    ctx.beginPath();
    ctx.ellipse(cx, cy, R, R * 0.62, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = 'rgba(127,255,212,0.25)';
    ctx.beginPath();
    ctx.ellipse(cx, cy, R * 0.5, R * 0.31, 0, 0, Math.PI * 2);
    ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy);
    ctx.moveTo(cx, cy - R * 0.62); ctx.lineTo(cx, cy + R * 0.62);
    ctx.stroke();

    const plot = (pos: ReturnType<typeof v3>, color: string, size: number, square = false): void => {
      const l = qrotInv(p.rot, vsub(pos, p.pos));
      const d = Math.hypot(l.x, l.y, l.z);
      const k = d > range ? range / d : 1;
      const bx = cx + (l.x * k / range) * R;
      const by = cy - (l.z * k / range) * R * 0.62;
      const hy = by - (l.y * k / range) * R * 0.62;
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.globalAlpha = d > range ? 0.45 : 0.95;
      ctx.beginPath();
      ctx.moveTo(bx, by); ctx.lineTo(bx, hy);
      ctx.stroke();
      if (square) ctx.fillRect(bx - size, hy - size, size * 2, size * 2);
      else { ctx.beginPath(); ctx.arc(bx, hy, size, 0, Math.PI * 2); ctx.fill(); }
    };
    for (const rock of sim.rocks) {
      if (vlen(vsub(rock.pos, p.pos)) < range * 0.55) plot(rock.pos, '#778', 1.6);
    }
    for (const stc of sim.structures) plot(stc.pos, stc.kind === 'base' ? (stc.team === p.team ? ALLY : HOSTILE) : '#ffd166', 3 * u, true);
    for (const s of sim.ships) {
      if (s === p || !s.alive) continue;
      plot(s.pos, sim.hostile(p, s) ? HOSTILE : ALLY, (p.lock === s.id ? 3.6 : 2.6) * u);
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = GREEN;
    ctx.beginPath();
    ctx.moveTo(cx, cy - 5 * u); ctx.lineTo(cx - 4 * u, cy + 4 * u); ctx.lineTo(cx + 4 * u, cy + 4 * u);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  private status(r: Renderer, sim: Sim, u: number): void {
    const ctx = r.ctx;
    ctx.fillStyle = '#cfe';
    ctx.textAlign = 'center';
    ctx.font = `bold ${13 * u}px "Courier New", monospace`;
    const x = r.width / 2;
    const y = 20 * u;
    const mode = sim.opts.mode;
    if (mode === 'deathmatch') {
      const top = sim.scoreboard()[0];
      ctx.fillText(`${t('kills')}: ${sim.player.kills} / ${sim.killLimit}   ${t('leader')}: ${top.name} ${top.kills}`, x, y);
    } else if (mode === 'team') {
      ctx.fillText(`${t('teamBlue')} ${sim.teamKills[0]}  :  ${sim.teamKills[1]} ${t('teamRed')}   (${t('to')} ${sim.killLimit})`, x, y);
    } else {
      const left = sim.ships.filter((s) => !s.isPlayer && s.alive).length;
      ctx.fillText(`${t('wave')} ${sim.wave}   ${t('enemies')}: ${left}   ${t('lives')}: ${'♥'.repeat(Math.max(0, sim.player.lives))}`, x, y);
    }
  }

  private messages(r: Renderer, sim: Sim, st: HudState, u: number): void {
    const ctx = r.ctx;
    const p = sim.player;
    const cx = r.width / 2;
    ctx.textAlign = 'center';
    if (st.banner) {
      ctx.globalAlpha = Math.min(1, st.banner.ttl);
      ctx.fillStyle = '#fff';
      ctx.font = `bold ${26 * u}px "Courier New", monospace`;
      ctx.fillText(st.banner.text, cx, r.height * 0.3);
      ctx.globalAlpha = 1;
    }
    if (!p.alive && !sim.result.over) {
      ctx.fillStyle = '#ff8a7a';
      ctx.font = `bold ${22 * u}px "Courier New", monospace`;
      ctx.fillText(t('destroyed'), cx, r.height * 0.4);
      if (p.respawn > 0) {
        ctx.font = `${15 * u}px "Courier New", monospace`;
        ctx.fillText(`${t('respawnIn')} ${Math.ceil(p.respawn)}`, cx, r.height * 0.4 + 26 * u);
      }
    }
    if (p.alive && p.outOfBounds && Math.floor(sim.time * 4) % 2 === 0) {
      ctx.fillStyle = '#ff5544';
      ctx.font = `bold ${20 * u}px "Courier New", monospace`;
      ctx.fillText(t('leaving'), cx, r.height * 0.22);
    }
    if (p.alive && p.lock >= 0 && p.missiles > 0) {
      ctx.fillStyle = '#ffb86b';
      ctx.font = `${12 * u}px "Courier New", monospace`;
      ctx.fillText(t('missileReady'), cx, r.height * 0.68);
    }
  }

  private scoreboard(r: Renderer, sim: Sim, u: number): void {
    const ctx = r.ctx;
    const rows = sim.scoreboard();
    const w = 330 * u;
    const rh = 18 * u;
    const h = rh * (rows.length + 2);
    const x = (r.width - w) / 2, y = (r.height - h) / 2;
    ctx.fillStyle = 'rgba(0,12,14,0.82)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = GREEN;
    ctx.strokeRect(x, y, w, h);
    ctx.font = `${12 * u}px "Courier New", monospace`;
    ctx.textAlign = 'left';
    ctx.fillStyle = GREEN;
    ctx.fillText(t('pilot'), x + 10, y + rh);
    ctx.textAlign = 'right';
    ctx.fillText(t('kills'), x + w - 70 * u, y + rh);
    ctx.fillText(t('deaths'), x + w - 10, y + rh);
    rows.forEach((s: Ship, i) => {
      const yy = y + rh * (i + 2);
      ctx.fillStyle = s.id === sim.localId ? '#fff' : `rgb(${s.color.join(',')})`;
      ctx.textAlign = 'left';
      ctx.fillText(s.name, x + 10, yy);
      ctx.textAlign = 'right';
      ctx.fillText(String(s.kills), x + w - 70 * u, yy);
      ctx.fillText(String(s.deaths), x + w - 10, yy);
    });
  }
}
