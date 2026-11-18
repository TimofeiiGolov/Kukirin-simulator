import assert from 'node:assert/strict';
import { createServer } from 'vite';

// Kukirin X1: проверяем отдельную физику питбайка по заводским данным.
const server = await createServer({ configFile: false, cacheDir: 'node_modules/.vite-physics-check', optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
try {
  const { DT, ScooterSim } = await server.ssrLoadModule('/src/game/physics.ts');
  const { PitBikeSim } = await server.ssrLoadModule('/src/game/pitBikePhysics.ts');
  const { PITBIKE } = await server.ssrLoadModule('/src/game/pitBikeSpec.ts');
  const { createSim } = await server.ssrLoadModule('/src/game/sim.ts');
  const { createTerrain } = await server.ssrLoadModule('/src/game/terrain.ts');
  const { MODELS, DEFAULT_TUNE, emptyInput } = await server.ssrLoadModule('/src/game/data.ts');
  const m = MODELS.x1;
  // Бесконечная плоскость с уклоном: байк удерживается в начале координат, дорога «едет» под ним
  const plane = (surf = 'asphalt', slope = 0, bump = 0) => ({
    off: 0, cones: [], obstacles: [], boxes: [], ramps: [],
    feat: null, // необязательный рельеф по ходу движения, например трамплин
    height(x) { const d = x + this.off; return d * slope + bump * Math.sin(d * 1.9) * Math.sin(d * 0.53) + (this.feat ? this.feat(d) : 0); },
    macro(x) { return (x + this.off) * slope; },
    surface: () => surf,
    gradient(x, _z, g) { const d = x + this.off; g.x = slope + (this.feat ? (this.feat(d + 0.05) - this.feat(d - 0.05)) / 0.1 : 0); g.z = 0; },
  });
  const cruise = (kmh) => (s) => (s.u * 3.6 < kmh ? 1 : 0.2);
  const make = (terrain, mode = 'sport', crash = true) => {
    const s = createSim(terrain, { model: 'x1', wheel: m.defaultWheel, tire: m.defaultTire, tune: { ...DEFAULT_TUNE }, riderKg: 75, mode, crash });
    s.reset(0, 0, 0);
    terrain.off += s.px; s.px = 0;
    return s;
  };
  const I = (o) => ({ ...emptyInput(), ...o });
  const run = (s, inp, sec, each) => {
    for (let i = 0; i < sec / DT; i++) {
      s.terrain.off += s.px; s.px = 0; s.pz = 0;
      s.step(typeof inp === 'function' ? inp(i * DT, s) : inp, DT);
      assert(Number.isFinite(s.u) && Number.isFinite(s.phi) && Number.isFinite(s.yb), 'state must stay finite');
      if (each) each(i * DT, s);
    }
  };
  const report = {};

  // --- отдельная модель и заводские числа ---
  let s = make(plane());
  assert(s instanceof PitBikeSim, 'X1 must use the pit bike simulation');
  assert(!(createSim(plane(), { ...s.cfg, model: 'g2' }) instanceof PitBikeSim) && createSim(plane(), { ...s.cfg, model: 'g2' }) instanceof ScooterSim, 'scooters keep the scooter simulation');
  assert.equal(m.mass, 52);
  assert.equal(m.battWh, 998.4);
  assert.deepEqual(m.modeSpeeds, { eco: 25, drive: 35, sport: 50 });
  const { FACTORY } = await server.ssrLoadModule('/src/game/pitBikeSpec.ts');
  assert.equal(FACTORY.wheelbase, 1.095, 'factory wheelbase 1095 mm');
  assert.equal(PITBIKE.scale, 1.1, 'in-game bike is 10 % larger than the factory one');
  assert(Math.abs(s.a0 + s.b0 - 1.095 * 1.1) < 1e-6, 'scaled wheelbase');
  assert(Math.abs(s.rF * 2 - 0.4756 * 1.1) < 1e-3 && Math.abs(s.rR * 2 - 0.4648 * 1.1) < 1e-3, '60/100-14 front and 80/100-12 rear, scaled');
  assert.equal(s.Mt, 127);
  assert(Math.abs(s.phi) < 1e-3 && Math.abs(s.u) < 1e-3, 'stands upright at rest');
  assert(s.wr.fz > s.wf.fz, 'seated rider loads the rear wheel more');
  report.rest = { frontN: Math.round(s.wf.fz), rearN: Math.round(s.wr.fz), sagF: +(s.wf.comp * 1000).toFixed(0), sagR: +(s.wr.comp * 1000).toFixed(0) };

  // --- мотор и цепь: разгон, обороты, просадка напряжения ---
  let t30 = 0, maxRpm = 0, minV = 99;
  run(s, I({ throttle: 1 }), 40, (t, s) => { if (!t30 && s.u * 3.6 > 30) t30 = t; maxRpm = Math.max(maxRpm, s.motorRpm); minV = Math.min(minV, s.busV); });
  assert(t30 > 2.5 && t30 < 7, `0–30 km/h in ${t30.toFixed(1)} s`);
  assert(maxRpm < PITBIKE.motorRpm * 1.15, 'motor stays near its rated speed');
  assert(minV < 52 && minV > 44, 'battery sags under load');
  assert(!s.crashed && Math.abs(s.phi) < 0.02, 'runs straight hands-off');
  report.accel = { to30: +t30.toFixed(1), topKmh: +(s.u * 3.6).toFixed(1), rpm: Math.round(maxRpm), minVolts: +minV.toFixed(1) };

  // --- подъём: 15° берёт, 22° — нет ---
  s = make(plane('asphalt', Math.tan((15 * Math.PI) / 180)));
  run(s, I({ throttle: 1 }), 20);
  assert(s.u * 3.6 > 6 && !s.crashed, `must climb 15° (got ${(s.u * 3.6).toFixed(1)} km/h)`);
  report.climb15 = +(s.u * 3.6).toFixed(1);
  s = make(plane('asphalt', Math.tan((22 * Math.PI) / 180)));
  run(s, I({ throttle: 1 }), 12);
  assert(s.u < 0.5, '22° is beyond the motor');

  // --- запас хода на средней скорости (заявлено до 40 км) ---
  s = make(plane(), 'drive');
  run(s, I({ throttle: 1 }), 20);
  const b0 = s.battery, o0 = s.odo;
  run(s, I({ throttle: 1 }), 60);
  const whKm = (((b0 - s.battery) * m.battWh) / 8) / ((s.odo - o0) / 1000);
  report.rangeKm = +(m.battWh / whKm).toFixed(1);
  assert(report.rangeKm > 32 && report.rangeKm < 55, `range ${report.rangeKm} km`);

  // --- тормоза ---
  report.brake = {};
  for (const [name, inp, max] of [['both', { brake: 1 }, 20], ['front', { brakeF: 1 }, 28], ['rear', { brakeR: 1 }, 40]]) {
    s = make(plane());
    run(s, I({ throttle: 1 }), 25);
    const o = s.odo;
    let dive = 0;
    run(s, (_t, s) => I(s.u > 0.5 ? inp : {}), 10, (_t, s) => { dive = Math.min(dive, s.th); });
    const d = s.odo - o;
    assert(s.u < 0.6 && !s.crashed && d < max && d > 9, `${name} brake: ${d.toFixed(1)} m`);
    if (name === 'front') assert(dive < -0.04, 'fork dives under front braking');
    report.brake[name] = +d.toFixed(1);
  }

  // --- равновесие: поворот начинается с контрруления, байк держит заданный крен ---
  s = make(plane());
  run(s, I({ throttle: 1 }), 8);
  let counter = 0;
  run(s, I({ throttle: 0.6, steer: 0.5 }), 0.25, (_t, s) => { counter = Math.max(counter, s.delta); });
  run(s, I({ throttle: 0.6, steer: 0.5 }), 4);
  assert(s.phi < -0.15 && s.r < -0.1 && s.delta < 0, 'settles into the turn leaned in');
  assert(counter > 0.01, 'turn-in starts with counter-steering');
  assert(Math.abs(s.u * s.r - 9.81 * Math.tan(s.phi)) < 1.2, 'lean balances the centripetal acceleration');
  report.turn = { leanDeg: +(-s.phi * 57.3).toFixed(1), counterSteerDeg: +(counter * 57.3).toFixed(1) };
  run(s, I({ throttle: 0.6 }), 3);
  assert(Math.abs(s.phi) < 0.08 && !s.crashed, 'returns upright');

  for (const surf of ['asphalt', 'wet', 'gravel', 'dirt', 'grass', 'sand']) for (const kmh of [15, 30, 50]) {
    s = make(plane(surf));
    const thr = (s) => (s.u * 3.6 < kmh ? 1 : 0.2);
    run(s, (_t, s) => I({ throttle: thr(s) }), 10);
    run(s, (t, s) => I({ throttle: thr(s), steer: Math.sin(t * 2.4) > 0 ? 1 : -1 }), 10);
    run(s, (_t, s) => I({ throttle: thr(s) }), 3);
    assert(!s.crashed, `slalom on ${surf} at ${kmh} km/h: ${s.crashReason}`);
    assert(Math.abs(s.phi) < 0.12, `upright after slalom on ${surf} at ${kmh} km/h`);
  }

  // --- неровности и выключенные аварии ---
  s = make(plane('dirt', 0, 0.06));
  let maxComp = 0;
  run(s, (_t, s) => I({ throttle: s.u * 3.6 < 30 ? 1 : 0.2 }), 20, (_t, s) => { maxComp = Math.max(maxComp, s.wf.comp, s.wr.comp); });
  assert(!s.crashed, `bumpy dirt: ${s.crashReason}`);
  assert(maxComp > 0.05, 'suspension works over bumps');
  s = make(plane('snow'), 'sport', false);
  run(s, (t) => I({ throttle: 1, steer: Math.sin(t * 3) > 0 ? 1 : -1 }), 20);
  assert(!s.crashed && Math.abs(s.phi) < 1.2, 'with crashes off the rider always saves it');

  // --- вилли: баланс у точки равновесия, выход без переворота ---
  s = make(plane());
  run(s, I({ throttle: 1 }), 2);
  let up = 0, maxDeg = 0;
  run(s, I({ throttle: 1, stunt: 1 }), 8, (_t, s) => { if (s.wheelie) up += DT; maxDeg = Math.max(maxDeg, s.stuntAngle); });
  assert(!s.crashed && up > 3 && s.stuntAngle > 19 && maxDeg < 45, `wheelie: ${up.toFixed(1)} s, ${maxDeg.toFixed(0)}° max`);
  report.wheelie = { seconds: +up.toFixed(1), angle: +s.stuntAngle.toFixed(0) };
  run(s, I({ throttle: 0.3 }), 2);
  assert(!s.crashed && s.stuntAngle < 3, 'front comes down when released');

  // --- руль: быстрый плавный отклик без рывка в обратную сторону ---
  s = make(plane());
  run(s, (_t, s) => I({ throttle: cruise(35)(s) }), 8);
  let tLean = 0, rPeak = 0, wrong = 0;
  const z0 = s.pz;
  for (let i = 0; i < 2.5 / DT; i++) {
    s.step(I({ throttle: cruise(35)(s), steer: 1 }), DT);
    if (!tLean && s.phi < -0.3) tLean = i * DT;
    rPeak = Math.min(rPeak, s.r);
    wrong = Math.max(wrong, z0 - s.pz);
  }
  assert(tLean > 0.15 && tLean < 0.5, `leans into a turn in ${tLean.toFixed(2)} s`);
  assert(-s.phi > 0.47 && -s.phi < 0.7, `full-steer lean ${(-s.phi * 57.3).toFixed(0)}°`);
  assert(rPeak / s.r < 1.5, 'yaw rate does not spike on turn-in');
  assert(wrong < 0.03, 'no visible swerve to the wrong side');
  report.steer = { leanSec: +tLean.toFixed(2), fullLeanDeg: +(-s.phi * 57.3).toFixed(1) };

  // --- вилли с места и с ходу: быстрый подъём, удержание, мягкое опускание ---
  report.wheelieFrom = {};
  for (const kmh of [0, 20, 40]) {
    s = make(plane());
    if (kmh) run(s, (_t, s) => I({ throttle: cruise(kmh)(s) }), 9);
    let t15 = 0, held = 0, top = 0, slam = 0;
    run(s, I({ throttle: 1, stunt: 1 }), 6, (t, s) => { if (!t15 && s.stuntAngle > 15) t15 = t; if (s.wheelie) held += DT; top = Math.max(top, s.stuntAngle); });
    assert(!s.crashed && t15 > 0 && t15 < 0.8 && held > 4.5 && top < 42, `wheelie from ${kmh} km/h: up in ${t15.toFixed(2)} s, held ${held.toFixed(1)} s, max ${top.toFixed(0)}°`);
    run(s, I({ throttle: 0.3 }), 2, (_t, s) => { slam = Math.max(slam, s.wf.fz); });
    assert(!s.crashed && s.stuntAngle < 3 && slam < 2600, `front wheel is set down gently (${slam.toFixed(0)} N)`);
    report.wheelieFrom[kmh] = +t15.toFixed(2);
  }
  s = make(plane());
  run(s, (_t, s) => I({ throttle: cruise(20)(s) }), 9);
  run(s, I({ throttle: 1, stunt: 1, lean: -1 }), 8);
  assert(!s.crashed && s.stuntAngle > 28 && s.stuntAngle < 44, `leaning back raises the wheelie without looping out (${s.stuntAngle.toFixed(0)}°)`);

  // --- стоппи: стант + передний тормоз; без команды байк через руль не летит ---
  s = make(plane());
  run(s, (_t, s) => I({ throttle: cruise(40)(s) }), 10);
  let sUp = 0, sMax = 0;
  run(s, I({ brakeF: 1, stunt: 1 }), 5, (_t, s) => { if (s.stoppie) sUp += DT; sMax = Math.max(sMax, s.stoppieDeg); });
  assert(!s.crashed && sUp > 1.5 && sMax > 14 && sMax < 36, `stoppie: ${sUp.toFixed(1)} s, ${sMax.toFixed(0)}°`);
  assert(s.u < 0.3 && Math.abs(s.th) < 0.05 && s.stuntScore >= 0, 'stoppie ends with the rear wheel back on the ground');
  report.stoppie = { seconds: +sUp.toFixed(1), angle: +sMax.toFixed(0) };
  for (const inp of [{ brakeF: 1 }, { brake: 1 }]) {
    s = make(plane());
    run(s, (_t, s) => I({ throttle: cruise(45)(s) }), 12);
    let lift = 0;
    run(s, (_t, s) => I(s.u > 0.5 ? inp : {}), 6, (_t, s) => { lift = Math.max(lift, s.stoppieDeg); });
    assert(!s.crashed && lift < 12, `panic braking keeps the rear down (${lift.toFixed(0)}°)`);
  }

  // --- прыжок: управление в воздухе и приземление ---
  const kicker = (d) => (d > 60 && d < 66 ? 0.9 * (0.5 - 0.5 * Math.cos(((d - 60) / 6) * Math.PI)) : 0);
  report.jump = {};
  for (const [name, air] of [['neutral', {}], ['noseUp', { lean: -1 }], ['noseDown', { lean: 1 }], ['whip', { steer: 1 }]]) {
    const tr = plane('dirt');
    tr.feat = kicker;
    s = make(tr);
    let airT = 0, thMax = -9, thMin = 9, roll = 0;
    run(s, (_t, s) => I(s.airborne && tr.off > 58 ? { throttle: 0.2, ...air } : { throttle: cruise(45)(s) }), 16, (_t, s) => {
      if (!s.airborne || tr.off < 58) return;
      airT += DT; thMax = Math.max(thMax, s.th); thMin = Math.min(thMin, s.th); roll = Math.max(roll, Math.abs(s.phi));
    });
    assert(!s.crashed && Math.abs(s.phi) < 0.1, `jump (${name}) lands safely: ${s.crashReason}`);
    assert(airT > 0.4, `jump (${name}) gets air: ${airT.toFixed(2)} s`);
    report.jump[name] = { air: +airT.toFixed(2), up: +(thMax * 57.3).toFixed(0), down: +(thMin * 57.3).toFixed(0), roll: +(roll * 57.3).toFixed(0) };
  }
  assert(report.jump.noseUp.up > report.jump.neutral.up + 2 && report.jump.noseDown.down < report.jump.neutral.down - 5, 'body lean pitches the bike in the air');
  assert(report.jump.whip.roll > 15 && report.jump.neutral.roll < 3, 'steering in the air whips the bike');
  report.jump = report.jump.neutral.air;

  // --- пустая батарея, откат назад, настоящая карта ---
  s = make(plane());
  s.battery = 0;
  run(s, I({ throttle: 1 }), 3);
  assert(Math.abs(s.u) < 0.1, 'empty battery must not propel the bike');
  s = make(plane());
  run(s, I({ brake: 1 }), 4);
  assert(s.u < -0.3 && s.u > -1.3 && s.battery === 1, 'rolls back by foot, without the motor');
  for (const map of ['city', 'polygon', 'hill']) {
    const sim = createSim(createTerrain(map), { model: 'x1', wheel: 14, tire: 'off', tune: { ...DEFAULT_TUNE }, riderKg: 75, mode: 'eco', crash: false });
    sim.respawn();
    for (let i = 0; i < 6 / DT; i++) { sim.step(I({ throttle: 0.5, brake: map === 'hill' ? 0.3 : 0 }), DT); assert(Number.isFinite(sim.px + sim.yb + sim.phi + sim.th), `${map}: finite`); }
    assert(Math.abs(sim.phi) < 1.2 && sim.yb - sim.terrain.height(sim.px, sim.pz) < 3, `${map}: stays on the ground`);
  }

  console.table(report);
  console.log('PASS: pit bike drivetrain, climbing, range, brakes, balance, slalom on 6 surfaces, bumps, wheelie and maps.');
} finally {
  await server.close();
}
