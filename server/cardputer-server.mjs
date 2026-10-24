#!/usr/bin/env node
// Отладочный эмулятор платформы CardPutter-Games (ESP32 Cardputer) на Node.js.
// Повторяет её HTTP-API лобби, WebSocket-реле (JSON ≤ 1 КБ всем остальным в комнате),
// /sdk.js, портал и раздачу игр /g/<id>/ — включая автоподстановку .gz.
// Ничего не симулирует, как и прошивка. Дополнительно: задержки/потери и счётчики трафика.
//
//   node server/cardputer-server.mjs --games dist-cardputer/games --port 8080 --latency 40 --stats
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const here = path.dirname(fileURLToPath(import.meta.url));

// ---------- параметры ----------
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf('--' + name);
  if (i < 0) return def;
  const v = args[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
export function parseOptions() {
  return {
    port: Number(opt('port', process.env.PORT || 8080)),
    games: path.resolve(String(opt('games', path.join(here, '..', 'dist-cardputer', 'games')))),
    latency: Number(opt('latency', 0)),
    jitter: Number(opt('jitter', 0)),
    loss: Number(opt('loss', 0)),
    stats: Boolean(opt('stats', false)),
    portal: opt('portal', ''),
    sdk: opt('sdk', ''),
    host: String(opt('host', '0.0.0.0')),
  };
}

// ---------- лимиты прошивки (config.h) ----------
export const LIMITS = { MAX_SESSIONS: 24, MAX_ROOMS: 8, WS_GRACE_MS: 20000, SESSION_IDLE_MS: 15 * 60 * 1000, MAX_WS_BYTES: 1024 };

const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.txt': 'text/plain', '.wasm': 'application/wasm', '.map': 'application/json',
};
const validId = (s) => /^[A-Za-z0-9_-]{1,32}$/.test(s);

export function createServer(o) {
  const portalHtml = fs.readFileSync(o.portal || path.join(here, 'vendor', 'portal.html'), 'utf8');
  const sdkJs = fs.readFileSync(o.sdk || path.join(here, 'vendor', 'sdk.js'), 'utf8');

  /** @type {Map<string, any>} */
  const sessions = new Map();
  const users = new Map();
  const rooms = [];
  let nextRoom = 1;
  const t0 = Date.now();
  const counters = {
    wsIn: 0, wsOut: 0, bytesIn: 0, bytesOut: 0, maxIn: 0, oversize: 0, dropped: 0,
    perSec: { in: 0, out: 0, bytesIn: 0, bytesOut: 0 },
  };

  // ---------- игры ----------
  function gameList() {
    const out = [];
    let dirs = [];
    try { dirs = fs.readdirSync(o.games, { withFileTypes: true }); } catch { /* нет SD */ }
    for (const d of dirs) {
      if (!d.isDirectory() || !validId(d.name)) continue;
      const base = path.join(o.games, d.name);
      if (!fs.existsSync(path.join(base, 'index.html')) && !fs.existsSync(path.join(base, 'index.html.gz'))) continue;
      const g = { id: d.name, title: d.name, description: '', min: 1, max: 1 };
      try {
        const m = JSON.parse(fs.readFileSync(path.join(base, 'manifest.json'), 'utf8'));
        if (typeof m.title === 'string') g.title = m.title;
        if (typeof m.description === 'string') g.description = m.description;
        if (typeof m.icon === 'string') g.icon = m.icon;
        const mn = Math.max(1, Math.min(8, m.min | 0 || 1));
        g.min = mn;
        g.max = Math.max(mn, Math.min(8, m.max | 0 || 1));
      } catch { /* без манифеста — одиночная игра */ }
      out.push(g);
    }
    return out;
  }
  const gameMax = (id) => (validId(id) ? gameList().find((g) => g.id === id)?.max ?? 0 : 0);

  // ---------- сессии и лобби (lobby.cpp / auth.cpp) ----------
  const nameOf = (tok) => sessions.get(tok)?.name ?? '?';
  const roomJson = (r) => ({
    id: r.id, game: r.game, title: r.title, max: r.maxP, open: r.open,
    owner: nameOf(r.ownerTok), count: r.members.length, members: r.members.map(nameOf),
  });

  function link(sock, payload) {
    // имитация сети: фиксированная задержка + джиттер с сохранением порядка, потери
    if (o.loss > 0 && Math.random() * 100 < o.loss) { counters.dropped++; return; }
    const send = () => { if (sock.readyState === 1) sock.send(payload); };
    if (o.latency <= 0 && o.jitter <= 0) { send(); return; }
    const due = Math.max(sock._next || 0, Date.now() + o.latency + Math.random() * o.jitter);
    sock._next = due;
    setTimeout(send, due - Date.now());
  }
  function sendTo(tok, payload) {
    const s = sessions.get(tok);
    if (!s || !s.ws) return;
    counters.wsOut++; counters.perSec.out++;
    const n = Buffer.byteLength(payload);
    counters.bytesOut += n; counters.perSec.bytesOut += n;
    link(s.ws, payload);
  }
  const broadcast = (r, payload, except) => { for (const t of r.members) if (t !== except) sendTo(t, payload); };
  function roomEvent(r, type, who) {
    broadcast(r, JSON.stringify({ t: type, room: r.id, name: who, owner: nameOf(r.ownerTok), members: r.members.map(nameOf) }));
  }
  function leave(s) {
    if (!s.room) return;
    const rid = s.room;
    s.room = 0;
    const i = rooms.findIndex((r) => r.id === rid);
    if (i < 0) return;
    const r = rooms[i];
    r.members = r.members.filter((t) => t !== s.token);
    if (!r.members.length) rooms.splice(i, 1);
    else {
      if (r.ownerTok === s.token) r.ownerTok = r.members[0];
      roomEvent(r, 'leave', s.name);
    }
  }
  function join(s, r) {
    r.members.push(s.token);
    s.room = r.id;
    if (!s.ws) s.wsLost = Date.now();
    roomEvent(r, 'join', s.name);
  }
  function create(s, game, title, maxP) {
    const gm = gameMax(game);
    if (gm < 2) return 'Игра не поддерживает мультиплеер';
    if (rooms.length >= LIMITS.MAX_ROOMS) return 'Слишком много комнат';
    leave(s);
    const t = String(title || '').trim().slice(0, 24);
    const r = {
      id: nextRoom++, game, title: t || `${s.name}'s game`, ownerTok: s.token, members: [], open: true,
      maxP: Math.max(2, Math.min(gm, maxP > 0 ? maxP : gm)),
    };
    rooms.push(r);
    join(s, r);
    return r;
  }
  function joinRoom(s, id) {
    const r = rooms.find((x) => x.id === id);
    if (!r) return 'Комната не найдена';
    if (s.room === id) return r;
    if (!r.open) return 'Игра уже началась';
    if (r.members.length >= r.maxP) return 'Комната заполнена';
    leave(s);
    const r2 = rooms.find((x) => x.id === id);
    if (!r2) return 'Комната не найдена';
    join(s, r2);
    return r2;
  }
  function quick(s, game) {
    if (gameMax(game) < 2) return 'Игра не поддерживает мультиплеер';
    let best = null;
    for (const r of rooms) {
      if (r.game !== game || !r.open || r.members.length >= r.maxP || s.room === r.id) continue;
      if (!best || r.members.length > best.members.length) best = r;
    }
    return best ? joinRoom(s, best.id) : create(s, game, 'Быстрая игра', 0);
  }
  function start(s) {
    const r = s.room && rooms.find((x) => x.id === s.room);
    if (!r) return 'Вы не в комнате';
    if (r.ownerTok !== s.token) return 'Старт может только хост';
    if (r.members.length < 2) return 'Нужно минимум 2 игрока';
    r.open = false;
    broadcast(r, JSON.stringify({ t: 'start', room: r.id, game: r.game }));
    return null;
  }
  function sessionCreate(name, guest) {
    for (const [tok, s] of sessions) if (s.name.toLowerCase() === name.toLowerCase()) { leave(s); sessions.delete(tok); break; }
    if (sessions.size >= LIMITS.MAX_SESSIONS) return '';
    const token = crypto.randomBytes(16).toString('hex');
    sessions.set(token, { token, name, guest, room: 0, ws: null, wsLost: 0, lastSeen: Date.now() });
    return token;
  }
  const guestName = () => {
    for (let i = 0; i < 20; i++) {
      const n = 'Guest' + (1000 + Math.floor(Math.random() * 9000));
      if (![...sessions.values()].some((s) => s.name === n)) return n;
    }
    return 'Guest' + Math.floor(Math.random() * 100000);
  };

  // ---------- HTTP ----------
  const send = (res, code, body, type = 'application/json', extra = {}) => {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
    res.end(body);
  };
  const json = (res, code, obj, cookie) => send(res, code, JSON.stringify(obj), 'application/json', cookie ? { 'Set-Cookie': `sid=${cookie}; Path=/; Max-Age=86400` } : {});
  const err = (res, code, msg) => json(res, code, { ok: false, error: msg });
  const tokenOf = (req, url) => {
    const h = req.headers['x-token'];
    if (h) return String(h);
    const m = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie || '');
    if (m) return m[1];
    return url.searchParams.get('t') || '';
  };
  const readJson = (req) => new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 1024) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
  });

  function serveGame(req, res, url) {
    const rest = url.pathname.slice(3); // после /g/
    const parts = rest.split('/');
    const id = parts.shift();
    if (!validId(id || '')) return send(res, 404, 'Not found', 'text/plain');
    let rel = parts.join('/');
    if (!rel || rel.endsWith('/')) rel += 'index.html';
    const base = path.join(o.games, id);
    const file = path.normalize(path.join(base, rel));
    if (!file.startsWith(base + path.sep)) return send(res, 404, 'Not found', 'text/plain');
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    let target = file, enc = null;
    if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) {
      if (fs.existsSync(file + '.gz')) { target = file + '.gz'; enc = 'gzip'; } // как ESPAsyncWebServer
      else return send(res, 404, 'Not found', 'text/plain');
    }
    const headers = { 'Content-Type': type, 'Cache-Control': 'max-age=300' };
    if (enc) headers['Content-Encoding'] = enc;
    res.writeHead(200, headers);
    fs.createReadStream(target).pipe(res);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    try {
      if (p === '/' && req.method === 'GET') return send(res, 200, portalHtml, 'text/html');
      if (p === '/sdk.js') return send(res, 200, sdkJs, 'application/javascript', { 'Cache-Control': 'max-age=3600' });
      if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }
      if (p.startsWith('/g/')) return serveGame(req, res, url);

      const auth = () => {
        const s = sessions.get(tokenOf(req, url));
        if (s) s.lastSeen = Date.now();
        if (!s) err(res, 401, 'Требуется вход');
        return s;
      };

      if (p === '/api/status') {
        return json(res, 200, { ok: true, name: 'CardPutter Games (Node debug)', version: 'debug', uptime: Math.floor((Date.now() - t0) / 1000), heap: process.memoryUsage().heapUsed, sd: true, players: sessions.size, rooms: rooms.length });
      }
      if (p === '/api/debug') {
        return json(res, 200, { ok: true, counters, sessions: sessions.size, rooms: rooms.map(roomJson), limits: LIMITS });
      }
      if (req.method === 'POST' && p.startsWith('/api/')) {
        const b = await readJson(req);
        switch (p) {
          case '/api/register': {
            const name = String(b.name || ''), pass = String(b.pass || '');
            if (!/^[A-Za-z0-9_-]{3,16}$/.test(name)) return err(res, 400, 'Имя: 3–16 символов, латиница, цифры, _ и -');
            if (users.has(name.toLowerCase())) return err(res, 400, 'Имя занято');
            if (pass.length < 4) return err(res, 400, 'Пароль слишком короткий');
            users.set(name.toLowerCase(), { name, pass });
            const tok = sessionCreate(name, false);
            if (!tok) return err(res, 503, 'Сервер заполнен');
            return json(res, 200, { ok: true, token: tok, name }, tok);
          }
          case '/api/login': {
            const u = users.get(String(b.name || '').toLowerCase());
            if (!u || u.pass !== String(b.pass || '')) return err(res, 401, 'Неверное имя или пароль');
            const tok = sessionCreate(u.name, false);
            if (!tok) return err(res, 503, 'Сервер заполнен');
            return json(res, 200, { ok: true, token: tok, name: u.name }, tok);
          }
          case '/api/guest': {
            const name = guestName();
            const tok = sessionCreate(name, true);
            if (!tok) return err(res, 503, 'Сервер заполнен');
            return json(res, 200, { ok: true, token: tok, name }, tok);
          }
          case '/api/logout': {
            const s = sessions.get(tokenOf(req, url));
            if (s) { leave(s); sessions.delete(s.token); }
            return json(res, 200, { ok: true });
          }
        }
        const s = auth();
        if (!s) return;
        let r;
        switch (p) {
          case '/api/room/create': r = create(s, String(b.game || ''), b.title, Number(b.max) || 0); break;
          case '/api/room/join': r = joinRoom(s, Number(b.id) || 0); break;
          case '/api/room/quick': r = quick(s, String(b.game || '')); break;
          case '/api/room/start': { const e = start(s); return e ? err(res, 400, e) : json(res, 200, { ok: true }); }
          case '/api/room/leave': leave(s); return json(res, 200, { ok: true });
          default: return err(res, 404, 'Не найдено');
        }
        return typeof r === 'string' ? err(res, 400, r) : json(res, 200, { ok: true, room: roomJson(r) });
      }
      if (req.method === 'GET' && p.startsWith('/api/')) {
        const s = auth();
        if (!s) return;
        switch (p) {
          case '/api/me': return json(res, 200, { ok: true, name: s.name, guest: s.guest, room: s.room ? roomJson(rooms.find((x) => x.id === s.room)) : null });
          case '/api/games': return json(res, 200, { ok: true, sd: true, games: gameList() });
          case '/api/players': return json(res, 200, { ok: true, players: [...sessions.values()].map((x) => ({ name: x.name, guest: x.guest, room: x.room })) });
          case '/api/rooms': {
            const g = url.searchParams.get('game') || '';
            if (g && !validId(g)) return err(res, 400, 'Неверный id игры');
            return json(res, 200, { ok: true, rooms: rooms.filter((r) => !g || r.game === g).map(roomJson) });
          }
        }
        return err(res, 404, 'Не найдено');
      }
      if (p.startsWith('/api/')) return err(res, 404, 'Не найдено');
      // captive portal: неизвестное уводим на главную
      res.writeHead(302, { Location: '/' });
      res.end();
    } catch (e) {
      console.error(e);
      send(res, 500, 'error', 'text/plain');
    }
  });

  // ---------- WebSocket-реле ----------
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });
  wss.on('connection', (ws) => {
    let sess = null;
    ws.on('close', () => {
      if (sess && sess.ws === ws) { sess.ws = null; sess.wsLost = Date.now(); }
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const raw = data.toString();
      const n = Buffer.byteLength(raw);
      counters.wsIn++; counters.perSec.in++; counters.bytesIn += n; counters.perSec.bytesIn += n;
      counters.maxIn = Math.max(counters.maxIn, n);
      if (n > LIMITS.MAX_WS_BYTES) { counters.oversize++; console.warn(`! сообщение ${n} Б > ${LIMITS.MAX_WS_BYTES} Б — прошивка его бы отбросила`); return; }
      let d;
      try { d = JSON.parse(raw); } catch { return; }
      if (d.t === 'hello') {
        const s = sessions.get(String(d.token || ''));
        if (!s) { ws.send('{"t":"error","e":"auth"}'); ws.close(); return; }
        if (s.ws && s.ws !== ws) s.ws.close();
        s.ws = ws; s.wsLost = 0; s.lastSeen = Date.now();
        sess = s;
        const r = s.room && rooms.find((x) => x.id === s.room);
        const w = { t: 'welcome', name: s.name, guest: s.guest, room: s.room };
        if (r) Object.assign(w, { game: r.game, owner: nameOf(r.ownerTok), open: r.open, members: r.members.map(nameOf) });
        ws.send(JSON.stringify(w));
        return;
      }
      if (!sess) return;
      sess.lastSeen = Date.now();
      if (d.t === 'ping') ws.send('{"t":"pong"}');
      else if (d.t === 'msg') {
        const r = sess.room && rooms.find((x) => x.id === sess.room);
        if (!r) return;
        broadcast(r, JSON.stringify({ t: 'msg', from: sess.name, d: d.d }), sess.token);
      } else if (d.t === 'start') {
        const e = start(sess);
        if (e) ws.send(JSON.stringify({ t: 'error', e }));
      } else if (d.t === 'leave') { leave(sess); ws.send('{"t":"left"}'); }
    });
  });

  // уборка как lobbyTick(): игроки без WS дольше WS_GRACE_MS выходят из комнаты
  const tick = setInterval(() => {
    const now = Date.now();
    for (const [tok, s] of [...sessions]) {
      if (s.room && !s.ws && now - s.wsLost > LIMITS.WS_GRACE_MS) leave(s);
      if (!s.ws && now - s.lastSeen > LIMITS.SESSION_IDLE_MS) { leave(s); sessions.delete(tok); }
    }
    const c = counters.perSec;
    if (o.stats && (c.in || c.out)) {
      console.log(`[${new Date().toISOString().slice(11, 19)}] игроков ${sessions.size}, комнат ${rooms.length} | вх ${c.in} сообщ/с ${(c.bytesIn / 1024).toFixed(1)} КБ/с | исх(реле) ${c.out} сообщ/с ${(c.bytesOut / 1024).toFixed(1)} КБ/с | макс ${counters.maxIn} Б`);
    }
    counters.perSec = { in: 0, out: 0, bytesIn: 0, bytesOut: 0 };
  }, 1000);
  server.on('close', () => clearInterval(tick));
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const o = parseOptions();
  const srv = createServer(o);
  srv.listen(o.port, o.host, () => {
    console.log(`Эмулятор CardPutter Games: http://localhost:${o.port}/`);
    console.log(`  игры: ${o.games}`);
    if (o.latency || o.jitter || o.loss) console.log(`  сеть: задержка ${o.latency}±${o.jitter} мс, потери ${o.loss}%`);
  });
}
