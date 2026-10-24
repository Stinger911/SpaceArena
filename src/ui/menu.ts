import type { InputManager } from '../input';
import { saveSettings } from '../input/settings';
import type { Mode } from '../game/types';
import { MAX_LEVEL, Profile, UPGRADE_IDS, UpgradeId, buyUpgrade, saveProfile, upgradeCost } from '../meta/upgrades';
import type { Synth } from '../audio/synth';
import { Key, getLang, setLang, t } from './i18n';

export interface StartConfig {
  mode: Mode;
  bots: number;
  difficulty: number;
}

export interface OverInfo {
  win: boolean;
  mode: Mode;
  kills: number;
  wave: number;
  earned: number;
}

export interface NetInfo {
  host: boolean;
  members: string[];
  owner: string;
  /** сообщение вместо формы (ошибка, ожидание) */
  message: string;
  starting: boolean;
}

export interface MenuHooks {
  onStart(cfg: StartConfig): void;
  onResume(): void;
  onQuit(): void;
}

const DIFFS: { key: Key; v: number }[] = [
  { key: 'easy', v: 0.2 }, { key: 'normal', v: 0.5 }, { key: 'hard', v: 0.85 },
];

const MODES: { mode: Mode; name: Key; desc: Key }[] = [
  { mode: 'deathmatch', name: 'deathmatch', desc: 'deathmatchD' },
  { mode: 'team', name: 'team', desc: 'teamD' },
  { mode: 'waves', name: 'waves', desc: 'wavesD' },
];

const UP_NAMES: Record<UpgradeId, [Key, Key]> = {
  hull: ['hullU', 'hullD'], laser: ['laserU', 'laserD'], energy: ['energyU', 'energyD'],
  engine: ['engineU', 'engineD'], missiles: ['missilesU', 'missilesD'], agility: ['agilityU', 'agilityD'],
};

export class Menu {
  cfg: StartConfig = { mode: 'deathmatch', bots: 5, difficulty: 0.5 };
  private el: HTMLElement;
  private screen: 'main' | 'hangar' | 'settings' | 'pause' | 'over' | 'net' | 'none' = 'none';
  netMode = false;
  private net: NetInfo = { host: false, members: [], owner: '', message: '', starting: false };
  private over: OverInfo | null = null;
  private note = '';

  constructor(parent: HTMLElement, private profile: Profile, private input: InputManager, private synth: Synth, private hooks: MenuHooks) {
    this.el = document.createElement('div');
    this.el.className = 'menu hidden';
    parent.appendChild(this.el);
    this.el.addEventListener('click', (e) => this.onClick(e));
    this.el.addEventListener('input', (e) => this.onInput(e));
  }

  get visible(): boolean { return this.screen !== 'none'; }
  get current(): string { return this.screen; }

  hide(): void { this.screen = 'none'; this.el.classList.add('hidden'); }

  show(screen: 'main' | 'hangar' | 'settings' | 'pause' | 'over' | 'net', over?: OverInfo): void {
    this.screen = screen;
    if (over) this.over = over;
    this.el.classList.remove('hidden');
    this.render();
  }

  private render(): void {
    switch (this.screen) {
      case 'main': this.el.innerHTML = this.mainHtml(); break;
      case 'hangar': this.el.innerHTML = this.hangarHtml(); break;
      case 'settings': this.el.innerHTML = this.settingsHtml(); break;
      case 'pause': this.el.innerHTML = this.pauseHtml(); break;
      case 'over': this.el.innerHTML = this.overHtml(); break;
      case 'net': this.el.innerHTML = this.netHtml(); break;
      default: this.el.innerHTML = '';
    }
  }

  /** Обновить экран ожидания сети. */
  setNet(info: Partial<NetInfo>): void {
    this.net = { ...this.net, ...info };
    if (this.screen === 'net') this.render();
  }

  private configHtml(): string {
    const c = this.cfg;
    const modes = MODES.map((m) =>
      `<button data-act="mode" data-v="${m.mode}" class="${c.mode === m.mode ? 'sel' : ''}">${t(m.name)}</button>`).join('');
    const desc = MODES.find((m) => m.mode === c.mode)!;
    const diffs = DIFFS.map((d) =>
      `<button data-act="diff" data-v="${d.v}" class="${Math.abs(c.difficulty - d.v) < 0.01 ? 'sel' : ''}">${t(d.key)}</button>`).join('');
    const botsRow = c.mode === 'waves' ? '' : `
      <div class="stat"><span>${t('botsLabel')}</span>
        <span class="row"><button data-act="bots" data-v="-1">−</button><span>${c.bots}</span><button data-act="bots" data-v="1">+</button></span></div>`;
    return `
      <h2>${t('modeTitle')}</h2>
      <div class="row">${modes}</div>
      <p>${t(desc.desc)}</p>
      ${botsRow}
      <div class="stat"><span>${t('diffLabel')}</span><span class="row">${diffs}</span></div>`;
  }

  private netHtml(): string {
    const n = this.net;
    const esc = (x: string): string => x.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
    const list = n.members.map((m) => `<div>${m === n.owner ? '👑 ' : '👤 '}${esc(m)}${m === n.owner ? ` (${t('netHost')})` : ''}</div>`).join('');
    let body = '';
    if (n.message) body = `<p>${n.message}</p>`;
    else if (n.host) body = `${this.configHtml()}<button data-act="start" ${n.starting ? 'disabled' : ''}>${n.starting ? t('netStarting') : t('start')}</button>`;
    else body = `<p>${t('netWaitHost')}</p>`;
    return `<h1>${t('title')}</h1><h2>${t('netTitle')}</h2>
      ${n.members.length ? `<h2>${t('netPlayers')}</h2><div>${list}</div>` : ''}
      ${body}
      <button data-act="quit">${t('toLobby')}</button>`;
  }

  private mainHtml(): string {
    return `
      <h1>${t('title')}</h1>
      <p>${t('subtitle')}</p>
      ${this.configHtml()}
      <button data-act="start">${t('start')}</button>
      <div class="row"><button data-act="hangar">${t('hangar')} (${this.profile.credits})</button><button data-act="settings">${t('settings')}</button></div>
      <p>${t('help')}</p><p>${t('helpTouch')}</p>
      ${this.profile.bestWave ? `<p>${t('bestWave')}: ${this.profile.bestWave}</p>` : ''}`;
  }

  private hangarHtml(): string {
    const rows = UPGRADE_IDS.map((id) => {
      const lvl = this.profile.upgrades[id];
      const [n, d] = UP_NAMES[id];
      const pips = '■'.repeat(lvl) + '□'.repeat(MAX_LEVEL - lvl);
      const cost = upgradeCost(lvl);
      const btn = lvl >= MAX_LEVEL
        ? `<button disabled>${t('max')}</button>`
        : `<button data-act="buy" data-v="${id}" ${this.profile.credits < cost ? 'disabled' : ''}>${cost}</button>`;
      return `<div class="stat"><span style="text-align:left"><b>${t(n)}</b> ${pips}<br><small>${t(d)}</small></span>${btn}</div>`;
    }).join('');
    return `<h1>${t('hangar')}</h1><h2>${t('credits')}: ${this.profile.credits}</h2>${rows}<button data-act="back">${t('back')}</button>`;
  }

  private onOff(v: boolean): string { return v ? t('on') : t('off'); }

  private settingsHtml(): string {
    const s = this.input.settings;
    const touch = s.touch === 'auto' ? t('auto') : this.onOff(s.touch === 'on');
    return `
      <h1>${t('settings')}</h1>
      <button data-act="set-invert">${t('invert')}: ${this.onOff(s.invertY)}</button>
      <button data-act="set-gyro">${t('gyro')}: ${this.onOff(s.gyro)}</button>
      <button data-act="set-touch">${t('touchUi')}: ${touch}</button>
      <button data-act="set-sound">${t('sound')}: ${this.onOff(s.sound)}</button>
      <div class="stat"><span>${t('sens')}</span><input type="range" min="0.5" max="2" step="0.1" value="${s.sensitivity}" data-input="sens"></div>
      <button data-act="set-lang">${t('lang')}: ${getLang() === 'ru' ? 'Русский' : 'English'}</button>
      ${this.note ? `<p>${this.note}</p>` : ''}
      <button data-act="back">${t('back')}</button>`;
  }

  private pauseHtml(): string {
    return `<h1>${t('pause')}</h1>
      <button data-act="resume">${t('resume')}</button>
      <button data-act="settings">${t('settings')}</button>
      <button data-act="quit">${t('quit')}</button>`;
  }

  private overHtml(): string {
    const o = this.over;
    if (!o) return '';
    const title = o.mode === 'waves' ? t('gameOver') : o.win ? t('victory') : t('defeat');
    const extra = o.mode === 'waves' ? `<p>${t('reachedWave')}: ${o.wave}</p>` : '';
    return `<h1>${title}</h1>${extra}<p>${t('kills')}: ${o.kills}</p><p>${t('earned')}: ${o.earned}</p>
      ${this.netMode ? '' : `<button data-act="again">${t('playAgain')}</button>`}
      <button data-act="hangar">${t('hangar')} (${this.profile.credits})</button>
      <button data-act="quit">${this.netMode ? t('toLobby') : t('quit')}</button>`;
  }

  private onInput(e: Event): void {
    const target = e.target as HTMLInputElement;
    if (target.dataset.input === 'sens') {
      this.input.settings.sensitivity = Number(target.value);
      saveSettings(this.input.settings);
    }
  }

  private async onClick(e: MouseEvent): Promise<void> {
    const btn = (e.target as HTMLElement).closest('button');
    if (!btn || btn.disabled) return;
    const act = btn.dataset.act;
    const v = btn.dataset.v ?? '';
    this.synth.unlock();
    this.synth.click();
    const s = this.input.settings;
    switch (act) {
      case 'mode': this.cfg.mode = v as Mode; this.render(); break;
      case 'diff': this.cfg.difficulty = Number(v); this.render(); break;
      case 'bots': this.cfg.bots = Math.max(2, Math.min(9, this.cfg.bots + Number(v))); this.render(); break;
      case 'start': case 'again': this.hooks.onStart(this.cfg); break;
      case 'hangar': this.show('hangar'); break;
      case 'settings': this.settingsFrom = this.screen === 'pause' ? 'pause' : 'main'; this.note = ''; this.show('settings'); break;
      case 'back': this.show(this.screen === 'settings' ? this.settingsFrom : this.netMode ? 'over' : 'main'); break;
      case 'buy':
        if (buyUpgrade(this.profile, v as UpgradeId)) saveProfile(this.profile);
        this.render();
        break;
      case 'resume': this.hooks.onResume(); break;
      case 'quit': this.hooks.onQuit(); break;
      case 'set-invert': s.invertY = !s.invertY; saveSettings(s); this.render(); break;
      case 'set-gyro': {
        const ok = await this.input.setGyro(!s.gyro);
        this.note = !s.gyro && !ok ? t('gyroFail') : '';
        saveSettings(s);
        this.render();
        break;
      }
      case 'set-touch': s.touch = s.touch === 'auto' ? 'on' : s.touch === 'on' ? 'off' : 'auto'; saveSettings(s); this.render(); break;
      case 'set-sound': s.sound = !s.sound; this.synth.setEnabled(s.sound); saveSettings(s); this.render(); break;
      case 'set-lang': setLang(getLang() === 'ru' ? 'en' : 'ru'); this.render(); break;
      default: break;
    }
  }

  private settingsFrom: 'main' | 'pause' = 'main';
}
