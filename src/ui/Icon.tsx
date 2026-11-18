import type { CSSProperties } from 'react';
import type { MapId } from '../game/data';

export type IconName = 'pitbike' | 'settings' | 'eye' | 'replay' | 'city' | 'road' | 'flag' | 'hill' | 'arrow' | 'close' | 'play' | 'pause' | 'reset' | 'chevron' | 'scooter' | 'sliders' | 'brake' | 'rider' | 'rotate' | 'spring' | 'palette' | 'wheel' | 'light' | 'battery' | 'weight' | 'helmet' | 'shirt' | 'camera' | 'motor' | 'sun' | 'sound' | 'touch' | 'gauge' | 'shield' | 'chart' | 'keyboard' | 'info' | 'steering';
const paths: Record<IconName, React.ReactNode> = {
  rotate: <><path d="M3 9c2-5 16-5 18 0s-4 7-9 7H7m0-3-3 3 3 3M12 3v5"/></>,
  spring: <><path d="M7 2h10M7 22h10M12 2v3l-5 2 10 4-10 4 10 4-5 2v1"/></>,
  palette: <><path d="M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 1-3.7 1.5 1.5 0 0 1 1-2.8h3A3 3 0 0 0 21 11a9 9 0 0 0-9-8Z"/><circle cx="7.5" cy="10" r=".8"/><circle cx="11" cy="6.5" r=".8"/><circle cx="16" cy="8" r=".8"/><circle cx="6.5" cy="15" r=".8"/></>,
  wheel: <><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/><path d="m10 10-4-4m8 4 4-4m-4 8 4 4m-8-4-4 4"/></>,
  light: <><path d="M4 5a8 8 0 0 1 0 14Zm7 1h9m-8 6h10m-11 6h9"/></>,
  battery: <><rect x="2" y="6" width="17" height="12" rx="2"/><path d="M22 10v4M7 10v4m5-4v4"/></>,
  weight: <><path d="M8 7h8l4 14H4ZM9 7a3 3 0 1 1 6 0"/></>,
  helmet: <><path d="M3 14V11a9 9 0 0 1 18 0v4l-4 6H6l-3-7Zm0-2h11l-2 5H4m12-5h5M8 21v-4"/></>,
  shirt: <path d="m8 3-6 4 3 5 3-2v11h8V10l3 2 3-5-6-4a4 4 0 0 1-8 0Z"/>,
  camera: <><path d="M3 7h4l2-3h6l2 3h4v14H3Z"/><circle cx="12" cy="13" r="4"/></>,
  motor: <><path d="M6 7h12v13H6ZM3 10v7m18-7v7M9 3h6m-3 0v4"/><path d="m13 10-3 4h4l-3 4"/></>,
  sun: <><circle cx="12" cy="12" r="4"/><path d="M12 1v2m0 18v2M1 12h2m18 0h2M4 4l1.5 1.5m13 13L20 20M4 20l1.5-1.5m13-13L20 4"/></>,
  sound: <><path d="m11 4-6 5H2v6h3l6 5Zm4 4a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/></>,
  touch: <><path d="M9 12V5a2 2 0 0 1 4 0v6l2-2 5 3-1 7-3 3h-5l-7-8a2 2 0 0 1 3-2l2 2"/><path d="M5 6a6 6 0 0 1 12 0"/></>,
  gauge: <><path d="M3 18a10 10 0 1 1 18 0ZM12 14l5-5"/><path d="M5 12h1m1-5 1 1m4-4v1m6 7h1"/></>,
  shield: <><path d="m12 2 8 3v7c0 5-8 10-8 10S4 17 4 12V5Z"/><path d="m8 12 3 3 5-6"/></>,
  chart: <><path d="M3 3v18h18M6 16l5-6 4 3 6-8"/></>,
  keyboard: <><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 9h1m3 0h1m3 0h1m3 0h1M6 12h1m3 0h1m3 0h1m3 0h1M7 16h10"/></>,
  info: <><circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v.1"/></>,
  steering: <><path d="M2 5h5l2 4h6l2-4h5M12 9v13"/><circle cx="12" cy="13" r="2"/></>,
  settings: <><path d="m9 3 .6-2h4.8l.6 2 2 .9 1.9-.6 2.4 4.1-1.4 1.5.1 2.3 1.4 1.5-2.4 4.1-2-.6-2 .9-.6 2H9.6l-.6-2-2-.9-2 .6-2.4-4.1L4 11.2V8.9L2.6 7.4 5 3.3l2 .6Z" transform="translate(0 2) scale(1 .95)"/><circle cx="12" cy="12" r="3.5"/></>,
  eye: <><path d="M2 12s3.5-8 10-8 10 8 10 8-3.5 8-10 8S2 12 2 12Z"/><circle cx="12" cy="12" r="4"/></>,
  replay: <><path d="M3 10h18v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Zm0 0L1.5 5 19 1l1.3 5Z"/><path d="m5 4 3 4m4-6 3 4m-5 7 5 3-5 3Z"/></>,
  city: <><path d="M2 22h20M4 22V10h5V3h6v8h5v11M9 22V11m6 11v-6"/><path d="M11 6h1m-1 3h1m-6 4h1m-1 4h1m4-4h1m-1 4h1m5-3h1m-1 4h1"/></>,
  road: <><path d="m2 21 6-18m14 18L16 3M12 3v3m0 4v4m0 4v3"/></>,
  hill: <><path d="M2 20h20M3 20l6-11 4 6 2-3 6 8"/><path d="M16 4v4m0-4 3 1.2-3 1.3"/></>,
  flag: <><path d="M5 22V2m0 1c5-4 9 4 15 0v11c-6 4-10-4-15 0"/></>,
  arrow: <><path d="M3 12h17m-6-6 6 6-6 6"/></>,
  close: <path d="m5 5 14 14M5 19 19 5"/>,
  play: <path d="m8 4 12 8-12 8Z"/>,
  pause: <path d="M8 4v16M16 4v16"/>,
  reset: <><path d="M3 10a9 9 0 1 1 2 8M3 4v6h6"/></>,
  chevron: <path d="m9 5 7 7-7 7"/>,
  pitbike: <><circle cx="5" cy="17" r="3.5"/><circle cx="19" cy="17" r="3.5"/><path d="M5 17l4-6h6l4 6M9 11l-1-3h3m4 3 2-5h2.5M11 11l1 6h-3"/></>,
  scooter: <><circle cx="5" cy="19" r="3"/><circle cx="20" cy="19" r="3"/><path d="M5 19h9l4-6-2-11h-4m6 11 2 6"/></>,
  sliders: <><path d="M5 2v7m0 6v7M12 2v11m0 6v3M19 2v2m0 6v12M2 9h6m1 10h6m1-15h6"/></>,
  brake: <><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2"/><path d="m9 7 1 1m6 1-1 1m0 6-1-1m-6 0 1-1M4 4l3 3"/></>,
  rider: <><circle cx="12" cy="5" r="3"/><path d="M5 22v-4a7 7 0 0 1 14 0v4"/></>,
};
export const MAP_ICONS: Record<MapId, IconName> = { polygon: 'flag', city: 'city', hill: 'hill' };

export function Icon({ name, size = 24, style }: { name: IconName; size?: number; style?: CSSProperties }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={style}>{paths[name]}</svg>;
}
