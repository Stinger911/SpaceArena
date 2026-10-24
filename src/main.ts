import { Synth } from './audio/synth';
import { Renderer } from './engine/render';
import { v3, vlen, vsub } from './engine/math';
import { Sim } from './game/sim';
import { neutralInput } from './game/types';
import type { SimEvent } from './game/types';
import { InputManager } from './input';
import { loadSettings } from './input/settings';
import { emptyUpgrades, loadProfile, saveProfile } from './meta/upgrades';
import { Fx } from './ui/fx';
import { Hud, HudState } from './ui/hud';
import { t } from './ui/i18n';
import { Menu, StartConfig } from './ui/menu';
import { MeshCache, drawScene, orbitCamera, playerCamera } from './ui/scene';
import { NetClient } from './net/client';
import { NetHost } from './net/host';
import type { NetSession } from './net/session';
import { CpTransport, loadSdk } from './net/transport';

const STEP = 1 / 60;

const canvas = document.getElementById('game') as HTMLCanvasElement;
const ui = document.getElementById('ui') as HTMLElement;
const renderer = new Renderer(canvas);
const synth = new Synth();
const profile = loadProfile();
const settings = loadSettings();
synth.enabled = settings.sound;
const meshes = new MeshCache();
const fx = new Fx();
const hud = new Hud();

type State = 'menu' | 'play' | 'pause' | 'over';
let state: State = 'menu';
let sim = makeDemo();
let acc = 0;
let tAbs = 0;
let shake = 0;
let external = false;
let overDelay = 0;
let warnTimer = 0;
const hs: HudState = { banner: null, feed: [], hitMarker: 0, external: false, scoreboard: false, gyro: false };

let net: NetSession | null = null;
let netStarted = false;
const roomParam = new URLSearchParams(location.search).get('room');
const dbg = document.createElement('div');
dbg.style.cssText = 'position:fixed;left:6px;top:6px;font:11px monospace;color:#7fffd4;white-space:pre;pointer-events:none;display:none;text-shadow:0 0 3px #000';
document.body.appendChild(dbg);

const input: InputManager = new InputManager(canvas, ui, settings, { onPause: () => pauseGame() });
const menu = new Menu(ui, profile, input, synth, {
  onStart: (cfg) => (net ? launchNet(cfg) : startGame(cfg)),
  onResume: () => resumeGame(),
  onQuit: () => quitToMenu(),
});

function makeDemo(): Sim {
  const s = new Sim({ mode: 'deathmatch', seed: (Math.random() * 1e9) | 0, upgrades: emptyUpgrades(), bots: 6, difficulty: 0.6 });
  // игрок в демо управляется ботом
  s.player.ai = { skill: 0.6, targetId: -1, retarget: 0, phase: 0, offset: v3(), jink: 0, jinkDir: 1 };
  return s;
}

function startGame(cfg: StartConfig): void {
  sim = new Sim({
    mode: cfg.mode, seed: (Math.random() * 1e9) | 0, upgrades: profile.upgrades, bots: cfg.bots, difficulty: cfg.difficulty,
  });
  fx.clear();
  hs.banner = null;
  hs.feed = [];
  hs.hitMarker = 0;
  external = false;
  overDelay = 0;
  acc = 0;
  state = 'play';
  menu.hide();
  input.setActive(true);
  input.setThrottle(0.6);
  synth.unlock();
}

function pauseGame(): void {
  if (state !== 'play') return;
  if (net && document.hidden) return;
  state = 'pause';
  input.setActive(false);
  menu.show('pause');
}

function resumeGame(): void {
  if (state !== 'pause') return;
  state = 'play';
  menu.hide();
  input.setActive(true);
  synth.unlock();
}

function quitToMenu(): void {
  if (net) { leaveRoom(); return; }
  state = 'menu';
  input.setActive(false);
  sim = makeDemo();
  fx.clear();
  menu.show('main');
}

function leaveRoom(): void {
  const cp = (window as unknown as { CP?: { leave(): Promise<unknown> } }).CP;
  net?.close();
  net = null;
  const go = (): void => { location.href = '/'; };
  if (cp) cp.leave().then(go, go); else go();
}

function launchNet(cfg: StartConfig): void {
  if (!(net instanceof NetHost) || net.status !== 'waiting') return;
  menu.setNet({ starting: true });
  net.launch(cfg.mode, cfg.bots, cfg.difficulty, (Math.random() * 1e9) | 0);
}

async function joinRoom(): Promise<void> {
  menu.netMode = true;
  menu.setNet({ message: t('netConnecting') });
  menu.show('net');
  const cp = await loadSdk();
  if (!cp) { menu.setNet({ message: t('netNoSdk') }); return; }
  const tr = new CpTransport(cp);
  tr.onReady = () => {
    if (net) return;
    const host = tr.owner === tr.name;
    const n: NetSession = host
      ? new NetHost(tr, { mode: 'deathmatch', bots: 5, difficulty: 0.5, upgrades: profile.upgrades, seed: 0, autoStart: false })
      : new NetClient(tr, profile.upgrades);
    net = n;
    n.onChange = refreshNetMenu;
    refreshNetMenu();
  };
}

function refreshNetMenu(): void {
  if (!net) return;
  let message = '';
  if (net.status === 'ended') message = net.endReason === 'late' ? t('netLate') : t('netHostLeft');
  const tr = net.members;
  menu.setNet({ host: net.role === 'host', members: tr.slice(), owner: (window as unknown as { CP?: { owner: string } }).CP?.owner ?? '', message });
}

function startNetGame(): void {
  if (!net?.sim) return;
  sim = net.sim;
  netStarted = true;
  fx.clear();
  hs.banner = null; hs.feed = []; hs.hitMarker = 0;
  external = false; overDelay = 0; acc = 0;
  state = 'play';
  menu.hide();
  input.setActive(true);
  input.setThrottle(0.6);
  synth.unlock();
}

function finishGame(): void {
  const p = sim.player;
  const mode = sim.opts.mode;
  const win = sim.viewerWon(p.id);
  const earned = 20 + p.kills * 25 + (win && mode !== 'waves' ? 200 : 0) + (mode === 'waves' ? Math.max(0, sim.wave - 1) * 60 : 0);
  profile.credits += earned;
  profile.totalKills += p.kills;
  if (mode === 'waves') profile.bestWave = Math.max(profile.bestWave, sim.wave);
  saveProfile(profile);
  state = 'over';
  input.setActive(false);
  menu.show('over', { win, mode, kills: p.kills, wave: sim.wave, earned });
}

const att = (pos: { x: number; y: number; z: number }): number => {
  const d = vlen(vsub(pos, sim.player.pos));
  return Math.pow(Math.max(0.04, 1 - d / 1600), 1.4);
};

function handleEvents(events: SimEvent[], live: boolean): void {
  for (const e of events) {
    switch (e.type) {
      case 'laser': if (live) { const own = e.owner === sim.localId; synth.laser(own ? 1 : att(e.pos), own); } break;
      case 'missile': if (live) synth.missile(e.owner === sim.localId ? 1 : att(e.pos)); break;
      case 'explode':
        fx.explosion(e.pos, e.size, e.color);
        if (live) synth.explosion(e.size, att(e.pos));
        break;
      case 'spark':
        fx.spark(e.pos);
        if (live) synth.spark(att(e.pos));
        break;
      case 'hit':
        fx.spark(e.pos);
        if (!live) break;
        if (e.victim === sim.localId) { shake = 1; synth.hit(true); }
        else { if (e.shooter === sim.localId) hs.hitMarker = 0.18; synth.hit(false, att(e.pos)); }
        break;
      case 'kill': {
        if (!live) break;
        const k = sim.shipById(e.killer)?.name ?? '—';
        const v = sim.shipById(e.victim)?.name ?? '?';
        hs.feed.push({ text: `${k} ✕ ${v}`, ttl: 5 });
        if (hs.feed.length > 5) hs.feed.shift();
        break;
      }
      case 'lock': if (live) synth.lock(); break;
      case 'respawn': if (live && e.id === sim.player.id) synth.respawn(); break;
      case 'wave':
        if (live) { hs.banner = { text: `${t('wave')} ${e.wave}`, ttl: 3 }; synth.wave(); }
        break;
      case 'over':
        if (live) { overDelay = 2; if (e.win) synth.win(); else synth.lose(); }
        break;
    }
  }
}

function frame(now: number): void {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  tAbs += dt;
  fx.update(dt);

  if (net) {
    if (net.status === 'ended' && state !== 'menu' && state !== 'over') {
      state = 'menu';
      input.setActive(false);
      menu.setNet({ message: net.endReason === 'late' ? t('netLate') : t('netHostLeft') });
      menu.show('net');
    } else if (net.status === 'playing' && !netStarted) startNetGame();
    else if (net.status === 'waiting' || state === 'menu') net.step(STEP, neutralInput());
  }
  if (net && state === 'pause') {
    // в сети бой не останавливается: пока открыто меню паузы, корабль дрейфует без ввода
    acc += dt;
    let k = 0;
    while (acc >= STEP && k++ < 6) { net.step(STEP, neutralInput()); acc -= STEP; }
    if (k >= 6) acc = 0;
    handleEvents(net.drainEvents(), false);
  }
  dbg.style.display = dbgOn && net ? 'block' : 'none';
  if (dbgOn && net) dbg.textContent = Object.entries(net.debug()).map(([k, v]) => `${k}: ${v}`).join('\n');

  if (state === 'play') {
    if (input.consumeView()) external = !external;
    const inp = input.poll(dt);
    acc += dt;
    let n = 0;
    while (acc >= STEP && n++ < 6) { if (net) net.step(STEP, inp); else sim.step(STEP, inp); acc -= STEP; }
    if (n >= 6) acc = 0;
    handleEvents(net ? net.drainEvents() : sim.drainEvents(), true);
    const p = sim.player;
    synth.engine(p.speed / p.stats.maxSpeed, p.alive);
    shake = Math.max(0, shake - dt * 3);
    hs.hitMarker = Math.max(0, hs.hitMarker - dt);
    warnTimer -= dt;
    if (p.alive && p.outOfBounds && warnTimer <= 0) { synth.warn(); warnTimer = 0.5; }
    if (hs.banner) { hs.banner.ttl -= dt; if (hs.banner.ttl <= 0) hs.banner = null; }
    for (const f of hs.feed) f.ttl -= dt;
    hs.feed = hs.feed.filter((f) => f.ttl > 0);
    if (sim.result.over) {
      overDelay -= dt;
      if (overDelay <= 0) finishGame();
    }
    hs.external = external || !p.alive;
    hs.scoreboard = input.scoreboard;
    hs.gyro = settings.gyro;
    const cam = playerCamera(p, external, shake, tAbs);
    drawScene(renderer, sim, meshes, fx, cam, !(external || !p.alive), tAbs);
    hud.draw(renderer, sim, hs);
  } else {
    // меню, пауза и итоги: за ними идёт демо-бой или замороженная сцена
    if (state === 'menu') {
      if (!(net && netStarted)) {
        acc += dt;
        let n = 0;
        while (acc >= STEP && n++ < 4) { sim.step(STEP, neutralInput()); acc -= STEP; }
        if (n >= 4) acc = 0;
        handleEvents(sim.drainEvents(), false);
        if (sim.result.over) sim = makeDemo();
      }
      synth.engine(0, false);
      drawScene(renderer, sim, meshes, fx, orbitCamera(tAbs, 650), false, tAbs);
    } else {
      synth.engine(0, false);
      const cam = playerCamera(sim.player, true, 0, tAbs);
      drawScene(renderer, sim, meshes, fx, cam, false, tAbs);
    }
  }
}

let last = performance.now();
let dbgOn = new URLSearchParams(location.search).has('debug');
window.addEventListener('resize', () => renderer.resize());
window.addEventListener('orientationchange', () => setTimeout(() => renderer.resize(), 150));
document.addEventListener('visibilitychange', () => { if (document.hidden && !net) pauseGame(); });
window.addEventListener('keydown', (e) => {
  if (e.code === 'F3') { dbgOn = !dbgOn; e.preventDefault(); }
  if (state === 'pause' && (e.code === 'KeyP' || e.code === 'Escape') && !e.repeat) resumeGame();
});

if (roomParam) void joinRoom(); else menu.show('main');
requestAnimationFrame(frame);

// Отладочный доступ для e2e-тестов и консоли: window.__sa
Object.defineProperty(window, '__sa', {
  value: {
    get state() { return state; },
    get role() { return net?.role ?? 'solo'; },
    get netStatus() { return net?.status ?? 'none'; },
    get over() { return sim.result.over; },
    get localId() { return sim.localId; },
    ships() {
      return sim.ships.map((s) => ({
        id: s.id, name: s.name, alive: s.alive, hp: Math.round(s.hp), kills: s.kills, deaths: s.deaths,
        pos: [s.pos.x, s.pos.y, s.pos.z].map(Math.round),
      }));
    },
    debug: () => net?.debug() ?? {},
    startHost: () => menu.cfg,
  },
});
