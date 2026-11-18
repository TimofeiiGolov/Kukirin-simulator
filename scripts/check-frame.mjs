import assert from 'node:assert/strict';
import { createServer } from 'vite';

// Frame pacing: FPS cap, adaptive resolution and render interpolation on synthetic display timelines.
const server = await createServer({ configFile: false, cacheDir: 'node_modules/.vite-frame-check', optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true }, appType: 'custom' });
try {
  const { FrameLimiter, FpsMeter, ResolutionGovernor, SimInterpolator, MIN_RENDER_SCALE } = await server.ssrLoadModule('/src/game/framePacing.ts');
  const { createSim } = await server.ssrLoadModule('/src/game/sim.ts');
  const { DT } = await server.ssrLoadModule('/src/game/physics.ts');
  const { MODELS, DEFAULT_TUNE, emptyInput } = await server.ssrLoadModule('/src/game/data.ts');

  // Deterministic jitter so runs are reproducible.
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const vsyncs = (hz, seconds, jitter = 0) => Array.from({ length: Math.round(hz * seconds) }, (_, i) => (i * 1000) / hz + (rand() - 0.5) * 2 * jitter);
  const rendered = (hz, cap, seconds, jitter = 0) => {
    const lim = new FrameLimiter();
    return vsyncs(hz, seconds, jitter).filter((t) => lim.shouldRender(t, cap));
  };
  const gaps = (ts) => ts.slice(1).map((t, i) => t - ts[i]);

  // --- FPS cap
  {
    const r = rendered(144, 60, 10);
    assert(Math.abs(r.length - 600) <= 2, `144 Hz capped to 60 should render ~600 frames, got ${r.length}`);
    const g = gaps(r);
    assert(Math.min(...g) > 13 && Math.max(...g) < 21.5, '144 Hz → 60 should alternate 2 and 3 refreshes only');
    const r120 = rendered(120, 60, 10, 0.6);
    assert(Math.abs(r120.length - 600) <= 2, `120 Hz capped to 60 should render ~600 frames, got ${r120.length}`);
    assert(gaps(r120).every((x) => x > 14 && x < 19), '120 Hz → 60 should render every second refresh');
    const r60 = rendered(60, 60, 10, 0.9);
    assert(r60.length >= 598, `60 Hz with jitter must not drop frames under a 60 cap, got ${r60.length}`);
    const r30 = rendered(60, 30, 10, 0.5);
    assert(Math.abs(r30.length - 300) <= 2 && gaps(r30).every((x) => x > 30 && x < 37), '60 Hz capped to 30 should render every second refresh');
    assert.equal(rendered(144, 0, 5).length, 720, 'unlimited renders every refresh');
    // after a long stall, no burst of catch-up frames
    const lim = new FrameLimiter();
    const ts = [...vsyncs(60, 1), ...vsyncs(60, 1).map((t) => t + 3000)];
    const out = ts.filter((t) => lim.shouldRender(t, 60));
    assert(gaps(out).filter((x) => x < 15).length === 0, 'no catch-up burst after a stall');
    console.log(`limiter: 144→60 ${r.length}, 120→60 ${r120.length}, 60→60 ${r60.length}, 60→30 ${r30.length}`);
  }

  // --- FPS meter
  {
    const m = new FpsMeter();
    for (const t of vsyncs(60, 3, 0.5)) m.tick(t);
    assert(Math.abs(m.fps - 60) < 1.5, `meter should read ~60, got ${m.fps}`);
    // very slow frames must lower the reading, not leave the last good value on screen
    for (let t = 4000; t < 16000; t += 2500) m.tick(t);
    assert(m.fps < 1, `meter should follow 2.5 s frames, got ${m.fps}`);
  }

  // --- Adaptive resolution. GPU time scales with pixel count (scale²); frames snap to display refreshes.
  const run = ({ hz = 60, seconds, gpu, cpu = () => 3, target = 60, gov = new ResolutionGovernor() }) => {
    const refresh = 1000 / hz;
    let t = 0;
    let changes = 0;
    const fpsLog = [];
    gov.reset(0, false);
    while (t < seconds * 1000) {
      const work = Math.max(gpu(t, gov.scale), cpu(t));
      const interval = Math.max(1, Math.ceil(work / refresh - 1e-9)) * refresh;
      t += interval;
      if (gov.sample(t, interval, cpu(t), target)) changes++;
      fpsLog.push([t, 1000 / interval]);
    }
    const tail = fpsLog.filter(([ts]) => ts > (seconds - 10) * 1000);
    const smooth = tail.filter(([, f]) => f >= target * 0.98).length / tail.length;
    const avgFps = (tail.length * 1000) / (tail[tail.length - 1][0] - tail[0][0] + 1000 / tail[0][1]);
    return { scale: gov.scale, changes, smooth, avgFps, gov };
  };
  {
    const heavy = run({ seconds: 60, gpu: (_t, s) => 25 * s * s });
    assert(heavy.scale < 0.85 && heavy.scale >= MIN_RENDER_SCALE, `GPU-bound load should lower resolution, scale ${heavy.scale}`);
    assert(heavy.smooth > 0.95, `GPU-bound load should end up at 60 FPS, smooth ${heavy.smooth.toFixed(2)}`);
    assert(heavy.changes <= 10, `resolution should settle, not oscillate (${heavy.changes} changes)`);
    const cpuBound = run({ seconds: 30, gpu: () => 6, cpu: () => 22 });
    assert.equal(cpuBound.scale, 1, 'CPU-bound frames must keep full resolution');
    const light = run({ seconds: 30, gpu: (_t, s) => 9 * s * s });
    assert.equal(light.scale, 1, 'light load keeps full resolution');
    const recover = run({ seconds: 120, gpu: (t, s) => (t < 20000 ? 30 : 8) * s * s });
    assert.equal(recover.scale, 1, `resolution should recover once the load drops, scale ${recover.scale}`);
    const hz144 = run({ hz: 144, seconds: 60, gpu: (_t, s) => 22 * s * s });
    assert(hz144.avgFps > 57, `144 Hz display with a 60 target should average 60, got ${hz144.avgFps.toFixed(1)}`);
    const floor = run({ seconds: 60, gpu: (_t, s) => 200 * s * s });
    assert.equal(floor.scale, MIN_RENDER_SCALE, 'resolution never drops below the floor');
    console.log(`governor: heavy→${heavy.scale} (${heavy.changes} changes, ${(heavy.smooth * 100).toFixed(0)}% at 60), cpu-bound→${cpuBound.scale}, recover→${recover.scale}, 144Hz→${hz144.scale}`);
  }

  // --- Interpolation with the real simulators: per-frame motion on a 144 Hz display must be even.
  for (const id of ['g2pro', 'x1']) {
    const m = MODELS[id];
    const terrain = { cones: [], obstacles: [], boxes: [], ramps: [], height: () => 0, macro: () => 0, surface: () => 'asphalt', gradient: (_x, _z, g) => { g.x = 0; g.z = 0; } };
    const sim = createSim(terrain, { model: id, wheel: m.defaultWheel, tire: m.defaultTire, tune: { ...DEFAULT_TUNE }, riderKg: 75, mode: 'drive', crash: false });
    sim.reset(0, 0, 0);
    const input = { ...emptyInput(), throttle: 1 };
    for (let i = 0; i < 4 / DT; i++) sim.step(input, DT);
    const interp = new SimInterpolator();
    const frameDt = 1 / 144;
    let acc = 0;
    const raw = [];
    const smooth = [];
    for (let f = 0; f < 144; f++) {
      acc += frameDt;
      while (acc >= DT) { interp.beforeStep(sim); sim.step(input, DT); acc -= DT; }
      raw.push(Math.hypot(sim.px, sim.pz));
      assert(interp.apply(sim, acc / DT), 'interpolation should apply while riding');
      smooth.push(Math.hypot(sim.px, sim.pz));
      interp.restore();
      assert.equal(Math.hypot(sim.px, sim.pz), raw[raw.length - 1], 'restore must return the exact physics state');
    }
    // largest frame-to-frame change in per-frame travel; immune to the bike steadily accelerating
    const spread = (xs) => { const d = gaps(xs); const avg = d.reduce((a, b) => a + b, 0) / d.length; return Math.max(...gaps(d).map(Math.abs)) / avg; };
    const rawJ = spread(raw);
    const smoothJ = spread(smooth);
    assert(rawJ > 0.15, `without interpolation 144 Hz motion is uneven (${(rawJ * 100).toFixed(0)}%)`);
    assert(smoothJ < 0.03, `${id}: interpolated per-frame motion should be even, deviation ${(smoothJ * 100).toFixed(1)}%`);
    // a teleport (respawn) must not be smeared across the frame
    interp.beforeStep(sim);
    sim.px += 50;
    assert.equal(interp.apply(sim, 0.5), false, 'no interpolation across a respawn');
    console.log(`interpolation ${id}: frame-to-frame motion jump ${(rawJ * 100).toFixed(0)}% → ${(smoothJ * 100).toFixed(1)}% at 144 Hz`);
  }
  console.log('PASS: frame cap, FPS meter, adaptive resolution and render interpolation.');
} finally {
  await server.close();
}
