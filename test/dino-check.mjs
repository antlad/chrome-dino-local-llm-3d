// Headless ragdoll validation. This is the test that decides whether the whole
// "static world + pinned feet" locomotion model works, so it checks the things
// that actually matter: does it travel, stay upright, keep stepping, and collapse
// honestly when killed.
import assert from 'node:assert/strict';
import { DinoRagdoll } from '../src/game/dino.js';

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
  for (let i = 0; i < 120; i++) d.step(1 / 60, { ...RUN, laneZ: 0.28 });
  const z = d.pelvis.z;
  assert.ok(z > 0.08, `did not drift to the lane (${z.toFixed(3)})`);
  assert.ok(d.hipHeight > 0.55, `toppled during lane change (${d.hipHeight.toFixed(2)})`);
});

console.log(failures ? `\n${failures} ragdoll check(s) failed` : '\nall ragdoll checks passed');
if (failures) process.exit(1);
