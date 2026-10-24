import { clamp } from '../engine/math';
import type { ShipInput } from '../game/types';
import { Settings, saveSettings } from './settings';
import { TouchControls } from './touch';

export interface InputHooks {
  onPause(): void;
}

const GAME_KEYS = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'KeyR', 'KeyF', 'Space', 'KeyM', 'Enter',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'KeyV', 'KeyB',
]);

const dz = (v: number, d = 0.12): number => (Math.abs(v) < d ? 0 : (v - Math.sign(v) * d) / (1 - d));

type OrientationEventCtor = typeof DeviceOrientationEvent & { requestPermission?: () => Promise<string> };

/** Собирает команды с клавиатуры, мыши, сенсора, геймпада и гироскопа. */
export class InputManager {
  readonly touch: TouchControls;
  throttle = 0.6;
  scoreboard = false;
  /** принимает ли игра ввод (false в меню) */
  active = false;
  readonly touchCapable: boolean;

  private keys = new Set<string>();
  private mdx = 0;
  private mdy = 0;
  private mFire = false;
  private mMissile = false;
  private viewEdge = false;
  private padPrev: boolean[] = [];
  private gyroOn = false;
  private g0 = { r: 0, u: 0 };
  private g = { r: 0, u: 0, have: false };

  constructor(private canvas: HTMLCanvasElement, ui: HTMLElement, public settings: Settings, private hooks: InputHooks) {
    this.touchCapable = (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches) || navigator.maxTouchPoints > 0;
    this.touch = new TouchControls(ui, {
      onView: () => { this.viewEdge = true; },
      onPause: () => this.hooks.onPause(),
      onRecenter: () => this.recenterGyro(),
    });

    window.addEventListener('keydown', (e) => this.onKey(e, true));
    window.addEventListener('keyup', (e) => this.onKey(e, false));
    window.addEventListener('blur', () => { this.keys.clear(); this.mFire = false; this.mMissile = false; });

    canvas.addEventListener('pointerdown', (e) => {
      if (!this.active || e.pointerType !== 'mouse') return;
      if (document.pointerLockElement !== canvas) { void canvas.requestPointerLock?.(); return; }
      if (e.button === 0) this.mFire = true;
      if (e.button === 2) this.mMissile = true;
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mFire = false;
      if (e.button === 2) this.mMissile = false;
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement !== canvas) return;
      this.mdx += e.movementX;
      this.mdy += e.movementY;
    });
    document.addEventListener('pointerlockchange', () => {
      if (document.pointerLockElement !== canvas && this.active) this.hooks.onPause();
      if (document.pointerLockElement !== canvas) { this.mFire = false; this.mMissile = false; }
    });
    window.addEventListener('wheel', (e) => {
      if (!this.active) return;
      this.setThrottle(this.throttle - Math.sign(e.deltaY) * 0.05);
    }, { passive: true });
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    if (down) this.keys.add(e.code); else this.keys.delete(e.code);
    if (this.active && GAME_KEYS.has(e.code)) e.preventDefault();
    if (e.code === 'Tab') this.scoreboard = down && this.active;
    if (!down) return;
    if (e.repeat) return;
    if (!this.active) return;
    if (e.code === 'KeyV') this.viewEdge = true;
    if (e.code === 'KeyP' || e.code === 'Escape') this.hooks.onPause();
    if (e.code === 'KeyI') { this.settings.invertY = !this.settings.invertY; saveSettings(this.settings); }
    if (e.code === 'KeyG') this.recenterGyro();
  }

  setThrottle(v: number): void {
    this.throttle = clamp(v, 0, 1);
    this.touch.drawThrottle(this.throttle);
  }

  /** Показывать ли сенсорные кнопки при текущих настройках. */
  touchWanted(): boolean {
    return this.settings.touch === 'on' || (this.settings.touch === 'auto' && this.touchCapable);
  }

  setActive(v: boolean): void {
    this.active = v;
    this.touch.setVisible(v && this.touchWanted());
    if (!v) {
      this.keys.clear();
      this.mFire = false;
      this.mMissile = false;
      this.scoreboard = false;
      if (document.pointerLockElement === this.canvas) document.exitPointerLock();
    }
  }

  consumeView(): boolean { const v = this.viewEdge; this.viewEdge = false; return v; }

  // ---------- гироскоп ----------

  async setGyro(on: boolean): Promise<boolean> {
    if (!on) {
      this.gyroOn = false;
      this.settings.gyro = false;
      window.removeEventListener('deviceorientation', this.onOrient);
      return false;
    }
    if (typeof DeviceOrientationEvent === 'undefined') return false;
    const ctor = DeviceOrientationEvent as OrientationEventCtor;
    try {
      if (typeof ctor.requestPermission === 'function') {
        const r = await ctor.requestPermission();
        if (r !== 'granted') return false;
      }
    } catch {
      return false;
    }
    this.g.have = false;
    window.addEventListener('deviceorientation', this.onOrient);
    this.gyroOn = true;
    this.settings.gyro = true;
    return true;
  }

  recenterGyro(): void {
    if (this.g.have) this.g0 = { r: this.g.r, u: this.g.u };
  }

  private onOrient = (e: DeviceOrientationEvent): void => {
    if (e.beta === null || e.gamma === null) return;
    const b = (e.beta * Math.PI) / 180;
    const c = (e.gamma * Math.PI) / 180;
    // вектор силы тяжести в системе координат устройства
    const gx = Math.cos(b) * Math.sin(c);
    const gy = -Math.sin(b);
    const raw = screen.orientation?.angle ?? (window as unknown as { orientation?: number }).orientation ?? 0;
    const angle = (((Math.round(raw / 90) * 90) % 360) + 360) % 360;
    let r: number, u: number;
    if (angle === 90) { r = -gy; u = gx; }
    else if (angle === 180) { r = -gx; u = -gy; }
    else if (angle === 270) { r = gy; u = -gx; }
    else { r = gx; u = gy; }
    this.g.r = r;
    this.g.u = u;
    if (!this.g.have) { this.g.have = true; this.g0 = { r, u }; }
  };

  // ---------- опрос ----------

  poll(dt: number): ShipInput {
    const s = this.settings;
    const k = this.keys;
    const sens = s.sensitivity;
    const inv = s.invertY ? -1 : 1;

    let pitch = ((k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0)) * inv;
    let yaw = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    let roll = (k.has('KeyE') ? 1 : 0) - (k.has('KeyQ') ? 1 : 0);
    let fire = k.has('Space') || this.mFire;
    let missile = k.has('KeyM') || k.has('Enter') || k.has('KeyB') || this.mMissile;
    let thr = this.throttle;
    if (k.has('KeyR')) thr += 0.6 * dt;
    if (k.has('KeyF')) thr -= 0.6 * dt;

    // мышь
    yaw += clamp(this.mdx * 0.05 * sens, -1, 1);
    pitch += clamp(-this.mdy * 0.05 * sens, -1, 1) * inv;
    this.mdx = 0;
    this.mdy = 0;

    // сенсорный стик
    const t = this.touch.state;
    yaw += t.stickX * sens;
    pitch += t.stickY * inv * sens;
    fire = fire || t.fire;
    missile = missile || t.missile;
    if (t.throttle !== null) thr = t.throttle;

    // геймпад
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const pad = Array.from(pads).find((p): p is Gamepad => !!p && p.connected);
    if (pad) {
      const ax = (i: number): number => dz(pad.axes[i] ?? 0);
      const btn = (i: number): boolean => !!pad.buttons[i]?.pressed;
      yaw += ax(0) * sens;
      pitch += -ax(1) * inv * sens;
      roll += ax(2);
      thr += -ax(3) * 0.8 * dt;
      if (btn(12)) thr += 0.6 * dt;
      if (btn(13)) thr -= 0.6 * dt;
      fire = fire || btn(7) || btn(0);
      missile = missile || btn(5) || btn(1) || btn(2) || btn(6);
      const edge = (i: number): boolean => btn(i) && !this.padPrev[i];
      if (edge(3)) this.viewEdge = true;
      if (edge(9) && this.active) this.hooks.onPause();
      if (edge(8)) this.recenterGyro();
      this.padPrev = pad.buttons.map((b) => b.pressed);
    } else {
      this.padPrev = [];
    }

    // гироскоп
    if (this.gyroOn && this.g.have) {
      const gain = 1 / 0.38;
      yaw += dz((this.g.r - this.g0.r) * gain, 0.06) * sens;
      pitch += dz((this.g.u - this.g0.u) * gain, 0.06) * inv * sens;
    }

    this.setThrottle(thr);
    yaw = clamp(yaw, -1, 1);
    pitch = clamp(pitch, -1, 1);
    // автокрен при повороте — для красоты и ощущения скорости
    roll = clamp(roll + yaw * 0.5, -1, 1);
    return { pitch, yaw, roll, throttle: this.throttle, fire, missile };
  }
}
