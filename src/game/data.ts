import type { DamageReport } from './damage';
import type { Lang } from '../i18n';
// Общие данные симулятора: модели, покрытия, шины, настройки, пресеты, карты

export type MapId = 'polygon' | 'city' | 'hill';

export interface MapDef {
  id: MapId;
  name: string;
  shortName: string;
  icon: string;
  desc: string;
}

/** Порядок переключения карт клавишей N. */
export const MAP_ORDER: MapId[] = ['city', 'polygon', 'hill'];

export const MAPS: Record<MapId, MapDef> = {
  hill: {
    id: 'hill',
    name: 'Горный спуск',
    shortName: 'Гора',
    icon: '⛰️',
    desc: 'Крутой спуск с вершины горы: серпантин со шпильками, камнепад, поваленные брёвна, шиканы из барьеров, трамплины, ручей и гравийные осыпи.',
  },
  polygon: {
    id: 'polygon',
    name: 'Тестовый полигон',
    shortName: 'Полигон',
    icon: '🏁',
    desc: '9 зон различных покрытий, слалом с конусами, трамплин, гребёнка, ямы и загородные холмы.',
  },
  city: {
    id: 'city',
    name: 'Городской мегаполис',
    shortName: 'Город',
    icon: '🏙️',
    desc: 'Проспекты, перекрёстки со светофорами, велодорожки, тротуары, парк, старый квартал с брусчаткой, пляж, каток и трамплины.',
  },
};

export type SurfaceId =
  | 'asphalt'
  | 'wet'
  | 'tiles'
  | 'cobble'
  | 'gravel'
  | 'dirt'
  | 'grass'
  | 'sand'
  | 'snow';

export const SURFACE_ORDER: SurfaceId[] = [
  'asphalt',
  'wet',
  'tiles',
  'cobble',
  'gravel',
  'dirt',
  'grass',
  'sand',
  'snow',
];

export interface SurfaceDef {
  id: SurfaceId;
  name: string;
  icon: string;
  mu: number; // пиковый коэффициент сцепления
  rr: number; // сопротивление качению
  soft: boolean; // рыхлое покрытие
  loose: number; // 0..1 "рыхлость" (растягивает пик скольжения)
  optPsi: number; // оптимальное давление в шинах
  color: string;
}

export const SURFACES: Record<SurfaceId, SurfaceDef> = {
  asphalt: { id: 'asphalt', name: 'Сухой асфальт', icon: '🛣️', mu: 1.0, rr: 0.012, soft: false, loose: 0.0, optPsi: 36, color: '#3a3b3e' },
  wet: { id: 'wet', name: 'Мокрый асфальт', icon: '🌧️', mu: 0.62, rr: 0.013, soft: false, loose: 0.05, optPsi: 32, color: '#25282c' },
  tiles: { id: 'tiles', name: 'Плитка', icon: '🟫', mu: 0.9, rr: 0.014, soft: false, loose: 0.0, optPsi: 34, color: '#8d8f93' },
  cobble: { id: 'cobble', name: 'Брусчатка', icon: '🪨', mu: 0.8, rr: 0.026, soft: false, loose: 0.1, optPsi: 30, color: '#7a7570' },
  gravel: { id: 'gravel', name: 'Гравий', icon: '🏔️', mu: 0.55, rr: 0.04, soft: true, loose: 0.7, optPsi: 24, color: '#9a948a' },
  dirt: { id: 'dirt', name: 'Грунт', icon: '🟤', mu: 0.7, rr: 0.03, soft: true, loose: 0.4, optPsi: 22, color: '#6b4f33' },
  grass: { id: 'grass', name: 'Трава', icon: '🌿', mu: 0.5, rr: 0.05, soft: true, loose: 0.5, optPsi: 22, color: '#4e7d3a' },
  sand: { id: 'sand', name: 'Песок', icon: '🏖️', mu: 0.45, rr: 0.11, soft: true, loose: 0.9, optPsi: 16, color: '#d6c08a' },
  snow: { id: 'snow', name: 'Снег / лёд', icon: '❄️', mu: 0.22, rr: 0.04, soft: true, loose: 0.3, optPsi: 20, color: '#e9f0f5' },
};

export type TireId = 'road' | 'semi' | 'off';

export interface TireDef {
  id: TireId;
  name: string;
  desc: string;
  grip: Record<SurfaceId, number>;
  rrHard: number;
  rrSoft: number;
  tread: 'none' | 'fine' | 'knob';
}

export const TIRES: Record<TireId, TireDef> = {
  road: {
    id: 'road',
    name: 'Дорожные (слик)',
    desc: 'Максимум сцепления и минимум сопротивления на асфальте, плохо на рыхлом.',
    grip: { asphalt: 1.0, wet: 0.88, tiles: 1.0, cobble: 0.9, gravel: 0.62, dirt: 0.68, grass: 0.62, sand: 0.58, snow: 0.7 },
    rrHard: 0.85,
    rrSoft: 1.2,
    tread: 'none',
  },
  semi: {
    id: 'semi',
    name: 'Полуслики',
    desc: 'Универсальный компромисс для города и грунтовок.',
    grip: { asphalt: 0.96, wet: 0.9, tiles: 0.97, cobble: 0.95, gravel: 0.85, dirt: 0.9, grass: 0.85, sand: 0.8, snow: 0.85 },
    rrHard: 1.0,
    rrSoft: 1.0,
    tread: 'fine',
  },
  off: {
    id: 'off',
    name: 'Внедорожные',
    desc: 'Крупный протектор: лучшее сцепление на грунте, гравии и песке.',
    grip: { asphalt: 0.88, wet: 0.78, tiles: 0.9, cobble: 0.96, gravel: 1.12, dirt: 1.2, grass: 1.15, sand: 1.15, snow: 1.05 },
    rrHard: 1.28,
    rrSoft: 0.88,
    tread: 'knob',
  },
};

export type ModelId = 'g2' | 'g2pro' | 'g2max' | 'g3pro' | 'g4' | 'x1';

export interface ModelDef {
  id: ModelId;
  name: string;
  desc: string;
  force: number; // макс. тяга, Н
  power: number; // номинальная мощность моторов, Вт
  peakPower: number; // доступный кратковременный пик для игровой модели тяги, Вт
  modeSpeeds: Record<ModeId, number>; // заводские лимиты передач, км/ч
  vmax: number; // км/ч
  mass: number; // кг
  battWh: number;
  travel: number; // ход подвески, м
  awd: boolean;
  label: string; // надпись на раме
  deckLen: number;
  deckW: number;
  hbarW: number;
  stemH: number;
  batteryBox: boolean;
  dualStem: boolean;
  defaultWheel: number;
  defaultTire: TireId;
  isCustom3D?: boolean;
  kind?: 'pitbike'; // отдельная 3D-модель и посадка сидя
  wheelSizes?: number[]; // доступные размеры колёс, если отличаются от самокатных
  colors: { frame: string; accent: string; stem: string; rim: string };
}

export const MODELS: Record<ModelId, ModelDef> = {
  g2: {
    id: 'g2',
    name: 'Kukirin G2',
    desc: 'Мотор 800 Вт, задний привод и 10″ бескамерные шины. Три режима: 25, 35 и 45 км/ч.',
    force: 275,
    power: 800,
    peakPower: 1200,
    modeSpeeds: { eco: 25, drive: 35, sport: 45 },
    vmax: 45,
    mass: 25.3,
    battWh: 748.8,
    travel: 0.088,
    awd: false,
    label: 'G2',
    deckLen: 0.92,
    deckW: 0.2,
    hbarW: 0.6,
    stemH: 0.82,
    batteryBox: false,
    dualStem: false,
    defaultWheel: 10,
    defaultTire: 'off',
    isCustom3D: true,
    colors: { frame: '#8a9099', accent: '#ff6a13', stem: '#16171a', rim: '#1a1b1e' },
  },
  g2pro: {
    id: 'g2pro',
    name: 'Kukirin G2 Pro',
    desc: 'Компактная модель с мотором 600 Вт и 9″ шинами. Три режима: 20, 40 и 45 км/ч.',
    force: 250,
    power: 600,
    peakPower: 1000,
    modeSpeeds: { eco: 20, drive: 40, sport: 45 },
    vmax: 45,
    mass: 25,
    battWh: 748.8,
    travel: 0.085,
    awd: false,
    label: 'G2 PRO',
    deckLen: 0.9,
    deckW: 0.19,
    hbarW: 0.6,
    stemH: 0.8,
    batteryBox: false,
    dualStem: false,
    defaultWheel: 9,
    defaultTire: 'off',
    colors: { frame: '#5f6368', accent: '#ff6a13', stem: '#16171a', rim: '#1a1b1e' },
  },
  g2max: {
    id: 'g2max',
    name: 'Kukirin G2 Max',
    desc: 'Мотор 1000 Вт и батарея 48 В · 20,8 А·ч. Три режима: 15, 30 и 55 км/ч.',
    force: 300,
    power: 1000,
    peakPower: 1200,
    modeSpeeds: { eco: 15, drive: 30, sport: 55 },
    vmax: 55,
    mass: 31.7,
    battWh: 998.4,
    travel: 0.09,
    awd: false,
    label: 'G2 MAX',
    deckLen: 0.92,
    deckW: 0.2,
    hbarW: 0.62,
    stemH: 0.82,
    batteryBox: true,
    dualStem: false,
    defaultWheel: 10,
    defaultTire: 'off',
    colors: { frame: '#4b4f55', accent: '#ff6a13', stem: '#101113', rim: '#202226' },
  },
  g3pro: {
    id: 'g3pro',
    name: 'Kukirin G3 Pro',
    desc: 'Два мотора по 1200 Вт, полный привод и съёмная батарея. Три режима: 25, 45 и 65 км/ч.',
    force: 500,
    power: 2400,
    peakPower: 3000,
    modeSpeeds: { eco: 25, drive: 45, sport: 65 },
    vmax: 65,
    mass: 43.6,
    battWh: 1216.8,
    travel: 0.1,
    awd: true,
    label: 'G3 PRO',
    deckLen: 0.96,
    deckW: 0.22,
    hbarW: 0.66,
    stemH: 0.85,
    batteryBox: true,
    dualStem: false,
    defaultWheel: 10,
    defaultTire: 'off',
    colors: { frame: '#2f3237', accent: '#2bd4ff', stem: '#0d0e10', rim: '#2a2d33' },
  },
  g4: {
    id: 'g4',
    name: 'Kukirin G4 Max',
    desc: 'G4 Max: два мотора по 1600 Вт, 12″ шины и батарея 60 В · 35,2 А·ч. Три режима: 38, 70 и 86 км/ч.',
    force: 620,
    power: 3200,
    peakPower: 4200,
    modeSpeeds: { eco: 38, drive: 70, sport: 86 },
    vmax: 86,
    mass: 64,
    battWh: 2112,
    travel: 0.11,
    awd: true,
    label: 'G4 MAX',
    deckLen: 1.0,
    deckW: 0.24,
    hbarW: 0.7,
    stemH: 0.88,
    batteryBox: true,
    dualStem: true,
    defaultWheel: 12,
    defaultTire: 'off',
    colors: { frame: '#1d1f23', accent: '#9bff2b', stem: '#0b0b0d', rim: '#15161a' },
  },
  x1: {
    id: 'x1',
    name: 'Kukirin X1',
    desc: 'Электрический питбайк: мотор в раме 1000 Вт (пик 2000 Вт), цепной привод, батарея 48 В · 20,8 А·ч, колёса 14″/12″. Три режима: 25, 35 и 50 км/ч.',
    force: 384,
    power: 1000,
    peakPower: 2000,
    modeSpeeds: { eco: 25, drive: 35, sport: 50 },
    vmax: 50,
    mass: 52,
    battWh: 998.4,
    travel: 0.13,
    awd: false,
    label: 'X1',
    deckLen: 0.92,
    deckW: 0.2,
    hbarW: 0.71,
    stemH: 0.85,
    batteryBox: true,
    dualStem: false,
    defaultWheel: 14,
    defaultTire: 'off',
    kind: 'pitbike',
    wheelSizes: [14],
    colors: { frame: '#b9bcc1', accent: '#ff6a13', stem: '#101113', rim: '#141518' },
  },
};

export type BrakeType = 'hyd4' | 'hyd2' | 'mech';
export const BRAKES: Record<BrakeType, { name: string; torque: number; lag: number; desc: string }> = {
  hyd4: { name: 'Гидравлика, 4 поршня', torque: 1.0, lag: 0.04, desc: 'Максимальная мощность и чувствительность.' },
  hyd2: { name: 'Гидравлика, 2 поршня', torque: 0.8, lag: 0.055, desc: 'Мягче, проще дозировать.' },
  mech: { name: 'Механика (тросик)', torque: 0.55, lag: 0.1, desc: 'Слабее, требует усилия.' },
};

export type PadId = 'organic' | 'semi' | 'sintered';
export const PADS: Record<PadId, { name: string; bite: number; cold: number; fadeStart: number; wet: number; desc: string }> = {
  organic: { name: 'Органические', bite: 1.0, cold: 0.97, fadeStart: 170, wet: 0.8, desc: 'Резкий старт торможения, быстро перегреваются.' },
  semi: { name: 'Полуметалл', bite: 0.95, cold: 0.92, fadeStart: 250, wet: 0.92, desc: 'Золотая середина.' },
  sintered: { name: 'Спечённые (металл)', bite: 0.9, cold: 0.84, fadeStart: 330, wet: 1.0, desc: 'Не боятся перегрева и воды, но нужен прогрев.' },
};

export interface Tune {
  fSpring: number; // Н/мм
  rSpring: number;
  fPre: number; // мм
  rPre: number;
  fComp: number; // 0..100
  fReb: number;
  rComp: number;
  rReb: number;
  fPsi: number;
  rPsi: number;
  steerDamper: number; // 0..100
  steerSens: number; // 50..150 %
  brakeType: BrakeType;
  rotor: 140 | 160 | 180;
  pad: PadId;
  bias: number; // % на переднее колесо (общая кнопка)
  curve: number; // 0.6..2.2 прогрессивность рычага
  regen: number; // 0..100
  abs: boolean;
  absThr: number; // % проскальзывания
  tcs: boolean;
}

export const DEFAULT_TUNE: Tune = {
  fSpring: 26,
  rSpring: 28,
  fPre: 6,
  rPre: 6,
  fComp: 50,
  fReb: 55,
  rComp: 50,
  rReb: 55,
  fPsi: 34,
  rPsi: 36,
  steerDamper: 30,
  steerSens: 100,
  brakeType: 'hyd4',
  rotor: 160,
  pad: 'semi',
  bias: 55,
  curve: 1.3,
  regen: 35,
  abs: true,
  absThr: 14,
  tcs: false,
};

export interface TunePreset {
  id: string;
  name: string;
  icon: string;
  surfaces: SurfaceId[];
  tune: Partial<Tune>;
}

export const PRESETS: TunePreset[] = [
  {
    id: 'asphalt',
    name: 'Асфальт',
    icon: '🛣️',
    surfaces: ['asphalt'],
    tune: { fSpring: 30, rSpring: 32, fPre: 8, rPre: 8, fComp: 55, rComp: 55, fReb: 55, rReb: 58, fPsi: 38, rPsi: 40, bias: 58, curve: 1.2, regen: 40, abs: true, absThr: 13, tcs: false, pad: 'semi', steerSens: 100 },
  },
  {
    id: 'wet',
    name: 'Мокро',
    icon: '🌧️',
    surfaces: ['wet'],
    tune: { fSpring: 26, rSpring: 28, fPre: 6, rPre: 6, fComp: 45, rComp: 45, fReb: 50, rReb: 52, fPsi: 32, rPsi: 34, bias: 45, curve: 1.9, regen: 20, abs: true, absThr: 9, tcs: true, pad: 'sintered', steerSens: 90 },
  },
  {
    id: 'paving',
    name: 'Плитка / брусчатка',
    icon: '🪨',
    surfaces: ['tiles', 'cobble'],
    tune: { fSpring: 20, rSpring: 22, fPre: 4, rPre: 4, fComp: 32, rComp: 32, fReb: 42, rReb: 44, fPsi: 30, rPsi: 32, bias: 55, curve: 1.4, regen: 35, abs: true, absThr: 15, tcs: false, pad: 'semi', steerSens: 100 },
  },
  {
    id: 'loose',
    name: 'Гравий',
    icon: '🏔️',
    surfaces: ['gravel'],
    tune: { fSpring: 22, rSpring: 24, fPre: 4, rPre: 4, fComp: 38, rComp: 40, fReb: 52, rReb: 55, fPsi: 25, rPsi: 27, bias: 40, curve: 1.7, regen: 15, abs: true, absThr: 22, tcs: true, pad: 'semi', steerSens: 95 },
  },
  {
    id: 'offroad',
    name: 'Грунт / трава',
    icon: '🌿',
    surfaces: ['dirt', 'grass'],
    tune: { fSpring: 18, rSpring: 20, fPre: 3, rPre: 3, fComp: 30, rComp: 32, fReb: 48, rReb: 50, fPsi: 22, rPsi: 24, bias: 42, curve: 1.6, regen: 15, abs: true, absThr: 22, tcs: true, pad: 'organic', steerSens: 105 },
  },
  {
    id: 'sand',
    name: 'Песок',
    icon: '🏖️',
    surfaces: ['sand'],
    tune: { fSpring: 16, rSpring: 18, fPre: 2, rPre: 2, fComp: 28, rComp: 28, fReb: 45, rReb: 46, fPsi: 16, rPsi: 18, bias: 35, curve: 1.8, regen: 8, abs: true, absThr: 26, tcs: true, pad: 'organic', steerSens: 110 },
  },
  {
    id: 'snow',
    name: 'Снег / лёд',
    icon: '❄️',
    surfaces: ['snow'],
    tune: { fSpring: 20, rSpring: 22, fPre: 4, rPre: 4, fComp: 35, rComp: 35, fReb: 50, rReb: 52, fPsi: 20, rPsi: 22, bias: 30, curve: 2.1, regen: 5, abs: true, absThr: 8, tcs: true, pad: 'sintered', steerSens: 85 },
  },
];

export function presetForSurface(s: SurfaceId): TunePreset {
  return PRESETS.find((p) => p.surfaces.includes(s)) ?? PRESETS[0];
}

export type HelmetType = 'none' | 'open' | 'full';

export interface Look {
  model: ModelId;
  frame: string;
  accent: string;
  stem: string;
  rim: string;
  tire: TireId;
  wheel: number; // дюймы
  fender: boolean;
  glow: boolean;
  glowColor: string;
  lightColor: string;
  helmet: HelmetType;
  helmetColor: string;
  jacket: string;
  pants: string;
  skin: string;
}

export function defaultLook(model: ModelId): Look {
  const m = MODELS[model];
  return {
    model,
    frame: m.colors.frame,
    accent: m.colors.accent,
    stem: m.colors.stem,
    rim: m.colors.rim,
    tire: m.defaultTire,
    wheel: m.defaultWheel,
    fender: true,
    glow: false,
    glowColor: m.colors.accent,
    lightColor: '#ffffff',
    helmet: 'full',
    helmetColor: '#f2f2f2',
    jacket: '#2c3e50',
    pants: '#1e2126',
    skin: '#e0ac86',
  };
}

export type ModeId = 'eco' | 'drive' | 'sport';
export type CameraMode = 'tpv' | 'fpv';
export type ReplayCamMode = 'orbit' | 'rider' | 'impact' | 'fpv';
export type TimeOfDay = 'day' | 'sunset' | 'night';

export interface Settings {
  /** Язык интерфейса; не задан до первого выбора на стартовом экране. */
  lang?: Lang;
  map: MapId;
  camera: CameraMode;
  time: TimeOfDay;
  quality: 'low' | 'med' | 'high';
  /** Ограничение частоты кадров; 0 — по частоте экрана. */
  fpsCap: 0 | 30 | 60;
  /** Снижать разрешение, когда видеокарта не успевает держать частоту кадров. */
  adaptiveRes: boolean;
  showFps: boolean;
  sound: boolean;
  mph: boolean;
  crash: boolean;
  xray: boolean; // рентген повреждений в повторе аварии
  autoProfile: boolean;
  touch: 'auto' | 'on' | 'off';
  riderKg: number;
  mode: ModeId;
}

export const DEFAULT_SETTINGS: Settings = {
  map: 'city',
  camera: 'fpv',
  time: 'day',
  quality: 'med',
  fpsCap: 60,
  adaptiveRes: true,
  showFps: false,
  sound: true,
  mph: false,
  crash: true,
  xray: true,
  autoProfile: false,
  touch: 'on',
  riderKg: 75,
  mode: 'drive',
};

export interface Telemetry {
  stoppie?: boolean; // стант на переднем колесе (питбайк)
  speed: number; // м/с
  throttle: number;
  battery: number; // 0..1
  power: number; // Вт (отриц. = рекуперация)
  surface: SurfaceId;
  compF: number; // 0..1
  compR: number;
  tempF: number;
  tempR: number;
  absActive: boolean;
  tcsActive: boolean;
  gLon: number;
  gLat: number;
  crashed: boolean;
  crashReason: string;
  airborne: boolean;
  odo: number; // м
  slipF: number; // 0..1+ насколько близко к пределу
  slipR: number;
  lockF: boolean;
  lockR: boolean;
  endo: boolean;
  wheelie: boolean;
  stuntAngle: number; // угол подъёма переднего колеса в градусах
  stuntDist: number; // текущая дистанция станта, м
  stuntTime: number; // текущее время станта, с
  stuntScore: number; // очки за текущий стант
  bestStuntDist: number; // рекорд дистанции станта, м
  bestStuntScore: number; // рекорд очков станта
  stuntZone: 'none' | 'lift' | 'sweet' | 'danger';
  tailScrape: boolean;
  // Рэгдолл и повтор со слоумо
  ragdollActive?: boolean;
  crashImpactKmh?: number;
  crashPeakG?: number;
  ragdollFlightDist?: number;
  ragdollMaxHeight?: number;
  liveSlowMo?: number;
  replayActive?: boolean;
  replayPaused?: boolean;
  replayTime?: number;
  replayDuration?: number;
  replayImpactTime?: number;
  replaySlowMo?: number;
  replayEffectiveSpeed?: number;
  replayCamMode?: ReplayCamMode;
  hasReplay?: boolean;
  /** Травмы райдера к текущему моменту повтора (или итог аварии). */
  damage?: DamageReport;
  xrayActive?: boolean;
  /** Частота отрисованных кадров и доля разрешения при адаптивном разрешении. */
  fps?: number;
  renderScale?: number;
}

export interface SimInput {
  throttle: number;
  steer: number; // -1 лево, +1 право
  lean: number; // -1 назад, +1 вперёд
  brake: number;
  brakeF: number;
  brakeR: number;
  stunt?: number; // 0..1 рывок руля на себя / стант на заднем колесе (Shift / кнопка)
}

export function emptyInput(): SimInput {
  return { throttle: 0, steer: 0, lean: 0, brake: 0, brakeF: 0, brakeR: 0, stunt: 0 };
}

export const SWATCHES = [
  '#ff6a13', '#ff2d2d', '#ffd400', '#9bff2b', '#2bd4ff', '#3b6cff', '#b84dff', '#ff4da6',
  '#ffffff', '#c7ccd1', '#8a9099', '#5f6368', '#2f3237', '#16171a',
];
