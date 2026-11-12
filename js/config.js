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
      moraleLoss: 3.5, bravery: 1,
      endurance: 1, recovery: 1,        // stamina: how slowly it is spent / how fast it comes back
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
      moraleLoss: 3.5, bravery: 1.05,
      endurance: 1, recovery: 1,
    },
    archer: {
      key: 'archer', name: 'Лучник', max: 500,
      desc: 'Стреляет навесом издалека, отходит от врага. В ближнем бою — лёгкая добыча.',
      hp: 60, radius: 5.5, mass: 0.8, speed: 47, accel: 320,
      reach: 7, dmgMin: 5, dmgMax: 8, cooldown: 0.9, windup: 0.15,
      crit: 0.05, knock: 20, arrowMul: 1, block: 0,
      ranged: { range: 390, minRange: 90, dmgMin: 10, dmgMax: 15, cooldown: 1.55, speed: 360, spread: 0.035, crit: 0.12 },
      moraleLoss: 3, bravery: 0.85,
      endurance: 1, recovery: 1.3,      // light kit: gets its breath back quickly
    },
    berserk: {
      key: 'berserk', name: 'Берсерк', max: 400,
      desc: 'Без щита и строя. Бежит впереди линии, от ран впадает в ярость и бьёт чаще и сильнее. Не боится великанов, пока есть силы, но быстро выдыхается.',
      hp: 105, radius: 6.5, mass: 1.2, speed: 52, accel: 340, armor: 1.1,   // no mail: blows bite deeper
      reach: 9, dmgMin: 13, dmgMax: 20, cooldown: 0.9, windup: 0.16,
      crit: 0.12, knock: 60, arrowMul: 1.1, block: 0,
      bonusVs: { archer: 1.2, crossbow: 1.2 },
      rage: true, wild: true,          // fights as a mob whatever the formation
      moraleLoss: 2.5, bravery: 1.4,
      endurance: 0.6, recovery: 0.9,
    },
    crossbow: {
      key: 'crossbow', name: 'Арбалетчик', max: 400,
      desc: 'Стреляет прямой наводкой по готовности, болт пробивает щит и доспех. Охотится на рыцарей и великанов. Перезаряжается долго, не бегает от врага.',
      hp: 75, radius: 6, mass: 1, speed: 40, accel: 260,
      reach: 8, dmgMin: 7, dmgMax: 11, cooldown: 0.9, windup: 0.18,
      crit: 0.06, knock: 35, arrowMul: 1, block: 0.05,
      ranged: { range: 300, minRange: 40, dmgMin: 18, dmgMax: 25, cooldown: 4.2, speed: 560, spread: 0.03, crit: 0.1, pierce: true, arc: 0.3, aimed: true },
      steady: true,                    // holds its ground instead of skirmishing back
      moraleLoss: 3, bravery: 0.95,
      endurance: 1, recovery: 1.1,
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
      moraleLoss: 6, bravery: 1.2,
      endurance: 2.6, recovery: 1.2,    // the horse gallops long, but not for ever
    },
    horsearcher: {
      key: 'horsearcher', name: 'Конный лучник', max: 200,
      desc: 'Лёгкая конница. Кружит на дистанции и стреляет на скаку, уходит от ближнего боя, добивает бегущих. Пешие лучники бьют дальше, погоня выматывает коня.',
      hp: 120, radius: 8, mass: 2.6, speed: 108, accel: 190, armor: 0.95,
      reach: 9, dmgMin: 8, dmgMax: 12, cooldown: 0.9, windup: 0.18,
      crit: 0.06, knock: 40, arrowMul: 0.9, block: 0,
      ranged: { range: 260, minRange: 0, dmgMin: 9, dmgMax: 13, cooldown: 1.7, speed: 380, spread: 0.045, crit: 0.1, ammo: 30 },
      mounted: true,
      moraleLoss: 4, bravery: 1,
      endurance: 2.4, recovery: 1.3,
    },
    giant: {
      key: 'giant', name: 'Великан', max: 40,
      desc: 'Огромный и медленный. Размашистый удар дубиной расшвыривает толпу. Не знает страха.',
      hp: 1700, radius: 16, mass: 14, speed: 31, accel: 120, armor: 0.55,
      reach: 20, dmgMin: 48, dmgMax: 70, cooldown: 1.8, windup: 0.45,
      crit: 0.08, knock: 330, arrowMul: 0.35, block: 0,
      cleave: 1.25, // half-angle in radians
      moraleLoss: 20, fearless: true, terror: 3,
      endurance: 30, recovery: 0.8,     // never runs, hardly tires: it just keeps coming
    },
    // the commander: never bought with a slider, one per army (TM.GENERALS)
    general: {
      key: 'general', name: 'Генерал', max: 1,
      desc: 'Полководец армии.',
      hp: 320, radius: 9, mass: 4.2, speed: 88, accel: 150, armor: 0.75,
      reach: 13, dmgMin: 22, dmgMax: 32, cooldown: 0.9, windup: 0.2,
      crit: 0.15, knock: 100, arrowMul: 0.6, block: 0.25,
      charge: { dmg: 30, minSpeed: 60, knock: 220 },
      mounted: true, commander: true,
      moraleLoss: 0, bravery: 1.6,
      endurance: 2.6, recovery: 1.3,
    },
  };
  TM.UNIT_TYPES.knight.mounted = true;

  TM.UNIT_ORDER = ['sword', 'spear', 'berserk', 'archer', 'crossbow', 'knight', 'horsearcher', 'giant'];
  TM.ALL_TYPES = TM.UNIT_ORDER.concat('general');

  // Commander archetypes. Each one changes how the whole army fights, not only the men next to him.
  TM.GENERALS = [
    { key: '', name: 'Нет', desc: 'Армия воюет без полководца' },
    { key: 'marshal', name: 'Маршал', short: 'Маршал',
      desc: 'Держится за линией. Рядом с ним строй стоит твёрже, страх и потери пугают меньше, полк бежит позже. Скачет к бегущим и собирает их' },
    { key: 'warlord', name: 'Вождь', short: 'Вождь',
      desc: 'Ведёт в бой сам и рубится в первом ряду. Рядом с ним бьют сильнее и чаще, армия раньше идёт в атаку. Его гибель потрясает армию' },
    { key: 'tactician', name: 'Стратег', short: 'Стратег',
      desc: 'Держится в тылу и управляет армией: стрелки бьют по одной цели и чаще, резервы вступают вовремя, конница ждёт решающего момента' },
  ];

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
      blue: { counts: { sword: 200, spear: 0, archer: 0, knight: 45, giant: 0 }, formation: 'wedge' },
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
    {
      name: 'Маршал против Вождя', desc: 'Одинаковые армии с великанами, разные полководцы: дисциплина против личного примера',
      red: { counts: { sword: 140, spear: 40, archer: 40, giant: 3 }, formation: 'line', general: 'marshal' },
      blue: { counts: { sword: 140, spear: 40, archer: 40, giant: 3 }, formation: 'line', general: 'warlord' },
    },
    {
      name: 'Ярость севера', desc: 'Берсерки и конные лучники против арбалетов и пик',
      red: { counts: { berserk: 160, horsearcher: 30, archer: 40 }, formation: 'line', general: 'warlord' },
      blue: { counts: { sword: 85, spear: 75, crossbow: 75 }, formation: 'line', general: 'marshal' },
    },
    {
      name: 'Степь против латников', desc: 'Конные лучники против тяжёлой армии',
      red: { counts: { horsearcher: 130, knight: 25 }, formation: 'line', general: 'tactician' },
      blue: { counts: { sword: 110, spear: 60, crossbow: 40, knight: 20 }, formation: 'block', general: 'marshal' },
    },
    {
      name: 'Арбалеты против рыцарей', desc: 'Пробьют ли болты латы раньше, чем рыцари доскачут?',
      red: { counts: { knight: 95 }, formation: 'wedge', general: 'warlord' },
      blue: { counts: { crossbow: 120, spear: 60 }, formation: 'line', general: 'tactician' },
    },
  ];
})(window.TM = window.TM || {});
