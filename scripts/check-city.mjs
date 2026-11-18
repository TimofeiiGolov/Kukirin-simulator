// Аудит данных карты «Город»: габариты, проезды, рельеф, размещение мелких объектов.
// Физика считает все боксы осевыми (rotY игнорируется), поэтому проверяем именно AABB halfX/halfZ.
import { createServer } from 'vite';

const server = await createServer({ configFile: false, cacheDir: 'node_modules/.vite-physics-check', optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', logLevel: 'error' });

const errors = [];
const warns = [];
const fail = (m) => errors.push(m);
const cap = (arr, n = 12) => (arr.length > n ? [...arr.slice(0, n), `… и ещё ${arr.length - n}`] : arr);

try {
  const T = await server.ssrLoadModule('/src/game/terrain.ts');
  const { HALF, isCityRoad, isCitySidewalk, surfaceAtCity, macroHeightCity, CITY_SPEED_BUMPS, CITY_RAMPS, CITY_CONES, CITY_SIGNS } = T;
  const terrain = T.createTerrain('city');
  const { boxes, obstacles } = terrain;
  const spawn = terrain.spawn;
  const fmt = (o) => `${o.kind}@(${o.x.toFixed(1)},${o.z.toFixed(1)})`;

  // Допустимые «на проезжей части» боксы: только припаркованные машины у бордюра.
  const ROAD_OK = new Set(['car']);
  const KERB_REACH = 3.6; // машина должна стоять не дальше этого от края проезжей части
  const RIDER_R = 0.3;

  // Зоны, которые должны оставаться свободными: зебры на перекрёстках и полосы СИМ у бордюра.
  const crossings = [[0, 0, 7, 7], [-90, 0, 7, 5.6], [90, 0, 7, 5.6], [0, -90, 5.6, 7], [0, 90, 5.6, 7]];
  const inCrosswalk = (x, z, pad = 0) => {
    for (const [ix, iz, sx, sz] of crossings) {
      for (const s of [-1, 1]) {
        if (Math.abs(x - (ix + s * 11.5)) < 1.7 + pad && Math.abs(z - iz) < sx + 0.6 + pad) return true;
        if (Math.abs(z - (iz + s * 11.5)) < 1.7 + pad && Math.abs(x - ix) < sz + 0.6 + pad) return true;
      }
    }
    return false;
  };
  // Зелёная полоса СИМ (|z| или |x| в 7.0..8.5 на проспектах)
  const inBikeLane = (x, z) => {
    const nearJ = (a) => [0, 90, -90].some((j) => Math.abs(a - j) < 12);
    if (Math.abs(Math.abs(z) - 7.75) < 0.75 && Math.abs(x) < 168 && !nearJ(x)) return true;
    if (Math.abs(Math.abs(x) - 7.75) < 0.75 && Math.abs(z) < 168 && !nearJ(z)) return true;
    return false;
  };

  const rectOverlap = (a, b, pad = 0) =>
    Math.abs(a.x - b.x) < a.halfX + b.halfX - 1e-3 + pad && Math.abs(a.z - b.z) < a.halfZ + b.halfZ - 1e-3 + pad;
  const circleRect = (o, b, pad = 0) => {
    const cx = Math.max(b.x - b.halfX, Math.min(o.x, b.x + b.halfX));
    const cz = Math.max(b.z - b.halfZ, Math.min(o.z, b.z + b.halfZ));
    return Math.hypot(o.x - cx, o.z - cz) < o.r + pad - 1e-3;
  };
  const roadInRect = (x0, x1, z0, z1, step = 0.25) => {
    const pts = [];
    for (let x = x0; x <= x1 + 1e-6; x += step) for (let z = z0; z <= z1 + 1e-6; z += step) if (isCityRoad(x, z)) pts.push([x, z]);
    return pts;
  };
  const distToNonRoad = (x, z, reach) => {
    for (let d = 0.2; d <= reach; d += 0.2) {
      for (let a = 0; a < 16; a++) {
        const ang = (a / 16) * Math.PI * 2;
        if (!isCityRoad(x + Math.cos(ang) * d, z + Math.sin(ang) * d)) return d;
      }
    }
    return Infinity;
  };

  // --- 1. Боксы: арена, дорога, пересечения ---
  for (const b of boxes) {
    if (Math.abs(b.x) + b.halfX > HALF || Math.abs(b.z) + b.halfZ > HALF) fail(`бокс за пределами арены: ${fmt(b)}`);
    if (!(b.halfX > 0 && b.halfZ > 0 && b.h > 0)) fail(`бокс с нулевым габаритом: ${fmt(b)}`);
    if (!b.label) fail(`у бокса нет label: ${fmt(b)}`);
    const road = roadInRect(b.x - b.halfX, b.x + b.halfX, b.z - b.halfZ, b.z + b.halfZ);
    if (road.length) {
      if (!ROAD_OK.has(b.kind)) fail(`бокс на проезжей части: ${fmt(b)} (${road.length} точек)`);
      else {
        const far = road.find(([x, z]) => distToNonRoad(x, z, KERB_REACH) === Infinity);
        if (far) fail(`машина выступает в проезжую часть дальше ${KERB_REACH} м от бордюра: ${fmt(b)}`);
        if (road.some(([x, z]) => inBikeLane(x, z))) fail(`машина стоит на полосе СИМ: ${fmt(b)}`);
        if (road.some(([x, z]) => inCrosswalk(x, z))) fail(`машина на пешеходном переходе: ${fmt(b)}`);
      }
    }
    // шаг рельефа под боксом
    const corners = [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sz]) => macroHeightCity(b.x + sx * b.halfX, b.z + sz * b.halfZ));
    const spread = Math.max(...corners) - Math.min(...corners);
    if (spread > 0.6) fail(`бокс на неровной земле (перепад ${spread.toFixed(2)} м): ${fmt(b)}`);
  }
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) if (rectOverlap(boxes[i], boxes[j])) fail(`боксы пересекаются: ${fmt(boxes[i])} ↔ ${fmt(boxes[j])}`);

  // «Невидимые стены»: коллайдер сильно больше разумного габарита
  const MAXFOOT = { building: 14, car: 6, bench: 1.2, busstop: 2.6, kiosk: 2.5, planter: 2.6, bikerack: 1.4, foodtruck: 3.2, gazebo: 3.2, picnic: 1.2, billboard: 3.5, playground: 3.5, stall: 2, fountain: 4, ledge: 3.4, monument: 2 };
  for (const b of boxes) {
    const m = MAXFOOT[b.kind];
    if (m && Math.max(b.halfX, b.halfZ) > m) fail(`слишком большой коллайдер для ${b.kind}: ${fmt(b)} half=${b.halfX}x${b.halfZ}`);
  }

  // --- 2. Круглые препятствия ---
  const OBS_MAX_R = { tree: 0.5, lamp: 0.3, sign: 0.3, hydrant: 0.3, bin: 0.4, bollard: 0.25, flag: 0.2, umbrella: 0.2, roadsign: 0.2, bush: 0.9, pole: 0.3, mailbox: 0.45, parkingmeter: 0.3, clock: 0.4, rock: 1.4 };
  for (const o of obstacles) {
    if (Math.abs(o.x) + o.r > HALF || Math.abs(o.z) + o.r > HALF) fail(`препятствие за ареной: ${fmt(o)}`);
    if (OBS_MAX_R[o.kind] && o.r > OBS_MAX_R[o.kind]) fail(`слишком толстый коллайдер ${fmt(o)} r=${o.r}`);
    if (o.h > 1.5 && o.r > 0.6 && o.kind !== 'rock') fail(`высокий объект с большим радиусом: ${fmt(o)}`);
    // граничные точки круга на проезжей части
    let onRoad = isCityRoad(o.x, o.z);
    for (let a = 0; a < 12 && !onRoad; a++) onRoad = isCityRoad(o.x + Math.cos(a * 0.5236) * o.r, o.z + Math.sin(a * 0.5236) * o.r);
    if (onRoad) fail(`препятствие на проезжей части: ${fmt(o)}`);
    for (const b of boxes) if (circleRect(o, b)) fail(`препятствие внутри бокса: ${fmt(o)} ↔ ${fmt(b)}`);
    if (inCrosswalk(o.x, o.z, o.r)) fail(`препятствие на пешеходном переходе: ${fmt(o)}`);
    const g = { x: 0, z: 0 };
    terrain.gradient(o.x, o.z, g);
    if (Math.hypot(g.x, g.z) > 0.2) fail(`объект на крутом склоне (${Math.hypot(g.x, g.z).toFixed(2)}): ${fmt(o)}`);
  }
  for (let i = 0; i < obstacles.length; i++)
    for (let j = i + 1; j < obstacles.length; j++) {
      const a = obstacles[i], b = obstacles[j];
      if (Math.abs(a.x - b.x) > 3 || Math.abs(a.z - b.z) > 3) continue;
      if (Math.hypot(a.x - b.x, a.z - b.z) < a.r + b.r - 1e-3) fail(`препятствия пересекаются: ${fmt(a)} ↔ ${fmt(b)}`);
    }

  // Нашлись объекты, которые «уборка» в terrain.ts молча удалила
  const rep = T.CITY_BUILD_REPORT;
  if (rep) {
    const hard = rep.removed.filter((r) => !/^(tree|bush|rock|umbrella)@/.test(r));
    if (hard.length) fail(`генератор удалил ${hard.length} объектов при очистке (поправьте координаты): ${cap(hard, 20).join(', ')}`);
    warns.push(`случайный декор: удалено ${rep.removed.length - hard.length} деревьев/кустов/камней`);
  }

  // --- 3. Конусы, трамплины, лежачие полицейские ---
  const solid = (x, z, r, pad) => {
    for (const b of boxes) if (circleRect({ x, z, r }, b, pad)) return `бокс ${fmt(b)}`;
    for (const o of obstacles) if (Math.hypot(o.x - x, o.z - z) < o.r + r + pad) return `препятствие ${fmt(o)}`;
    return null;
  };
  for (const c of CITY_CONES) {
    const s = surfaceAtCity(c.x, c.z);
    if (!['asphalt', 'tiles', 'wet', 'cobble'].includes(s)) fail(`конус вне твёрдого покрытия (${s}): (${c.x},${c.z})`);
    const hit = solid(c.x, c.z, c.r, 0.2);
    if (hit) fail(`конус пересекает ${hit}: (${c.x.toFixed(1)},${c.z.toFixed(1)})`);
    if (isCityRoad(c.x, c.z) && inCrosswalk(c.x, c.z)) fail(`конус на пешеходном переходе: (${c.x},${c.z})`);
  }
  for (const r of CITY_RAMPS) {
    const xa = r.dir === 1 ? r.x0 : r.x0 - r.len;
    const rect = { x: xa + r.len / 2, z: r.z0, halfX: r.len / 2 + 0.4, halfZ: r.halfW + 0.4 };
    for (const b of boxes) if (rectOverlap(rect, b)) fail(`трамплин пересекает ${fmt(b)}: x0=${r.x0},z0=${r.z0}`);
    for (const o of obstacles) if (circleRect(o, rect, 0.2)) fail(`трамплин пересекает ${fmt(o)}: x0=${r.x0},z0=${r.z0}`);
    for (const sx of [rect.x - rect.halfX, rect.x + rect.halfX])
      for (const sz of [r.z0 - r.halfW, r.z0 + r.halfW]) {
        const s = surfaceAtCity(sx, sz);
        if (!['asphalt', 'tiles', 'wet', 'cobble'].includes(s)) fail(`трамплин на неподходящем покрытии (${s}): x0=${r.x0},z0=${r.z0}`);
      }
    const mg = Math.hypot(macroHeightCity(rect.x + 0.5, r.z0) - macroHeightCity(rect.x - 0.5, r.z0), macroHeightCity(rect.x, r.z0 + 0.5) - macroHeightCity(rect.x, r.z0 - 0.5));
    if (mg > 0.12) fail(`трамплин на склоне: x0=${r.x0}`);
    for (const cb of CITY_SPEED_BUMPS) {
      const bb = cb.axis === 'z' ? { x: cb.x, z: cb.z, halfX: cb.halfW, halfZ: cb.halfL } : { x: cb.x, z: cb.z, halfX: cb.halfL, halfZ: cb.halfW };
      if (rectOverlap(rect, bb)) fail(`трамплин на лежачем полицейском: x0=${r.x0}`);
    }
  }
  for (const b of CITY_SPEED_BUMPS) {
    const rect = b.axis === 'z' ? { x: b.x, z: b.z, halfX: b.halfW, halfZ: b.halfL } : { x: b.x, z: b.z, halfX: b.halfL, halfZ: b.halfW };
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1], [0, 0]]) {
      const px = rect.x + sx * rect.halfX, pz = rect.z + sz * rect.halfZ;
      if (!isCityRoad(px, pz)) fail(`лежачий полицейский выходит за проезжую часть: (${b.x},${b.z})`);
    }
    if (rect.halfX > 9.0 + 1e-6 && rect.halfZ > 9.0 + 1e-6) fail('полицейский шире дороги');
    if (inCrosswalk(b.x, b.z, 0.8)) fail(`лежачий полицейский у пешеходного перехода: (${b.x},${b.z})`);
    for (const bx of boxes) if (rectOverlap(rect, bx)) fail(`лежачий полицейский пересекает ${fmt(bx)}`);
    for (const o of obstacles) if (circleRect(o, rect)) fail(`лежачий полицейский пересекает ${fmt(o)}`);
  }

  // --- 4. Знаки районов и точка старта ---
  for (const s of CITY_SIGNS) {
    for (const b of boxes) if (b.h > 4 && Math.abs(s.x - b.x) < b.halfX && Math.abs(s.z - b.z) < b.halfZ) fail(`знак района «${s.title}» внутри ${fmt(b)}`);
    for (const o of obstacles) if (Math.hypot(s.x - o.x, s.z - o.z) < o.r + 0.3) fail(`знак района «${s.title}» внутри ${fmt(o)}`);
  }
  {
    const clear = (x, z, r) => !solid(x, z, r, 0);
    if (!clear(spawn.x, spawn.z, 2.0)) fail(`точка старта занята: ${solid(spawn.x, spawn.z, 2, 0)}`);
    for (let d = 0; d <= 25; d += 0.5) {
      const x = spawn.x + Math.cos(spawn.psi) * d, z = spawn.z + Math.sin(spawn.psi) * d;
      if (!clear(x, z, 0.8)) fail(`путь от старта перекрыт на ${d} м: ${solid(x, z, 0.8, 0)}`);
    }
    if (surfaceAtCity(spawn.x, spawn.z) !== 'asphalt') fail('старт не на асфальте');
  }

  // --- 5. Проходимость: заливка сеткой от точки старта ---
  const CS = 0.4, N = Math.round((2 * HALF) / CS);
  const blocked = new Uint8Array(N * N);
  const ci = (v) => Math.floor((v + HALF) / CS);
  const markRect = (x0, x1, z0, z1) => {
    for (let i = Math.max(0, ci(x0)); i <= Math.min(N - 1, ci(x1)); i++) for (let j = Math.max(0, ci(z0)); j <= Math.min(N - 1, ci(z1)); j++) blocked[j * N + i] = 1;
  };
  for (const b of boxes) markRect(b.x - b.halfX - RIDER_R, b.x + b.halfX + RIDER_R, b.z - b.halfZ - RIDER_R, b.z + b.halfZ + RIDER_R);
  for (const o of obstacles) markRect(o.x - o.r - RIDER_R, o.x + o.r + RIDER_R, o.z - o.r - RIDER_R, o.z + o.r + RIDER_R);
  const seen = new Uint8Array(N * N);
  const stack = [ci(spawn.z) * N + ci(spawn.x)];
  seen[stack[0]] = 1;
  while (stack.length) {
    const c = stack.pop();
    const i = c % N, j = (c - i) / N;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ni = i + di, nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= N || nj >= N) continue;
      const n = nj * N + ni;
      if (seen[n] || blocked[n]) continue;
      seen[n] = 1;
      stack.push(n);
    }
  }
  const lost = [];
  let roadCells = 0;
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) {
      const x = -HALF + (i + 0.5) * CS, z = -HALF + (j + 0.5) * CS;
      if (!isCityRoad(x, z)) continue;
      roadCells++;
      if (!blocked[j * N + i] && !seen[j * N + i]) lost.push([x, z]);
    }
  if (lost.length > 5) fail(`${lost.length} клеток дороги недостижимы от старта, например (${lost[0][0].toFixed(1)}, ${lost[0][1].toFixed(1)})`);
  // Проезд поперёк дороги: на каждой станции осевых магистралей должен быть зазор ≥ 2.5 м
  const roadAxes = [];
  for (const c of [0, 90, -90]) roadAxes.push({ along: 'x', c, half: c === 0 ? 9 : 6.5 }, { along: 'z', c, half: c === 0 ? 9 : 6.5 });
  for (const ax of roadAxes) {
    for (let s = -HALF + 1; s < HALF; s += 0.5) {
      const iv = [];
      const lo = ax.c - ax.half, hi = ax.c + ax.half;
      const probe = (px, pz) => isCityRoad(px, pz);
      const mid = ax.along === 'x' ? probe(s, ax.c) : probe(ax.c, s);
      if (!mid) continue;
      for (const b of boxes) {
        const [a0, a1, c0, c1] = ax.along === 'x' ? [b.x - b.halfX, b.x + b.halfX, b.z - b.halfZ, b.z + b.halfZ] : [b.z - b.halfZ, b.z + b.halfZ, b.x - b.halfX, b.x + b.halfX];
        if (s > a0 - RIDER_R && s < a1 + RIDER_R) iv.push([c0 - RIDER_R, c1 + RIDER_R]);
      }
      for (const o of obstacles) {
        const [a, c] = ax.along === 'x' ? [o.x, o.z] : [o.z, o.x];
        if (Math.abs(s - a) < o.r + RIDER_R) {
          const w = Math.sqrt((o.r + RIDER_R) ** 2 - (s - a) ** 2);
          iv.push([c - w, c + w]);
        }
      }
      iv.sort((p, q) => p[0] - q[0]);
      let edge = lo, gap = 0;
      for (const [a, b] of iv) { gap = Math.max(gap, a - edge); edge = Math.max(edge, b); }
      gap = Math.max(gap, hi - edge);
      if (gap < 2.5) { fail(`дорога перегорожена поперёк: ось ${ax.along} c=${ax.c}, станция ${s.toFixed(1)}, зазор ${gap.toFixed(2)}`); break; }
    }
  }

  // --- 6. Ключевые точки достижимы ---
  const reach = (x, z) => { const i = ci(x), j = ci(z); return seen[j * N + i] || [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([a, b]) => seen[(j + b) * N + i + a]); };
  for (const [name, x, z] of [...CITY_SIGNS.map((s) => [s.title, s.x, s.z]), ...CITY_RAMPS.map((r) => ['ramp', r.x0, r.z0]), ['fountain', 47, 53], ['ledge plaza', 38, -40]])
    if (!boxes.some((b) => Math.abs(x - b.x) < b.halfX && Math.abs(z - b.z) < b.halfZ) && !reach(x, z)) fail(`недостижимо: ${name} (${x}, ${z})`);

  // --- 7. Рельеф: ступеньки и крутизна macroHeightCity ---
  let maxSlope = 0, steps = [];
  for (let x = -HALF; x < HALF; x += 0.5)
    for (let z = -HALF; z < HALF; z += 0.5) {
      const h0 = macroHeightCity(x, z);
      const sx = Math.abs(macroHeightCity(x + 0.5, z) - h0) / 0.5;
      const sz = Math.abs(macroHeightCity(x, z + 0.5) - h0) / 0.5;
      const s = Math.max(sx, sz);
      maxSlope = Math.max(maxSlope, s);
      if (s > 0.3) steps.push(`(${x},${z}) ${s.toFixed(2)}`);
    }
  if (steps.length) fail(`ступеньки/крутизна рельефа >0.3: ${cap(steps, 6).join('; ')}`);
  // Бордюр: перепад высоты 3.2 см допустим только на границе дороги и тротуара вне пешеходных переходов
  const kerbBad = [];
  for (const [ix, iz] of [[0, 0], [-90, 0], [90, 0], [0, -90], [0, 90]])
    for (let t = -6; t <= 6; t += 0.5)
      for (const [x, z] of [[ix + 11.5, iz + t], [ix - 11.5, iz + t], [ix + t, iz + 11.5], [ix + t, iz - 11.5]]) {
        const d = Math.abs(terrain.height(x + 0.1, z) - terrain.height(x - 0.1, z));
        if (d > 0.03 && isCityRoad(x, z) !== isCityRoad(x + 0.1, z)) kerbBad.push(`(${x},${z})`);
      }
  if (kerbBad.length) fail(`бордюр посреди перехода: ${cap(kerbBad, 5).join(' ')}`);

  // --- 8. Покрытия: граница дорога/тротуар совпадает с геометрией ---
  const mism = [];
  for (let x = -HALF; x < HALF; x += 1.5)
    for (let z = -HALF; z < HALF; z += 1.5) {
      const s = surfaceAtCity(x, z);
      if (isCityRoad(x, z) && !['asphalt', 'wet', 'cobble'].includes(s)) mism.push(`(${x},${z}) road=${s}`);
      if (isCitySidewalk(x, z) && s !== 'tiles') mism.push(`(${x},${z}) sidewalk=${s}`);
    }
  if (mism.length) fail(`покрытие не совпадает с дорогой/тротуаром: ${cap(mism, 5).join('; ')}`);

  // --- 9. Тупики кольцевых улиц: каждый конец дороги должен упираться в другую дорогу или в край арены ---
  const dead = [];
  for (const c of [-90, 90]) {
    for (const [pt, along] of [[(s) => [s, c], 'x'], [(s) => [c, s], 'z']]) {
      let last = null;
      for (let s = -HALF; s <= HALF; s += 0.5) if (isCityRoad(...pt(s))) last = s;
      let first = null;
      for (let s = HALF; s >= -HALF; s -= 0.5) if (isCityRoad(...pt(s))) first = s;
      for (const e of [last, first]) {
        if (Math.abs(e) >= HALF - 1 || Math.abs(e) > 168) continue;
        const [x, z] = pt(e);
        const dirx = along === 'x' ? Math.sign(e) : 0, dirz = along === 'z' ? Math.sign(e) : 0;
        const ahead = [1.5, 3.5, 6, 8].some((d) => isCityRoad(x + dirx * d, z + dirz * d));
        if (!ahead) dead.push(`${along}-улица c=${c} кончается на ${e}`);
      }
    }
  }
  if (dead.length) fail(`тупики дорог: ${cap(dead, 8).join('; ')}`);

  // --- Сводка ---
  const count = (arr) => arr.reduce((m, o) => ((m[o.kind] = (m[o.kind] ?? 0) + 1), m), {});
  console.log('boxes:', JSON.stringify(count(boxes)));
  console.log('obstacles:', JSON.stringify(count(obstacles)));
  console.log(`road cells ${roadCells}, max macro slope ${maxSlope.toFixed(3)}`);
  for (const w of warns) console.warn('warn:', w);
} finally {
  await server.close();
}

if (errors.length) {
  const uniq = [...new Set(errors)];
  console.error(`\ncheck:city — ${uniq.length} проблем:`);
  for (const e of uniq.slice(0, 80)) console.error(' ✗', e);
  if (uniq.length > 80) console.error(` … и ещё ${uniq.length - 80}`);
  process.exit(1);
}
console.log('check:city OK');
