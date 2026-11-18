// Спуск по «Горному спуску» на автопилоте: проверяет, что трасса проходима от старта до финиша.
import assert from 'node:assert/strict';
import { createServer } from 'vite';

const server = await createServer({ configFile: false, cacheDir: 'node_modules/.vite-physics-check', optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', logLevel: 'error' });
try {
  const { ScooterSim, DT } = await server.ssrLoadModule('/src/game/physics.ts');
  const { MODELS, DEFAULT_TUNE, emptyInput } = await server.ssrLoadModule('/src/game/data.ts');
  const T = await server.ssrLoadModule('/src/game/terrain.ts');
  const terrain = T.createTerrain('hill');

  // Рельеф: крутой, но в пределах того, что учитывает физика
  let maxG = 0;
  for (let x = -150; x < 160; x += 0.5) {
    const z = T.hillTrailZ(x);
    const g = (terrain.macro(x - 0.25, z) - terrain.macro(x + 0.25, z)) / 0.5;
    maxG = Math.max(maxG, g);
    const m = (T.hillTrailZ(x + 0.5) - T.hillTrailZ(x - 0.5));
    const k = 2 / Math.hypot(1, m);
    const cross = Math.abs(terrain.macro(x - m * k, z + k) - terrain.macro(x + m * k, z - k)) / 4;
    assert(cross < 0.08, `trail is banked sideways at x=${x}: ${cross.toFixed(3)}`);
  }
  const drop = terrain.macro(-164, 0) - terrain.macro(162, T.hillTrailZ(162));
  assert(drop > 55, `descent is only ${drop.toFixed(1)} m`);
  assert(maxG > 0.3 && maxG < 0.5, `steepest pitch ${maxG.toFixed(2)}`);

  // Препятствия на тропе оставляют проезд не уже 1.5 м
  for (let x = -148; x < 156; x += 0.25) {
    const zc = T.hillTrailZ(x);
    const blocked = [];
    for (const o of terrain.obstacles) if (Math.abs(o.x - x) < o.r) blocked.push([o.z - o.r - zc, o.z + o.r - zc]);
    for (const b of terrain.boxes) if (Math.abs(b.x - x) < b.halfX) blocked.push([b.z - b.halfZ - zc, b.z + b.halfZ - zc]);
    blocked.push([-99, -T.HILL_TRAIL_HALF], [T.HILL_TRAIL_HALF, 99]);
    blocked.sort((a, b) => a[0] - b[0]);
    let gap = 0;
    let edge = blocked[0][1];
    for (const [a, b] of blocked.slice(1)) { gap = Math.max(gap, a - edge); edge = Math.max(edge, b); }
    assert(gap >= 1.5, `trail blocked at x=${x}: widest gap ${gap.toFixed(2)} m`);
  }

  // Автопилот: ведёт по рассчитанной траектории и тормозит до ~15 км/ч
  const m = MODELS.g2;
  const sim = new ScooterSim(terrain, { model: m.id, wheel: m.defaultWheel, tire: m.defaultTire, tune: { ...DEFAULT_TUNE }, riderKg: 75, mode: 'drive', crash: true });
  sim.respawn();
  assert(Math.abs(sim.px - T.HILL_SPAWN.x) < 0.01, 'spawn point must come from the map');
  // Траектория: динамическое программирование по сетке (x, смещение от оси) в обход препятствий
  const X0 = -150, DX = 0.5, NX = 640, OFFS = Array.from({ length: 37 }, (_, i) => -3.6 + i * 0.2), PAD = 0.75;
  const blocked = (x, off) => {
    const z = T.hillTrailZ(x) + off;
    for (const o of terrain.obstacles) if (Math.hypot(o.x - x, o.z - z) < o.r + PAD) return true;
    for (const b of terrain.boxes) if (Math.abs(b.x - x) < b.halfX + PAD && Math.abs(b.z - z) < b.halfZ + PAD) return true;
    for (const r of terrain.ramps) if (x > r.x0 - PAD && x < r.x0 + r.len + PAD && Math.abs(z - r.z0) < r.halfW + PAD) return true;
    return false;
  };
  let cost = OFFS.map((o) => Math.abs(o));
  const back = [];
  for (let i = 1; i < NX; i++) {
    const x = X0 + i * DX;
    const next = [];
    const from = [];
    OFFS.forEach((off, j) => {
      let best = Infinity;
      let bj = j;
      for (const k of [j - 1, j, j + 1]) if (k >= 0 && k < OFFS.length && cost[k] + (k === j ? 0 : 0.3) < best) { best = cost[k] + (k === j ? 0 : 0.3); bj = k; }
      next.push(blocked(x, off) ? Infinity : best + Math.abs(off) * 0.02);
      from.push(bj);
    });
    assert(next.some(Number.isFinite), `no clear line at x=${x}`);
    cost = next;
    back.push(from);
  }
  let j = cost.indexOf(Math.min(...cost));
  assert(Number.isFinite(cost[j]), 'no clear line down the trail');
  const path = new Array(NX);
  for (let i = NX - 1; i >= 0; i--) { path[i] = OFFS[j]; if (i > 0) j = back[i - 1][j]; }
  const laneAt = (x) => T.hillTrailZ(x) + path[Math.max(0, Math.min(NX - 1, Math.round((x - X0) / DX)))];
  let t = 0;
  let vmax = 0;
  const input = emptyInput();
  while (sim.px < 160 && t < 240) {
    const look = 2.5 + sim.u * 0.45;
    const tx = sim.px + look;
    const tz = laneAt(tx);
    let err = Math.atan2(-(tz - sim.pz), tx - sim.px) - sim.psi; // курс: (cos ψ, −sin ψ)
    err = Math.atan2(Math.sin(err), Math.cos(err));
    input.steer = Math.max(-0.4, Math.min(0.4, -err * 0.9));
    const kmh = sim.u * 3.6;
    input.throttle = kmh < 11 ? 0.6 : 0;
    input.brake = kmh > 15 ? Math.min(1, (kmh - 15) / 8) : 0;
    sim.step(input, DT);
    t += DT;
    if (process.env.TRACE && Math.round(t / DT) % 480 === 0) console.log('T', t.toFixed(0), sim.px.toFixed(1), (sim.pz - T.hillTrailZ(sim.px)).toFixed(1), (sim.psi * 57.3).toFixed(0), kmh.toFixed(1), input.steer.toFixed(2), input.brake.toFixed(2));
    vmax = Math.max(vmax, kmh);
    assert(Number.isFinite(sim.px) && Number.isFinite(sim.u), 'simulation must stay finite');
    if (sim.crashed) break;
  }
  console.log(`hill: drop ${drop.toFixed(1)} m, steepest ${Math.round(maxG * 100)}%, run ${t.toFixed(1)} s, top ${vmax.toFixed(0)} km/h, end x=${sim.px.toFixed(1)}${sim.crashed ? ` CRASH: ${sim.crashReason}` : ''}`);
  assert(!sim.crashed, `autopilot crashed at x=${sim.px.toFixed(1)}: ${sim.crashReason}`);
  assert(sim.px >= 160, `autopilot stopped at x=${sim.px.toFixed(1)}`);

  // Без тормозов склон разгоняет самокат сам
  sim.respawn();
  sim.px = -138; sim.pz = T.hillTrailZ(-138);
  const coast = emptyInput();
  for (let i = 0; i < 4 / DT && !sim.crashed; i++) sim.step(coast, DT);
  assert(sim.u * 3.6 > 15, `coasting downhill reached only ${(sim.u * 3.6).toFixed(1)} km/h`);
  console.log('Hill map check passed');
} finally {
  await server.close();
}
