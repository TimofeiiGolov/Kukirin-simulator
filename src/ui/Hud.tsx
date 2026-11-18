import { tr, trf, trn } from '../i18n';
import { useState } from 'react';
import type { DamageReport, InjuryKind } from '../game/damage';
import { MAPS, MODELS, SURFACES, type ModelId, type ReplayCamMode, type Settings, type Telemetry } from '../game/data';
import { Icon, MAP_ICONS } from './Icon';

const TONE: Record<InjuryKind, (grade: number) => string> = {
  fracture: (g) => (g >= 2 ? 'red' : 'amber'),
  concussion: (g) => (g >= 2 ? 'red' : 'amber'),
  ligament: () => 'amber',
  contusion: () => 'soft',
  abrasion: () => 'soft',
};

/** Сводка травм: тяжесть, счётчики и список по мере появления в повторе. */
function DamagePanel({ d, time, compact }: { d: DamageReport; time?: number; compact?: boolean }) {
  const major = d.injuries.filter((i) => i.kind !== 'contusion' && i.kind !== 'abrasion');
  const softAreas = new Set(d.injuries.filter((i) => i.kind === 'contusion' || i.kind === 'abrasion').map((i) => i.site)).size;
  const rows = major.slice(0, compact ? 3 : 7);
  return (
    <aside className={`damage-panel sev-${d.severity} ${compact ? 'compact' : ''}`} aria-label={tr('Повреждения райдера')} aria-live="polite">
      <div className="damage-head"><span className="eyebrow">{tr('Рентген · повреждения')}</span><strong>{tr(d.severityLabel)}</strong></div>
      <div className="damage-stats">
        <span title={tr('Injury Severity Score — сумма квадратов тяжести трёх наиболее пострадавших областей тела')}><b>{d.iss}</b><small>ISS</small></span>
        <span><b>{d.fractures}</b><small>{tr('переломы')}</small></span>
        <span><b>{d.ligaments}</b><small>{tr('связки')}</small></span>
        <span><b>{d.weeks ? `~${d.weeks}` : '—'}</b><small>{tr('нед. лечения')}</small></span>
      </div>
      {!compact && <ul className="damage-list">
        {rows.map((i) => <li key={i.id} className={`tone-${TONE[i.kind](i.grade)} ${time !== undefined && time - i.t < 0.6 ? 'fresh' : ''}`}><span>{i.label}</span><small>{i.cause}</small></li>)}
        {major.length > rows.length && <li className="more">{trf('и ещё {n}', { n: major.length - rows.length })}</li>}
        {softAreas > 0 && <li className="tone-soft"><span>{tr('Ушибы и ссадины')}</span><small>{trn(softAreas, 'область тела', 'области тела', 'областей тела')}</small></li>}
        {d.injuries.length === 0 && <li className="more">{tr('Травм пока нет')}</li>}
      </ul>}
      {!compact && d.helmetNote && <p className="damage-note">{d.helmetNote}</p>}
    </aside>
  );
}

const CAM_LABELS: Record<ReplayCamMode, string> = { orbit: 'Орбита', rider: 'Райдер', impact: 'Удар', fpv: 'От первого лица' };
interface Props {
  tel: Telemetry | null;
  settings: Settings;
  model: ModelId;
  onCamera: () => void;
  onMenu: () => void;
  onMode: () => void;
  onMap: () => void;
  onRecover: () => void;
  onReplay: () => void;
  onReplayPause: () => void;
  onReplaySlowMo: () => void;
  onReplayCam: () => void;
  onXray: () => void;
  onReplaySeek: (norm01: number) => void;
}
export function Hud(p: Props) {
  const { tel: t, settings: s } = p;
  const [details, setDetails] = useState(false);
  const speed = Math.abs(t?.speed ?? 0) * (s.mph ? 2.23694 : 3.6);
  const max = MODELS[p.model].modeSpeeds[s.mode] * (s.mph ? .621371 : 1);
  const surface = SURFACES[t?.surface ?? 'asphalt'];
  const replay = !!t?.replayActive;
  const crashed = !!t?.crashed && !replay;
  const duration = Math.max(.01, t?.replayDuration ?? 1);
  const progress = Math.max(0, Math.min(1, (t?.replayTime ?? 0) / duration));
  const odo = t?.odo ?? 0;
  const warning = t?.lockF ? tr('Блокировка переднего колеса') : t?.lockR ? tr('Блокировка заднего колеса') : t?.endo ? tr('Перенесите вес назад') : t?.airborne ? tr('В воздухе') : t && t.slipR > 1.6 && t.throttle > .3 && speed > 4 ? tr('Пробуксовка') : '';
  return (
    <div className={`ride-ui ${replay ? 'is-replay' : ''}`}>
      <div className="speedometer">
        <div className="speed-reading"><span className="speed-number">{Math.round(speed)}</span><span className="speed-unit">{s.mph ? tr('миль/ч') : tr('км/ч')}</span>{(t?.speed ?? 0) < -.25 && <span className="reverse-label">R</span>}</div>
        <div className="speed-line"><span style={{ width: `${Math.min(100, speed / max * 100)}%` }} /></div>
        <div className="ride-stats"><span>{Math.round(t?.power ?? 0)} <small>{tr('Вт')}</small></span><i/><span className={(t?.battery ?? 1) < .2 ? 'low-battery' : ''}>{Math.round((t?.battery ?? 1) * 100)}%</span><i/><span>{odo >= 1000 ? `${(odo / 1000).toFixed(1)} ${tr('км')}` : `${Math.round(odo)} ${tr('м')}`}</span></div>
        <div className="ride-secondary"><button onClick={p.onMode} title={tr('Сменить режим (M)')}>{s.mode.toUpperCase()} <span>{Math.round(max)} {s.mph ? tr('миль/ч') : tr('км/ч')}</span></button><button onClick={() => setDetails(v => !v)} aria-expanded={details}>{tr('Данные')} {details ? '−' : '+'}</button></div>
        {details && <div className="ride-details">
          <div><span>{tr('Подвеска · перед / зад')}</span><b>{Math.round((t?.compF ?? 0) * 100)} / {Math.round((t?.compR ?? 0) * 100)}%</b></div>
          <div><span>{tr('Тормоза · перед / зад')}</span><b>{Math.round(t?.tempF ?? 25)} / {Math.round(t?.tempR ?? 25)} °C</b></div>
          <div><span>ABS / TCS</span><b>{t?.absActive ? 'ABS' : '—'} / {t?.tcsActive ? 'TCS' : '—'}</b></div>
          <div><span>{tr('Перегрузка · прод. / попер.')}</span><b>{(t?.gLon ?? 0).toFixed(1)} / {(t?.gLat ?? 0).toFixed(1)} G</b></div>
          <div><span>{tr('Рекорд станта')}</span><b>{(t?.bestStuntDist ?? 0).toFixed(1)} {tr('м ·')} {t?.bestStuntScore ?? 0}</b></div>
        </div>}
      </div>
      {s.showFps && !!t?.fps && <div className={`fps-counter ${t.fps < (s.fpsCap || 60) * 0.9 ? 'is-low' : ''}`}>
        <b>{Math.round(t.fps)}</b> FPS{(t.renderScale ?? 1) < 1 && <span title={tr('Доля разрешения')}> · {Math.round((t.renderScale ?? 1) * 100)}%</span>}
      </div>}
      <div className="location-line">
        {replay ? <><Icon name="replay"/><span>{tr('Повтор')}</span><i/><span>{(t?.replayEffectiveSpeed ?? .25).toFixed(2)}×</span></> : <><button onClick={p.onMap} title={tr('Сменить карту (N)')}><Icon name={MAP_ICONS[s.map ?? 'city']}/><span>{tr(MAPS[s.map ?? 'city'].shortName)}</span></button><i/><span className="surface-label"><Icon name="road"/>{tr(surface.name)}</span></>}
      </div>
      <div className="ride-actions">
        <button onClick={p.onMenu} aria-label={tr('Гараж и настройки')} title={tr('Гараж и настройки (G / Esc)')}><Icon name="settings"/></button>
        <button onClick={replay ? p.onReplayCam : p.onCamera} aria-label={tr('Сменить камеру')} title={tr('Сменить камеру (C)')}><Icon name="eye"/></button>
        <button onClick={p.onReplay} disabled={!replay && !t?.hasReplay} aria-label={replay ? tr('Выйти из повтора') : tr('Повтор последнего падения')} title={t?.hasReplay || replay ? tr('Повтор (P)') : tr('Повтор появится после падения')}><Icon name={replay ? 'close' : 'replay'}/><span>{replay ? tr('Выход') : tr('Повтор')}</span></button>
      </div>
      {!replay && !crashed && <div className="ride-events" aria-live="polite">
        {t && (t.wheelie || t.stuntAngle > 6) && <div className={`stunt-readout ${t.stuntZone === 'danger' ? 'danger' : ''}`}><div><span>{t.stuntZone === 'sweet' ? tr('Баланс ×2') : t.stuntZone === 'danger' ? (t.stoppie ? tr('Отпусти тормоз!') : tr('Задний тормоз!')) : t.stoppie ? tr('Стоппи') : tr('Стант')}</span><strong>{Math.round(t.stuntAngle)}°</strong></div><div className="balance-track"><span style={{ left: `${Math.min(100, t.stuntAngle / 48 * 100)}%` }}/></div><p>{t.stuntDist.toFixed(1)} {tr('м')} <i/> {t.stuntTime.toFixed(1)} {tr('с')} <i/> +{t.stuntScore}</p></div>}
        {warning && <p className="ride-warning">{warning}</p>}
      </div>}
      {crashed && <div className="incident-panel">
        <span className="eyebrow danger">{tr('Падение')}</span><h2>{tr(t?.crashReason || 'Столкновение')}</h2>
        <div className="incident-stats"><span>{Math.round(t?.crashImpactKmh ?? 0)} <small>{tr('км/ч')}</small></span><span>{(t?.crashPeakG ?? 0).toFixed(1)} <small>G</small></span><span>{(t?.ragdollFlightDist ?? 0).toFixed(1)} <small>{tr('м полёт')}</small></span><span>{(t?.ragdollMaxHeight ?? 0).toFixed(1)} <small>{tr('м высота')}</small></span></div>
        {s.xray && t?.damage && <p className={`incident-damage sev-${t.damage.severity}`}>{tr(t.damage.severityLabel)}{t.damage.fractures > 0 ? ` · ${trf('переломов: {n}', { n: t.damage.fractures })}` : ''}</p>}
        <div className="incident-buttons"><button className="text-button" onClick={p.onReplay} disabled={!t?.hasReplay}>{tr('Смотреть повтор')}</button><button className="primary-button" onClick={p.onRecover}>{tr('Продолжить')} <Icon name="arrow" size={18}/></button></div>
      </div>}
      {replay && s.xray && t?.damage && <DamagePanel d={t.damage} time={(t.replayTime ?? 0) - (t.replayImpactTime ?? 0)}/>}
      {replay && <div className="replay-panel">
        <div className="replay-heading"><span className="eyebrow">{tr(t?.crashReason || 'Повтор поездки')}</span><span>{Math.round(t?.crashImpactKmh ?? 0)} {tr('км/ч ·')} {(t?.crashPeakG ?? 0).toFixed(1)} G</span></div>
        <div className="replay-timeline"><input aria-label={tr('Позиция повтора')} type="range" min={0} max={1000} value={Math.round(progress * 1000)} onChange={e => p.onReplaySeek(Number(e.target.value) / 1000)}/><span className="impact-tick" style={{ left: `${Math.max(0, Math.min(100, (t?.replayImpactTime ?? 0) / duration * 100))}%` }} title={tr('Момент удара')}/></div>
        <div className="replay-times"><span>{(t?.replayTime ?? 0).toFixed(1)} {tr('с')}</span><span>{duration.toFixed(1)} {tr('с')}</span></div>
        <div className="replay-buttons"><button onClick={p.onReplayPause} aria-label={t?.replayPaused ? tr('Воспроизвести') : tr('Пауза')}><Icon name={t?.replayPaused ? 'play' : 'pause'} size={20}/></button><button onClick={p.onReplaySlowMo}>{t?.replaySlowMo ?? .25}×</button><button onClick={p.onReplayCam}>{tr(CAM_LABELS[t?.replayCamMode ?? 'orbit'])}</button><button onClick={p.onXray} aria-pressed={s.xray} title={tr('Рентген повреждений (X)')}>{tr('Рентген')} {s.xray ? tr('вкл') : tr('выкл')}</button><button onClick={p.onRecover}>{tr('Продолжить')} <Icon name="arrow" size={18}/></button></div>
      </div>}
    </div>
  );
}
