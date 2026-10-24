export type Lang = 'ru' | 'en';

const DICT = {
  ru: {
    lock: 'ЗАХВАТ', hull: 'КОРПУС', energy: 'ЭНЕРГИЯ', speed: 'СКОРОСТЬ', missiles: 'РАКЕТЫ', gyroOn: 'ГИРОСКОП ВКЛ',
    kills: 'Убийства', deaths: 'Смерти', leader: 'Лидер', teamBlue: 'СИНИЕ', teamRed: 'КРАСНЫЕ', to: 'до',
    wave: 'ВОЛНА', enemies: 'Враги', lives: 'Жизни', destroyed: 'ВЫ УНИЧТОЖЕНЫ', respawnIn: 'Возрождение через',
    leaving: 'ПОКИДАЕТЕ АРЕНУ — РАЗВЕРНИТЕСЬ!', missileReady: 'ЦЕЛЬ В ЗАХВАТЕ — РАКЕТА ГОТОВА', pilot: 'Пилот',
    pause: 'ПАУЗА',
    title: 'SPACE ARENA', subtitle: 'Космический бой на векторной арене',
    modeTitle: 'Режим боя', deathmatch: 'Дезматч', deathmatchD: 'Каждый сам за себя, до 12 убийств',
    team: 'Командный бой', teamD: 'Две команды с базами, до 20 убийств', waves: 'Волны ботов', wavesD: 'Выживайте против нарастающих волн, 3 жизни',
    botsLabel: 'Соперников', diffLabel: 'Сложность', easy: 'Лёгкая', normal: 'Нормальная', hard: 'Тяжёлая',
    start: 'В БОЙ', hangar: 'АНГАР', settings: 'НАСТРОЙКИ', back: 'НАЗАД', resume: 'ПРОДОЛЖИТЬ', quit: 'В МЕНЮ',
    credits: 'Кредиты', upgrade: 'Улучшить', max: 'МАКС', level: 'ур.',
    hullU: 'Корпус', laserU: 'Лазеры', energyU: 'Энергия', engineU: 'Двигатель', missilesU: 'Ракеты', agilityU: 'Маневренность',
    hullD: '+25 прочности', laserD: '+2 урона', energyD: '+5 восстановления', engineD: '+22 к скорости', missilesD: '+1 ракета', agilityD: '+9% поворот',
    invert: 'Инверсия вертикали', gyro: 'Гироскоп', touchUi: 'Сенсорные кнопки', sound: 'Звук', sens: 'Чувствительность', lang: 'Язык',
    on: 'вкл', off: 'выкл', auto: 'авто', gyroFail: 'Гироскоп недоступен или доступ не разрешён',
    victory: 'ПОБЕДА', defeat: 'ПОРАЖЕНИЕ', gameOver: 'КОНЕЦ ИГРЫ', earned: 'Заработано кредитов', reachedWave: 'Достигнута волна',
    bestWave: 'Рекорд волн', playAgain: 'ЕЩЁ РАЗ',
    help: 'Клавиши: WASD/стрелки — курс, Q/E — крен, R/F — тяга, Пробел — огонь, M — ракета (нужен захват), V — вид, Tab — таблица, P — пауза. Клик по игре включает мышь.',
    helpTouch: 'Касание слева — стик, справа — кнопки огня и ракет, ползунок — тяга.',
  },
  en: {
    lock: 'LOCK', hull: 'HULL', energy: 'ENERGY', speed: 'SPEED', missiles: 'MISSILES', gyroOn: 'GYRO ON',
    kills: 'Kills', deaths: 'Deaths', leader: 'Leader', teamBlue: 'BLUE', teamRed: 'RED', to: 'to',
    wave: 'WAVE', enemies: 'Enemies', lives: 'Lives', destroyed: 'YOU WERE DESTROYED', respawnIn: 'Respawn in',
    leaving: 'LEAVING THE ARENA — TURN BACK!', missileReady: 'TARGET LOCKED — MISSILE READY', pilot: 'Pilot',
    pause: 'PAUSE',
    title: 'SPACE ARENA', subtitle: 'Vector-arena space combat',
    modeTitle: 'Battle mode', deathmatch: 'Deathmatch', deathmatchD: 'Free for all, first to 12 kills',
    team: 'Team battle', teamD: 'Two teams with bases, first to 20 kills', waves: 'Bot waves', wavesD: 'Survive escalating waves, 3 lives',
    botsLabel: 'Opponents', diffLabel: 'Difficulty', easy: 'Easy', normal: 'Normal', hard: 'Hard',
    start: 'LAUNCH', hangar: 'HANGAR', settings: 'SETTINGS', back: 'BACK', resume: 'RESUME', quit: 'TO MENU',
    credits: 'Credits', upgrade: 'Upgrade', max: 'MAX', level: 'lv.',
    hullU: 'Hull', laserU: 'Lasers', energyU: 'Energy', engineU: 'Engine', missilesU: 'Missiles', agilityU: 'Agility',
    hullD: '+25 durability', laserD: '+2 damage', energyD: '+5 recharge', engineD: '+22 top speed', missilesD: '+1 missile', agilityD: '+9% turn rate',
    invert: 'Invert vertical', gyro: 'Gyroscope', touchUi: 'Touch buttons', sound: 'Sound', sens: 'Sensitivity', lang: 'Language',
    on: 'on', off: 'off', auto: 'auto', gyroFail: 'Gyroscope unavailable or permission denied',
    victory: 'VICTORY', defeat: 'DEFEAT', gameOver: 'GAME OVER', earned: 'Credits earned', reachedWave: 'Wave reached',
    bestWave: 'Best wave', playAgain: 'AGAIN',
    help: 'Keys: WASD/arrows steer, Q/E roll, R/F throttle, Space fire, M missile (needs lock), V view, Tab scores, P pause. Click the game to enable mouse.',
    helpTouch: 'Touch left side for the stick, right for fire and missile buttons, slider sets throttle.',
  },
} as const;

export type Key = keyof (typeof DICT)['ru'];

const LANG_KEY = 'space-arena-lang';

function detect(): Lang {
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (saved === 'ru' || saved === 'en') return saved;
  } catch { /* нет доступа к хранилищу */ }
  return (navigator.language || 'ru').toLowerCase().startsWith('ru') ? 'ru' : 'en';
}

let lang: Lang = detect();

export const getLang = (): Lang => lang;

export function setLang(l: Lang): void {
  lang = l;
  try { localStorage.setItem(LANG_KEY, l); } catch { /* не критично */ }
}

export const t = (k: Key): string => DICT[lang][k];
