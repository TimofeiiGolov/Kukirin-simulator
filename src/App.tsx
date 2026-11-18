import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DEFAULT_SETTINGS,
  DEFAULT_TUNE,
  MAPS,
  MAP_ORDER,
  MODELS,
  defaultLook,
  presetForSurface,
  type Look,
  type ModeId,
  type Settings,
  type SimInput,
  type SurfaceId,
  type Telemetry,
  type Tune,
} from './game/data';
import { Game, type GameAction } from './game/game';
import { detectLang, isLang, setLang } from './i18n';
import { Garage } from './ui/Garage';
import { Hud } from './ui/Hud';
import { LanguageGate } from './ui/LanguageGate';
import { TouchControls } from './ui/TouchControls';

const STORE = 'kukirin-sim-v1';

function load<T extends object>(key: string, def: T): T {
  try {
    const raw = localStorage.getItem(`${STORE}:${key}`);
    if (raw) return { ...def, ...(JSON.parse(raw) as Partial<T>) };
  } catch {
    /* ignore */
  }
  return def;
}

const MODES: ModeId[] = ['eco', 'drive', 'sport'];
const BROWSER_LANG = detectLang();

export default function App() {
  const containerRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<Game | null>(null);
  const previewActiveRef = useRef(true);
  const onGaragePreviewChange = useCallback((active: boolean) => {
    previewActiveRef.current = active;
    gameRef.current?.setGaragePreviewActive(active);
  }, []);

  const [look, setLook] = useState<Look>(() => {
    const loaded = load('look', defaultLook('g2'));
    return MODELS[loaded.model] ? loaded : defaultLook('g2');
  });
  const [tune, setTune] = useState<Tune>(() => load('tune', DEFAULT_TUNE));
  const [settings, setSettings] = useState<Settings>(() => {
    const loaded = load('settings', DEFAULT_SETTINGS);
    return {
      ...loaded,
      lang: isLang(loaded.lang) ? loaded.lang : undefined,
      map: MAPS[loaded.map] ? loaded.map : DEFAULT_SETTINGS.map,
      fpsCap: ([0, 30, 60] as const).includes(loaded.fpsCap) ? loaded.fpsCap : DEFAULT_SETTINGS.fpsCap,
    };
  });
  // До первого выбора интерфейс показывается на языке браузера
  setLang(settings.lang ?? BROWSER_LANG);
  const [menuOpen, setMenuOpen] = useState(true);
  const [tel, setTel] = useState<Telemetry | null>(null);

  const lookRef = useRef(look);
  const tuneRef = useRef(tune);
  const settingsRef = useRef(settings);
  const menuRef = useRef(menuOpen);
  lookRef.current = look;
  tuneRef.current = tune;
  settingsRef.current = settings;
  menuRef.current = menuOpen;

  const updLook = useCallback((p: Partial<Look>) => setLook((l) => ({ ...l, ...p })), []);
  const updTune = useCallback((p: Partial<Tune>) => setTune((t) => ({ ...t, ...p })), []);
  const updSet = useCallback((p: Partial<Settings>) => setSettings((s) => ({ ...s, ...p })), []);

  const actionRef = useRef<(a: GameAction) => void>(() => {});
  actionRef.current = (a) => {
    if (a === 'camera') setSettings((s) => ({ ...s, camera: s.camera === 'tpv' ? 'fpv' : 'tpv' }));
    else if (a === 'mode') setSettings((s) => ({ ...s, mode: MODES[(MODES.indexOf(s.mode) + 1) % 3] }));
    else if (a === 'map') setSettings((s) => ({ ...s, map: MAP_ORDER[(MAP_ORDER.indexOf(s.map ?? 'city') + 1) % MAP_ORDER.length] }));
    else if (a === 'menu') setMenuOpen((o) => !o);
    else if (a === 'recover') gameRef.current?.recover();
    else if (a === 'replay') gameRef.current?.startReplay();
    else if (a === 'replayPause') gameRef.current?.toggleReplayPause();
    else if (a === 'replaySlowMo') gameRef.current?.cycleReplaySlowMo();
    else if (a === 'replayCam') gameRef.current?.cycleReplayCam();
    else if (a === 'xray') setSettings((s) => ({ ...s, xray: !s.xray }));
  };

  // создание игры
  useEffect(() => {
    const g = new Game(containerRef.current!, setTel, (a) => actionRef.current(a));
    gameRef.current = g;
    if (import.meta.env.DEV) (window as unknown as { __game?: Game }).__game = g;
    g.setPaused(menuRef.current);
    g.setGaragePreviewActive(previewActiveRef.current);
    g.setConfig(lookRef.current, tuneRef.current, settingsRef.current);
    g.setLayout(window.innerWidth > window.innerHeight ? 'right' : 'bottom');
    const onResize = () => g.setLayout(window.innerWidth > window.innerHeight ? 'right' : 'bottom');
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      g.dispose();
      gameRef.current = null;
    };
  }, []);

  // конфигурация
  useEffect(() => {
    gameRef.current?.setConfig(look, tune, settings);
  }, [look, tune, settings]);

  useEffect(() => {
    const g = gameRef.current;
    if (!g) return;
    Object.assign(g.touch, { throttle: 0, steer: 0, lean: 0, brake: 0, brakeF: 0, brakeR: 0, stunt: 0 });
    g.setPaused(menuOpen);
    g.setConfig(lookRef.current, tuneRef.current, settingsRef.current);
  }, [menuOpen]);

  // сохранение
  useEffect(() => {
    try {
      localStorage.setItem(`${STORE}:look`, JSON.stringify(look));
      localStorage.setItem(`${STORE}:tune`, JSON.stringify(tune));
      localStorage.setItem(`${STORE}:settings`, JSON.stringify(settings));
    } catch {
      /* ignore */
    }
  }, [look, tune, settings]);

  // авто-профиль по покрытию (срабатывает только при смене покрытия или включении тумблера)
  const surface: SurfaceId = tel?.surface ?? 'asphalt';
  const prevSurfaceRef = useRef<SurfaceId>(surface);
  const prevAutoRef = useRef<boolean>(settings.autoProfile);
  useEffect(() => {
    const surfChanged = prevSurfaceRef.current !== surface;
    const autoTurnedOn = !prevAutoRef.current && settings.autoProfile;
    prevSurfaceRef.current = surface;
    prevAutoRef.current = settings.autoProfile;
    if (settings.autoProfile && (surfChanged || autoTurnedOn)) {
      updTune(presetForSurface(surface).tune);
    }
  }, [surface, settings.autoProfile, updTune]);

  const touchOn =
    settings.touch === 'on' ||
    (settings.touch === 'auto' && typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches);

  const onTouchInput = useCallback((p: Partial<SimInput>) => {
    const g = gameRef.current;
    if (g) Object.assign(g.touch, p);
  }, []);

  return (
    <div className="fixed inset-0 bg-black overflow-hidden">
      <div ref={containerRef} className="absolute inset-0" />
      {!menuOpen && (
        <Hud
          tel={tel}
          model={look.model}
          settings={settings}
          onCamera={() => actionRef.current('camera')}
          onMenu={() => setMenuOpen(true)}
          onMode={() => actionRef.current('mode')}
          onMap={() => actionRef.current('map')}
          onRecover={() => actionRef.current('recover')}
          onReplay={() => actionRef.current('replay')}
          onReplayPause={() => actionRef.current('replayPause')}
          onReplaySlowMo={() => actionRef.current('replaySlowMo')}
          onReplayCam={() => actionRef.current('replayCam')}
          onXray={() => actionRef.current('xray')}
          onReplaySeek={(norm01) => gameRef.current?.seekReplay(norm01)}
        />
      )}
      {!menuOpen && touchOn && !tel?.replayActive && !tel?.crashed && <TouchControls onInput={onTouchInput} />}
      {menuOpen && (
        <Garage
          look={look}
          tune={tune}
          settings={settings}
          surface={surface}
          updLook={updLook}
          setLook={setLook}
          updTune={updTune}
          updSet={updSet}
          onClose={() => setMenuOpen(false)}
          onRespawn={() => {
            gameRef.current?.respawn();
            setMenuOpen(false);
          }}
          onPreviewChange={onGaragePreviewChange}
          onFocusPart={(part) => gameRef.current?.focusGaragePart(part)}
        />
      )}
      {!settings.lang && <LanguageGate suggested={BROWSER_LANG} onPick={(lang) => updSet({ lang })} />}
    </div>
  );
}
