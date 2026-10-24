// Транспорт: тонкая обёртка над window.CP (SDK Cardputer) и in-memory реле для тестов.
import { Wire, utf8len } from './protocol';

export interface Transport {
  /** моё имя в комнате */
  readonly name: string;
  readonly owner: string;
  readonly members: string[];
  /** отправить всем остальным в комнате (≤ 1 КБ) */
  send(d: Wire): void;
  onMessage: (from: string, d: Wire) => void;
  /** кто-то вошёл или вышел */
  onMembers: () => void;
  /** соединение установлено/восстановлено (пришёл welcome) */
  onReady: () => void;
  close(): void;
  readonly stats: { msgsOut: number; bytesOut: number; maxMsg: number };
}

interface CPLike {
  name: string; owner: string; members: string[]; room: number;
  on(t: string, f: (m: any) => void): unknown;
  connect(): void;
  send(d: unknown): void;
  ws: { close(): void } | null;
  auto: boolean;
}

export class CpTransport implements Transport {
  onMessage: (from: string, d: Wire) => void = () => {};
  onMembers: () => void = () => {};
  onReady: () => void = () => {};
  stats = { msgsOut: 0, bytesOut: 0, maxMsg: 0 };
  constructor(private cp: CPLike) {
    cp.on('msg', (m: { from: string; d: Wire }) => this.onMessage(m.from, m.d));
    cp.on('join', () => this.onMembers());
    cp.on('leave', () => this.onMembers());
    cp.on('welcome', () => { this.onMembers(); this.onReady(); });
    cp.connect();
  }
  get name(): string { return this.cp.name; }
  get owner(): string { return this.cp.owner; }
  get members(): string[] { return this.cp.members; }
  send(d: Wire): void {
    const n = utf8len(JSON.stringify({ t: 'msg', d }));
    this.stats.msgsOut++; this.stats.bytesOut += n; this.stats.maxMsg = Math.max(this.stats.maxMsg, n);
    this.cp.send(d);
  }
  close(): void { this.cp.auto = false; this.cp.ws?.close(); }
}

/** Загружает /sdk.js (платформа Cardputer или отладочный сервер) и ждёт window.CP. */
export function loadSdk(src = '/sdk.js'): Promise<CPLike | null> {
  return new Promise((resolve) => {
    const w = window as unknown as { CP?: CPLike };
    if (w.CP) { resolve(w.CP); return; }
    const el = document.createElement('script');
    el.src = src;
    el.onload = () => resolve(w.CP ?? null);
    el.onerror = () => resolve(null);
    document.head.appendChild(el);
  });
}

// ---------- in-memory реле (тесты) ----------

export class LoopbackHub {
  endpoints: LoopbackEndpoint[] = [];
  /** кадры, отправленные за время; для оценки трафика */
  totalBytes = 0;
  totalMsgs = 0;
  /** предел реле Cardputer */
  limit = 1024;
  /** задержка в секундах (в каждую сторону) */
  latency = 0;
  private queue: { at: number; to: LoopbackEndpoint; from: string; d: Wire }[] = [];
  private now = 0;

  add(name: string): LoopbackEndpoint {
    const e = new LoopbackEndpoint(this, name);
    this.endpoints.push(e);
    this.notify();
    return e;
  }
  remove(e: LoopbackEndpoint): void {
    this.endpoints = this.endpoints.filter((x) => x !== e);
    this.notify();
  }
  get owner(): string { return this.endpoints[0]?.name ?? ''; }
  get members(): string[] { return this.endpoints.map((e) => e.name); }
  notify(): void { for (const e of this.endpoints) e.onMembers(); }

  relay(from: LoopbackEndpoint, d: Wire): void {
    const n = utf8len(JSON.stringify({ t: 'msg', d }));
    if (n > this.limit) throw new Error(`сообщение ${n} Б больше предела реле ${this.limit} Б`);
    from.stats.msgsOut++; from.stats.bytesOut += n; from.stats.maxMsg = Math.max(from.stats.maxMsg, n);
    this.totalBytes += n; this.totalMsgs++;
    const copy = JSON.parse(JSON.stringify(d)) as Wire;
    for (const e of this.endpoints) {
      if (e === from) continue;
      this.queue.push({ at: this.now + this.latency, to: e, from: from.name, d: copy });
    }
    this.deliver();
  }
  /** Продвигает время и доставляет сообщения, чьё время пришло. */
  advance(dt: number): void { this.now += dt; this.deliver(); }
  private deliver(): void {
    const due = this.queue.filter((q) => q.at <= this.now + 1e-9);
    this.queue = this.queue.filter((q) => q.at > this.now + 1e-9);
    for (const q of due) if (this.endpoints.includes(q.to)) q.to.onMessage(q.from, q.d);
  }
}

export class LoopbackEndpoint implements Transport {
  onMessage: (from: string, d: Wire) => void = () => {};
  onMembers: () => void = () => {};
  onReady: () => void = () => {};
  stats = { msgsOut: 0, bytesOut: 0, maxMsg: 0 };
  constructor(private hub: LoopbackHub, readonly name: string) {}
  get owner(): string { return this.hub.owner; }
  get members(): string[] { return this.hub.members; }
  send(d: Wire): void { this.hub.relay(this, d); }
  close(): void { this.hub.remove(this); }
}
