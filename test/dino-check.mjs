// Headless ragdoll validation. This is the test that decides whether the whole
// "static world + pinned feet" locomotion model works, so it checks the things
// that actually matter: does it travel, stay upright, keep stepping, and collapse
// honestly when killed.
import assert from 'node:assert/strict';
import { DinoRagdoll } from '../src/game/dino.js';
import { CONFIG } from '../src/game/config.js';

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log('  ok  ' + name);
  } catch (err) {
    failures++;
    console.log('FAIL  ' + name + '\n      ' + err.message);
  }
}

function run(dino, seconds, cmd) {
  const steps = Math.round(seconds * 60);
  for (let i = 0; i < steps; i++) dino.step(1 / 60, cmd);
}

const RUN = { speed: 8, ducking: false, laneZ: 0, dying: false, slowmo: 1 };

test('the dino runs itself forward under its own pinned-foot drive', () => {
  const d = new DinoRagdoll();
  const start = d.pelvis.x;
  run(d, 3, RUN);
  const travelled = d.pelvis.x - start;
  // 3 s at 8 m/s is 24 m; require at least 60 % of that to be real progress.
  assert.ok(travelled > 14, `only travelled ${travelled.toFixed(2)} m in 3 s`);
});

test('forward speed actually tracks the commanded speed', () => {
  const d = new DinoRagdoll();
  run(d, 2.5, RUN);
  const vx = d.velocity()[0];
  assert.ok(Math.abs(vx - 8) < 2.2, `vx ${vx.toFixed(2)} vs commanded 8`);
});

test('it stays upright: hip holds height and the torso does not faceplant', () => {
  const d = new DinoRagdoll();
  run(d, 3, RUN);
  const hip = d.hipHeight;
  assert.ok(hip > 0.62 && hip < 1.35, `hip height ${hip.toFixed(3)}`);
  const head = d.world.pos[d.i.head * 3 + 1];
  const tail = d.world.pos[d.i.tail4 * 3 + 1];
  assert.ok(head > 0.7, `head dropped to ${head.toFixed(3)}`);
  assert.ok(head > tail, 'tail is above the head, the animal is inverted');
});

test('feet keep alternating: it steps, it does not skate or stand still', () => {
  const d = new DinoRagdoll();
  run(d, 3, RUN);
  assert.ok(d.stepCount > 8, `only ${d.stepCount} footfalls in 3 s`);
  // It must also spend some time airborne, i.e. a real flight phase exists.
  assert.ok(d.airTime >= 0, 'airTime went negative');
});

test('feet do not stay welded to the ground while running', () => {
  const d = new DinoRagdoll();
  run(d, 2, RUN);
  let pinnedFrames = 0;
  for (let i = 0; i < 120; i++) {
    d.step(1 / 60, RUN);
    if (d.world.inv[d.i.footL] === 0 && d.world.inv[d.i.footR] === 0) pinnedFrames++;
  }
  // Both feet pinned at once is allowed briefly but must not be the norm.
  assert.ok(pinnedFrames < 40, `both feet pinned for ${pinnedFrames}/120 frames`);
});

test('the animal never sinks through the floor', () => {
  const d = new DinoRagdoll();
  let minClear = Infinity;
  for (let i = 0; i < 60 * 4; i++) {
    d.step(1 / 60, RUN);
    minClear = Math.min(minClear, d.clearance());
  }
  assert.ok(minClear > -0.12, `sank to ${minClear.toFixed(3)}`);
});

test('the skeleton does not stretch apart', () => {
  const d = new DinoRagdoll();
  run(d, 3, RUN);
  const w = d.world;
  for (const dist of w.dist) {
    if (dist.tag !== 'bone') continue;
    const got = w.distance(dist.a, dist.b);
    const err = Math.abs(got - dist.rest) / dist.rest;
    assert.ok(err < 0.12, `bone ${w.names[dist.a]}-${w.names[dist.b]} off by ${(err * 100).toFixed(1)}%`);
  }
});

test('no NaN anywhere after a hard run', () => {
  const d = new DinoRagdoll();
  run(d, 5, { ...RUN, speed: 15 });
  for (let p = 0; p < d.world.count; p++) {
    for (let k = 0; k < 3; k++) {
      assert.ok(Number.isFinite(d.world.pos[p * 3 + k]), `particle ${p} axis ${k} is NaN`);
    }
  }
});

test('a jump launches it and it comes back down on its feet', () => {
  const d = new DinoRagdoll();
  run(d, 1.5, RUN);
  const before = d.hipHeight;
  d.jump(8.6);
  let peak = before;
  for (let i = 0; i < 20; i++) {
    d.step(1 / 60, RUN);
    peak = Math.max(peak, d.hipHeight);
  }
  assert.ok(peak - before > 0.9, `jumped only ${(peak - before).toFixed(2)} m`);
  run(d, 1.6, RUN);
  assert.ok(d.hipHeight > 0.6, `did not recover, hip ${d.hipHeight.toFixed(2)}`);
  assert.ok(Math.abs(d.velocity()[0]) > 3, 'lost all forward speed after landing');
});

test('ducking lowers the body', () => {
  const stand = new DinoRagdoll();
  run(stand, 2, RUN);
  const duck = new DinoRagdoll();
  run(duck, 2, { ...RUN, ducking: true });
  assert.ok(duck.hipHeight < stand.hipHeight - 0.15,
    `duck ${duck.hipHeight.toFixed(2)} vs stand ${stand.hipHeight.toFixed(2)}`);
});

test('death releases every motor and the body collapses under gravity', () => {
  const d = new DinoRagdoll();
  run(d, 2, RUN);
  const uprightHip = d.hipHeight;
  const headBefore = d.world.pos[d.i.head * 3 + 1];
  d.die({ x: -2.5, y: 5.5, z: 0.6 });
  for (let i = 0; i < 40; i++) d.step(1 / 60, { ...RUN, dying: true, speed: 0 });

  assert.ok(!d.stance.L && !d.stance.R, 'a foot is still pinned after death');
  assert.ok(d.world.inv[d.i.footL] > 0 && d.world.inv[d.i.footR] > 0, 'feet still welded');
  const hipAfter = d.hipHeight;
  assert.ok(hipAfter < uprightHip - 0.2, `hip barely fell: ${hipAfter.toFixed(2)} vs ${uprightHip.toFixed(2)}`);
  const headAfter = d.world.pos[d.i.head * 3 + 1];
  assert.ok(headAfter < headBefore, 'head never came down');
});

test('the corpse tumbles forward and settles, still in one piece', () => {
  const d = new DinoRagdoll();
  run(d, 2, RUN);
  const xAtDeath = d.pelvis.x;
  d.die({ x: -1.5, y: 5.0, z: 0 });
  for (let i = 0; i < 240; i++) d.step(1 / 60, { speed: 0, dying: true, ducking: false, laneZ: 0 });

  const slid = d.pelvis.x - xAtDeath;
  assert.ok(Math.abs(slid) > 0.25, `corpse slid only ${slid.toFixed(2)} m`);
  assert.ok(d.hipHeight > 0.08, `corpse sank through the floor (${d.hipHeight.toFixed(2)})`);
  assert.ok(d.clearance() > -0.1, `parts underground (${d.clearance().toFixed(2)})`);

  const w = d.world;
  for (const dist of w.dist) {
    if (dist.tag !== 'bone') continue;
    const err = Math.abs(w.distance(dist.a, dist.b) - dist.rest) / dist.rest;
    assert.ok(err < 0.2, `bone ${w.names[dist.a]}-${w.names[dist.b]} tore open (${(err * 100).toFixed(0)}%)`);
  }
  const v = d.velocity();
  assert.ok(Math.hypot(...v) < 0.6, `corpse still moving at ${Math.hypot(...v).toFixed(2)}`);
});

test('respawn restores a running animal', () => {
  const d = new DinoRagdoll();
  run(d, 1, RUN);
  d.die({ x: 0, y: 5, z: 0 });
  run(d, 2, { speed: 0, dying: true, ducking: false, laneZ: 0 });
  d.respawn(0);
  assert.equal(d.aliveFlag, true);
  run(d, 2, RUN);
  assert.ok(d.pelvis.x > 6, `respawned dino travels ${d.pelvis.x.toFixed(2)} m in 2 s`);
  assert.ok(d.hipHeight > 0.6, 'respawned dino cannot hold itself up');
});

test('lane changes move it sideways without toppling', () => {
  const d = new DinoRagdoll();
  run(d, 1, RUN);
  const outer = CONFIG.laneWidth * (CONFIG.laneCount - 1) / 2;
  for (let i = 0; i < 120; i++) d.step(1 / 60, { ...RUN, laneZ: outer });
  const z = d.pelvis.z;
  // The pelvis has to actually arrive. It used to be enough for this test that the
  // animal drifted *toward* a 0.28 m lane, which a body that stalled a third of the
  // way across would also have satisfied. Now the lane is the whole point of the
  // move, so reaching it is what is checked.
  assert.ok(Math.abs(z - outer) < 0.05, `did not reach the lane (${z.toFixed(3)} of ${outer.toFixed(3)})`);
  assert.ok(d.hipHeight > 0.55, `toppled during lane change (${d.hipHeight.toFixed(2)})`);
});

test('a strafe crosses a lane fast enough to be worth pressing', () => {
  // The strafe is the only evasion in the game besides the jump, so its speed is a
  // fairness number rather than a feel one: a lane change that takes longer than the
  // gap between two props cannot be completed, and the player learns to jump
  // everything. The ceiling below is the field's own worst-case reaction budget,
  // minGapFor divided by speed, so this fails if the drift is ever slowed to the
  // point where the answer to an obstacle has to be a jump.
  const budgetAt = (speed) => {
    const airtime = (2 * CONFIG.jumpVelocity) / Math.abs(CONFIG.jumpGravity);
    return (airtime * speed + 2.0) / speed;
  };
  for (const speed of [CONFIG.baseSpeed, CONFIG.maxSpeed]) {
    const d = new DinoRagdoll();
    const cmd = { speed, ducking: false, laneZ: 0, dying: false, slowmo: 1 };
    run(d, 1, cmd);
    const outer = CONFIG.laneWidth * (CONFIG.laneCount - 1) / 2;
    cmd.laneZ = outer;
    let seconds = 0;
    while (seconds < 3 && Math.abs(d.pelvis.z) < outer * 0.95) {
      d.step(1 / 60, cmd);
      seconds += 1 / 60;
    }
    assert.ok(Math.abs(d.pelvis.z) >= outer * 0.95,
      `at ${speed} m/s never got across the lane (${d.pelvis.z.toFixed(3)} of ${outer.toFixed(3)})`);
    const budget = budgetAt(speed);
    assert.ok(seconds < budget,
      `at ${speed} m/s a lane change took ${seconds.toFixed(2)} s, over the ` +
      `${budget.toFixed(2)} s of ground available between two props`);
    assert.ok(d.hipHeight > 0.55, `at ${speed} m/s the strafe toppled it (${d.hipHeight.toFixed(2)})`);
  }
});

/**
 * Measure the legs over the airborne part of a leap.
 *
 * The window deliberately starts once the animal is properly off the sand rather
 * than at the first frame of airTime. The tuck is entered over airTuckTime, so the
 * earliest frames are a leg travelling to a pose, and counting a direction change in
 * a leg that is deliberately moving would make the measurement meaningless.
 */
function flightLegs(dino, speed) {
  const d = dino;
  const cmd = { speed, ducking: false, laneZ: 0, dying: false, slowmo: 1 };
  run(d, 2, cmd);
  const stand = d.hipHeight;
  d.jump(CONFIG.jumpVelocity);

  const jointAngle = (side) => {
    const w = d.world;
    const a = d.i.pelvis * 3, b = d.i['thigh' + side] * 3, c = d.i['shin' + side] * 3;
    const v1 = [w.pos[a] - w.pos[b], w.pos[a + 1] - w.pos[b + 1], w.pos[a + 2] - w.pos[b + 2]];
    const v2 = [w.pos[c] - w.pos[b], w.pos[c + 1] - w.pos[b + 1], w.pos[c + 2] - w.pos[b + 2]];
    const l1 = Math.hypot(...v1), l2 = Math.hypot(...v2);
    return Math.acos(Math.max(-1, Math.min(1, (v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2]) / (l1 * l2))));
  };

  const out = { frames: 0, reversals: 0, atFoldLimit: 0, samples: 0, peakFootSpeed: 0 };
  const prevVy = { L: 0, R: 0 };
  let t = 0;
  for (let i = 0; i < Math.round(1.5 * 60); i++) {
    for (const side of ['L', 'R']) {
      prevVy[side] = d.world.getVelocity(d.i['foot' + side], 1 / 60, d.world.substeps)[1];
    }
    d.step(1 / 60, cmd);
    t += 1 / 60;
    // Genuine flight, narrowly defined. The leap has to still be committed, the tuck
    // has to have finished being assumed, and the hip has to be above the height a
    // running bob reaches. Every one of those excludes a phase where a leg is
    // legitimately travelling somewhere, which is what would make a reversal count
    // meaningless.
    if (!(d._jumping || d.airTime > 0.04)) continue;
    if (t <= CONFIG.airTuckTime + 0.02) continue;
    if (d.hipHeight < stand + 0.25) continue;
    out.frames++;
    for (const side of ['L', 'R']) {
      const v = d.world.getVelocity(d.i['foot' + side], 1 / 60, d.world.substeps);
      out.peakFootSpeed = Math.max(out.peakFootSpeed, Math.hypot(v[0], v[1], v[2]));
      // A foot reversing through 0.25 m/s is a flap, not a tremor. Below that a leg
      // settling into its servo target also changes sign, and that is fine.
      if (Math.abs(v[1]) > 0.25 && prevVy[side] !== 0
        && Math.sign(v[1]) !== Math.sign(prevVy[side])) out.reversals++;
      const hip = d.world.angles.find((r) => r.name === 'hip' + side);
      if (jointAngle(side) < hip.lo + 0.06) out.atFoldLimit++;
      out.samples++;
    }
  }
  return out;
}

test('the airborne tuck is a shape the hip joint can actually make', () => {
  // This is the test that would have caught the twitch directly, without needing to
  // watch the legs. The tuck target is a *toe*, and solveLeg pulls the ankle back off
  // it by the foot vector, so the pose the gait commands is only reachable if the
  // resulting hip-to-ankle span leaves the hip above its hard fold limit. The shipped
  // numbers put it at 0.42 rad against a limit of 0.50, which is not a tuck, it is a
  // leg being told every frame to do something its joint refuses.
  const L = new DinoRagdoll().leg;
  const ax = CONFIG.airReach - L.toeX * L.meta;
  const ay = -CONFIG.airTuck - L.toeY * L.meta;
  const span = Math.hypot(ax, ay);
  const hip = Math.acos(Math.max(-1, Math.min(1,
    (L.femur ** 2 + L.tibia ** 2 - span ** 2) / (2 * L.femur * L.tibia))));
  const limit = 0.50;
  assert.ok(hip > limit + 0.1,
    `the tuck commands a hip angle of ${hip.toFixed(2)} rad against a fold limit of ` +
    `${limit}; the IK and the joint will fight all flight. span ${span.toFixed(3)} m ` +
    `(airTuck ${CONFIG.airTuck}, airReach ${CONFIG.airReach})`);
});

test('the legs hold the tuck instead of twitching in the air', () => {
  // The reported bug, measured rather than eyeballed. Before the fix a leap had the
  // hip pinned against its fold limit for 82 % of the flight and both feet reversing
  // direction about 19 times a second, because the pose being commanded was one the
  // joint refused and the stumble panic was firing on top of it.
  for (const speed of [CONFIG.baseSpeed, CONFIG.maxSpeed]) {
    const m = flightLegs(new DinoRagdoll(), speed);
    assert.ok(m.frames > 40, `only ${m.frames} airborne frames measured at ${speed} m/s`);
    const perSecond = m.reversals / (m.frames / 60);
    assert.ok(m.atFoldLimit === 0,
      `at ${speed} m/s the hip sat against its fold limit in ${m.atFoldLimit} of ` +
      `${m.samples} airborne samples: the tuck is fighting the joint`);
    assert.ok(perSecond < 10,
      `at ${speed} m/s the feet changed direction ${perSecond.toFixed(1)} times a second ` +
      `(${m.reversals} in ${m.frames} frames): the legs are twitching, not holding a pose`);
    assert.ok(m.peakFootSpeed < 16,
      `at ${speed} m/s a foot was driven at ${m.peakFootSpeed.toFixed(1)} m/s mid-flight`);
  }
});

console.log(failures ? `\n${failures} ragdoll check(s) failed` : '\nall ragdoll checks passed');
if (failures) process.exit(1);
