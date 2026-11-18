import * as THREE from 'three';

// ============================================================================
// Канвас-текстуры города: фасады (дневные + карта свечения окон), витрины,
// крыши, бетон, дерево, гофра, афиши. Все ≤ 512 px, бесшовные при повторе.
// ============================================================================

export type FacadeStyle = 'brick' | 'plaster' | 'concrete' | 'glass' | 'fins';

export const FACADE_PALETTES: Record<FacadeStyle, string[]> = {
  brick: ['#a4553f', '#8f4a3a', '#b5694a', '#9a5a44'],
  plaster: ['#e9dcc3', '#dfc7a0', '#cfd8c4', '#e8c9b8', '#c9d7e3'],
  concrete: ['#b9bcc0', '#a8adb3', '#c9c3b5', '#aeb6bd'],
  glass: ['#4a7fa3', '#3d8c9b', '#5a7fb0', '#45747f'],
  fins: ['#cfc4ae', '#b7c0c4', '#c8b6a4', '#aebdb5'],
};

export const SHOP_SIGN_COLORS = ['#c2410c', '#1d4ed8', '#15803d', '#7e22ce', '#be123c', '#0f766e'];
const SHOP_NAMES = ['CAFÉ', 'SHOP', 'BANK', 'PHARMA', 'DELI', 'BOOKS', 'PIZZA', 'MARKET'];

function rngFactory(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function canvas(w: number, h = w): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

function tex(c: HTMLCanvasElement, srgb = true): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function tint(hex: string, amt: number) {
  const c = new THREE.Color(hex);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  c.setHSL(hsl.h, hsl.s, Math.max(0, Math.min(1, hsl.l + amt)));
  return `#${c.getHexString()}`;
}

const LIT = ['#ffd98a', '#ffe7b0', '#ffc66b', '#cfe6ff'];

export interface FacadeTex {
  map: THREE.CanvasTexture;
  emissive: THREE.CanvasTexture;
}

/** Плитка 256×256 = 4×4 ячейки по 64 px (ячейка ≈ 3 м). */
export function facadeTextures(style: FacadeStyle, base: string, seed = 1): FacadeTex {
  const [c, g] = canvas(256);
  const [ce, ge] = canvas(256);
  ge.fillStyle = '#000';
  ge.fillRect(0, 0, 256, 256);
  const rnd = rngFactory(seed * 977 + style.length * 31);
  const CELL = 64;

  // фон стены
  g.fillStyle = base;
  g.fillRect(0, 0, 256, 256);
  if (style === 'brick') {
    for (let y = 0; y < 256; y += 8) {
      const off = (y / 8) % 2 ? 8 : 0;
      for (let x = -16; x < 256; x += 16) {
        g.fillStyle = tint(base, (rnd() - 0.5) * 0.09);
        g.fillRect(x + off, y, 15, 7);
      }
    }
  } else if (style === 'concrete' || style === 'fins') {
    for (let i = 0; i < 700; i++) {
      g.fillStyle = tint(base, (rnd() - 0.5) * 0.06);
      g.fillRect(rnd() * 256, rnd() * 256, 2 + rnd() * 3, 2 + rnd() * 3);
    }
  } else if (style === 'plaster') {
    for (let i = 0; i < 500; i++) {
      g.fillStyle = tint(base, (rnd() - 0.5) * 0.05);
      g.fillRect(rnd() * 256, rnd() * 256, 3 + rnd() * 5, 3 + rnd() * 5);
    }
  }

  const glassPane = (x: number, y: number, w: number, h: number, lit: boolean, cool: boolean) => {
    const gr = g.createLinearGradient(x, y, x + w * 0.4, y + h);
    gr.addColorStop(0, cool ? '#8fc3dd' : '#6f8fa8');
    gr.addColorStop(0.55, cool ? '#3e6f93' : '#2f4b63');
    gr.addColorStop(1, cool ? '#2a4a66' : '#1f3347');
    g.fillStyle = gr;
    g.fillRect(x, y, w, h);
    if (lit) {
      ge.fillStyle = LIT[(rnd() * LIT.length) | 0];
      ge.fillRect(x, y, w, h);
    }
  };

  for (let cy = 0; cy < 4; cy++) {
    for (let cx = 0; cx < 4; cx++) {
      const x0 = cx * CELL;
      const y0 = cy * CELL;
      const lit = rnd() < 0.5;
      if (style === 'brick') {
        const wx = x0 + 15;
        const wy = y0 + 14;
        g.fillStyle = '#d8d2c4';
        g.fillRect(wx - 3, wy - 6, 40, 5); // перемычка
        g.fillRect(wx - 5, wy + 38, 44, 5); // подоконник
        g.fillStyle = '#f3efe6';
        g.fillRect(wx - 2, wy - 1, 38, 40);
        glassPane(wx + 1, wy + 2, 14, 34, lit, false);
        glassPane(wx + 19, wy + 2, 14, 34, lit, false);
        g.fillStyle = '#7a756b';
        g.fillRect(wx - 5, wy + 43, 44, 1);
      } else if (style === 'plaster') {
        const wx = x0 + 18;
        const wy = y0 + 12;
        g.fillStyle = tint(base, -0.12);
        g.fillRect(wx - 9, wy, 8, 38);
        g.fillRect(wx + 29, wy, 8, 38);
        g.fillStyle = '#ffffff';
        g.fillRect(wx - 2, wy - 2, 32, 42);
        glassPane(wx + 1, wy + 1, 12, 36, lit, true);
        glassPane(wx + 15, wy + 1, 12, 36, lit, true);
        g.fillStyle = '#9a8f80';
        g.fillRect(wx - 4, wy + 40, 36, 4);
        if (cy === 0) {
          g.fillStyle = tint(base, -0.08);
          g.fillRect(x0, y0 + 60, CELL, 4);
        }
      } else if (style === 'concrete') {
        g.fillStyle = tint(base, -0.1);
        g.fillRect(x0, y0, CELL, 1);
        g.fillRect(x0, y0, 1, CELL);
        g.fillStyle = tint(base, -0.18);
        g.fillRect(x0 + 2, y0 + 8, 60, 30);
        glassPane(x0 + 4, y0 + 10, 56, 26, lit, true);
        g.fillStyle = tint(base, -0.2);
        g.fillRect(x0 + 31, y0 + 10, 2, 26);
        g.fillStyle = tint(base, 0.08);
        g.fillRect(x0 + 2, y0 + 38, 60, 3);
      } else if (style === 'glass') {
        glassPane(x0, y0, CELL, CELL, lit && rnd() < 0.7, true);
        g.fillStyle = 'rgba(255,255,255,0.12)';
        g.beginPath();
        g.moveTo(x0, y0 + CELL);
        g.lineTo(x0 + 28, y0);
        g.lineTo(x0 + 44, y0);
        g.lineTo(x0 + 16, y0 + CELL);
        g.fill();
        g.fillStyle = tint(base, -0.04);
        g.fillRect(x0, y0 + 50, CELL, 14); // парапетная панель
        if (lit) {
          ge.fillStyle = '#000';
          ge.fillRect(x0, y0 + 50, CELL, 14);
        }
        g.fillStyle = '#c9d3da';
        g.fillRect(x0, y0, 2, CELL);
        g.fillRect(x0, y0 + 49, CELL, 2);
      } else {
        // fins: вертикальные рёбра и высокие окна
        g.fillStyle = tint(base, 0.06);
        g.fillRect(x0, y0, 10, CELL);
        g.fillRect(x0 + 54, y0, 10, CELL);
        glassPane(x0 + 12, y0 + 4, 40, 50, lit, true);
        g.fillStyle = tint(base, -0.15);
        g.fillRect(x0 + 31, y0 + 4, 2, 50);
        g.fillRect(x0, y0 + 56, CELL, 8);
        if (lit) {
          ge.fillStyle = '#000';
          ge.fillRect(x0 + 31, y0 + 4, 2, 50);
        }
      }
    }
  }
  return { map: tex(c), emissive: tex(ce) };
}

/** Витрина 512×128 ≈ 8×3.2 м: вывеска, стекло, дверь. */
export function shopfrontTextures(variant: number): FacadeTex {
  const K = 200 / 128;
  const [c, g] = canvas(512, 200);
  const [ce, ge] = canvas(512, 200);
  g.scale(1, K);
  ge.scale(1, K);
  const sign = SHOP_SIGN_COLORS[variant % SHOP_SIGN_COLORS.length];
  g.fillStyle = '#3a3f46';
  g.fillRect(0, 0, 512, 128);
  ge.fillStyle = '#000';
  ge.fillRect(0, 0, 512, 128);
  // вывеска
  g.fillStyle = sign;
  g.fillRect(0, 0, 512, 30);
  g.fillStyle = '#ffffff';
  g.font = "700 30px system-ui, Segoe UI, sans-serif";
  g.textBaseline = 'middle';
  g.textAlign = 'center';
  const rnd = rngFactory(variant * 13 + 5);
  for (let i = 0; i < 2; i++) {
    const nm = SHOP_NAMES[(((rnd() * SHOP_NAMES.length) | 0) + variant) % SHOP_NAMES.length];
    g.save();
    g.scale(1, 1 / K);
    g.fillText(nm, 128 + i * 256, 16 * K);
    g.restore();
  }
  // подсвеченная вывеска светится своими цветами, иначе ночью текст сливается в белую полосу
  ge.globalAlpha = 0.6;
  ge.drawImage(g.canvas, 0, 0, 512, 30, 0, 0, 512, 30);
  ge.globalAlpha = 1;
  // стекло витрин
  for (let i = 0; i < 2; i++) {
    const x0 = i * 256;
    const doorX = x0 + (i === 0 ? 170 : 40);
    const gr = g.createLinearGradient(0, 34, 0, 118);
    gr.addColorStop(0, '#9cc0d6');
    gr.addColorStop(0.5, '#4a6a82');
    gr.addColorStop(1, '#27394a');
    g.fillStyle = '#c9ced4';
    g.fillRect(x0 + 6, 32, 244, 92);
    for (let p = 0; p < 3; p++) {
      const px = x0 + 10 + p * 80;
      if (px + 4 >= doorX - 6 && px <= doorX + 40) continue;
      g.fillStyle = gr;
      g.fillRect(px, 36, 76, 82);
      ge.fillStyle = '#ffcf86';
      ge.globalAlpha = 0.55;
      ge.fillRect(px, 36, 76, 82);
      ge.globalAlpha = 1;
    }
    g.fillStyle = '#2d343b';
    g.fillRect(doorX - 4, 34, 48, 90);
    g.fillStyle = gr;
    g.fillRect(doorX, 38, 40, 82);
    g.fillStyle = '#e5e7eb';
    g.fillRect(doorX + 30, 78, 3, 14);
    ge.fillStyle = '#ffcf86';
    ge.globalAlpha = 0.6;
    ge.fillRect(doorX, 38, 40, 82);
    ge.globalAlpha = 1;
  }
  g.fillStyle = '#2b3036';
  g.fillRect(0, 118, 512, 10);
  return { map: tex(c), emissive: tex(ce) };
}

export function roofTexture(kind: 'tar' | 'tile'): THREE.CanvasTexture {
  const [c, g] = canvas(128);
  const rnd = rngFactory(kind === 'tar' ? 3 : 4);
  if (kind === 'tar') {
    g.fillStyle = '#6b6f73';
    g.fillRect(0, 0, 128, 128);
    for (let i = 0; i < 900; i++) {
      g.fillStyle = tint('#6b6f73', (rnd() - 0.5) * 0.14);
      g.fillRect(rnd() * 128, rnd() * 128, 2, 2);
    }
  } else {
    g.fillStyle = '#9b4a34';
    g.fillRect(0, 0, 128, 128);
    for (let y = 0; y < 128; y += 16) {
      for (let x = (y / 16) % 2 ? -8 : 0; x < 128; x += 16) {
        g.fillStyle = tint('#9b4a34', (rnd() - 0.5) * 0.08);
        g.fillRect(x, y, 15, 14);
        g.fillStyle = 'rgba(0,0,0,0.25)';
        g.fillRect(x, y + 14, 15, 2);
      }
    }
  }
  return tex(c);
}

/** Серый бетон/тротуар — оттенок задаётся цветом материала. */
export function concreteTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(128);
  g.fillStyle = '#d4d4d4';
  g.fillRect(0, 0, 128, 128);
  const rnd = rngFactory(9);
  for (let i = 0; i < 1200; i++) {
    const v = 190 + ((rnd() * 50) | 0);
    g.fillStyle = `rgb(${v},${v},${v})`;
    g.fillRect(rnd() * 128, rnd() * 128, 2, 2);
  }
  g.fillStyle = 'rgba(0,0,0,0.18)';
  g.fillRect(0, 0, 128, 1.5);
  g.fillRect(0, 0, 1.5, 128);
  g.fillRect(0, 64, 128, 1);
  g.fillRect(64, 0, 1, 128);
  return tex(c);
}

/** Доски (вдоль U) — оттенок через цвет материала. */
export function woodTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(128);
  const rnd = rngFactory(21);
  for (let y = 0; y < 128; y += 16) {
    const v = 200 + ((rnd() * 40) | 0);
    g.fillStyle = `rgb(${v},${v - 12},${v - 30})`;
    g.fillRect(0, y, 128, 15);
    for (let i = 0; i < 14; i++) {
      g.fillStyle = 'rgba(80,45,20,0.12)';
      g.fillRect(rnd() * 128, y + rnd() * 14, 20 + rnd() * 50, 1);
    }
    g.fillStyle = 'rgba(0,0,0,0.35)';
    g.fillRect(0, y + 15, 128, 1);
  }
  return tex(c);
}

/** Гофрированный металл (контейнеры) — вертикальные рёбра. */
export function ribTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(128);
  for (let x = 0; x < 128; x += 8) {
    const gr = g.createLinearGradient(x, 0, x + 8, 0);
    gr.addColorStop(0, '#9a9a9a');
    gr.addColorStop(0.5, '#ffffff');
    gr.addColorStop(1, '#9a9a9a');
    g.fillStyle = gr;
    g.fillRect(x, 0, 8, 128);
  }
  return tex(c);
}

export function plateTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(128, 64);
  g.fillStyle = '#f4f4ef';
  g.fillRect(0, 0, 128, 64);
  g.fillStyle = '#1d4ed8';
  g.fillRect(0, 0, 14, 64);
  g.fillStyle = '#111827';
  g.font = '700 38px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('K 482 AB', 70, 34);
  const t = tex(c);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

export function adTexture(variant: number, w = 256, h = 256, base?: string): THREE.CanvasTexture {
  const [c, g] = canvas(w, h);
  const pals = [
    ['#f97316', '#fde68a', 'SALE'],
    ['#2563eb', '#bfdbfe', 'GO!'],
    ['#16a34a', '#dcfce7', 'FRESH'],
    ['#9333ea', '#f3e8ff', 'CITY'],
  ];
  const [a0, b, label] = pals[variant % pals.length];
  const a = base ?? a0;
  const gr = g.createLinearGradient(0, 0, w, h);
  gr.addColorStop(0, a);
  gr.addColorStop(1, tint(a, -0.2));
  g.fillStyle = gr;
  g.fillRect(0, 0, w, h);
  g.fillStyle = b;
  g.beginPath();
  g.arc(w * 0.72, h * 0.3, h * 0.22, 0, Math.PI * 2);
  g.fill();
  g.fillRect(w * 0.08, h * 0.62, w * 0.5, h * 0.05);
  g.fillRect(w * 0.08, h * 0.72, w * 0.35, h * 0.05);
  g.fillStyle = '#ffffff';
  g.font = `800 ${Math.round(h * 0.26)}px system-ui, sans-serif`;
  g.textAlign = 'left';
  g.textBaseline = 'middle';
  g.fillText(label, w * 0.08, h * 0.38);
  const t = tex(c);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

export function clockTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(128);
  g.fillStyle = '#f8fafc';
  g.beginPath();
  g.arc(64, 64, 62, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = '#111827';
  g.lineWidth = 3;
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    g.beginPath();
    g.moveTo(64 + Math.sin(a) * 52, 64 - Math.cos(a) * 52);
    g.lineTo(64 + Math.sin(a) * 58, 64 - Math.cos(a) * 58);
    g.stroke();
  }
  g.lineWidth = 5;
  g.beginPath();
  g.moveTo(64, 64);
  g.lineTo(64 + Math.sin(2.2) * 30, 64 - Math.cos(2.2) * 30);
  g.stroke();
  g.lineWidth = 3;
  g.beginPath();
  g.moveTo(64, 64);
  g.lineTo(64 + Math.sin(0.1) * 46, 64 - Math.cos(0.1) * 46);
  g.stroke();
  const t = tex(c);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

/** Меню на борту фудтрака. */
export function menuTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(256, 128);
  g.fillStyle = '#1f2937';
  g.fillRect(0, 0, 256, 128);
  g.fillStyle = '#fde68a';
  g.font = '700 26px system-ui, sans-serif';
  g.textAlign = 'center';
  g.font = '700 22px system-ui, sans-serif';
  g.fillText('TACOS • BURGERS', 128, 36);
  g.fillStyle = '#e5e7eb';
  for (let i = 0; i < 4; i++) g.fillRect(30, 56 + i * 16, 120 + (i % 2) * 40, 5);
  g.fillStyle = '#fbbf24';
  for (let i = 0; i < 4; i++) g.fillRect(200, 56 + i * 16, 28, 5);
  const t = tex(c);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

/** Дорожные знаки: red — «кирпич», yellow — предупреждение, blue — парковка. */
export function roadSignTexture(kind: 'red' | 'yellow' | 'blue'): THREE.CanvasTexture {
  const [c, g] = canvas(128);
  if (kind === 'yellow') {
    const tri = (r: number, col: string) => {
      g.fillStyle = col;
      g.beginPath();
      g.moveTo(64, 64 - r);
      g.lineTo(64 + r * 0.866, 64 + r * 0.5);
      g.lineTo(64 - r * 0.866, 64 + r * 0.5);
      g.closePath();
      g.fill();
    };
    tri(62, '#dc2626');
    tri(50, '#fde047');
    g.fillStyle = '#111827';
    g.fillRect(60, 42, 8, 26);
    g.beginPath();
    g.arc(64, 78, 5, 0, Math.PI * 2);
    g.fill();
  } else {
    g.fillStyle = kind === 'red' ? '#dc2626' : '#f8fafc';
    g.beginPath();
    g.arc(64, 64, 62, 0, Math.PI * 2);
    g.fill();
    if (kind === 'blue') {
      g.fillStyle = '#1d4ed8';
      g.beginPath();
      g.arc(64, 64, 55, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = '#f8fafc';
    if (kind === 'red') g.fillRect(20, 54, 88, 20);
    else {
      g.font = '800 84px system-ui, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText('P', 64, 68);
    }
  }
  const t = tex(c);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}
