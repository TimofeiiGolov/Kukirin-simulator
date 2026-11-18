import { useEffect, useRef } from 'react';
import { LANGS, type Lang } from '../i18n';

/** Стартовый выбор языка: показывается, пока язык не сохранён в настройках. */
export function LanguageGate({ suggested, onPick }: { suggested: Lang; onPick: (lang: Lang) => void }) {
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => { first.current?.focus(); }, []);
  return (
    <div className="language-gate" role="dialog" aria-modal="true" aria-label="Language · Язык · Język">
      <div className="language-card">
        <span className="eyebrow">KUKIRIN SIM</span>
        <h1>Language · Язык · Język</h1>
        <div className="language-options">
          {LANGS.map((l) => (
            <button key={l.id} ref={l.id === suggested ? first : undefined} className={l.id === suggested ? 'suggested' : ''} onClick={() => onPick(l.id)}>
              <span>{l.short}</span>
              <strong>{l.label}</strong>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
