// Obstacle clearance: proof that every prop can actually be jumped.
//
// This file exists because the game was, for a long time, un-winnable, and no
// other test noticed. The contract check verified method names. The physics check
// verified the solver. The ragdoll check verified that a jump launches the animal
// and that it lands on its feet. All of that passed while it was physically
// impossible to clear a single obstacle, because "the jump works" and "the jump is
// sufficient" are different claims and only the second one matters to a player.
//
// The claim being tested is the field's central promise: that obstacle spacing and
// size are derived from the jump arc, so no seed can generate a wall. The budget
// for one clearance is
//
//     the hit box stays entirely above the prop's top, for the time it takes the
//     body to travel (bodyLength + propWidth), i.e. (bodyLength + propWidth) / speed
//
// and it is measured against the *worst* legal instance of each kind (maximum size
// jitter) at the *slowest* legal speed (baseSpeed), which is where the ratio is
// hardest to satisfy. A run that starts at a crawl is a run where nothing can be
// jumped, which is exactly how this shipped broken.

import test from 'node:test';
import assert from 'node:assert/strict';
import { DinoRagdoll } from '../src/game/dino.js';
import { CONFIG } from '../src/game/config.js';
import { OBSTACLE_KINDS, ObstacleField } from '../src/game/obstacles.js';
import { FIXED } from '../src/game/game.js';

// Spacing is the field's business, so the field itself is asked rather than the
// numbers being copied in here. Two files agreeing on a gap by coincidence is how
// the last one went wrong.
const FIELD = new ObstacleField();

// The step the game simulates at, imported rather than restated. The gait is a driven
// spring system and its answer depends on the step size it is handed: the same animal
// crouches to different heights at 1/60 and 1/120. Measuring the fairness of flyer
// heights at a step the player never experiences would make this file a ceremony.
const DT = FIXED;

// Warm-up and sampling are in seconds, not step counts, so changing DT cannot silently
// shorten them: at 1/120 the old 300-step warm-up was 2.5 s, which is not enough for the
// gait to settle at the top of the speed range, and a body still mid-transition reads as
// a far taller crouch than one the player ever ducks behind.
//
// The sample is long on purpose, because the failure this file exists to catch turned out
// to be a resonance and resonances are rare. The head-chain whip that put the snout at
// 1.10 m while the hip sat at 0.38 m appeared on about one stride in two thousand,
// roughly 30 s into a run at 4 m/s. A sample of a few seconds returns a beautifully clean
// envelope and passes a game that kills ducking players at random. Shortening these
// numbers makes this file decorative.
const WARM_SECONDS = 12;
const SAMPLE_SECONDS = 34;
const stepsFor = (seconds) => Math.round(seconds / DT);

// Worst-case jitter from ObstacleField._spawn: h scales by up to 1.1, w and d by up
// to 1.14. If the test used nominal sizes the props could be tuned to pass here and
// still be unclearable in a real run that happened to roll big.
const JITTER_H = 1.1;
const JITTER_W = 1.14;

/**
 * Fly the animal once and record the airborne trajectory.
 *
 * Returns samples of { x, bottom, length } where bottom and length come from
 * DinoRagdoll.hitBounds(), so what is measured here is the same box the game tests
 * collisions against. Using bounds() instead would measure the decorative tail and
 * report a clearance failure for geometry that cannot kill the player.
 */
function flight(speed) {
  const d = new DinoRagdoll();
  for (let i = 0; i < stepsFor(3.5); i++) d.step(DT, { speed, ducking: false, laneZ: 0, dying: false });
  const x0 = d.pelvis.x;
  assert.ok(d.jump(CONFIG.jumpVelocity), 'the jump was refused');
  const samples = [];
  for (let i = 0; i < stepsFor(7); i++) {
    d.step(DT, { speed, ducking: false, laneZ: 0, dying: false });
    if (d.airTime <= 0.04) { if (samples.length) break; else continue; }
    const b = d.hitBounds();
    samples.push({ x: d.pelvis.x - x0, bottom: b.minY, length: b.maxX - b.minX });
  }
  return samples;
}

/**
 * The widest prop of width `w` whose top is at `top` that this arc can clear.
 *
 * Scans every contiguous window in which the whole hit box is above `top`, and
 * reports the largest (window travel - body length) found. That difference is the
 * spare room the prop is allowed to occupy: it is the horizontal overlap the body
 * can afford to have with the obstacle while still being above it.
 */
function clearanceAt(speed, top) {
  const s = flight(speed);
  let best = -Infinity;
  let i = 0;
  while (i < s.length) {
    if (s[i].bottom > top) {
      let j = i;
      while (j < s.length && s[j].bottom > top) j++;
      const window = s.slice(i, j);
      const travel = window[window.length - 1].x - window[0].x;
      const body = Math.max(...window.map((p) => p.length));
      best = Math.max(best, travel - body);
      i = j;
    } else i++;
  }
  return { room: best, hang: s.length * DT };
}

// Every ground kind, at both ends of the speed range, against its own worst case.
const SPEEDS = [CONFIG.baseSpeed, CONFIG.maxSpeed];
const GROUND = Object.entries({
  'cactus-small': { w: 0.50, h: 0.60 },
  'cactus-tall': { w: 0.55, h: 1.00 },
  'cactus-cluster': { w: 1.10, h: 0.74 },
  'rock': { w: 0.78, h: 0.42 },
});

// Room to spare, in metres, beyond the geometric minimum. Without margin the game
// is theoretically clearable and unplayable: the perfect window would be a frame or
// two wide and only a frame-perfect input would survive it. This number is what
// makes "a comfortably timed jump" pass rather than "a jump timed to the frame".
const MARGIN = 0.12;

for (const speed of SPEEDS) {
  for (const [kind, spec] of GROUND) {
    const top = spec.h * JITTER_H;
    const width = spec.w * JITTER_W;
    test(`${kind} is clearable at ${speed} m/s`, () => {
      const { room } = clearanceAt(speed, top);
      assert.ok(
        room >= width + MARGIN,
        `${kind} at ${speed} m/s: the arc keeps the hit box above ${top.toFixed(2)} m `
        + `with only ${room.toFixed(2)} m of spare room, but a max-size prop is `
        + `${width.toFixed(2)} m wide and needs ${(width + MARGIN).toFixed(2)} m`,
      );
    });
  }
}

// The arc has to stay a jump and not become a hover. Both directions have shipped
// broken: too little hang made every prop a wall, and an earlier over-correction
// gave a 2.4 s arc that looked like the animal was falling off a cliff in slow
// motion. The lower bound is a gameplay guarantee, the upper is a sanity check on
// the same numbers from the other side.
test('the jump hangs long enough to clear but is still a jump', () => {
  const { hang } = clearanceAt(CONFIG.baseSpeed, 0.45);
  assert.ok(hang > 0.85, `hang is only ${hang.toFixed(2)} s; nothing can be cleared`);
  assert.ok(hang < 1.9, `hang is ${hang.toFixed(2)} s; that is a float, not a leap`);
});

test('the apex clears the tallest prop', () => {
  const tallest = Math.max(...GROUND.map(([, s]) => s.h)) * JITTER_H;
  const s = flight(CONFIG.baseSpeed);
  const apex = Math.max(...s.map((p) => p.bottom));
  assert.ok(apex > tallest + 0.15, `apex bottom ${apex.toFixed(2)} vs prop top ${tallest.toFixed(2)}`);
});

// The field lays props out using the arc. If spacing is derived from a different
// arc than the one the ragdoll actually performs, the field produces walls while
// every individual prop stays individually clearable, which is the exact failure
// that made this unplayable. So the field's own airtime is checked against the
// measured hang rather than against an assumption.
test('the field spaces props using the arc the ragdoll actually performs', () => {
  const measured = flight(CONFIG.baseSpeed).length * DT;
  assert.ok(
    Math.abs(FIELD.airtime - measured) < 0.22,
    `field assumes ${(FIELD.airtime).toFixed(2)} s of airtime but the ragdoll measures `
    + `${measured.toFixed(2)} s; gaps are being derived from the wrong jump`,
  );

  // And the gap it demands at top speed has to be enough to land, re-plant, and
  // jump again: at least a full arc of travel plus the body.
  const gap = FIELD.minGapFor(CONFIG.maxSpeed);
  const needed = measured * CONFIG.maxSpeed;
  assert.ok(gap > needed,
    `min gap ${gap.toFixed(2)} m is shorter than one jump arc (${needed.toFixed(2)} m) at top speed`);
});

// A guarantee worth stating explicitly, because it was violated for the whole
// existence of this file until now: the hit box must not include the tail, or a
// trailing decoration ends runs and no jump can clear anything.
test('the tail cannot kill the player', () => {
  const d = new DinoRagdoll();
  for (let i = 0; i < 120; i++) d.step(DT, { speed: 3, ducking: false, laneZ: 0, dying: false });
  const all = d.bounds();
  const hit = d.hitBounds();
  assert.ok(hit.minX > all.minX + 0.2,
    `hit box reaches back to ${hit.minX.toFixed(2)} vs body ${all.minX.toFixed(2)}; the tail is still solid`);
});

// --- the other half of the game ---------------------------------------------------
//
// Jumping is only one of the two things a player can do. The flyers exist to make
// you duck, and a flyer that cannot be ducked under is not a variety obstacle, it
// is a second jump question wearing a different sprite. Worse, a flyer positioned so
// that *both* standing and crouching hit it is unanswerable by either input and the
// run simply ends, which is how the ground props were broken before this file existed.
//
// These numbers are measured as an envelope, not sampled at one instant, and that
// distinction is the reason this test exists. The axial chain is a spring, and a
// spring that is underdamped rings after the crouch is commanded instead of settling
// on it. Sampled one second in, the crouched box looked like it topped out at 0.67 m;
// observed across the whole transition it was peaking at 1.14 m, higher than the
// standing back, so every flyer the player is told to duck under killed them anyway.
// A single-sample test could not have caught that, and did not.
//
// The specs are read from OBSTACLE_KINDS rather than copied into this file, so the
// test cannot quietly drift away from the thing it is supposed to be policing.
const FLYERS = Object.entries(OBSTACLE_KINDS).filter(([, s]) => s.fly);

// The full speed range a run can reach, sampled finely. The gait drives the ring, and
// the ring is phase-locked to the stride, so whether a run hits the bad phase depends
// on speed in a way that is close to arbitrary: with 8 coarse speeds the whip was
// invisible and the envelope looked 2 cm safer than it is. 0.2 m/s is fine enough to
// land near the worst phase at every point of the range.
const ENVELOPE_SPEEDS = [];
for (let v = 1.6; v < CONFIG.maxSpeed; v += 0.2) ENVELOPE_SPEEDS.push(+v.toFixed(2));
ENVELOPE_SPEEDS.push(CONFIG.maxSpeed);

/**
 * The worst vertical extent the hit box ever takes on in a posture, across the speed
 * range and across the whole standing-to-crouching transition.
 *
 * `hi` is the highest the box ever reaches and decides whether a posture clears a
 * belly. `minTop` is the lowest its *top* ever falls, which is the head bob's trough,
 * and decides whether a posture is guaranteed to be hit by one. A flyer has to sit
 * under the low standing top, not the high one, or the player is killed on some
 * strides and spared on others.
 */
function envelope(duck) {
  let lo = Infinity;
  let hi = -Infinity;
  let minTop = Infinity;
  let worstAt = '';
  const warm = stepsFor(WARM_SECONDS);
  const sample = stepsFor(SAMPLE_SECONDS);
  for (const speed of ENVELOPE_SPEEDS) {
    const d = new DinoRagdoll();
    for (let i = 0; i < warm; i++) d.step(DT, { speed, ducking: duck, laneZ: 0, dying: false });
    for (let i = 0; i < sample; i++) {
      d.step(DT, { speed, ducking: duck, laneZ: 0, dying: false });
      const b = d.hitBounds();
      if (b.minY < lo) lo = b.minY;
      if (b.maxY > hi) { hi = b.maxY; worstAt = `${speed.toFixed(1)} m/s`; }
      if (b.maxY < minTop) minTop = b.maxY;
    }
  }
  return { lo, hi, minTop, worstAt };
}

const STANDING = envelope(false);
const CROUCHED = envelope(true);

// The spawn jitter in ObstacleField._spawn is what actually sets a flyer's extent,
// so the test has to use its real range rather than the nominal spec. Flyers are
// jittered far less than ground props (see the comment in _spawn): `y` is scaled by
// 0.99..1.01, `h` by 0.97..1.03, and a flyer bobs by up to 0.025 m. The belly is
// therefore lowest when y rolls low, h rolls tall and the bob is at its bottom, all at
// once, and that is the only clearance that counts. Note the low `y` roll drops the
// belly *toward* the crouch, so a flyer tuned to the nominal height alone would fail.
const FLY_Y_MIN = 0.99;
const FLY_Y_MAX = 1.01;
const FLY_H_MIN = 0.97;
const FLY_H_MAX = 1.03;
const FLY_BOB = 0.03;
// ObstacleField.checkHit shrinks the ragdoll box before testing it, so the top that
// actually matters is this much lower than the box reports. Ignoring it makes the test
// disagree with the game about whether a contact happened.
const HIT_PAD = 0.055;

// How far off the running line ObstacleField._spawn is allowed to put a ground prop.
// Its laneSpread is 0.16 for anything that sits on the sand; a dodge has to survive
// the prop being parked at either end of that, on the side that matters.
const GROUND_PROP_Z = 0.16;

for (const [kind, spec] of FLYERS) {
  test(`${kind} is passable by ducking or by jumping`, () => {
    // The belly has two worst cases and they come from different rolls, so both have
    // to be satisfied at once. The belly is *lowest* (hard to duck under) when y rolls
    // low, h rolls tall and the bob is at its bottom. It is *highest* (hard to be hit
    // by, because it floats above the head bob) when y rolls high, h rolls short and
    // the bob is at its top. A flyer that only clears the crouch on its nominal height
    // is duckable on some rolls and lethal on others.
    const bellyLow = spec.y * FLY_Y_MIN - (spec.h / 2) * FLY_H_MAX - FLY_BOB;
    const bellyHigh = spec.y * FLY_Y_MAX - (spec.h / 2) * FLY_H_MIN + FLY_BOB;
    const top = spec.y * FLY_Y_MAX + (spec.h / 2) * FLY_H_MAX + FLY_BOB;
    const crouchTop = CROUCHED.hi - HIT_PAD;
    const standingTop = STANDING.minTop - HIT_PAD;

    // A clean duck: the belly never dips into the crouch, and never rises above the
    // standing head bob, so ducking always clears and standing always hits.
    const duckable = crouchTop < bellyLow && bellyHigh < standingTop;
    if (duckable) {
      // It also has to read as a duck rather than a hop. A flyer whose whole body sits
      // above the standing back can be jumped as easily as ducked, so it would pass
      // without ever exercising the duck input.
      assert.ok(top > STANDING.hi - 0.3,
        `${kind} tops out at ${top.toFixed(2)} m against a standing top of ${STANDING.hi.toFixed(2)}: `
        + 'high enough that a player reasonably jumps it, so it is not exercising the duck');
      return;
    }

    // Anything that is not a clean duck has to be a jump. The interesting failure is a
    // flyer stranded between the two postures: too low to duck under, too high to hop,
    // and not sitting on the sand. That kills a run with no answer available.
    const groundProp = bellyLow < 0.18;
    assert.ok(groundProp,
      `${kind}: belly spans ${bellyLow.toFixed(2)}..${bellyHigh.toFixed(2)} m. The crouch tops `
      + `out at ${crouchTop.toFixed(2)} (at ${CROUCHED.worstAt}) and the standing head bob bottoms `
      + `out at ${standingTop.toFixed(2)}, so this belly is sometimes inside the crouch and always `
      + 'above the ground. It is neither duckable nor jumpable. Lift the whole body above '
      + `${standingTop.toFixed(2)} or drop it to the sand.`);
    const { room } = clearanceAt(CONFIG.baseSpeed, top);
    assert.ok(room >= spec.w * JITTER_W + MARGIN,
      `${kind} can only be jumped, but the arc leaves ${room.toFixed(2)} m of room for a `
      + `${(spec.w * JITTER_W).toFixed(2)} m prop`);
  });
}

// The crouch has to be a real crouch *and* a settled one. If the axial spring is ever
// retuned to ring again, or duckHeight creeps up, this is the assertion that says so
// before the flyer tests turn into a set of confusing jump tests.
test('ducking settles well below the standing back', () => {
  assert.ok(CROUCHED.hi < STANDING.hi - 0.2,
    `standing top ${STANDING.hi.toFixed(2)} vs crouched top ${CROUCHED.hi.toFixed(2)} `
    + `(worst at ${CROUCHED.worstAt})`);
  assert.ok(CROUCHED.hi < 0.90,
    `the crouched box peaks at ${CROUCHED.hi.toFixed(2)} m at ${CROUCHED.worstAt}; the flyers `
    + `need the crouch to settle under their bellies, so a crouch this high is not a crouch`);
});

// Ducking is a key the player holds, so the posture has to hold too. A crouch that
// settles and then rings back up under a sustained keypress is indistinguishable from
// one that never worked, from behind the keyboard.
test('the crouch holds while the key is held', () => {
  const d = new DinoRagdoll();
  for (let i = 0; i < 120; i++) d.step(DT, { speed: CONFIG.baseSpeed, ducking: false, laneZ: 0, dying: false });
  let peak = -Infinity;
  let peakFrame = -1;
  for (let i = 0; i < 600; i++) {
    d.step(DT, { speed: CONFIG.baseSpeed, ducking: true, laneZ: 0, dying: false });
    if (i < 60) continue;                 // the fold itself is allowed to take 1 s
    const y = d.hitBounds().maxY;
    if (y > peak) { peak = y; peakFrame = i; }
  }
  assert.ok(peak < 0.90,
    `the crouched box reached ${peak.toFixed(2)} m at frame ${peakFrame} of a sustained hold`);
});

// --- the third axis -----------------------------------------------------------------
//
// Everything above answers "can the jump clear it" and "can the crouch clear it".
// Neither question is about the strafe, which is the third thing a player can do and
// the only way past a ground prop without leaving the sand.
//
// That blind spot was not hypothetical. At the previous laneWidth of 0.62 m the
// cactus-cluster could not be dodged from *any* lane at *any* speed, because the prop
// is 0.525 m deep at full jitter, sits up to 0.16 m off the running line, and the
// animal's own hit box swings 0.48 m either side of the lane centre during a stride.
// The rock left 3 mm. Every test in this file passed, because every test in this file
// was about jumping.
//
// So the strafe gets the same treatment as the arc: for each ground prop, at each
// legal speed and each legal prop offset, some lane has to put the hit box wholly
// outside the prop's depth, with the same margin a jump needs.

// Settled per lane, not sampled mid-slide: a body still travelling to a lane reads
// as a box straddling two of them, which would report a dodge as impossible for a
// reason the player never experiences. The stride swing is the opposite case, it is
// real and it is the thing that eats the clearance, so each lane is sampled across
// enough strides to catch the widest leg extension. Memoised because every prop
// against every offset asks for the same handful of boxes.
const laneBoxCache = new Map();
function laneBox(speed, lane) {
  const key = `${speed}|${lane.toFixed(3)}`;
  if (laneBoxCache.has(key)) return laneBoxCache.get(key);
  const d = new DinoRagdoll();
  const cmd = { speed, ducking: false, laneZ: lane, dying: false, slowmo: 1 };
  for (let i = 0; i < stepsFor(8); i++) d.step(DT, cmd);
  let minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < stepsFor(14); i++) {
    d.step(DT, cmd);
    const b = d.hitBounds();
    if (b.minZ < minZ) minZ = b.minZ;
    if (b.maxZ > maxZ) maxZ = b.maxZ;
  }
  // checkHit shrinks the box before testing it, so this is the box that kills.
  const box = { minZ: minZ + HIT_PAD, maxZ: maxZ - HIT_PAD };
  laneBoxCache.set(key, box);
  return box;
}

const LANE_RANGE = CONFIG.laneCount > 1 ? (CONFIG.laneCount - 1) / 2 : 0.5;
const LANE_LIMIT = LANE_RANGE * CONFIG.laneWidth;
const LANES = [-LANE_LIMIT, 0, LANE_LIMIT];

// The field puts a ground prop up to this far off the running line (laneSpread in
// ObstacleField._spawn), and both directions have to be survivable.
const PROP_OFFSETS = [-GROUND_PROP_Z, 0, GROUND_PROP_Z];

for (const speed of SPEEDS) {
  for (const [kind, spec] of GROUND) {
    // Computed here so the assertion message can name the worst case, which is the
    // number a person retuning laneWidth is going to want. The depth comes from the
    // kind table rather than the GROUND literal above, which only carries the two
    // dimensions the vertical arc cares about.
    const halfD = (OBSTACLE_KINDS[kind].d * JITTER_W) / 2;
    let worst = Infinity, worstOffset = 0;
    for (const propZ of PROP_OFFSETS) {
      const propMin = propZ - halfD, propMax = propZ + halfD;
      let best = -Infinity;
      for (const lane of LANES) {
        const b = laneBox(speed, lane);
        // Positive only when the two boxes do not overlap in z at all.
        const slack = propMax <= b.minZ ? b.minZ - propMax
          : b.maxZ <= propMin ? propMin - b.maxZ
            : -Infinity;
        if (slack > best) best = slack;
      }
      if (best < worst) { worst = best; worstOffset = propZ; }
    }
    const depth = OBSTACLE_KINDS[kind].d * JITTER_W;
    test(`${kind} is dodgeable at ${speed} m/s`, () => {
      assert.ok(worst > 0,
        `${kind} at ${speed} m/s cannot be dodged at all. With the prop ${(worstOffset * 100).toFixed(0)} cm ` +
        `off the line and ${depth.toFixed(2)} m deep, no lane out of ` +
        `${LANES.map((l) => l.toFixed(2)).join(', ')} gets the hit box clear of it. The strafe is ` +
        'decoration and jumping is the only answer.');
      assert.ok(worst >= MARGIN,
        `${kind} at ${speed} m/s: the best lane leaves ${worst.toFixed(3)} m of lateral slack against ` +
        `a prop offset of ${worstOffset.toFixed(2)} m, under the ${MARGIN} m needed to commit to a ` +
        'lane without a frame-perfect press.');
    });
  }
}

// Width alone is not enough; the animal has to be able to *get there*. A lane change
// that cannot be committed inside the ground available between two props is the same
// as a lane that does not exist, and the previous numbers were exactly that: 1.5 m/s
// of drift took 0.42 s to cross 0.62 m, and the pelvis then lagged the lane target
// behind a rate-9 spring, so the body was a third of the way across when the next prop
// arrived. The budget is the field's own minimum gap divided by speed, which is how
// much ground a player actually has to react.
for (const speed of SPEEDS) {
  const budget = FIELD.minGapFor(speed) / speed;
  test(`a lane change commits inside the gap between two props at ${speed} m/s`, () => {
    const d = new DinoRagdoll();
    const cmd = { speed, ducking: false, laneZ: -LANE_LIMIT, dying: false, slowmo: 1 };
    for (let i = 0; i < stepsFor(6); i++) d.step(DT, cmd);
    cmd.laneZ = LANE_LIMIT;
    let seconds = 0;
    while (seconds < budget * 2 && Math.abs(d.pelvis.z) < LANE_LIMIT * 0.95) {
      d.step(DT, cmd);
      seconds += DT;
    }
    assert.ok(Math.abs(d.pelvis.z) >= LANE_LIMIT * 0.95,
      `at ${speed} m/s the pelvis never arrived (${d.pelvis.z.toFixed(3)} of ${LANE_LIMIT.toFixed(3)} m): ` +
      'the lane is a request the body ignores');
    assert.ok(seconds < budget,
      `at ${speed} m/s a lane change took ${seconds.toFixed(2)} s of the ${budget.toFixed(2)} s ` +
      'available between two props, so the strafe cannot be committed in time');
    assert.ok(d.hipHeight > 0.55,
      `at ${speed} m/s the strafe toppled the animal (hip ${d.hipHeight.toFixed(2)} m): easing the ` +
      'drift in faster than the pelvis can be dragged leaves the feet behind');
  });
}
