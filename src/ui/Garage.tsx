import { LANGS, getLang, tr, trf } from '../i18n';
import { useEffect, useRef, useState } from 'react';
import { Icon, MAP_ICONS, type IconName } from './Icon';
import { ScooterPreview } from './ScooterPreview';
import { effMu, staticSag, stoppingDistance } from '../game/calc';
import {
  BRAKES,
  DEFAULT_TUNE,
  MAPS,
  MAP_ORDER,
  MODELS,
  PADS,
  PRESETS,
  SURFACES,
  SURFACE_ORDER,
  TIRES,
  defaultLook,
  presetForSurface,
  type BrakeType,
  type Look,
  type ModeId,
  type ModelId,
  type PadId,
  type Settings,
  type SurfaceId,
  type TireId,
  type Tune,
} from '../game/data';
import { ColorField, Field, MetricRow, Section, Seg, Slider, Stat, Toggle, type Tone } from './primitives';

type TabId = 'model' | 'susp' | 'brake' | 'rider' | 'game';
const TABS: { id: TabId; label: string; icon: IconName }[] = [
  { id: 'model', icon: 'scooter', label: 'Транспорт' },
  { id: 'susp', icon: 'spring', label: 'Подвеска' },
  { id: 'brake', icon: 'brake', label: 'Тормоза' },
  { id: 'rider', icon: 'rider', label: 'Райдер' },
  { id: 'game', icon: 'settings', label: 'Игра' },
];
const MODES: ModeId[] = ['eco', 'drive', 'sport'];
const TIMES: Settings['time'][] = ['day', 'sunset', 'night'];
const TIME_LABEL: Record<Settings['time'], string> = { day: 'День', sunset: 'Закат', night: 'Ночь' };
const MAX_VMAX = Math.max(...Object.values(MODELS).map(m => m.vmax));
const SKIN_TONES = ['#f3cfb3', '#e0ac86', '#c68863', '#9a6a45', '#6b4429', '#3f2716'];

export type GarageFocusPart = 'all' | 'front' | 'rear' | 'cockpit' | 'deck';

interface Props {
  look: Look;
  tune: Tune;
  settings: Settings;
  surface: SurfaceId;
  updLook: (p: Partial<Look>) => void;
  setLook: (l: Look) => void;
  updTune: (p: Partial<Tune>) => void;
  updSet: (p: Partial<Settings>) => void;
  onClose: () => void;
  onPreviewChange?: (active: boolean) => void;
  onRespawn: () => void;
  onFocusPart?: (part: GarageFocusPart) => void;
}

const shortName = (id: ModelId) => MODELS[id].name.replace('Kukirin ', '');
const isPitbike = (id: ModelId) => MODELS[id].kind === 'pitbike';
const vehicleIcon = (id: ModelId): IconName => (isPitbike(id) ? 'pitbike' : 'scooter');
/** Скорость в выбранных единицах: в гараже те же единицы, что и на спидометре. */
const speed = (kmh: number, mph: boolean) => ({ value: Math.round(mph ? kmh * 0.621371 : kmh), unit: tr(mph ? 'миль/ч' : 'км/ч') });
const next = <T,>(list: T[], cur: T) => list[(list.indexOf(cur) + 1) % list.length];

function PresetBar({ surface, tune, updTune }: { surface: SurfaceId; tune: Tune; updTune: (p: Partial<Tune>) => void }) {
  const rec = presetForSurface(surface);
  const isActive = (p: (typeof PRESETS)[number]) => (Object.keys(p.tune) as (keyof Tune)[]).every(k => tune[k] === p.tune[k]);
  return <Section icon="road" title={tr('Профиль покрытия')} hint={tr('Быстрая настройка')}>
    <div className="chip-list">
      {PRESETS.map(p => <button key={p.id} className="chip" aria-pressed={isActive(p)} onClick={() => updTune(p.tune)}>{tr(p.name)}{p.id === rec.id && <span className="recommended-dot" title={tr('Рекомендуется для текущего покрытия')}/>}</button>)}
      <button className="chip ghost" onClick={() => updTune(DEFAULT_TUNE)}><Icon name="reset" size={13}/>{tr('Сброс')}</button>
    </div>
    <p className="field-hint">{tr('Оранжевая точка — профиль для текущего покрытия.')}</p>
  </Section>;
}

function ModelTab({ look, settings, updLook, setLook, onFocusPart, activePart }: Pick<Props, 'look' | 'settings' | 'updLook' | 'setLook' | 'onFocusPart'> & { activePart: GarageFocusPart }) {
  const m = MODELS[look.model];
  const pit = isPitbike(look.model);
  const pick = (id: ModelId) => setLook({ ...defaultLook(id), helmet: look.helmet, helmetColor: look.helmetColor, jacket: look.jacket, pants: look.pants, skin: look.skin, fender: look.fender, glow: look.glow });
  const parts: [GarageFocusPart, string, IconName][] = [
    ['all', tr('Общий вид'), vehicleIcon(look.model)],
    ['front', tr('Вилка'), 'wheel'],
    ['rear', tr('Маятник'), 'wheel'],
    ['cockpit', tr('Руль'), 'steering'],
    ['deck', pit ? tr('Мотор') : tr('Дека'), pit ? 'motor' : 'sliders'],
  ];
  const models = Object.values(MODELS);
  return <>
    <Section icon={vehicleIcon(look.model)} title={tr('Выберите модель')} hint={`${models.length} ${tr('моделей')}`}>
      <div className="model-list">{models.map((mm, i) => {
        const v = speed(mm.vmax, settings.mph);
        return <button key={mm.id} aria-pressed={mm.id === look.model} onClick={() => pick(mm.id)}>
          <span className="model-index">{String(i + 1).padStart(2, '0')}</span>
          <span className="model-info">
            <strong>{shortName(mm.id)}{mm.kind === 'pitbike' && <em className="kind-badge">{tr('Питбайк')}</em>}</strong>
            <span>{mm.power} {tr('Вт ·')} {mm.awd ? tr('Полный привод') : tr('Задний привод')}</span>
            <span className="model-meter"><i style={{ width: `${(mm.vmax / MAX_VMAX) * 100}%` }}/></span>
          </span>
          <span className="model-speed">{v.value}<small>{v.unit}</small></span>
        </button>;
      })}</div>
      <p className="model-description">{tr(m.desc)}</p>
      <div className="spec-grid"><Stat icon="battery" label={tr('Батарея')} value={`${Math.round(m.battWh)} ${tr('Вт·ч')}`}/><Stat icon="weight" label={tr('Масса')} value={`${m.mass} ${tr('кг')}`}/><Stat icon="wheel" label={tr('Колёса')} value={`${m.defaultWheel}″`}/></div>
      <div className="mode-specs">{MODES.map(mode => { const v = speed(m.modeSpeeds[mode], settings.mph); return <div key={mode} className={`mode-${mode}`}><span>{mode.toUpperCase()}</span><strong>{v.value} <small>{v.unit}</small></strong></div>; })}</div>
      {onFocusPart && <div className="chip-list">{parts.map(([id, label, icon]) => <button key={id} className="chip" aria-pressed={activePart === id} onClick={() => onFocusPart(id)}><Icon name={icon} size={14}/>{label}</button>)}</div>}
    </Section>
    <Section icon="palette" title={tr('Цвета')}>
      <ColorField label={pit ? tr('Рама') : tr('Рама и дека')} value={look.frame} onChange={frame => updLook({ frame })}/>
      <ColorField label={tr('Акценты')} value={look.accent} onChange={accent => updLook({ accent, glowColor: accent })}/>
      <ColorField label={pit ? tr('Вилка и руль') : tr('Стойка и руль')} value={look.stem} onChange={stem => updLook({ stem })}/>
      <ColorField label={tr('Диски колёс')} value={look.rim} onChange={rim => updLook({ rim })}/>
    </Section>
    <Section icon="wheel" title={tr('Колёса и шины')}>
      {pit ? <p className="field-hint">{tr('Штатные шины: передняя 60/100-14, задняя 80/100-12. Размер не меняется.')}</p> : <>
        <Seg label={tr('Колёса')} options={[8.5, 9, 10, 11, 12].map(value => ({ value, label: `${value}″` }))} value={look.wheel} onChange={wheel => updLook({ wheel })}/>
        <p className="field-hint">{trf('У модели {model} штатные колёса {size}″. Другие размеры — тюнинг.', { model: shortName(look.model), size: m.defaultWheel })}</p>
      </>}
      <div className="option-list">{Object.values(TIRES).map(t => <button key={t.id} aria-pressed={look.tire === t.id} onClick={() => updLook({ tire: t.id as TireId })}>
        <strong className="option-heading">{tr(t.name)}{m.defaultTire === t.id && <em className="kind-badge">{tr('Штатные')}</em>}</strong><span>{tr(t.desc)}</span>
      </button>)}</div>
    </Section>
    <Section icon="light" title={tr('Обвес и свет')}>
      <Toggle icon="wheel" label={tr('Крылья')} value={look.fender} onChange={fender => updLook({ fender })}/>
      <Toggle icon="light" label={pit ? tr('Подсветка') : tr('Подсветка деки')} value={look.glow} onChange={glow => updLook({ glow })}/>
      {look.glow && <ColorField label={tr('Подсветка')} value={look.glowColor} onChange={glowColor => updLook({ glowColor })}/>}
      <ColorField label={tr('Свет фары')} value={look.lightColor} onChange={lightColor => updLook({ lightColor })}/>
    </Section>
  </>;
}

const muTone = (mu: number): Tone => (mu > 0.75 ? 'good' : mu > 0.45 ? 'ok' : 'bad');

function GripTable({ tire, fPsi, rPsi, surface }: { tire: TireId; fPsi: number; rPsi: number; surface: SurfaceId }) {
  return <div className="metric-table">{SURFACE_ORDER.map(s => {
    const mu = effMu(s, tire, (fPsi + rPsi) / 2);
    return <MetricRow key={s} label={tr(SURFACES[s].name)} value={`μ ${mu.toFixed(2)}`} bar={mu / 1.1} tone={muTone(mu)} current={s === surface} currentLabel={tr('Текущее покрытие')}/>;
  })}</div>;
}

function SuspTab({ look, tune, settings, surface, updTune }: Pick<Props, 'look' | 'tune' | 'settings' | 'surface' | 'updTune'>) {
  const sag = staticSag(look.model, settings.riderKg, tune);
  const sagTone = (p: number) => `tone-text-${p > 0.45 ? 'bad' : p < 0.12 ? 'ok' : 'good'}`;
  return <>
    <PresetBar surface={surface} tune={tune} updTune={updTune}/>
    <Section icon="spring" title={tr('Передняя подвеска')} hint={trf('ход {n} мм', { n: (MODELS[look.model].travel * 1000).toFixed(0) })}>
      <Slider label={tr('Жёсткость пружины')} value={tune.fSpring} min={10} max={60} unit={tr(' Н/мм')} onChange={v => updTune({ fSpring: v })}/>
      <Slider label={tr('Преднатяг')} value={tune.fPre} min={0} max={25} unit={tr(' мм')} onChange={v => updTune({ fPre: v })}/>
      <Slider label={tr('Демпфер: сжатие')} value={tune.fComp} min={0} max={100} unit="%" onChange={v => updTune({ fComp: v })} hint={tr('Выше — жёстче на ударах, меньше клюёт на тормозе')}/>
      <Slider label={tr('Демпфер: отбой')} value={tune.fReb} min={0} max={100} unit="%" onChange={v => updTune({ fReb: v })} hint={tr('Выше — медленнее возвращается, меньше «пого»')}/>
    </Section>
    <Section icon="spring" title={tr('Задняя подвеска')}>
      <Slider label={tr('Жёсткость пружины')} value={tune.rSpring} min={10} max={60} unit={tr(' Н/мм')} onChange={v => updTune({ rSpring: v })}/>
      <Slider label={tr('Преднатяг')} value={tune.rPre} min={0} max={25} unit={tr(' мм')} onChange={v => updTune({ rPre: v })}/>
      <Slider label={tr('Демпфер: сжатие')} value={tune.rComp} min={0} max={100} unit="%" onChange={v => updTune({ rComp: v })}/>
      <Slider label={tr('Демпфер: отбой')} value={tune.rReb} min={0} max={100} unit="%" onChange={v => updTune({ rReb: v })}/>
    </Section>
    <Section icon="chart" title={tr('Анализ настройки')} hint={trf('вес райдера {n} кг', { n: settings.riderKg })}>
      <div className="spec-grid two">
        <Stat label={tr('Просадка (SAG) пер.')} value={<span className={sagTone(sag.pctF)}>{sag.sagF.toFixed(0)} {tr('мм ·')} {(sag.pctF * 100).toFixed(0)}%</span>}/>
        <Stat label={tr('Просадка (SAG) зад.')} value={<span className={sagTone(sag.pctR)}>{sag.sagR.toFixed(0)} {tr('мм ·')} {(sag.pctR * 100).toFixed(0)}%</span>}/>
        <Stat label={tr('Частота пер.')} value={`${sag.freqF.toFixed(1)} ${tr('Гц')}`}/>
        <Stat label={tr('Частота зад.')} value={`${sag.freqR.toFixed(1)} ${tr('Гц')}`}/>
      </div>
      <p className="field-hint">{tr('Идеальный SAG — 20–35% хода. Если пружина «пробивает» (красная полоса на HUD) — повысьте жёсткость или демпфирование сжатия.')}</p>
    </Section>
    <Section icon="steering" title={tr('Руль')}>
      <Slider label={tr('Рулевой демпфер')} value={tune.steerDamper} min={0} max={100} unit="%" onChange={v => updTune({ steerDamper: v })} hint={tr('Гасит быстрые рывки руля на скорости')}/>
      <Slider label={tr('Чувствительность руля')} value={tune.steerSens} min={50} max={150} unit="%" onChange={v => updTune({ steerSens: v })}/>
    </Section>
    <Section icon="gauge" title={tr('Давление в шинах')} hint="psi">
      <Slider label={tr('Переднее')} value={tune.fPsi} min={12} max={50} unit=" psi" onChange={v => updTune({ fPsi: v })}/>
      <Slider label={tr('Заднее')} value={tune.rPsi} min={12} max={50} unit=" psi" onChange={v => updTune({ rPsi: v })}/>
      <Field label={trf('Эффективное сцепление ({tire}):', { tire: tr(TIRES[look.tire].name) }).replace(/:$/, '')}>
        <GripTable tire={look.tire} fPsi={tune.fPsi} rPsi={tune.rPsi} surface={surface}/>
      </Field>
    </Section>
  </>;
}

function BrakeTab({ look, tune, settings, surface, updTune }: Pick<Props, 'look' | 'tune' | 'settings' | 'surface' | 'updTune'>) {
  const mass = MODELS[look.model].mass + settings.riderKg;
  const dist = SURFACE_ORDER.map(s => ({ s, d: stoppingDistance(s, look.tire, look.wheel, tune, mass) }));
  const maxD = Math.max(...dist.map(x => x.d));
  const mu = effMu(surface, look.tire, (tune.fPsi + tune.rPsi) / 2);
  const idealBias = Math.round((0.45 + 0.2 * mu) * 100);
  const from = speed(30, settings.mph);
  return <>
    <PresetBar surface={surface} tune={tune} updTune={updTune}/>
    <Section icon="brake" title={tr('Тормозная система')}>
      <Seg<BrakeType> small label={tr('Тормозная система')} options={(Object.keys(BRAKES) as BrakeType[]).map(k => ({ value: k, label: tr(BRAKES[k].name.replace('Гидравлика, ', 'Гидр. ').replace('Механика (тросик)', 'Механика')) }))} value={tune.brakeType} onChange={v => updTune({ brakeType: v })}/>
      <p className="field-hint">{tr(BRAKES[tune.brakeType].desc)}</p>
      <Field label={tr('Диаметр роторов')}>
        <Seg label={tr('Диаметр роторов')} options={[{ value: 140, label: tr('140 мм') }, { value: 160, label: tr('160 мм') }, { value: 180, label: tr('180 мм') }]} value={tune.rotor} onChange={v => updTune({ rotor: v as 140 | 160 | 180 })}/>
      </Field>
      <Field label={tr('Колодки')}>
        <Seg<PadId> small label={tr('Колодки')} options={(Object.keys(PADS) as PadId[]).map(k => ({ value: k, label: tr(PADS[k].name.split(' ')[0]) }))} value={tune.pad} onChange={v => updTune({ pad: v })}/>
        <p className="field-hint">{tr(PADS[tune.pad].desc)} {tr('Перегрев с')} {PADS[tune.pad].fadeStart}°C.</p>
      </Field>
    </Section>
    <Section icon="sliders" title={tr('Распределение и рычаг')}>
      <Slider label={tr('Баланс (перед / зад) для общего тормоза')} value={tune.bias} min={0} max={100} unit={tr('% перед')} onChange={v => updTune({ bias: v })} hint={trf('На текущем покрытии оптимально ≈ {n}% на переднее колесо', { n: idealBias })}/>
      <Slider label={tr('Прогрессивность рычага')} value={tune.curve} min={0.6} max={2.2} step={0.05} decimals={2} onChange={v => updTune({ curve: v })} hint={tr('Выше — мягкое начало, резкое в конце хода (лучше на скользком)')}/>
    </Section>
    <Section icon="battery" title={tr('Электроника')}>
      <Slider label={tr('Рекуперация')} value={tune.regen} min={0} max={100} unit="%" onChange={v => updTune({ regen: v })} hint={tr('Тормозит задним мотором при сбросе газа и торможении')}/>
      <Toggle icon="shield" label="ABS" value={tune.abs} onChange={v => updTune({ abs: v })} hint={tr('Предотвращает блокировку колёс')}/>
      {tune.abs && <Slider label={tr('Порог ABS (проскальзывание)')} value={tune.absThr} min={5} max={30} unit="%" onChange={v => updTune({ absThr: v })} hint={tr('Низкий — для льда и воды; высокий — для гравия и песка')}/>}
      <Toggle icon="shield" label={tr('Антибуксовка (TCS)')} value={tune.tcs} onChange={v => updTune({ tcs: v })} hint={tr('Режет тягу при пробуксовке')}/>
    </Section>
    <Section icon="road" title={settings.mph ? `${tr('Тормозной путь')} · ${from.value} ${from.unit}` : tr('Тормозной путь с 30 км/ч')} hint={tr('оценка')}>
      <div className="metric-table">{dist.map(({ s, d }) => <MetricRow key={s} label={tr(SURFACES[s].name)} value={`${d.toFixed(1)} ${tr('м')}`} bar={d / maxD} tone={d < 7 ? 'good' : d < 12 ? 'ok' : 'bad'} current={s === surface} currentLabel={tr('Текущее покрытие')}/>)}</div>
    </Section>
  </>;
}

function RiderTab({ look, settings, updLook, updSet }: Pick<Props, 'look' | 'settings' | 'updLook' | 'updSet'>) {
  return <>
    <Section icon="weight" title={tr('Вес райдера')}>
      <Slider label={tr('Вес')} value={settings.riderKg} min={45} max={120} unit={tr(' кг')} onChange={v => updSet({ riderKg: v })} hint={tr('Влияет на динамику, просадку подвески и тормозной путь')}/>
    </Section>
    <Section icon="helmet" title={tr('Шлем')}>
      <Seg label={tr('Шлем')} options={[{ value: 'none', label: tr('Без') }, { value: 'open', label: tr('Открытый') }, { value: 'full', label: tr('Интеграл') }]} value={look.helmet} onChange={v => updLook({ helmet: v })}/>
      {look.helmet !== 'none' && <ColorField label={tr('Цвет шлема')} value={look.helmetColor} onChange={v => updLook({ helmetColor: v })}/>}
    </Section>
    <Section icon="shirt" title={tr('Экипировка')}>
      <ColorField label={tr('Куртка')} value={look.jacket} onChange={v => updLook({ jacket: v })}/>
      <ColorField label={tr('Штаны')} value={look.pants} onChange={v => updLook({ pants: v })}/>
      <Field label={tr('Тон кожи')}>
        <div className="skin-tones">{SKIN_TONES.map(c => <button key={c} onClick={() => updLook({ skin: c })} aria-label={trf('Тон кожи {c}', { c })} aria-pressed={look.skin === c} style={{ background: c }}/>)}</div>
      </Field>
    </Section>
  </>;
}

function GameTab({ settings, updSet, onRespawn }: Pick<Props, 'settings' | 'updSet' | 'onRespawn'>) {
  const keys: [string, string][] = [
    ['W / ↑', tr('газ')],
    ['Shift / F', tr(' стант (езда на заднем колесе)')],
    [`S / ↓ / ${tr('Пробел')}`, tr('тормоз (оба) / задний ход')],
    ['Shift + Z', tr(' стоппи на питбайке (езда на переднем колесе)')],
    ['Z / X', tr('передний / задний тормоз (X гасит перекрут станта)')],
    ['A D / ← →', tr('руль (в т.ч. подруливание в станте)')],
    ['Q / E', tr('вес назад (выше угол станта) / вперёд')],
    ['C', tr('камера 1-е / 3-е лицо')],
    ['M', tr('режим ECO / DRIVE / SPORT')],
    ['N', tr('сменить карту')],
    ['P', tr('повтор аварии со слоумо')],
    ['V', tr('сменить ракурс камеры в повторе')],
    ['G / Esc', tr('гараж и настройки')],
    ['R', tr('поднять после падения')],
  ];
  const k = (key: string) => <kbd>{key}</kbd>;
  return <>
    <Section icon="city" title={tr('Локация')}>
      <div className="option-list">{MAP_ORDER.map(id => MAPS[id]).map(mp => <button key={mp.id} aria-pressed={(settings.map ?? 'city') === mp.id} onClick={() => updSet({ map: mp.id })}>
        <strong className="option-heading"><Icon name={MAP_ICONS[mp.id]} size={17}/>{tr(mp.shortName)}</strong><span>{tr(mp.desc)}</span>
      </button>)}</div>
    </Section>
    <Section icon="camera" title={tr('Камера')}>
      <Seg label={tr('Камера')} options={[{ value: 'tpv', label: tr('От третьего лица') }, { value: 'fpv', label: tr('От первого лица') }]} value={settings.camera} onChange={v => updSet({ camera: v })}/>
      <p className="field-hint">{tr('Во время езды потяните по экрану, чтобы осмотреться.')}</p>
    </Section>
    <Section icon="motor" title={tr('Режим мотора')}>
      <Seg label={tr('Режим мотора')} options={MODES.map(m => ({ value: m, label: m.toUpperCase() }))} value={settings.mode} onChange={v => updSet({ mode: v })}/>
    </Section>
    <Section icon="sun" title={tr('Окружение')}>
      <Field label={tr('Время суток')} icon="sun">
        <Seg label={tr('Время суток')} options={TIMES.map(t => ({ value: t, label: tr(TIME_LABEL[t]) }))} value={settings.time} onChange={v => updSet({ time: v })}/>
      </Field>
      <Field label={tr('Графика')} icon="sliders">
        <Seg label={tr('Графика')} options={[{ value: 'low', label: tr('Низкая') }, { value: 'med', label: tr('Средняя') }, { value: 'high', label: tr('Высокая') }]} value={settings.quality} onChange={v => updSet({ quality: v })}/>
      </Field>
    </Section>
    <Section icon="gauge" title={tr('Плавность кадров')} hint={settings.fpsCap ? `${settings.fpsCap} FPS` : undefined}>
      <Field label={tr('Частота кадров')}>
        <Seg<Settings['fpsCap']> label={tr('Частота кадров')} options={[{ value: 30, label: '30' }, { value: 60, label: '60' }, { value: 0, label: tr('Макс.') }]} value={settings.fpsCap} onChange={v => updSet({ fpsCap: v })}/>
        <p className="field-hint">{tr('60 — ровная картинка и меньше нагрев. «Макс.» — по частоте экрана (120/144 Гц).')}</p>
      </Field>
      <Toggle icon="sliders" label={tr('Адаптивное разрешение')} value={settings.adaptiveRes} onChange={v => updSet({ adaptiveRes: v })} hint={tr('Немного снижает чёткость, когда видеокарта не успевает, чтобы кадры оставались плавными')}/>
      <Toggle icon="chart" label={tr('Счётчик FPS')} value={settings.showFps} onChange={v => updSet({ showFps: v })} hint={tr('Показывать частоту кадров во время езды')}/>
    </Section>
    <Section icon="settings" title={tr('Геймплей')}>
      <Toggle icon="rider" label={tr('Падения и 3D-рэгдолл')} value={settings.crash} onChange={v => updSet({ crash: v })} hint={tr('Вылет райдера (рэгдолл) при столкновении на скорости + авто-повтор со слоумо')}/>
      <Toggle icon="shield" label={tr('Рентген повреждений')} value={settings.xray} onChange={v => updSet({ xray: v })} hint={tr('В повторе аварии: скелет, сломанные кости и список травм')}/>
      <Toggle icon="road" label={tr('Авто-профиль покрытия')} value={settings.autoProfile} onChange={v => updSet({ autoProfile: v })} hint={tr('Подвеска и тормоза подстраиваются под покрытие')}/>
      <Toggle icon="sound" label={tr('Звук')} value={settings.sound} onChange={v => updSet({ sound: v })}/>
      <Toggle icon="gauge" label={tr('Мили в час')} value={settings.mph} onChange={v => updSet({ mph: v })}/>
      <Field label={tr('Сенсорное управление')} icon="touch">
        <Seg label={tr('Сенсорное управление')} options={[{ value: 'auto', label: tr('Авто') }, { value: 'on', label: tr('Вкл') }, { value: 'off', label: tr('Выкл') }]} value={settings.touch} onChange={v => updSet({ touch: v })}/>
      </Field>
      <button onClick={onRespawn} className="secondary-button"><Icon name="reset" size={16}/>{tr('↩ Вернуться на старт и зарядить батарею').replace(/^↩\s*/, '')}</button>
    </Section>
    <Section icon="keyboard" title={tr('Управление')}>
      <dl className="key-list">{keys.map(([key, desc]) => <div key={key}><dt>{k(key)}</dt><dd>{desc.trim()}</dd></div>)}</dl>
      <p className="field-hint">{tr('На телефоне: левый джойстик — руль (←→) и перенос веса (↑↓), справа — газ и тормоз. Для станта удерживайте газ и переносите вес назад.')}</p>
    </Section>
    <Section icon="info" title={tr('Подсказки по физике и станту')}>
      <ul className="tip-list">
        <li><strong>{tr('Стант (езда на заднем колесе):')}</strong> {tr('зажмите')} {k('W')} + {k('Shift')}{tr('. Райдер встаёт задней ногой на упор и держит баланс в зелёной зоне (19°–37°, множитель очков ×2).')}</li>
        <li>{tr('Чтобы задрать угол выше до высекания искр задним крылом (>36°), потяните вес назад (')}{k('Q')}{tr('). Если угол уходит в красную зону (>42°), коротко нажмите задний тормоз (')}{k('X')}{tr('), чтобы не перевернуться назад!')}</li>
        <li><strong>{tr('Питбайк X1:')}</strong> {tr('Shift поднимает на заднее колесо на любой скорости и сам держит баланс; Q — выше угол, E или X — ниже. Shift + передний тормоз (Z) — стоппи на переднем колесе. В воздухе Q / E задирают и опускают нос, A / D кладут байк набок (уип).')}</li>
        <li>{tr('На мокром, снегу и песке тормозите задним колесом и плавно — передний тормоз может сорвать колесо в занос.')}</li>
        <li>{tr('Слишком сильный передний тормоз на сухом асфальте поднимает заднее колесо — это «стоппи» и падение через руль.')}</li>
        <li><strong>{tr('Рэгдолл и повтор со слоумо:')}</strong> {tr('при столкновении на большой скорости с препятствием или машиной райдер вылетает из седла по законам 3D-физики, после чего автоматически включается кинематографический повтор со слоумо (')}{k('P')}).</li>
      </ul>
    </Section>
  </>;
}

/** Подпись слева: модель и ключевые цифры, одна и та же в студии и поверх мира. */
function GarageHero({ look, settings, studio }: { look: Look; settings: Settings; studio: boolean }) {
  const m = MODELS[look.model];
  const pit = isPitbike(look.model);
  const v = speed(m.vmax, settings.mph);
  const kicker = studio ? (pit ? tr('Питбайк') : tr('Электросамокат')) : pit ? tr('Ваш питбайк') : tr('Ваш самокат');
  return <div className="garage-hero">
    <span className="hero-kicker"><Icon name={vehicleIcon(look.model)} size={15}/>{kicker}</span>
    <h2>{shortName(look.model)}</h2>
    <dl className="hero-specs">
      <div><dt>{tr('Макс. скорость')}</dt><dd>{v.value}<small>{v.unit}</small></dd></div>
      <div><dt>{tr('Мощность')}</dt><dd>{m.power}<small>{tr('Вт')}</small></dd></div>
      <div><dt>{tr('Батарея')}</dt><dd>{Math.round(m.battWh)}<small>{tr('Вт·ч')}</small></dd></div>
      <div><dt>{tr('Масса')}</dt><dd>{m.mass}<small>{tr('кг')}</small></dd></div>
    </dl>
    <span className="hero-hint"><Icon name="rotate" size={15}/>{studio ? tr('Потяните, чтобы повернуть') : tr('Потяните, чтобы осмотреть')}</span>
  </div>;
}

export function Garage(props: Props) {
  const [tab, setTab] = useState<TabId>('model');
  const [previewPart, setPreviewPart] = useState<GarageFocusPart>('all');
  const { look, tune, settings, surface, onPreviewChange, updSet } = props;
  const closeRef = useRef<HTMLButtonElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => { closeRef.current?.focus({ preventScroll: true }); }, []);
  useEffect(() => { scrollRef.current?.scrollTo(0, 0); }, [tab]);
  useEffect(() => { setPreviewPart('all'); }, [look.model]);
  useEffect(() => {
    onPreviewChange?.(tab === 'model');
    return () => onPreviewChange?.(false);
  }, [tab, onPreviewChange]);
  const map = settings.map ?? 'city';
  const studio = tab === 'model';
  return <div className={`garage-layout ${studio ? 'is-studio' : 'is-world'}`}>
    {studio && <ScooterPreview look={look} tune={tune} part={previewPart} onReset={() => setPreviewPart('all')}/>}
    <div className="garage-brand"><span>KUKIRIN</span><span>{tr('СИМУЛЯТОР')}</span></div>
    <GarageHero look={look} settings={settings} studio={studio}/>
    <aside className="garage-panel" aria-label={tr('Гараж и настройки')}>
      <header className="garage-header">
        <div className="garage-title"><span className="eyebrow">KUKIRIN SIM</span><h1>{tr('Гараж')}</h1></div>
        <div className="language-switch" role="group" aria-label={tr('Язык')}>{LANGS.map(l => <button key={l.id} aria-pressed={getLang() === l.id} title={l.label} onClick={() => updSet({ lang: l.id })}>{l.short}</button>)}</div>
        <button ref={closeRef} className="close-button" onClick={props.onClose} aria-label={tr('Закрыть гараж')}><Icon name="close" size={20}/></button>
      </header>
      <nav className="garage-tabs" aria-label={tr('Разделы гаража')}>{TABS.map(t => <button key={t.id} aria-current={tab === t.id ? 'page' : undefined} onClick={() => setTab(t.id)}>
        <Icon name={t.id === 'model' ? vehicleIcon(look.model) : t.icon} size={19}/><span>{tr(t.label)}</span>
      </button>)}</nav>
      <div ref={scrollRef} className="garage-content">
        {tab === 'model' && <ModelTab look={look} settings={settings} updLook={props.updLook} setLook={props.setLook} onFocusPart={setPreviewPart} activePart={previewPart}/>}
        {tab === 'susp' && <SuspTab look={look} tune={tune} settings={settings} surface={surface} updTune={props.updTune}/>}
        {tab === 'brake' && <BrakeTab look={look} tune={tune} settings={settings} surface={surface} updTune={props.updTune}/>}
        {tab === 'rider' && <RiderTab look={look} settings={settings} updLook={props.updLook} updSet={updSet}/>}
        {tab === 'game' && <GameTab settings={settings} updSet={updSet} onRespawn={props.onRespawn}/>}
      </div>
      <footer className="garage-footer">
        <div className="session-chips" role="group" aria-label={tr('Сессия')}>
          <button onClick={() => updSet({ map: next(MAP_ORDER, map) })} title={tr('Сменить карту')}><Icon name={MAP_ICONS[map]} size={16}/><span>{tr(MAPS[map].shortName)}</span></button>
          <button onClick={() => updSet({ time: next(TIMES, settings.time) })} title={tr('Сменить время суток')}><Icon name="sun" size={16}/><span>{tr(TIME_LABEL[settings.time])}</span></button>
          <button onClick={() => updSet({ mode: next(MODES, settings.mode) })} title={tr('Сменить режим мотора')} className={`mode-${settings.mode}`}><i className="mode-dot"/><span>{settings.mode.toUpperCase()}</span></button>
        </div>
        <button className="primary-button ride-button" onClick={props.onClose}><span>{tr('Ехать')}</span><span className="ride-side"><kbd>Esc</kbd><Icon name="arrow" size={20}/></span></button>
      </footer>
    </aside>
  </div>;
}
