// Сенсорное управление: плавающий стик слева, кнопки и ползунок тяги справа.

export interface TouchState {
  stickX: number;
  stickY: number;
  /** null — ползунок не трогают */
  throttle: number | null;
  fire: boolean;
  missile: boolean;
}

export interface TouchHooks {
  onView(): void;
  onPause(): void;
  onRecenter(): void;
}

const STICK_R = 62;

function el(tag: string, css: string, text = ''): HTMLElement {
  const e = document.createElement(tag);
  e.style.cssText = css;
  if (text) e.textContent = text;
  return e;
}

const BTN = 'position:absolute;display:flex;align-items:center;justify-content:center;border-radius:50%;' +
  'border:2px solid rgba(127,255,212,.7);background:rgba(2,26,26,.45);color:#7fffd4;font:bold 13px "Courier New",monospace;' +
  'letter-spacing:.06em;touch-action:none;user-select:none;-webkit-user-select:none;';

export class TouchControls {
  readonly state: TouchState = { stickX: 0, stickY: 0, throttle: null, fire: false, missile: false };
  private root: HTMLElement;
  private stickPointer = -1;
  private origin = { x: 0, y: 0 };
  private base: HTMLElement;
  private knob: HTMLElement;
  private thumb: HTMLElement;
  private slider: HTMLElement;
  private shownThrottle = 0.6;

  constructor(parent: HTMLElement, private hooks: TouchHooks) {
    this.root = el('div', 'position:fixed;inset:0;pointer-events:none;display:none;z-index:5;');
    parent.appendChild(this.root);
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());

    // зона стика (левая половина экрана)
    const zone = el('div', 'position:absolute;left:0;top:0;width:52%;height:100%;pointer-events:auto;touch-action:none;');
    this.root.appendChild(zone);
    this.base = el('div', 'position:absolute;width:124px;height:124px;border-radius:50%;border:2px solid rgba(127,255,212,.5);background:rgba(2,26,26,.25);display:none;transform:translate(-50%,-50%);');
    this.knob = el('div', 'position:absolute;width:56px;height:56px;border-radius:50%;background:rgba(127,255,212,.45);border:2px solid #7fffd4;display:none;transform:translate(-50%,-50%);');
    this.root.append(this.base, this.knob);
    zone.addEventListener('pointerdown', (e) => this.stickDown(e, zone));
    zone.addEventListener('pointermove', (e) => this.stickMove(e));
    zone.addEventListener('pointerup', (e) => this.stickUp(e));
    zone.addEventListener('pointercancel', (e) => this.stickUp(e));

    // огонь
    const fire = el('div', BTN + 'right:22px;bottom:26px;width:104px;height:104px;font-size:15px;pointer-events:auto;', 'ОГОНЬ');
    this.hold(fire, (v) => { this.state.fire = v; });
    // ракета
    const missile = el('div', BTN + 'right:138px;bottom:34px;width:76px;height:76px;pointer-events:auto;', 'РАКЕТА');
    this.hold(missile, (v) => { this.state.missile = v; });
    // тяга
    this.slider = el('div', 'position:absolute;right:30px;top:18%;height:34%;width:46px;border:2px solid rgba(127,255,212,.6);border-radius:23px;background:rgba(2,26,26,.35);pointer-events:auto;touch-action:none;');
    this.thumb = el('div', 'position:absolute;left:3px;right:3px;height:34px;border-radius:17px;background:rgba(127,255,212,.55);');
    this.slider.appendChild(this.thumb);
    this.slider.addEventListener('pointerdown', (e) => { this.slider.setPointerCapture(e.pointerId); this.setThrottle(e); });
    this.slider.addEventListener('pointermove', (e) => { if (this.slider.hasPointerCapture(e.pointerId)) this.setThrottle(e); });
    const release = (e: PointerEvent): void => { if (this.slider.hasPointerCapture(e.pointerId)) this.slider.releasePointerCapture(e.pointerId); this.state.throttle = null; };
    this.slider.addEventListener('pointerup', release);
    this.slider.addEventListener('pointercancel', release);
    // служебные кнопки
    const pause = el('div', BTN + 'right:14px;top:10px;width:44px;height:44px;pointer-events:auto;', 'II');
    pause.addEventListener('pointerdown', (e) => { e.preventDefault(); this.hooks.onPause(); });
    const view = el('div', BTN + 'right:68px;top:10px;width:44px;height:44px;pointer-events:auto;font-size:11px;', 'ВИД');
    view.addEventListener('pointerdown', (e) => { e.preventDefault(); this.hooks.onView(); });
    const recenter = el('div', BTN + 'right:122px;top:10px;width:44px;height:44px;pointer-events:auto;font-size:10px;', 'ЦЕНТР');
    recenter.addEventListener('pointerdown', (e) => { e.preventDefault(); this.hooks.onRecenter(); });
    this.root.append(fire, missile, this.slider, pause, view, recenter);
    this.drawThrottle(this.shownThrottle);
  }

  private hold(node: HTMLElement, set: (v: boolean) => void): void {
    node.addEventListener('pointerdown', (e) => { e.preventDefault(); node.setPointerCapture(e.pointerId); set(true); node.style.background = 'rgba(127,255,212,.4)'; });
    const up = (e: PointerEvent): void => { if (node.hasPointerCapture(e.pointerId)) node.releasePointerCapture(e.pointerId); set(false); node.style.background = 'rgba(2,26,26,.45)'; };
    node.addEventListener('pointerup', up);
    node.addEventListener('pointercancel', up);
  }

  private setThrottle(e: PointerEvent): void {
    const r = this.slider.getBoundingClientRect();
    const v = 1 - Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    this.state.throttle = v;
    this.drawThrottle(v);
  }

  /** Обновить положение ползунка (когда тягу меняют другим способом). */
  drawThrottle(v: number): void {
    this.shownThrottle = v;
    this.thumb.style.top = `calc(${(1 - v) * 100}% - ${(1 - v) * 34}px)`;
  }

  private stickDown(e: PointerEvent, zone: HTMLElement): void {
    if (this.stickPointer !== -1) return;
    e.preventDefault();
    zone.setPointerCapture(e.pointerId);
    this.stickPointer = e.pointerId;
    this.origin = { x: e.clientX, y: e.clientY };
    for (const n of [this.base, this.knob]) { n.style.display = 'block'; n.style.left = `${e.clientX}px`; n.style.top = `${e.clientY}px`; }
    this.state.stickX = 0;
    this.state.stickY = 0;
  }

  private stickMove(e: PointerEvent): void {
    if (e.pointerId !== this.stickPointer) return;
    let dx = e.clientX - this.origin.x;
    let dy = e.clientY - this.origin.y;
    const len = Math.hypot(dx, dy);
    if (len > STICK_R) { dx = (dx / len) * STICK_R; dy = (dy / len) * STICK_R; }
    this.knob.style.left = `${this.origin.x + dx}px`;
    this.knob.style.top = `${this.origin.y + dy}px`;
    const dead = 0.08;
    const nx = dx / STICK_R, ny = dy / STICK_R;
    this.state.stickX = Math.abs(nx) < dead ? 0 : nx;
    // экранная ось Y направлена вниз: вверх по стику — положительное значение
    this.state.stickY = Math.abs(ny) < dead ? 0 : -ny;
  }

  private stickUp(e: PointerEvent): void {
    if (e.pointerId !== this.stickPointer) return;
    this.stickPointer = -1;
    this.base.style.display = 'none';
    this.knob.style.display = 'none';
    this.state.stickX = 0;
    this.state.stickY = 0;
  }

  setVisible(v: boolean): void {
    this.root.style.display = v ? 'block' : 'none';
    if (!v) {
      this.state.fire = false;
      this.state.missile = false;
      this.state.stickX = 0;
      this.state.stickY = 0;
      this.state.throttle = null;
      this.stickPointer = -1;
      this.base.style.display = 'none';
      this.knob.style.display = 'none';
    }
  }
}
