// TOTAL MASSACRE — global config, teams and unit definitions.
(function (TM) {
  'use strict';

  TM.CONFIG = {
    WORLD_W: 2400,
    WORLD_H: 1500,
    DT: 1 / 60,            // fixed simulation step
    MAX_STEPS_PER_FRAME: 10,
    GRID_CELL: 32,
    DECAL_SCALE: 1,        // ground/decal layer: 1 px = 1 world unit (pixel-art grid)
    MAX_PARTICLES: 5000,
    GRAVITY: 620,
    ARMY_GAP: 300,         // distance from world center to each army's front rank
  };

  TM.TEAMS = [
    {
      id: 0, key: 'red', name: 'Красные', full: 'Красная армия', dir: 1,
      color: '#d63f36', dark: '#6e1a15', light: '#ff9184', cloth: '#b02a22', corpse: '#6a3430',
    },
    {
      id: 1, key: 'blue', name: 'Синие', full: 'Синяя армия', dir: -1,
      color: '#3a7be0', dark: '#16336e', light: '#93bfff', cloth: '#2457b0', corpse: '#33466e',
    },
  ];

  // Unit archetypes. Numbers are tuned for fun first, realism second.
  TM.UNIT_TYPES = {
    sword: {
      key: 'sword', name: 'Мечник', max: 500,
      desc: 'Щит и меч. Высокий урон вблизи, блокирует часть стрел. Влезает под копья.',
      hp: 110, radius: 6, mass: 1, speed: 46, accel: 300,
      reach: 8, dmgMin: 14, dmgMax: 21, cooldown: 0.75, windup: 0.17,
      crit: 0.10, knock: 45, arrowMul: 1, block: 0.40,
      bonusVs: { spear: 1.15, archer: 1.2 },
      sense: 230, moraleLoss: 3.5, bravery: 1,
    },
    spear: {
      key: 'spear', name: 'Копейщик', max: 500,
      desc: 'Длинное копьё — бьёт первым и держит дистанцию. Ломает кавалерию и великанов.',
      hp: 100, radius: 6, mass: 1.1, speed: 40, accel: 260,
      reach: 22, dmgMin: 12, dmgMax: 17, cooldown: 0.9, windup: 0.22,
      crit: 0.08, knock: 55, arrowMul: 1, block: 0.12,
      bonusVs: { knight: 3.0, giant: 1.8 },
      prefer: { knight: 70, giant: 40 },
      brace: 38,
      sense: 230, moraleLoss: 3.5, bravery: 1.05,
    },
    archer: {
      key: 'archer', name: 'Лучник', max: 500,
      desc: 'Стреляет навесом издалека, отходит от врага. В ближнем бою — лёгкая добыча.',
      hp: 60, radius: 5.5, mass: 0.8, speed: 47, accel: 320,
      reach: 7, dmgMin: 5, dmgMax: 8, cooldown: 0.9, windup: 0.15,
      crit: 0.05, knock: 20, arrowMul: 1, block: 0,
      ranged: { range: 390, minRange: 90, dmgMin: 10, dmgMax: 15, cooldown: 1.55, speed: 360, spread: 0.035, crit: 0.12 },
      sense: 400, moraleLoss: 3, bravery: 0.85,
    },
    knight: {
      key: 'knight', name: 'Рыцарь', max: 250,
      desc: 'Тяжёлая кавалерия. Таранный натиск раскидывает пехоту. Охотится на лучников.',
      hp: 220, radius: 9, mass: 4, speed: 95, accel: 150, armor: 0.85,
      reach: 12, dmgMin: 18, dmgMax: 27, cooldown: 1.0, windup: 0.2,
      crit: 0.12, knock: 90, arrowMul: 0.7, block: 0.15,
      bonusVs: { archer: 1.6 },
      prefer: { archer: 120 },
      charge: { dmg: 34, minSpeed: 62, knock: 260 },
      sense: 340, moraleLoss: 6, bravery: 1.2,
    },
    giant: {
      key: 'giant', name: 'Великан', max: 40,
      desc: 'Огромный и медленный. Размашистый удар дубиной расшвыривает толпу. Не знает страха.',
      hp: 1700, radius: 16, mass: 14, speed: 31, accel: 120, armor: 0.55,
      reach: 20, dmgMin: 48, dmgMax: 70, cooldown: 1.8, windup: 0.45,
      crit: 0.08, knock: 330, arrowMul: 0.35, block: 0,
      cleave: 1.25, // half-angle in radians
      sense: 260, moraleLoss: 20, fearless: true, terror: 3,
    },
  };

  TM.UNIT_ORDER = ['sword', 'spear', 'archer', 'knight', 'giant'];

  TM.FORMATIONS = [
    { key: 'line', name: 'Линия', desc: 'Широкий фронт, лучники позади, конница на флангах' },
    { key: 'block', name: 'Фаланга', desc: 'Плотный глубокий квадрат' },
    { key: 'wedge', name: 'Клин', desc: 'Острый клин — тяжёлые юниты на острие' },
    { key: 'horde', name: 'Орда', desc: 'Беспорядочная толпа' },
    { key: 'manual', name: 'Вручную', desc: 'Расставьте отряды мышью прямо на поле' },
  ];

  TM.PRESETS = [
    {
      name: 'Классика', desc: 'Сбалансированные армии',
      red: { counts: { sword: 70, spear: 50, archer: 50, knight: 14, giant: 0 }, formation: 'line' },
      blue: { counts: { sword: 70, spear: 50, archer: 50, knight: 14, giant: 0 }, formation: 'line' },
    },
    {
      name: 'Мясорубка 400×400', desc: 'Огромная бойня',
      red: { counts: { sword: 160, spear: 100, archer: 100, knight: 30, giant: 4 }, formation: 'line' },
      blue: { counts: { sword: 160, spear: 100, archer: 100, knight: 30, giant: 4 }, formation: 'line' },
    },
    {
      name: 'Элита против орды', desc: 'Великаны, рыцари и пики против 350 мечей',
      red: { counts: { sword: 0, spear: 60, archer: 0, knight: 36, giant: 4 }, formation: 'line' },
      blue: { counts: { sword: 350, spear: 0, archer: 0, knight: 0, giant: 0 }, formation: 'horde' },
    },
    {
      name: 'Дождь стрел', desc: 'Стрелки против штурма',
      red: { counts: { sword: 0, spear: 60, archer: 260, knight: 0, giant: 0 }, formation: 'line' },
      blue: { counts: { sword: 200, spear: 0, archer: 0, knight: 35, giant: 0 }, formation: 'wedge' },
    },
    {
      name: 'Рыцари против пик', desc: 'Классическая контра: смогут ли рыцари пробить стену копий?',
      red: { counts: { sword: 0, spear: 0, archer: 0, knight: 90, giant: 0 }, formation: 'wedge' },
      blue: { counts: { sword: 0, spear: 160, archer: 40, knight: 0, giant: 0 }, formation: 'block' },
    },
    {
      name: 'Нашествие великанов', desc: '8 гигантов против 285 бойцов',
      red: { counts: { sword: 0, spear: 0, archer: 0, knight: 0, giant: 8 }, formation: 'line' },
      blue: { counts: { sword: 225, spear: 0, archer: 60, knight: 0, giant: 0 }, formation: 'horde' },
    },
  ];
})(window.TM = window.TM || {});
