// Все звуки синтезируются на лету через Web Audio: никаких аудиофайлов.

export class Synth {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private engineOsc: OscillatorNode | null = null;
  private engineGain: GainNode | null = null;
  private voices = 0;
  enabled = true;

  /** Нужно вызывать из обработчика пользовательского жеста (требование браузеров). */
  unlock(): void {
    if (!this.enabled) return;
    if (!this.ctx) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(this.ctx.destination);
      const len = this.ctx.sampleRate;
      this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.startEngine();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (this.master) this.master.gain.value = on ? 0.5 : 0;
    if (on) this.unlock();
  }

  private startEngine(): void {
    if (!this.ctx || !this.master) return;
    const osc = this.ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = 55;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 240;
    const g = this.ctx.createGain();
    g.gain.value = 0;
    osc.connect(lp).connect(g).connect(this.master);
    osc.start();
    this.engineOsc = osc;
    this.engineGain = g;
  }

  /** Гул двигателя игрока. speed01 — доля от максимальной скорости. */
  engine(speed01: number, alive: boolean): void {
    if (!this.ctx || !this.engineOsc || !this.engineGain) return;
    const t = this.ctx.currentTime;
    this.engineOsc.frequency.setTargetAtTime(48 + speed01 * 55, t, 0.1);
    this.engineGain.gain.setTargetAtTime(alive ? 0.035 + speed01 * 0.03 : 0, t, 0.15);
  }

  private ok(): boolean {
    return !!this.ctx && !!this.master && this.enabled && this.ctx.state === 'running' && this.voices < 28;
  }

  private tone(type: OscillatorType, f0: number, f1: number, dur: number, vol: number, delay = 0): void {
    if (!this.ok() || vol <= 0.003) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master!);
    this.voices++;
    o.onended = () => { this.voices--; };
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  private noise(dur: number, vol: number, f0: number, f1: number, delay = 0): void {
    if (!this.ok() || vol <= 0.003) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(40, f1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.master!);
    this.voices++;
    src.onended = () => { this.voices--; };
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  laser(vol = 1, own = true): void {
    this.tone('square', own ? 1500 : 1100, own ? 260 : 200, 0.13, 0.07 * vol);
  }
  missile(vol = 1): void {
    this.noise(0.5, 0.12 * vol, 3000, 400);
    this.tone('sawtooth', 220, 90, 0.4, 0.05 * vol);
  }
  explosion(size: number, vol = 1): void {
    const k = Math.min(1.4, size / 60);
    this.noise(0.5 + 0.5 * k, 0.32 * vol, 1800, 60);
    this.tone('sine', 120, 28, 0.6 + 0.3 * k, 0.28 * vol);
  }
  hit(onPlayer: boolean, vol = 1): void {
    if (onPlayer) { this.tone('sawtooth', 180, 70, 0.18, 0.2); this.noise(0.12, 0.12, 2200, 300); }
    else this.tone('triangle', 900, 500, 0.06, 0.06 * vol);
  }
  spark(vol = 1): void { this.noise(0.08, 0.05 * vol, 5000, 1500); }
  lock(): void { this.tone('square', 1200, 1200, 0.06, 0.05); this.tone('square', 1600, 1600, 0.06, 0.05, 0.09); }
  warn(): void { this.tone('square', 520, 520, 0.12, 0.05); }
  respawn(): void { this.tone('sine', 300, 900, 0.35, 0.1); }
  wave(): void { [440, 554, 659].forEach((f, i) => this.tone('triangle', f, f, 0.2, 0.09, i * 0.12)); }
  win(): void { [523, 659, 784, 1047].forEach((f, i) => this.tone('triangle', f, f, 0.3, 0.1, i * 0.14)); }
  lose(): void { [392, 330, 262, 196].forEach((f, i) => this.tone('sawtooth', f, f * 0.98, 0.35, 0.07, i * 0.2)); }
  click(): void { this.tone('square', 800, 600, 0.04, 0.04); }
}
