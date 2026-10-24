export interface Settings {
  /** Инверсия вертикальной оси (стик, мышь, гироскоп) */
  invertY: boolean;
  gyro: boolean;
  /** Показывать сенсорные кнопки: auto — только на устройствах с тачскрином */
  touch: 'auto' | 'on' | 'off';
  sound: boolean;
  /** Множитель чувствительности 0.5..2 */
  sensitivity: number;
}

const KEY = 'void-arena-settings-v1';

export const defaultSettings = (): Settings => ({ invertY: false, gyro: false, touch: 'auto', sound: true, sensitivity: 1 });

export function loadSettings(): Settings {
  const d = defaultSettings();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return d;
    const p = JSON.parse(raw) as Partial<Settings>;
    return {
      invertY: typeof p.invertY === 'boolean' ? p.invertY : d.invertY,
      gyro: false, // гироскоп всегда включается вручную: на iOS нужно разрешение по жесту пользователя
      touch: p.touch === 'on' || p.touch === 'off' ? p.touch : 'auto',
      sound: typeof p.sound === 'boolean' ? p.sound : d.sound,
      sensitivity: Math.min(2, Math.max(0.5, Number(p.sensitivity) || 1)),
    };
  } catch {
    return d;
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ничего: настройки просто не сохранятся */
  }
}
