import assert from 'node:assert/strict';
import { createServer } from 'vite';

// Test the real 480 Hz simulator on a flat, obstacle-free asphalt surface, plus steering/roll and ragdoll physics.
const server = await createServer({ configFile: false, cacheDir: 'node_modules/.vite-physics-check', optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true }, appType: 'custom' });
try {
  const { ScooterSim, DT } = await server.ssrLoadModule('/src/game/physics.ts');
  const { RagdollSim, PARTICLE_COUNT, P_PELVIS, P_CHEST, P_HEAD } = await server.ssrLoadModule('/src/game/ragdoll.ts');
  const { MODELS, DEFAULT_TUNE, emptyInput } = await server.ssrLoadModule('/src/game/data.ts');
  const expected = { g2: [25, 35, 45], g2pro: [20, 40, 45], g2max: [15, 30, 55], g3pro: [25, 45, 65], g4: [38, 70, 86], x1: [25, 35, 50] };
  const { createSim } = await server.ssrLoadModule('/src/game/sim.ts');
  const terrain = { cones: [], obstacles: [], boxes: [], ramps: [], height: () => 0, macro: () => 0, surface: () => 'asphalt', gradient: (_x, _z, g) => { g.x = 0; g.z = 0; } };
  const rows = [];
  const make = (m, mode) => {
    const sim = createSim(terrain, { model: m.id, wheel: m.defaultWheel, tire: m.defaultTire, tune: { ...DEFAULT_TUNE }, riderKg: 75, mode, crash: false });
    sim.reset(0, 0, 0);
    return sim;
  };
  const step = (sim, input, seconds) => {
    for (let i = 0; i < seconds / DT; i++) {
      // The map boundary is unrelated to this dynamometer-style test.
      sim.px = 0; sim.pz = 0;
      sim.step(input, DT);
      assert(Number.isFinite(sim.u), 'Speed must remain finite');
    }
  };
  for (const model of Object.values(MODELS)) {
    assert.equal(model.vmax, expected[model.id][2]);
    for (const [i, mode] of ['eco', 'drive', 'sport'].entries()) {
      const limit = expected[model.id][i];
      assert.equal(model.modeSpeeds[mode], limit);
      const sim = make(model, mode);
      step(sim, { ...emptyInput(), throttle: 1 }, 90);
      const speed = sim.u * 3.6;
      assert(speed <= limit + .05, `${model.id}/${mode} exceeds factory speed`);
      assert(speed >= limit - .8, `${model.id}/${mode}: only ${speed.toFixed(2)} of ${limit} km/h`);
      assert(sim.battery > 0 && sim.battery < 1, 'Battery consumption must remain valid');
      const before = sim.odo;
      const input = { ...emptyInput(), brake: 1 };
      for (let n = 0; n < 10 / DT && sim.u > .5; n++) { sim.px = 0; sim.pz = 0; sim.step(input, DT); }
      assert(sim.u <= .5, `${model.id}/${mode}: brakes failed`);
      rows.push({ model: model.name, mode, limit, measured: +speed.toFixed(2), brakingMeters: +(sim.odo - before).toFixed(1) });
    }
  }
  assert.equal(MODELS.g3pro.awd, true, 'G3 Pro must power both wheels');
  assert.equal(MODELS.g4.defaultWheel, 12, 'G4 Max has 12-inch stock wheels');
  const empty = make(MODELS.g2, 'sport');
  empty.battery = 0;
  step(empty, { ...emptyInput(), throttle: 1 }, 3);
  assert(Math.abs(empty.u) < .1, 'Empty battery must not propel the scooter');
  const reverse = make(MODELS.g2, 'drive');
  step(reverse, { ...emptyInput(), brake: 1 }, 3);
  assert(reverse.u < -.2 && reverse.u > -1.9, 'Reverse should engage with a low speed limit');

  // Test realistic cornering roll & self-stabilization when steering returns to center
  const cornerSim = make(MODELS.g2, 'drive');
  step(cornerSim, { ...emptyInput(), throttle: 1 }, 6);
  step(cornerSim, { ...emptyInput(), throttle: 1, steer: 0.65 }, 1.5);
  assert(cornerSim.phi < -0.15, `Scooter must lean into right turn (phi=${cornerSim.phi.toFixed(3)})`);
  assert(cornerSim.r < -0.25, `Scooter must yaw into right turn (r=${cornerSim.r.toFixed(3)})`);
  step(cornerSim, { ...emptyInput(), throttle: 1, steer: 0 }, 2.0);
  assert(Math.abs(cornerSim.phi) < 0.04 && Math.abs(cornerSim.delta) < 0.02, 'Scooter must self-stabilize upright after turn');

  // Test realistic heavy human ragdoll trajectory & settling
  const rag = new RagdollSim();
  const pose = new Float32Array(PARTICLE_COUNT * 3);
  const ys = [0.89, 1.39, 1.60, 0.87, 0.87, 1.36, 1.36, 0.48, 0.48, 0.12, 0.12, 0.08, 0.08, 1.05, 1.05, 0.92, 0.92];
  const zs = [0, 0, 0, -0.085, 0.085, -0.185, 0.185, -0.085, 0.085, -0.04, 0.04, -0.04, 0.04, -0.22, 0.22, -0.25, 0.25];
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    pose[i * 3] = 0;
    pose[i * 3 + 1] = ys[i];
    pose[i * 3 + 2] = zs[i];
  }
  rag.trigger(
    pose,
    {
      reason: 'Столкновение',
      preVxW: 10, // 36 km/h
      preVyW: 0,
      preVzW: 0,
      preSpeed: 10,
      impactVn: 10,
      impactNx: -1,
      impactNz: 0,
      impactX: 0.56,
      impactY: 0.8,
      impactZ: 0,
      peakG: 22,
      kind: 'obstacle',
    },
    0,
    0,
    1,
    terrain,
  );
  for (let i = 0; i < 180; i++) {
    rag.step(1 / 60, terrain, { x: 0.2, y: 0, z: 0, psi: 0 });
  }
  const spineLen = Math.hypot(
    rag.pos[P_CHEST * 3] - rag.pos[P_PELVIS * 3],
    rag.pos[P_CHEST * 3 + 1] - rag.pos[P_PELVIS * 3 + 1],
    rag.pos[P_CHEST * 3 + 2] - rag.pos[P_PELVIS * 3 + 2],
  );
  assert(Math.abs(spineLen - 0.5) < 0.03, `Spine length must remain anatomical (${spineLen.toFixed(3)} m)`);
  assert(rag.maxHeight < 1.55, `Human ragdoll must not rocket into the sky (maxHeight=${rag.maxHeight.toFixed(2)} m)`);
  assert(rag.flightDist > 2.2 && rag.flightDist < 9.5, `Human ragdoll slide/tumble distance must be realistic (${rag.flightDist.toFixed(2)} m)`);
  assert(rag.pos[P_HEAD * 3 + 1] >= 0.08, 'Head must not penetrate ground');
  assert(rag.comVel.length() < 0.35, `Ragdoll must settle to rest on asphalt (vel=${rag.comVel.length().toFixed(3)} m/s)`);

  // Joints must stay anatomical through different crash types: no knees bending forwards or sideways, no feet pointing backwards
  const sub = (p, a, b) => [p[a * 3] - p[b * 3], p[a * 3 + 1] - p[b * 3 + 1], p[a * 3 + 2] - p[b * 3 + 2]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const unit = (a) => { const l = Math.hypot(...a) || 1; return a.map((x) => x / l); };
  const orth = (a, n) => unit(a.map((x, i) => x - n[i] * dot(a, n)));
  const sinDeg = (x) => (Math.asin(Math.max(-1, Math.min(1, x))) * 180) / Math.PI;
  const riding = [[-.22, .89, 0], [-.1, 1.37, 0], [-.05, 1.57, 0], [-.22, .87, -.085], [-.22, .87, .085], [-.11, 1.34, -.185], [-.11, 1.34, .185], [0, .6, -.11], [-.1, .6, .12], [.055, .294, -.04], [-.3, .31, .04], [.21, .284, -.06], [-.15, .28, .06], [.05, 1.12, -.3], [.05, 1.12, .3], [.3, 1.1, -.24], [.3, 1.1, .24]];
  for (const [kind, speed, side] of [['obstacle', 12, 1], ['endo', 9, 1], ['loopout', 6, -1], ['landing', 9, 1], ['slip', 14, -1]]) {
    const body = new RagdollSim();
    body.trigger(new Float32Array(riding.flat()), { reason: kind, preVxW: speed, preVyW: kind === 'landing' ? -4 : 0, preVzW: 0, preSpeed: speed, impactVn: speed, impactNx: -1, impactNz: 0, impactX: .56, impactY: .8, impactZ: 0, peakG: 22, kind }, 0, side, side, terrain);
    const worst = { knee: 0, kneeSide: 0, foot: 0, bone: 0 };
    for (let f = 0; f < 300; f++) {
      body.step(1 / 60, terrain, { x: Math.min(1.5, f * .04), y: 0, z: 0, psi: 0, lay: Math.min(1, f / 30), side });
      const p = body.pos;
      const up = unit(sub(p, 1, 0));
      const right = orth(sub(p, 4, 3), up);
      for (const [hip, knee, ank, toe] of [[3, 7, 9, 11], [4, 8, 10, 12]]) {
        const thigh = unit(sub(p, knee, hip));
        const shin = unit(sub(p, ank, knee));
        const axis = orth(right, thigh);
        worst.knee = Math.max(worst.knee, sinDeg(dot(shin, cross(axis, thigh))));
        worst.kneeSide = Math.max(worst.kneeSide, Math.abs(sinDeg(dot(shin, axis))));
        worst.foot = Math.max(worst.foot, sinDeg(-dot(unit(sub(p, toe, ank)), cross(orth(axis, shin), shin))));
        worst.bone = Math.max(worst.bone, Math.abs(Math.hypot(...sub(p, knee, hip)) - .42) / .42, Math.abs(Math.hypot(...sub(p, ank, knee)) - .41) / .41);
      }
    }
    assert(worst.knee < 12, `${kind}: knee hyperextends by ${worst.knee.toFixed(0)} degrees`);
    assert(worst.kneeSide < 45, `${kind}: knee bends sideways by ${worst.kneeSide.toFixed(0)} degrees`);
    assert(worst.foot < 12, `${kind}: foot points backwards by ${worst.foot.toFixed(0)} degrees`);
    assert(worst.bone < .08, `${kind}: leg bone stretched by ${(worst.bone * 100).toFixed(0)}%`);
    assert(body.maxHeight < 1.6 && body.comVel.length() < .35, `${kind}: body must come to rest (v=${body.comVel.length().toFixed(2)}, h=${body.maxHeight.toFixed(2)})`);
  }

  // Damage model: severity must grow with the crash, the helmet must protect the head, and injuries must appear over time
  const { DamageSystem } = await server.ssrLoadModule('/src/game/damage.ts');
  const wall = { ...terrain, boxes: [{ x: 4, z: 0, halfX: 3, halfZ: 6, h: 6, kind: 'building', label: 'wall' }] };
  const crash = (kind, speed, helmet, ground) => {
    const body = new RagdollSim();
    const damage = new DamageSystem();
    body.damage = damage;
    damage.begin({ helmet, riderKg: 75 }, 7);
    body.trigger(new Float32Array(riding.flat()), { reason: kind, preVxW: speed, preVyW: 0, preVzW: 0, preSpeed: speed, impactVn: speed, impactNx: -1, impactNz: 0, impactX: .56, impactY: .8, impactZ: 0, peakG: 22, kind }, 0, .5, 1, ground);
    for (let f = 0; f < 330 && !body.settled; f++) body.step(1 / 60, ground, { x: Math.min(1.5, f * .04), y: 0, z: 0, psi: 0, lay: Math.min(1, f / 30), side: 1 });
    return damage;
  };
  const headAis = (d) => Math.max(0, ...d.evaluate().report.injuries.filter((i) => ['skull', 'jaw', 'cervical'].includes(i.site) && i.kind !== 'abrasion' && i.kind !== 'contusion').map((i) => i.ais));
  const slow = crash('slip', 4.2, 'full', terrain).evaluate().report;
  assert(slow.severity <= 2 && slow.injuries.every((i) => i.ais < 3), `A 15 km/h slide must not cause severe injuries (${slow.severityLabel}, ISS ${slow.iss})`);
  const bare = crash('obstacle', 22, 'none', wall);
  const helmeted = crash('obstacle', 22, 'full', wall);
  assert(bare.evaluate().report.severity >= 4, `Hitting a wall at 80 km/h without a helmet must be severe (ISS ${bare.evaluate().report.iss})`);
  assert(bare.evaluate().report.iss > slow.iss + 10, 'Injury severity must grow with crash energy');
  assert(headAis(helmeted) < headAis(bare), `A full-face helmet must reduce head injuries (${headAis(helmeted)} vs ${headAis(bare)})`);
  assert(bare.evaluate().report.fractures >= 3, 'A wall impact at 80 km/h must break bones');
  assert(bare.evaluate(-1).report.injuries.length === 0, 'No injuries may be reported before the impact');
  assert(bare.evaluate(0.05).report.injuries.length <= bare.evaluate().report.injuries.length, 'Injuries must accumulate over the crash timeline');
  assert(new DamageSystem().evaluate().report.iss === 0, 'An idle damage model reports no injuries');

  console.table(rows);
  console.log('PASS: 18 model/mode combinations, braking, dual drive, stock wheels, empty battery, reverse, cornering roll, realistic human ragdoll, anatomical joint limits in 5 crash types, and the injury model.');
} finally { await server.close(); }
