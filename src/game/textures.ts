import * as THREE from 'three';
import type { SurfaceId } from './data';

function rngFactory(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mkCanvas(size: number, readback = false): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  // getImageData с GPU-холста каждый раз ждёт видеокарту; программный холст отдаёт пиксели сразу
  return [c, c.getContext('2d', readback ? { willReadFrequently: true } : undefined)!];
}

function finish(c: HTMLCanvasElement, repeat: number, aniso = 8): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = aniso;
  return t;
}

// рисует с учётом бесшовного повтора
function wrapped(size: number, x: number, y: number, m: number, fn: (x: number, y: number) => void) {
  fn(x, y);
  const ox = x < m ? size : x > size - m ? -size : 0;
  const oy = y < m ? size : y > size - m ? -size : 0;
  if (ox) fn(x + ox, y);
  if (oy) fn(x, y + oy);
  if (ox && oy) fn(x + ox, y + oy);
}

function shade(base: [number, number, number], v: number) {
  const r = Math.max(0, Math.min(255, base[0] + v));
  const g = Math.max(0, Math.min(255, base[1] + v));
  const b = Math.max(0, Math.min(255, base[2] + v));
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

/** Попиксельный шум: бесшовен по определению. */
function grain(ctx: CanvasRenderingContext2D, size: number, rnd: () => number, amp: number, tint: [number, number, number] = [1, 1, 1]) {
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = (rnd() - 0.5) * amp;
    d[i] = Math.max(0, Math.min(255, d[i] + v * tint[0]));
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + v * tint[1]));
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + v * tint[2]));
  }
  ctx.putImageData(img, 0, 0);
}

/**
 * Холсты покрытий детерминированы (зерно = id), поэтому генерируются один раз за сессию:
 * смена карты и повторные вызовы получают новую текстуру поверх того же холста.
 */
const surfaceCanvases = new Map<SurfaceId, { canvas: HTMLCanvasElement; roughness: number; meters: number }>();

export function surfaceTexture(
  id: SurfaceId,
  cellMeters: number,
): { map: THREE.CanvasTexture; roughness: number; meters: number } {
  let s = surfaceCanvases.get(id);
  if (!s) surfaceCanvases.set(id, (s = paintSurface(id)));
  return { map: finish(s.canvas, cellMeters / s.meters), roughness: s.roughness, meters: s.meters };
}

function paintSurface(id: SurfaceId): { canvas: HTMLCanvasElement; roughness: number; meters: number } {
  const size = 512;
  const [c, ctx] = mkCanvas(size, true);
  const rnd = rngFactory(id.length * 977 + id.charCodeAt(0) * 31);
  let meters = 6;
  let roughness = 0.9;

  const speckle = (n: number, base: [number, number, number], spread: number, rmin: number, rmax: number) => {
    for (let i = 0; i < n; i++) {
      const x = rnd() * size;
      const y = rnd() * size;
      const r = rmin + rnd() * (rmax - rmin);
      ctx.fillStyle = shade(base, (rnd() - 0.5) * spread);
      wrapped(size, x, y, r + 1, (px, py) => {
        ctx.beginPath();
        ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.fill();
      });
    }
  };
  // мягкие пятна (неравномерность выцветания/износа), бесшовные
  const blotch = (n: number, rgb: string, alpha: number, rmin: number, rmax: number) => {
    for (let i = 0; i < n; i++) {
      const x = rnd() * size;
      const y = rnd() * size;
      const r = rmin + rnd() * (rmax - rmin);
      wrapped(size, x, y, r, (px, py) => {
        const g = ctx.createRadialGradient(px, py, 0, px, py, r);
        g.addColorStop(0, `rgba(${rgb},${alpha})`);
        g.addColorStop(1, `rgba(${rgb},0)`);
        ctx.fillStyle = g;
        ctx.fillRect(px - r, py - r, r * 2, r * 2);
      });
    }
  };
  const crack = (rgb: string, w: number) => {
    let x = rnd() * size;
    let y = rnd() * size;
    let a = rnd() * Math.PI * 2;
    ctx.strokeStyle = rgb;
    ctx.lineWidth = w;
    for (let k = 0; k < 14; k++) {
      const nx = x + Math.cos(a) * (10 + rnd() * 14);
      const ny = y + Math.sin(a) * (10 + rnd() * 14);
      wrapped(size, x, y, 40, (px, py) => {
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px + (nx - x), py + (ny - y));
        ctx.stroke();
      });
      x = nx;
      y = ny;
      a += (rnd() - 0.5) * 1.1;
    }
  };

  switch (id) {
    case 'asphalt': {
      ctx.fillStyle = '#45474b';
      ctx.fillRect(0, 0, size, size);
      blotch(26, '70,72,76', 0.35, 40, 110);
      blotch(18, '30,31,34', 0.3, 30, 90);
      speckle(500, [66, 66, 70], 14, 6, 26);
      // светлый щебень и тёмные вкрапления битума
      speckle(2600, [118, 118, 122], 70, 0.7, 1.5);
      speckle(3000, [36, 36, 40], 30, 0.7, 1.6);
      crack('rgba(20,20,22,0.7)', 1.2);
      crack('rgba(20,20,22,0.55)', 0.9);
      grain(ctx, size, rnd, 22);
      meters = 8;
      roughness = 0.93;
      break;
    }
    case 'wet': {
      ctx.fillStyle = '#25282d';
      ctx.fillRect(0, 0, size, size);
      blotch(26, '60,66,76', 0.3, 40, 110);
      blotch(18, '14,15,18', 0.35, 30, 90);
      speckle(3500, [48, 52, 60], 30, 0.6, 1.4);
      crack('rgba(10,10,12,0.7)', 1.1);
      grain(ctx, size, rnd, 14);
      meters = 8;
      roughness = 0.28;
      break;
    }
    case 'tiles': {
      const n = 4;
      const s = size / n;
      ctx.fillStyle = '#6a6c70';
      ctx.fillRect(0, 0, size, size);
      for (let i = 0; i < n; i++)
        for (let j = 0; j < n; j++) {
          const v = 168 + rnd() * 26;
          const x = i * s + 3;
          const y = j * s + 3;
          const w = s - 6;
          ctx.fillStyle = `rgb(${v},${v + 1},${v + 4})`;
          ctx.fillRect(x, y, w, w);
          // фаска плитки: светлая сверху-слева, тёмная снизу-справа
          ctx.fillStyle = 'rgba(255,255,255,0.22)';
          ctx.fillRect(x, y, w, 2);
          ctx.fillRect(x, y, 2, w);
          ctx.fillStyle = 'rgba(0,0,0,0.18)';
          ctx.fillRect(x, y + w - 2, w, 2);
          ctx.fillRect(x + w - 2, y, 2, w);
          if (rnd() > 0.7) {
            const g = ctx.createRadialGradient(x + rnd() * w, y + rnd() * w, 0, x + w / 2, y + w / 2, w * 0.6);
            g.addColorStop(0, 'rgba(70,62,50,0.16)');
            g.addColorStop(1, 'rgba(70,62,50,0)');
            ctx.fillStyle = g;
            ctx.fillRect(x, y, w, w);
          }
        }
      speckle(2500, [160, 160, 164], 60, 0.6, 1.4);
      grain(ctx, size, rnd, 16);
      meters = 3.2;
      roughness = 0.85;
      break;
    }
    case 'cobble': {
      ctx.fillStyle = '#34312e';
      ctx.fillRect(0, 0, size, size);
      const rows = 12;
      const h = size / rows;
      for (let j = 0; j < rows; j++) {
        const cols = 10;
        const w = size / cols;
        const off = j % 2 ? w / 2 : 0;
        for (let i = -1; i < cols + 1; i++) {
          const v = 100 + rnd() * 60;
          const warm = rnd() * 14;
          const x = i * w + off + 2.5 + (rnd() - 0.5) * 2;
          const y = j * h + 2.5 + (rnd() - 0.5) * 2;
          const sw = w - 5;
          const sh = h - 5;
          wrapped(size, x, y, w, (px, py) => {
            const g = ctx.createLinearGradient(px, py, px + sw, py + sh);
            g.addColorStop(0, `rgb(${v + 22 + warm},${v + 18},${v + 8})`);
            g.addColorStop(1, `rgb(${v - 16 + warm},${v - 18},${v - 24})`);
            ctx.fillStyle = g;
            ctx.beginPath();
            ctx.roundRect(px, py, sw, sh, 10);
            ctx.fill();
          });
        }
      }
      speckle(3000, [120, 116, 110], 80, 0.6, 1.4);
      grain(ctx, size, rnd, 18);
      meters = 2.4;
      roughness = 0.95;
      break;
    }
    case 'gravel': {
      ctx.fillStyle = '#85807a';
      ctx.fillRect(0, 0, size, size);
      blotch(30, '110,104,96', 0.3, 30, 80);
      speckle(2200, [170, 164, 154], 100, 2, 5);
      speckle(2200, [100, 96, 90], 100, 1.5, 4);
      speckle(9000, [140, 134, 126], 130, 0.8, 2.2);
      grain(ctx, size, rnd, 30);
      meters = 3;
      roughness = 1;
      break;
    }
    case 'dirt': {
      ctx.fillStyle = '#6b4e33';
      ctx.fillRect(0, 0, size, size);
      blotch(30, '120,88,56', 0.35, 40, 100);
      blotch(20, '60,42,26', 0.3, 30, 80);
      speckle(900, [112, 82, 54], 50, 6, 22);
      speckle(5000, [100, 72, 46], 80, 1, 3.5);
      speckle(400, [150, 138, 120], 60, 1.5, 3);
      grain(ctx, size, rnd, 24, [1, 0.9, 0.7]);
      meters = 6;
      roughness = 1;
      break;
    }
    case 'grass': {
      ctx.fillStyle = '#477532';
      ctx.fillRect(0, 0, size, size);
      blotch(34, '96,140,56', 0.4, 40, 110);
      blotch(26, '40,84,36', 0.35, 40, 100);
      blotch(8, '150,140,70', 0.2, 30, 70);
      for (let i = 0; i < 11000; i++) {
        const x = rnd() * size;
        const y = rnd() * size;
        const l = 5 + rnd() * 10;
        const a = -Math.PI / 2 + (rnd() - 0.5) * 0.9;
        ctx.strokeStyle = shade([72, 126, 50], (rnd() - 0.4) * 80);
        ctx.lineWidth = 1.1 + rnd() * 0.6;
        wrapped(size, x, y, 14, (px, py) => {
          ctx.beginPath();
          ctx.moveTo(px, py);
          ctx.lineTo(px + Math.cos(a) * l, py + Math.sin(a) * l);
          ctx.stroke();
        });
      }
      grain(ctx, size, rnd, 14, [0.6, 1, 0.5]);
      meters = 5;
      roughness = 1;
      break;
    }
    case 'sand': {
      ctx.fillStyle = '#d6c08c';
      ctx.fillRect(0, 0, size, size);
      blotch(30, '232,214,168', 0.35, 40, 110);
      blotch(20, '170,140,92', 0.2, 40, 100);
      speckle(7000, [214, 192, 138], 60, 0.6, 1.8);
      ctx.lineWidth = 3;
      for (let i = 0; i < 16; i++) {
        ctx.strokeStyle = i % 2 ? 'rgba(160,130,80,0.16)' : 'rgba(255,240,200,0.14)';
        ctx.beginPath();
        for (let x = 0; x <= size; x += 16) {
          const y = (i + 0.5) * (size / 16) + Math.sin((x / size) * Math.PI * 4 + i) * 5;
          if (x === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      grain(ctx, size, rnd, 22, [1, 0.95, 0.8]);
      meters = 8;
      roughness = 1;
      break;
    }
    case 'snow': {
      ctx.fillStyle = '#e8eff4';
      ctx.fillRect(0, 0, size, size);
      blotch(30, '200,218,235', 0.35, 40, 110);
      speckle(600, [210, 226, 238], 30, 10, 40);
      speckle(5000, [244, 248, 253], 25, 0.8, 2);
      grain(ctx, size, rnd, 10);
      meters = 7;
      roughness = 0.75;
      break;
    }
  }
  return { canvas: c, roughness, meters };
}

export function stripesTexture(a: string, b: string, count = 1): THREE.CanvasTexture {
  const [c, ctx] = mkCanvas(64);
  ctx.fillStyle = a;
  ctx.fillRect(0, 0, 64, 64);
  ctx.fillStyle = b;
  ctx.fillRect(0, 0, 64, 32);
  const t = finish(c, 1, 4);
  t.repeat.set(1, count);
  return t;
}

export function windowsTexture(): THREE.CanvasTexture {
  const [c, ctx] = mkCanvas(128);
  ctx.fillStyle = '#1a2230';
  ctx.fillRect(0, 0, 128, 128);
  const rnd = rngFactory(7);
  for (let y = 4; y < 128; y += 12)
    for (let x = 4; x < 128; x += 12) {
      ctx.fillStyle = rnd() > 0.55 ? '#ffd98a' : '#2a3548';
      ctx.fillRect(x, y, 7, 8);
    }
  const t = finish(c, 1, 4);
  return t;
}

const UI_FONT = 'system-ui, Segoe UI, Roboto, sans-serif';

/**
 * Вывеска района. mode 'hud' — фиксированная плашка 4:1 (полигон/горы), 'sign' — компактная
 * городская табличка, ширина подгоняется под текст. Текст всегда вписывается в холст.
 * Соотношение сторон лежит в texture.userData.aspect.
 */
export function labelTexture(text: string, icon: string, mode: 'hud' | 'sign' = 'hud'): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  let aspect = 4;
  if (mode === 'hud') {
    const w = 768;
    const h = 192;
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = 'rgba(12,14,18,0.82)';
    ctx.beginPath();
    ctx.roundRect(8, 8, w - 16, h - 16, 36);
    ctx.fill();
    ctx.strokeStyle = '#ff6a13';
    ctx.lineWidth = 8;
    ctx.stroke();
    const full = `${icon} ${text}`;
    let fs = 84;
    ctx.font = `700 ${fs}px ${UI_FONT}`;
    const maxW = w - 72;
    const mw = ctx.measureText(full).width;
    if (mw > maxW) {
      fs = Math.max(24, Math.floor((fs * maxW) / mw));
      ctx.font = `700 ${fs}px ${UI_FONT}`;
    }
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(full, w / 2, h / 2 + 4);
  } else {
    const h = 128;
    const fs = 54;
    const probe = document.createElement('canvas').getContext('2d')!;
    probe.font = `600 ${fs}px ${UI_FONT}`;
    const tw = Math.ceil(probe.measureText(text).width);
    probe.font = `${fs}px ${UI_FONT}`;
    const iw = Math.ceil(probe.measureText(icon).width);
    const padX = 34;
    const gap = 26;
    // ограничиваем ширину; сверх лимита текст сжимается по горизонтали
    const maxText = 1280 - padX * 2 - iw - gap - 40;
    const textW = Math.min(tw, maxText);
    const w = Math.min(2048, padX + iw + gap + textW + padX + 20);
    c.width = w;
    c.height = h;
    aspect = w / h;
    const ctx = c.getContext('2d')!;
    // тень-подложка и корпус таблички
    ctx.fillStyle = 'rgba(6,10,14,0.35)';
    ctx.beginPath();
    ctx.roundRect(4, 8, w - 8, h - 8, 18);
    ctx.fill();
    const g = ctx.createLinearGradient(0, 4, 0, h - 8);
    g.addColorStop(0, '#1f3a52');
    g.addColorStop(1, '#10222f');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.roundRect(4, 4, w - 8, h - 12, 18);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.roundRect(11, 11, w - 22, h - 26, 12);
    ctx.stroke();
    // акцентная полоса
    ctx.fillStyle = '#ff6a13';
    ctx.fillRect(22, h - 28, w - 44, 4);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.font = `${fs}px ${UI_FONT}`;
    ctx.fillStyle = '#ffffff';
    ctx.fillText(icon, padX, h / 2 - 6);
    ctx.font = `600 ${fs}px ${UI_FONT}`;
    ctx.save();
    ctx.translate(padX + iw + gap, h / 2 - 5);
    if (tw > textW) ctx.scale(textW / tw, 1);
    ctx.fillText(text, 0, 0);
    ctx.restore();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  t.userData.aspect = aspect;
  return t;
}

/** Фасад дальних зданий: светлая «карта цвета» (тонируется вершинным цветом) + карта ночных окон. 8×8 ячеек: 4 м × 3.6 м. */
export function facadeTextures(): { map: THREE.CanvasTexture; emissive: THREE.CanvasTexture } {
  const size = 256;
  const cell = size / 8;
  const [c, ctx] = mkCanvas(size);
  const [e, ectx] = mkCanvas(size);
  const rnd = rngFactory(41);
  ctx.fillStyle = '#dcdfe3';
  ctx.fillRect(0, 0, size, size);
  ectx.fillStyle = '#000';
  ectx.fillRect(0, 0, size, size);
  for (let j = 0; j < 8; j++)
    for (let i = 0; i < 8; i++) {
      const x = i * cell + 5;
      const y = j * cell + 6;
      const w = cell - 10;
      const h = cell - 13;
      const g = ctx.createLinearGradient(0, y, 0, y + h);
      g.addColorStop(0, '#6f8fae');
      g.addColorStop(1, '#2c3f55');
      ctx.fillStyle = g;
      ctx.fillRect(x, y, w, h);
      ctx.fillStyle = 'rgba(255,255,255,0.28)';
      ctx.fillRect(x, y, w, 2);
      ctx.fillStyle = '#b4b8be';
      ctx.fillRect(x - 1, y + h, w + 2, 3);
      if (rnd() > 0.55) {
        ectx.fillStyle = rnd() > 0.2 ? '#ffd68a' : '#bfe0ff';
        ectx.fillRect(x, y, w, h);
      }
    }
  const map = finish(c, 1, 8);
  const emissive = finish(e, 1, 8);
  return { map, emissive };
}

/** Стрелка разметки (белая на прозрачном): прямо / поворот. Острие вверх по локальной -Z. */
export function roadArrowTexture(kind: 'straight' | 'left' | 'right'): THREE.CanvasTexture {
  const [c, ctx] = mkCanvas(128);
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 14;
  ctx.lineJoin = 'miter';
  const head = (x: number, y: number, dx: number, dy: number) => {
    const px = -dy;
    const py = dx;
    ctx.beginPath();
    ctx.moveTo(x + dx * 26, y + dy * 26);
    ctx.lineTo(x + px * 26, y + py * 26);
    ctx.lineTo(x - px * 26, y - py * 26);
    ctx.closePath();
    ctx.fill();
  };
  if (kind === 'straight') {
    ctx.beginPath();
    ctx.moveTo(64, 118);
    ctx.lineTo(64, 40);
    ctx.stroke();
    head(64, 40, 0, -1);
  } else {
    const s = kind === 'left' ? -1 : 1;
    ctx.beginPath();
    ctx.moveTo(64, 118);
    ctx.lineTo(64, 64);
    ctx.lineTo(64 + s * 30, 40);
    ctx.stroke();
    head(64 + s * 34, 36, s * 0.8, -0.6);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

export function glowTexture(): THREE.CanvasTexture {
  const [c, ctx] = mkCanvas(128);
  const g = ctx.createRadialGradient(64, 64, 4, 64, 64, 62);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.45)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  return t;
}

export function deckGripTexture(modelLabel: string, accent: string): THREE.CanvasTexture {
  const w = 1024;
  const h = 384;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;

  // Основная текстура резинового коврика
  ctx.fillStyle = '#15171b';
  ctx.fillRect(0, 0, w, h);

  // Мелкая противоскользящая сетка
  ctx.fillStyle = '#1f2228';
  for (let y = 16; y < h - 16; y += 10) {
    for (let x = 20; x < w - 20; x += 10) {
      const off = (y / 10) % 2 === 0 ? 0 : 5;
      ctx.fillRect(x + off, y, 5, 5);
    }
  }

  // Диагональные водоотводные ламели протектора коврика
  ctx.strokeStyle = '#0c0d10';
  ctx.lineWidth = 10;
  for (let i = -3; i < 12; i++) {
    const x0 = i * 95;
    // верхняя половина
    ctx.beginPath();
    ctx.moveTo(x0, 26);
    ctx.lineTo(x0 + 70, h * 0.36);
    ctx.stroke();
    // нижняя половина
    ctx.beginPath();
    ctx.moveTo(x0, h - 26);
    ctx.lineTo(x0 + 70, h * 0.64);
    ctx.stroke();
  }

  // Боковые акцентные канты на коврике
  ctx.strokeStyle = accent;
  ctx.lineWidth = 6;
  ctx.strokeRect(18, 18, w - 36, h - 36);

  // Центральная плашка с логотипом KUKIRIN
  ctx.fillStyle = '#101216';
  ctx.beginPath();
  ctx.roundRect(w * 0.2, h * 0.32, w * 0.6, h * 0.36, 18);
  ctx.fill();
  ctx.strokeStyle = accent;
  ctx.lineWidth = 4;
  ctx.stroke();

  ctx.fillStyle = accent;
  ctx.font = '900 62px "Arial Black", Impact, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`KUKIRIN ${modelLabel}`, w * 0.5, h * 0.5 + 2);

  // Шляпки болтов по краям деки
  ctx.fillStyle = '#383d47';
  const bolts = [45, 240, 512, 784, 979];
  for (const bx of bolts) {
    for (const by of [34, h - 34]) {
      ctx.beginPath();
      ctx.arc(bx, by, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#14161a';
      ctx.beginPath();
      ctx.arc(bx, by, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#383d47';
    }
  }

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

export function decalTexture(text: string, accent: string, _dark: boolean): THREE.CanvasTexture {
  const w = 640;
  const h = 140;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, w, h);

  // Гоночные шевроны и полоса
  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.moveTo(12, h - 18);
  ctx.lineTo(w - 20, h - 18);
  ctx.lineTo(w - 8, h - 10);
  ctx.lineTo(12, h - 10);
  ctx.closePath();
  ctx.fill();

  // Шашечки / полосы справа
  const x0 = w - 175;
  for (let i = 0; i < 5; i++) {
    ctx.fillStyle = i % 2 === 0 ? accent : 'rgba(255,255,255,0.85)';
    ctx.beginPath();
    ctx.moveTo(x0 + i * 28, 22);
    ctx.lineTo(x0 + i * 28 + 18, 22);
    ctx.lineTo(x0 + i * 28 - 4, h - 28);
    ctx.lineTo(x0 + i * 28 - 22, h - 28);
    ctx.closePath();
    ctx.fill();
  }

  // Надпись KUKIRIN + модель
  ctx.fillStyle = '#ffffff';
  ctx.font = '800 28px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('KUKIRIN PERFORMANCE', 18, 14);

  ctx.fillStyle = accent;
  ctx.font = `900 ${text.length > 3 ? 66 : 76}px "Arial Black", Impact, system-ui, sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 16, h * 0.62);

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

export function stemDecalTexture(accent: string, text: string): THREE.CanvasTexture {
  const w = 512;
  const h = 80;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = accent;
  ctx.font = '900 44px "Arial Black", Impact, system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(text.toUpperCase(), 12, h / 2 + 2);
  const s = 13;
  for (let i = 0; i < 6; i++)
    for (let j = 0; j < 3; j++) if ((i + j) % 2 === 0) ctx.fillRect(w - 96 + i * s, 16 + j * s, s - 2, s - 2);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Полоса дороги с разметкой (поперёк — ширина дороги, вдоль — период 6 м). Для продолжения улиц за ареной. */
export function roadStripTexture(width: number): THREE.CanvasTexture {
  const w = 512;
  const ppm = w / width;
  const h = Math.round(6 * ppm);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  const base = surfaceTexture('asphalt', 1).map.image as HTMLCanvasElement;
  const pat = ctx.createPattern(base, 'repeat')!;
  const k = (8 * ppm) / base.width;
  pat.setTransform(new DOMMatrix().scale(k, k));
  ctx.fillStyle = pat;
  ctx.fillRect(0, 0, w, h);
  const X = (m: number) => w / 2 + m * ppm;
  const line = (m: number, wid: number, col: string, y0 = 0, y1 = h) => {
    ctx.fillStyle = col;
    ctx.fillRect(X(m) - (wid * ppm) / 2, y0, wid * ppm, y1 - y0);
  };
  const edge = width / 2 - 2;
  line(-edge, 0.14, 'rgba(240,240,240,0.9)');
  line(edge, 0.14, 'rgba(240,240,240,0.9)');
  if (width > 16) {
    line(-0.2, 0.12, '#f2c200', 0, h * 0.97);
    line(0.2, 0.12, '#f2c200', 0, h * 0.97);
    for (const s of [-1, 1]) {
      line(s * 3.6, 0.13, 'rgba(240,240,240,0.92)', h * 0.1, h * 0.57);
      ctx.fillStyle = 'rgba(16,185,129,0.9)';
      ctx.fillRect(X(s * 7.8) - 0.7 * ppm, 0, 1.4 * ppm, h);
    }
  } else {
    line(0, 0.13, '#f2c200', h * 0.1, h * 0.57);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  t.userData.period = 6;
  return t;
}
