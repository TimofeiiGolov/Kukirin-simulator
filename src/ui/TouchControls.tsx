import { tr } from '../i18n';
import { useEffect, useRef, useState } from 'react';
import type { SimInput } from '../game/data';

type Patch = Partial<SimInput>;
function Joystick({ onChange }: { onChange: (steer: number, lean: number) => void }) {
  const base = useRef<HTMLDivElement>(null);
  const pointer = useRef<number | null>(null);
  const [knob, setKnob] = useState({ x: 0, y: 0 });
  const handle = (e: React.PointerEvent) => {
    const r = base.current!.getBoundingClientRect();
    const radius = r.width / 2;
    let x = (e.clientX - r.left - radius) / (radius * .7);
    let y = (e.clientY - r.top - radius) / (radius * .7);
    const length = Math.hypot(x, y);
    if (length > 1) { x /= length; y /= length; }
    setKnob({ x, y });
    const deadzone = (v: number) => Math.abs(v) < .06 ? 0 : Math.sign(v) * Math.pow((Math.abs(v) - .06) / .94, 1.25);
    onChange(deadzone(x), deadzone(-y));
  };
  const end = () => { pointer.current = null; setKnob({ x: 0, y: 0 }); onChange(0, 0); };
  return <div className="joystick-wrap"><span className="lean-forward">{tr('вес вперёд')}</span><div ref={base} className="touch-joystick" role="group" aria-label={tr('Руль и перенос веса')}
    onPointerDown={e => { if (pointer.current !== null) return; pointer.current = e.pointerId; e.currentTarget.setPointerCapture(e.pointerId); handle(e); }}
    onPointerMove={e => { if (pointer.current === e.pointerId) handle(e); }}
    onPointerUp={e => { if (pointer.current === e.pointerId) end(); }} onPointerCancel={end} onLostPointerCapture={end} onContextMenu={e => e.preventDefault()}>
    <span className="steer-arrow left"/><span className="steer-arrow right"/><div className="joystick-knob" style={{ left: `${50 + knob.x * 35}%`, top: `${50 + knob.y * 35}%` }}/>
  </div><span className="lean-backward">{tr('вес назад')}</span></div>;
}
function Hold({ onHold, kind, children }: { onHold: (v: boolean) => void; kind: string; children: string }) {
  const pointer = useRef<number | null>(null);
  const [down, setDown] = useState(false);
  const end = () => { pointer.current = null; setDown(false); onHold(false); };
  return <button className={`pedal ${kind} ${down ? 'pressed' : ''}`} aria-label={children} aria-pressed={down}
    onPointerDown={e => { if (pointer.current !== null) return; pointer.current = e.pointerId; e.currentTarget.setPointerCapture(e.pointerId); setDown(true); onHold(true); }}
    onPointerUp={e => { if (pointer.current === e.pointerId) end(); }} onPointerCancel={end} onLostPointerCapture={end}
    onContextMenu={e => e.preventDefault()}>{children}</button>;
}
export function TouchControls({ onInput }: { onInput: (p: Patch) => void }) {
  useEffect(() => {
    const reset = () => onInput({ throttle: 0, brake: 0, steer: 0, lean: 0, stunt: 0 });
    window.addEventListener('blur', reset);
    document.addEventListener('visibilitychange', reset);
    return () => { window.removeEventListener('blur', reset); document.removeEventListener('visibilitychange', reset); reset(); };
  }, [onInput]);
  return <div className="touch-controls"><Joystick onChange={(steer, lean) => onInput({ steer, lean })}/><div className="pedals"><Hold kind="brake" onHold={v => onInput({ brake: v ? 1 : 0 })}>{tr('ТОРМОЗ')}</Hold><Hold kind="throttle" onHold={v => onInput({ throttle: v ? 1 : 0 })}>{tr('ГАЗ')}</Hold></div></div>;
}
