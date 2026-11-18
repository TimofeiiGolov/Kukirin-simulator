import { trf } from '../i18n';
import type { CSSProperties, ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import { SWATCHES } from '../game/data';

export type Tone = 'good' | 'ok' | 'bad' | 'accent';

export function Section({ title, children, hint, icon }: { title: string; children: ReactNode; hint?: string; icon?: IconName }) {
  return <section className="settings-section">
    <div className="section-heading">
      <h3>{icon && <span className="section-icon"><Icon name={icon} size={16}/></span>}<span>{title}</span></h3>
      {hint && <span className="section-hint">{hint}</span>}
    </div>
    <div className="section-content">{children}</div>
  </section>;
}

export function Slider({ label, value, min, max, step = 1, unit = '', onChange, hint, decimals = 0 }: {
  label: string; value: number; min: number; max: number; step?: number; unit?: string;
  onChange: (v: number) => void; hint?: string; decimals?: number;
}) {
  const fill = `${((value - min) / (max - min)) * 100}%`;
  return <label className="slider-field">
    <span className="field-heading"><span>{label}</span><output>{value.toFixed(decimals)}{unit}</output></span>
    <input type="range" min={min} max={max} step={step} value={value} style={{ '--fill': fill } as CSSProperties} onChange={e => onChange(parseFloat(e.target.value))}/>
    {hint && <span className="field-hint">{hint}</span>}
  </label>;
}

export function Seg<T extends string | number>({ options, value, onChange, small, label }: {
  options: { value: T; label: ReactNode }[]; value: T; onChange: (v: T) => void; small?: boolean; label?: string;
}) {
  return <div className={`segmented ${small ? 'small' : ''}`} role="group" aria-label={label}>{options.map(o => <button key={String(o.value)} aria-pressed={o.value === value} onClick={() => onChange(o.value)}>{o.label}</button>)}</div>;
}

export function Field({ label, icon, children }: { label: string; icon?: IconName; children: ReactNode }) {
  return <div className="field"><div className="field-title">{icon && <Icon name={icon} size={15}/>}{label}</div>{children}</div>;
}

export function Toggle({ label, value, onChange, hint, icon }: { label: string; value: boolean; onChange: (v: boolean) => void; hint?: string; icon?: IconName }) {
  return <button className="toggle-field" role="switch" aria-checked={value} onClick={() => onChange(!value)}>
    {icon && <Icon name={icon} size={18}/>}
    <span className="toggle-description"><span className="field-label">{label}</span>{hint && <span className="field-hint">{hint}</span>}</span>
    <span className={`toggle-track ${value ? 'on' : ''}`}><span/></span>
  </button>;
}

export function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return <div className="color-field">
    <div className="field-heading"><span>{label}</span><label className="custom-color"><span>{value.toUpperCase()}</span><input aria-label={trf('{label}: свой цвет', { label })} type="color" value={value} onChange={e => onChange(e.target.value)}/></label></div>
    <div className="swatches">{SWATCHES.map(c => <button key={c} onClick={() => onChange(c)} aria-label={`${label}: ${c}`} aria-pressed={value.toLowerCase() === c} style={{ background: c }}/>)}</div>
  </div>;
}

export function Bar({ value, tone = 'accent', className = '' }: { value: number; tone?: Tone; className?: string }) {
  return <div className={`data-bar ${className}`}><div className={`tone-${tone}`} style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }}/></div>;
}

/** Строка таблицы «покрытие → полоса → значение»; текущая строка подсвечивается. */
export function MetricRow({ label, value, bar, tone, current, currentLabel }: { label: string; value: string; bar: number; tone: Tone; current?: boolean; currentLabel?: string }) {
  return <div className={`metric-row ${current ? 'current' : ''}`}>
    <span className="metric-label">{current && <i className="current-dot" title={currentLabel} aria-label={currentLabel}/>}{label}</span>
    <Bar value={bar} tone={tone}/>
    <span className="metric-value">{value}</span>
  </div>;
}

export function Stat({ label, value, icon }: { label: string; value: ReactNode; icon?: IconName }) {
  return <div className="spec-stat"><span>{icon && <Icon name={icon} size={14}/>}{label}</span><strong>{value}</strong></div>;
}
