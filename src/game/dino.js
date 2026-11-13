// The ragdoll T-Rex.
//
// One skeleton, two ways of existing.
//
//   alive -> the pelvis is a *soft* root: its horizontal speed is chased with a
//            limited acceleration and its height is held by a spring, but it stays
//            a real particle in the solver. A second, weaker spring on the chest
//            holds the posture up so the torso sags without collapsing. The feet
//            are commanded: the gait clock decides where a foot must land, the
//            foot is servoed there, and on touchdown it becomes a true world
//            anchor (invMass = 0). The body is then dragged over that anchor.
//
//   dead  -> motors fade out over ~0.16 s, the feet are released, and the root
//            stops being driven. From that instant the body is 100 % the solver:
//            gravity, ground friction, self-collision, and whatever angular
//            momentum the hit left behind. Nothing scripted touches it again.
//
// Why the skeleton is bent. Position-based angle constraints are conditioned on
// 1/sin(theta): at theta = pi the gradient diverges and a straight limb becomes a
// source of explosive energy rather than a joint. Every joint in this skeleton is
// authored to rest between roughly 1.2 and 2.5 radians, which is both what a
// digitigrade runner actually looks like and what the solver can hold. Joints that
// could not be placed away from pi (the spine, the tail) are not angle joints at
// all: they are trusses made of distance constraints, which are perfectly
// conditioned, plus the chest spring for anti-gravity.
//
// Every pose number in this file is an OFFSET IN RADIANS from the angle the rest
// skeleton measures, never an absolute angle.

import { PhysicsWorld, angle3, clamp } from '../engine/pbd3d.js';
import { CONFIG, lerp, smooth } from './config.js';

/** Local-space rest skeleton. Pelvis at origin, facing +X, Y up.
 *
 *  The leg is a digitigrade chain and its proportions are load-bearing, not
 *  cosmetic. Read pelvis as the hip, thigh as the knee, shin as the ankle, foot as
 *  the toe:
 *
 *    femur  (0.300, -0.140)  short and forward
 *    shin   (-0.300, -0.440) long and back
 *    foot   (0.215, -0.045)  nearly horizontal, toe forward
 *
 *  Two reasons this exact shape. First, no joint sits near pi: the hip measures
 *  1.41 rad and the knee 1.19 rad, and a position-based angle constraint is
 *  conditioned on 1/sin(theta), so a straight limb is an energy source rather than
 *  a joint. Second, the chain (0.331 + 0.533 + 0.225) reaches down to the sand at
 *  only 67 % extension, which is what leaves about 0.37 m of horizontal reach
 *  behind the hip and 0.80 m in front of it. A leg long enough to look right but
 *  straight enough to touch the floor at standing height has no reach left, and
 *  the animal spends the whole run pulling itself down instead of forward. */
export const SKELETON = {
  pelvis: { x: 0.000, y: 0.000, z: 0.000, mass: 4.6, radius: 0.150, friction: 0.55 },
  chest: { x: 0.265, y: 0.115, z: 0.000, mass: 3.6, radius: 0.148 },
  neck: { x: 0.475, y: 0.245, z: 0.000, mass: 1.3, radius: 0.085 },
  head: { x: 0.645, y: 0.300, z: 0.000, mass: 2.0, radius: 0.108 },
  snout: { x: 0.870, y: 0.255, z: 0.000, mass: 0.75, radius: 0.072 },

  tail1: { x: -0.290, y: -0.030, z: 0.000, mass: 1.5, radius: 0.100 },
  tail2: { x: -0.565, y: -0.095, z: 0.012, mass: 0.95, radius: 0.074 },
  tail3: { x: -0.800, y: -0.185, z: 0.026, mass: 0.6, radius: 0.052 },
  tail4: { x: -1.005, y: -0.300, z: 0.038, mass: 0.40, radius: 0.036 },

  thighL: { x: 0.300, y: -0.140, z: 0.100, mass: 1.60, radius: 0.084 },
  shinL: { x: 0.000, y: -0.580, z: 0.110, mass: 0.90, radius: 0.056 },
  footL: { x: 0.215, y: -0.625, z: 0.116, mass: 0.50, radius: 0.055, friction: 0.95 },

  thighR: { x: 0.300, y: -0.140, z: -0.100, mass: 1.60, radius: 0.084 },
  shinR: { x: 0.000, y: -0.580, z: -0.110, mass: 0.90, radius: 0.056 },
  footR: { x: 0.215, y: -0.625, z: -0.116, mass: 0.50, radius: 0.055, friction: 0.95 },

  armL: { x: 0.315, y: -0.020, z: 0.125, mass: 0.28, radius: 0.034 },
  armR: { x: 0.315, y: -0.020, z: -0.125, mass: 0.28, radius: 0.034 },
};

const ORDER = Object.keys(SKELETON);
const SIDES = ['L', 'R'];

/**
 * Particles left out of the collision box. See `hitBounds` for why the tail is
 * not allowed to kill the player. The arms stay in: they are at the front, and a
 * run should end if the dino's chest hits something.
 */
const HIT_EXCLUDE = new Set(['tail1', 'tail2', 'tail3', 'tail4']);

/** Bones rendered as tapered capsules: [from, to, radiusAtFrom, radiusAtTo]. */
export const BONES = [
  ['pelvis', 'chest', 0.150, 0.145],
  ['chest', 'neck', 0.145, 0.082],
  ['neck', 'head', 0.082, 0.102],
  ['head', 'snout', 0.102, 0.069],
  ['pelvis', 'tail1', 0.146, 0.096],
  ['tail1', 'tail2', 0.096, 0.070],
  ['tail2', 'tail3', 0.070, 0.049],
  ['tail3', 'tail4', 0.049, 0.032],
  ['pelvis', 'thighL', 0.092, 0.084],
  ['thighL', 'shinL', 0.084, 0.056],
  ['shinL', 'footL', 0.056, 0.058],
  ['pelvis', 'thighR', 0.092, 0.084],
  ['thighR', 'shinR', 0.084, 0.056],
  ['shinR', 'footR', 0.056, 0.058],
  ['chest', 'armL', 0.038, 0.032],
  ['chest', 'armR', 0.038, 0.032],
];

/** The torso and tail are trusses, not hinge chains. Each extra link turns a
 *  hinged quad into two triangles, which is what keeps the animal in one piece
 *  without a single ill-conditioned angle constraint.
 *
 *  The rule this list has to obey: nothing below the hip gets braced to anything
 *  above it. The hip, knee and ankle are moved by the gait, so a distance link from
 *  one of them to the torso is a tow rope, and the foot is stronger than the back.
 *  `chest -> thigh` looked like a sensible way to keep the animal from folding in
 *  half, and it was the single largest defect in the skeleton: measured against
 *  removing it, it was worth 0.75 rad of nose-dive, taking the head from a level
 *  1.0 m to the sand and pitching the whole torso through 75 degrees every stride.
 *  The hip angle limit already stops the leg folding into the chest, and it does it
 *  at the joint, where the load belongs. */
const BRACES = [
  ['pelvis', 'neck'], ['chest', 'tail1'], ['pelvis', 'tail2'],
  ['chest', 'head'], ['neck', 'snout'],
  ['pelvis', 'head'], ['neck', 'tail1'], ['pelvis', 'tail3'],
  ['tail1', 'tail3'], ['tail2', 'tail4'], ['tail1', 'tail4'],
  ['head', 'tail1'],
];

/** Hinge joints, expressed as hard limits rather than springs.
 *
 *  While the animal is alive nothing here has a target: the legs are placed by IK
 *  and these are only what stops a limb folding through itself or straightening
 *  into a dislocation. That is also why `hi` runs right up to the edge of full
 *  extension. A position-based angle constraint is conditioned on 1/sin(theta), so
 *  a *motor* holding a limb straight is an energy source, but a *limit* that only
 *  fires on violation is harmless. Capping the top at 1.86 rad instead cut the
 *  leg's reach to 0.70 m against the 0.86 m the solver asks for, and the anchor
 *  paid for the difference by pulling the pelvis into the sand.
 *
 *  Named for the joint the angle sits at: hipL is the knee, kneeL is the ankle,
 *  matching the pelvis -> thigh(knee) -> shin(ankle) -> foot(toe) chain. */
const JOINTS = [
  { a: 'pelvis', b: 'thighL', c: 'shinL', name: 'hipL', lo: 0.50, hi: 2.96 },
  { a: 'thighL', b: 'shinL', c: 'footL', name: 'kneeL', lo: 0.50, hi: 2.90 },
  { a: 'pelvis', b: 'thighR', c: 'shinR', name: 'hipR', lo: 0.50, hi: 2.96 },
  { a: 'thighR', b: 'shinR', c: 'footR', name: 'kneeR', lo: 0.50, hi: 2.90 },
];

const JOINT_BY_NAME = new Map(JOINTS.map((j) => [j.name, j]));

/**
 * The parts of the animal that hang off the hip rather than stand on it: spine,
 * skull and tail. `support` is the fraction of gravity the muscles in that region
 * cancel, `tau` is the time constant of its posture spring, `duckOffset` is the
 * height it drops to above the hip when the animal folds down.
 *
 * support and tau are not independent, and the relationship is the whole design.
 * The posture spring holds a particle against whatever gravity `support` leaves
 * uncancelled, and the steady-state error of that arrangement is
 * `|g| * (1 - support) * tau^2`. Two things follow. The error is *quadratic* in tau
 * and only linear in (1 - support), so softness is far more expensive than weight:
 * taking the tail from tau 0.34 to 0.08 buys fifteen times more than raising its
 * support from 0.34 to 0.86. And because it is quadratic, a tau that feels
 * "slightly too soft" is not slightly wrong, it is catastrophically wrong, which is
 * how a tail authored at 0.40 m ended up measured at 1.83 m, straight up in the air.
 *
 * So tau is chosen first and kept short, in the 0.05 to 0.09 band where the error
 * stays under about 6 cm, and support is then used for what it is actually good at:
 * feel. support is what decides how much of the body sinks into each footfall, so
 * the chest and the base of the tail hold nearly all their own weight while the head
 * and the tail tip, which are light and want to lag, are allowed to be softer.
 */
const AXIAL = {
  chest: { support: 0.95, tau: 0.06, duckOffset: -0.020 },
  neck: { support: 0.93, tau: 0.06, duckOffset: -0.030, whipDamp: 0.8 },
  head: { support: 0.88, tau: 0.07, duckOffset: -0.070, whipDamp: 0.8 },
  snout: { support: 0.82, tau: 0.08, duckOffset: -0.140, whipDamp: 0.8 },
  tail1: { support: 0.94, tau: 0.06, duckOffset: -0.070 },
  tail2: { support: 0.90, tau: 0.07, duckOffset: -0.150 },
  tail3: { support: 0.86, tau: 0.075, duckOffset: -0.240 },
  tail4: { support: 0.82, tau: 0.08, duckOffset: -0.330 },
  armL: { support: 0.50, tau: 0.14, duckOffset: -0.055 },
  armR: { support: 0.50, tau: 0.14, duckOffset: -0.055 },
};
const AXIAL_NAMES = Object.keys(AXIAL);

/** Where limbs drift as the motors bleed out, as offsets from neutral.
 *  Negative folds a limb, which is what a limp body does. */
const DEAD_SPLAY = {
  hipL: -0.34, kneeL: -0.44,
  hipR: -0.20, kneeR: -0.30,
};

/** Smooth 0->1 with no overshoot: a foot must not bounce past its landing spot. */
function easeOut(t) {
  const x = clamp(t, 0, 1);
  return x * (2 - x);
}

export class DinoRagdoll {
  constructor(opts = {}) {
    const cfg = { ...CONFIG, ...opts };
    this.cfg = cfg;
    // Tunable copy of the axial table. Overridable per instance so the posture can
    // be swept by the diagnostic harnesses without editing the module.
    this.axial = opts.axial ? { ...AXIAL, ...opts.axial } : AXIAL;

    this.world = new PhysicsWorld({
      gravity: cfg.gravity,
      substeps: 4,
      iterations: 7,
      damping: 0.994,
      maxSpeed: cfg.maxFootSpeed ?? 14,
    });

    for (const name of ORDER) {
      const s = SKELETON[name];
      this.world.addParticle({
        name,
        x: s.x, y: cfg.standHeight + s.y, z: s.z,
        mass: s.mass, radius: s.radius, friction: s.friction ?? 0.6,
      });
    }

    for (const [a, b, r0, r1] of BONES) {
      const ia = this.world.idx(a), ib = this.world.idx(b);
      this.world.addDistance(ia, ib, { stiff: 1, tag: 'bone' });
      this.world.addBone(ia, ib, { r0, r1, name: a + '-' + b });
    }
    for (const [a, b] of BRACES) {
      this.world.addDistance(this.world.idx(a), this.world.idx(b), { stiff: 0.9, tag: 'brace' });
    }
    // One weight-bearing strut per leg, hip to ankle. This is the quadriceps: the
    // only thing that stops the leg folding under the animal. The IK solver shapes
    // the knee, the strut holds the body up, and splitting those two jobs is what
    // makes the stance stable. Removing it in favour of angle motors produced a
    // runner that collapsed to half height within a second, because an angle
    // constraint at the knee resists *rotation* and the load here is *compression*.
    this._struts = {};
    for (const side of SIDES) {
      const ia = this.world.idx('pelvis'), ib = this.world.idx('shin' + side);
      const rest = this.world.distance(ia, ib);
      this.world.addDistance(ia, ib, { stiff: 0.75, tag: 'strut' + side, rest });
      this._struts[side] = this.world.dist[this.world.dist.length - 1];
    }
    for (const j of JOINTS) {
      this.world.addAngle(
        this.world.idx(j.a), this.world.idx(j.b), this.world.idx(j.c),
        { lo: 0.2, hi: Math.PI - 0.2, stiff: 0.3, limitStiff: 0.9, name: j.name, target: null },
      );
    }
    this.world.buildCollisionSkip();

    // Measure the pose the rest skeleton actually has. The limits come from the
    // table; the measured angle is what the death splay is expressed against.
    this.neutral = {};
    for (const j of JOINTS) {
      const rec = this.world.angles.find((r) => r.name === j.name);
      const rest = angle3(this.world.pos, rec.a, rec.b, rec.c);
      this.neutral[j.name] = rest;
      rec.rest = rest;
      rec.lo = j.lo;
      rec.hi = j.hi;
    }

    this.i = {};
    for (const n of ORDER) this.i[n] = this.world.idx(n);

    // Leg metrics for the IK solver, measured off the skeleton rather than typed
    // into a config table. Two sources of the same number always drift apart, and
    // when they do the solver commands a shape the distance constraints refuse.
    const seg = (a, b) => {
      const p = SKELETON[a], q = SKELETON[b];
      return { len: Math.hypot(q.x - p.x, q.y - p.y), dx: q.x - p.x, dy: q.y - p.y };
    };
    const femur = seg('pelvis', 'thighL');
    const tibia = seg('thighL', 'shinL');
    const meta = seg('shinL', 'footL');
    this.leg = {
      femur: femur.len,
      tibia: tibia.len,
      meta: meta.len,
      toeX: meta.dx / (meta.len || 1),
      toeY: meta.dy / (meta.len || 1),
      chain: femur.len + tibia.len,
      // Vertical drop from hip to a planted toe at the rest pose. The IK solver
      // reads this to know how much horizontal reach it has left.
      standDrop: -SKELETON.footL.y,
      // What the hip-to-ankle strut is allowed to be commanded to. The lower bound
      // keeps a leg from being commanded into a fold; the upper bound stops a
      // mis-measured target from demanding more than the chain can give, which is
      // what previously turned a stumble into the pelvis being dragged down.
      minSpan: Math.abs(femur.len - tibia.len) + 0.03,
      maxSpan: (femur.len + tibia.len) * 0.985,
    };

    this.phase = 0;
    this.stance = { L: false, R: false };
    this.stanceTime = { L: 0, R: 0 };
    this.plantX = { L: 0, R: 0 };
    this.plantZ = { L: 0, R: 0 };
    this.swingT = { L: 0, R: 0 };
    this.swingClock = { L: 0, R: 0 };
    /** Seconds a leg has spent at the end of its swing arc without landing. This is
     *  the difference between a late step and a seized gait. */
    this._swingOver = { L: 0, R: 0 };
    /** Hip-behind-anchor distance at touchdown, the start of the scripted sweep. */
    this.behindTo = { L: 0, R: 0 };
    this.grounded = true;
    this.noContact = 0;
    this.stepCount = 0;
    this.landImpact = 0;
    this.lastFallSpeed = 0;
    this.aliveFlag = true;
    this.motor = 1;
    this.laneZ = 0;
    this.heading = 0;
    this.speedNow = 0;
    this.airTime = 0;
    this.recovered = 0;
    /** Per-bone 0..1 standing-to-ducked blend for driveAxial. Kept per bone rather
     *  than one global so the fold propagates down the spine instead of happening
     *  everywhere at once. */
    this._axialK = {};
    for (const n of AXIAL_NAMES) this._axialK[n] = 0;
    this._drift = 0;
    /** The root's own position and velocity. Authoritative while alive, since the
     *  pelvis is kinematic; see driveRoot. */
    this.rootX = 0;
    this.rootY = cfg.standHeight;
    this.rootZ = 0;
    this.rootVy = 0;
    this._lastRootY = cfg.standHeight;
    /** Scratch for solveLeg. The frame loop must not allocate. */
    this._ik = {
      thighX: 0, thighY: 0, thighZ: 0,
      shinX: 0, shinY: 0, shinZ: 0,
      ankleX: 0, ankleY: 0,
    };
  }

  // ------------------------------------------------------------------ state

  get pelvis() {
    const w = this.world, b = this.i.pelvis * 3;
    return { x: w.pos[b], y: w.pos[b + 1], z: w.pos[b + 2] };
  }

  get hipHeight() {
    return this.world.pos[this.i.pelvis * 3 + 1];
  }

  velocity() {
    return this.world.getVelocity(this.i.pelvis, 1 / 60, this.world.substeps);
  }

  /** Lowest point of the whole body above the ground plane. */
  clearance() {
    const w = this.world;
    let lowest = Infinity;
    for (let p = 0; p < w.count; p++) {
      const y = w.pos[p * 3 + 1] - w.radius[p];
      if (y < lowest) lowest = y;
    }
    return lowest;
  }

  /** Rough AABB, used for obstacle hits. */
  bounds() {
    return this._bounds(null);
  }

  /**
   * The box collisions are actually tested against: the body with the tail left
   * out.
   *
   * The tail is a metre of trailing decorative geometry, and it is the single
   * biggest source of false deaths. Two ways it lies. Its tip drags on the sand,
   * so a whole-body AABB has a floor near zero even mid-jump, which meant the
   * animal could never get its lowest point above a cactus no matter how well it
   * timed the leap. And its length stretches the box to two metres, so an
   * obstacle stayed "overlapping" for almost twice as long as the animal was really
   * there, long enough that the jump came down onto it. Neither is a thing that
   * should end a run: the tail never leads the animal forward, so nothing can be
   * hit tail-first in normal play. The comment on `checkHit` already conceded that
   * "losing a run because a tail brushed a cactus reads as unfair, not physical";
   * this is that concession taken seriously rather than padded by 5 cm.
   */
  hitBounds() {
    return this._bounds(HIT_EXCLUDE);
  }

  _bounds(exclude) {
    const w = this.world;
    const o = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity };
    for (let p = 0; p < w.count; p++) {
      if (exclude && exclude.has(w.names[p])) continue;
      const b = p * 3, r = w.radius[p];
      if (w.pos[b] - r < o.minX) o.minX = w.pos[b] - r;
      if (w.pos[b] + r > o.maxX) o.maxX = w.pos[b] + r;
      if (w.pos[b + 1] - r < o.minY) o.minY = w.pos[b + 1] - r;
      if (w.pos[b + 1] + r > o.maxY) o.maxY = w.pos[b + 1] + r;
      if (w.pos[b + 2] - r < o.minZ) o.minZ = w.pos[b + 2] - r;
      if (w.pos[b + 2] + r > o.maxZ) o.maxZ = w.pos[b + 2] + r;
    }
    return o;
  }

  /** Ground distance one foot covers while it is planted. */
  strideLength(speed) {
    return this.plantReach(speed) + this.cfg.maxReach;
  }

  /** How far ahead of the hip a swinging foot is placed. */
  plantReach(speed) {
    const n = clamp(speed / this.cfg.maxSpeed, 0, 1);
    return lerp(this.cfg.reachMin, this.cfg.reachMax, n);
  }

  /**
   * Gait cycles per second. One cycle moves *both* legs, so it covers two
   * strides, not one: getting that factor of two wrong is what made the previous
   * controller believe it was always going half speed and quietly drag both
   * anchors backwards through the sand.
   */
  strideCadence(speed) {
    const cover = 2 * this.strideLength(speed);
    return clamp(speed / Math.max(0.15, cover), this.cfg.strideMinCadence, this.cfg.strideCadence);
  }

  /** Speed the current gait can actually deliver without the feet slipping. */
  gaitCapacity() {
    return 2 * this.strideLength(this.speedNow) * this.strideCadence(this.speedNow);
  }

  // ------------------------------------------------------------------ input

  /** Launch the animal. Every particle gets the same vy so the body does not
   *  fold in half on takeoff. */
  jump(vy) {
    if (!this.aliveFlag) return false;
    const w = this.world;
    this.releaseFoot('L');
    this.releaseFoot('R');
    // The root is kinematic while alive, so a jump is an initial condition on it
    // rather than an impulse on particles. Every limb still gets the same upward
    // velocity so the body leaves the ground in one piece instead of folding.
    this.rootVy = vy;
    // A jump has to be *committed*, not merely flagged. postStep cancels an
    // airborne state that ends inside jumpGrace, which is what distinguishes the
    // momentary float at an exchange of support from a real leap. Setting airTime to
    // the same token value the hop uses meant a jump was cancelled by the very next
    // frame, because the gait plants a foot on frame one and the cancellation fires
    // on contact. Starting above the grace window is what makes the arc survive.
    this.airTime = this.cfg.jumpGrace + 0.06;
    // Marks this flight as a committed leap rather than the running hop, so the
    // root uses the gentle arc gravity and the legs tuck. Cleared on landing.
    this._jumping = true;
    for (let p = 0; p < w.count; p++) {
      if (w.inv[p] === 0 || p === this.i.pelvis) continue;
      const cur = w.getVelocity(p, 1 / 60, w.substeps);
      w.setVelocity(p, cur[0], Math.max(cur[1], vy * 0.9), cur[2], 1 / 60, w.substeps);
    }
    return true;
  }

  /** Cut a jump short when the player releases early. */
  jumpCut() {
    if (!this.aliveFlag) return;
    const w = this.world;
    for (let p = 0; p < w.count; p++) {
      if (w.inv[p] === 0) continue;
      const cur = w.getVelocity(p, 1 / 60, w.substeps);
      if (cur[1] > 0) {
        w.setVelocity(p, cur[0], cur[1] * this.cfg.jumpCutMultiplier, cur[2], 1 / 60, w.substeps);
      }
    }
  }

  /** Panic flail so a missed step turns into a recovery instead of a faceplant. */
  scramble(speed = 4) {
    if (!this.aliveFlag) return;
    const w = this.world;
    for (const side of SIDES) {
      if (this.stance[side]) continue;
      const foot = this.i['foot' + side];
      const cur = w.getVelocity(foot, 1 / 60, w.substeps);
      // Forward, not up. A foot that is hanging in the air is not failing because it
      // is too low, it is failing because it is not arriving, and the touchdown test
      // wants a foot sweeping down through the plant pose. Lifting it makes the
      // condition that triggered the panic worse, which is how the previous version
      // ended up with both feet parked at 0.42 m indefinitely.
      w.setVelocity(foot, cur[0] + speed * 0.22 + 0.6, cur[1] - 0.5, cur[2], 1 / 60, w.substeps);
      w.nudgeVelocity(this.i['thigh' + side], 0.4 * speed, -0.3, 0, 0.3, 1 / 60, w.substeps);
    }
    this.recovered = 0.3;
  }

  /** Death. The corpse keeps whatever momentum the collision left behind. */
  die(knockback) {
    if (!this.aliveFlag) return;
    this.aliveFlag = false;
    this.releaseFoot('L');
    this.releaseFoot('R');
    const w = this.world;
    // The root stops being authored here. From this frame the pelvis is an ordinary
    // particle, so the tumble the player watches is the solver's, not a animation.
    if (w.pinned[this.i.pelvis]) w.setPinned(this.i.pelvis, false);
    const kb = knockback ?? { x: 0, y: 4.5, z: 0 };
    for (let p = 0; p < w.count; p++) {
      const cur = w.getVelocity(p, 1 / 60, w.substeps);
      const headHeavy = (p === this.i.head || p === this.i.snout || p === this.i.neck) ? 1.6 : 1;
      w.setVelocity(
        p,
        cur[0] * 0.55 + (kb.x ?? 0),
        cur[1] * 0.55 + (kb.y ?? 0) * headHeavy,
        cur[2] * 0.55 + (kb.z ?? 0),
        1 / 60, w.substeps,
      );
    }
  }

  respawn(x = 0) {
    const w = this.world;
    this.releaseFoot('L');
    this.releaseFoot('R');
    for (const n of ORDER) {
      const s = SKELETON[n];
      w.setPos(this.i[n], x + s.x, this.cfg.standHeight + s.y, s.z);
      w.setVelocity(this.i[n], 0, 0, 0, 1 / 60, w.substeps);
    }
    for (const d of w.dist) d.broken = false;
    this.rootX = x;
    this.rootY = this.cfg.standHeight;
    this.rootZ = 0;
    this.rootVy = 0;
    this._lastRootY = this.cfg.standHeight;
    this._drift = 0;
    this.aliveFlag = true;
    this.motor = 1;
    this.phase = 0;
    this.grounded = true;
    this.airTime = 0;
    this.noContact = 0;
    this.stepCount = 0;
    this.landImpact = 0;
    this.laneZ = 0;
    this.heading = 0;
    this.speedNow = 0;
    this.swingT.L = 0;
    this.swingT.R = 0;
    this.swingClock.L = 0;
    this.swingClock.R = 0;
    this._swingOver.L = 0;
    this._swingOver.R = 0;
  }

  releaseFoot(side) {
    if (!side) return;
    this.stance[side] = false;
    this.stanceTime[side] = 0;
    const w = this.world;
    const foot = this.i['foot' + side];
    if (w.pinned[foot]) w.setPinned(foot, false);
  }

  // ------------------------------------------------------------------- step

  /**
   * @param {number} dt seconds
   * @param {object} cmd {speed, ducking, laneZ, dying, slowmo}
   */
  step(dt, cmd) {
    const speed = cmd.speed ?? 0;
    const ducking = !!cmd.ducking;
    const dying = !!cmd.dying;
    this.speedNow = speed;
    this._ducking = ducking;

    const laneZ = cmd.laneZ ?? 0;
    const laneVel = (laneZ - this.laneZ) / Math.max(dt, 1e-4);
    this.heading = clamp((laneZ - this.laneZ) * 2.2, -0.3, 0.3);
    this.laneZ = laneZ;

    const cadence = this.strideCadence(speed);
    if (this.aliveFlag && !dying) this.phase = (this.phase + cadence * dt) % 1;

    const air = this.airTime > 0.04;
    if (this.aliveFlag && !dying) {
      this.driveRoot(dt, speed, ducking, laneVel);
      this.applyPose(ducking, air);
    } else {
      this.motor = Math.max(0, this.motor - dt / this.cfg.deadFadeTime);
      this.applyDeathPose();
    }

    this.driveFeet(speed, dt);
    this.applyMotorStiffness(air);

    this.world.step(dt * (cmd.slowmo ?? 1));
    this.postStep(dt);
  }

  /**
   * The root, while the animal is alive, is kinematic: it is moved, not pushed.
   *
   * This is the part worth explaining. The previous design tried to make the run
   * emerge from forces, with the pelvis chasing a commanded speed through a foot
   * pinned to the ground. Those two controllers have no solution to agree on. A
   * pinned anchor is a hard constraint; a velocity chase is a demand; between them
   * the solver chose whichever was softer that frame, and the visible result was an
   * animal bouncing between hip height 0.15 and 0.88 while travelling backwards.
   *
   * So the responsibilities are split the way every shipped runner splits them.
   * The root owns where the body goes, and its vertical is real physics: gravity,
   * an arc, a landing. The body owns everything else, entirely under the solver,
   * which is where the ragdoll actually lives. The spine sags, the tail lags, the
   * head drags behind the neck, the knees find their own shape between a hip that
   * is authored and a foot that is nailed down. And the moment it dies the pelvis
   * is released, so the thing the player actually watches is fully physical.
   */
  driveRoot(dt, speed, ducking, laneVel) {
    const w = this.world;
    const pelvis = this.i.pelvis;

    this.rootX += speed * dt;

    // Vertical: genuinely ballistic whenever it is off the sand, and pinned to
    // standing height while a foot is carrying it. Not a scripted bounce: gravity
    // decides the shape of the arc and the landing is whatever the arc arrives at.
    const floor = ducking ? this.cfg.duckHeight : this.cfg.standHeight;
    if (this.airTime > 0) {
      // The arc is integrated against its own gravity, not the solver's, but only
      // for a committed leap. See the note on `jumpGravity` in the config: a body
      // launched at -24 is back on the sand before it has travelled a body length,
      // which leaves nothing to jump over. The little flight phase between
      // footsteps is *not* that case. It is a hop of a few centimetres, and it is
      // supposed to snap back down; giving it the gentle arc turned the run into a
      // series of floaty bounds and lifted the standing hip by 20 cm. So the two
      // share `airTime` but not `gravity`.
      const gArc = this._jumping ? this.cfg.jumpGravity : this.cfg.gravity;
      this.rootVy += gArc * dt;
      this.rootY += this.rootVy * dt;
      if (this.rootY <= floor && this.rootVy < 0) {
        this.lastFallSpeed = this.rootVy;
        this.rootY = floor;
        this.rootVy = 0;
        this.airTime = 0;
        this._jumping = false;
      }
    } else {
      // A running body is not a rigid one. The hip dips through mid-stance and
      // rises slightly at the exchange of support, driven by the same clock the
      // legs run on, so the bob and the footsteps cannot drift out of phase.
      const cadence = this.strideCadence(speed);
      const bob = Math.sin(this.phase * Math.PI * 4) * this.cfg.hopAmplitude * clamp(speed / 3, 0, 1);
      this.rootY += (floor + bob - this.rootY) * smooth(this.cfg.supportBlend, dt);
      this.rootVy = 0;
    }

    this.rootZ += (this.laneZ - this.rootZ) * smooth(9, dt);

    const vx = speed;
    const vy = this.airTime > 0 ? this.rootVy : (this.rootY - this._lastRootY) / Math.max(dt, 1e-4);
    const vz = (this.rootZ - w.pos[pelvis * 3 + 2]) / Math.max(dt, 1e-4);
    this._lastRootY = this.rootY;

    w.setPos(pelvis, this.rootX, this.rootY, this.rootZ);
    w.setVelocity(pelvis, vx, vy, vz, 1 / 60, w.substeps);
    if (!w.pinned[pelvis]) w.setPinned(pelvis, true);

    this.driveAxial(dt);
  }

  /**
   * The axial chain: spine, head and tail.
   *
   * These have no bones to stand on. The pelvis is authored, the legs go where the
   * gait puts them, and everything from the chest back is a rigid truss hanging off a
   * kinematic hip. Rigid is the problem: a truss of distance constraints holds its
   * lengths perfectly and its orientation not at all, so the whole torso and tail is
   * free to rotate about the pelvis like a propeller, and these springs are the only
   * thing resisting that torque.
   *
   * That is why the shape of the write matters more than the numbers. The first
   * version *added* a spring increment, `v += (target - pos) / tau * dt`. Under that
   * form the equilibrium is where the spring force equals the weight it is not
   * cancelling, so the droop is `g * (1 - support) * tau`, which for the head works
   * out at 2.25 m. It is not a soft spring, it is no spring, and what the solver
   * produced over three seconds was the tail at 1.77 m and the head on the sand,
   * with the animal doing a handstand at 8 m/s.
   *
   * This version targets a velocity instead, the same shape driveBone uses: the
   * particle's velocity is lerped toward `(target - pos) / tau`. There is no
   * equilibrium droop to solve for in the spring itself, because a particle sitting
   * still on its target is exactly the fixed point the spring wants.
   *
   * The `support` term, on the other hand, has to be an impulse and cannot be part of
   * the target. Baked into the target it is not a force, it is a permanent velocity
   * offset: a particle whose target velocity is -0.09 m/s does not sag a little, it
   * descends at 0.09 m/s forever. The truss is rigid, so the head's slow dive became
   * the tail's slow rise, and the whole torso rotated about the hip through 0.4 m in
   * each direction. Added after the blend it is what it was always meant to be, a
   * partial gravity of `-g * support`, and the sag it produces is the closed-form
   * `g * support * tau^2`, which is small, bounded, and tunable.
   */
  driveAxial(dt) {
    const w = this.world;
    const pelvis = this.i.pelvis;
    const rx = w.pos[pelvis * 3], ry = w.pos[pelvis * 3 + 1], rz = w.pos[pelvis * 3 + 2];
    // The hip is kinematic while the animal is alive, which means its velocity is
    // not an estimate to be filtered, it is a number we chose. Carrying it into every
    // axial target is the difference between a spring that tracks the body and one
    // that chases it: without it the head is a mass on a soft strut standing on a
    // platform bobbing at 3.6 Hz, and the lag grows with speed until the animal is
    // 0.26 m above its own skeleton while ducking, which is not a duck. With it, the
    // spring only ever has to correct the *relative* offset, and the bob is free.
    const hipVel = w.getVelocity(pelvis, 1 / 60, w.substeps);
    const duck = this._ducking;
    const cap = this.cfg.maxLimbSpeed;

    for (const name of AXIAL_NAMES) {
      const spec = this.axial[name];
      const i = this.i[name];
      if (w.inv[i] === 0) continue;
      const b = i * 3;

      // Ducking interpolates to a folded offset rather than scaling the standing
      // one, because the neck and head have to tuck toward hip level while the tail
      // drops below it, and no single multiplier does both. The blend is per bone so
      // the fold ripples down the chain instead of the animal flattening in a frame.
      const k = (this._axialK[name] = lerp(this._axialK[name], duck ? 1 : 0, smooth(7, dt)));
      const wantY = ry + lerp(SKELETON[name].y, spec.duckOffset, k);

      const gain = 1 / Math.max(spec.tau, 1e-3);
      const ks = clamp(dt / Math.max(spec.tau, 1e-3), 0, 0.5);
      const cur = w.getVelocity(i, 1 / 60, w.substeps);
      const weight = -this.cfg.gravity * spec.support * dt;

      const offVelX = clamp((rx + SKELETON[name].x - w.pos[b]) * gain, -cap, cap);
      const offVelY = clamp((wantY - w.pos[b + 1]) * gain, -cap, cap);
      const offVelZ = clamp((rz + SKELETON[name].z - w.pos[b + 2]) * gain, -cap, cap);

      // The blend is a velocity lerp toward `hipVel + offset/tau`, which is a first
      // order lag, not a true second order spring. It was rewritten as a critically
      // damped spring (`v(1 - 2k) + k*offVel + 2k*hipV`) on the theory that the chain
      // was underdamped and ringing the snout up through the crouch. That turned out
      // to be the wrong diagnosis for the *average* posture and a worse fix: the ring
      // was already gone once the hip velocity was carried into the target (above),
      // and the critical form, which reaches into the solver with a stiffer second
      // order term, drove the pinned-foot legs past their bone constraint. `shinR-footR`
      // stretched to 55 % because a pinned foot cannot be pulled back by the solver, so
      // the stretch has nowhere to go but the distance joint. Soft wins that trade.
      //
      // The whip is a different problem, and it is a fairness one. Once the head chain
      // has arrived at its tucked target it still carries upward momentum from the
      // stride, so at certain phases it overshoots the fold by 0.7 m: measured at hip
      // 0.38 m with the snout at 1.10 m, which is *above* the standing head bob. That
      // is rare, about one stride in two thousand, but it is exactly the failure the
      // duck cannot defend against, and it only shows up once the sim runs at a small
      // enough step to resolve it. So the correction is one sided: a ducked bone that
      // is already at or above where the fold wants it is not permitted to still be
      // travelling up. Nothing is pushed down, so the standing gait and the tail are
      // untouched, and the crouch is left free to bounce within its own envelope.
      let vy = lerp(cur[1], clamp(hipVel[1] + offVelY, -cap, cap), ks) + weight;
      if (duck && vy > 0 && w.pos[b + 1] >= wantY && spec.whipDamp) {
        vy *= 1 - spec.whipDamp;
      }

      w.setVelocity(
        i,
        lerp(cur[0], clamp(hipVel[0] + offVelX, -cap, cap), ks),
        vy,
        lerp(cur[2], clamp(hipVel[2] + offVelZ, -cap, cap), ks),
        1 / 60, w.substeps,
      );
    }
  }

  applyPose(ducking, air) {
    // While the animal is standing and running the legs are placed by IK (see
    // driveFeet), so the hip and knee motors are demoted to plain limits: they
    // still stop the leg hyperextending, they just no longer fight the gait for
    // control of where the knee lives. Racing an IK solution with a motor target
    // is how the previous version lost 0.4 m of height and ended up running on its
    // chest.
    for (const rec of this.world.angles) rec.target = null;
  }

  applyDeathPose() {
    const n = this.neutral;
    for (const rec of this.world.angles) {
      const splay = DEAD_SPLAY[rec.name];
      rec.target = splay === undefined ? null : clamp(n[rec.name] + splay, rec.lo, rec.hi);
    }
  }

  applyMotorStiffness(air) {
    // While alive the angle records have no target, so `stiff` is inert and only
    // `limitStiff` fires. It matters after death, when the corpse is given a
    // splayed pose to settle into: soft, so the limbs flop rather than snap.
    for (const rec of this.world.angles) {
      rec.stiff = this.aliveFlag ? this.motor * 0.5 : clamp(this.motor, 0, 1) * 0.18;
    }
  }

  /** This leg's own position in the gait cycle, 0 = the moment it lands. */
  legPhase(side) {
    return (this.phase + (side === 'L' ? 0 : 0.5)) % 1;
  }

  /**
   * Two-bone IK in the sagittal plane.
   *
   * The foot target is given; the ankle is back off it along the toe direction and
   * the knee is solved between the hip and the ankle with a forward bias. Solving
   * it analytically instead of hoping three angle motors converge is what makes
   * the stance trustworthy: the answer either exists or it does not, and where it
   * does not we clamp to full extension rather than let the solver discover a new
   * equilibrium by dragging the pelvis into the sand.
   *
   * Writes into `out` (thighX/Y/Z, shinX/Y/Z) to keep the frame allocation-free.
   */
  solveLeg(px, py, pz, fx, fy, fz, kneeBias, out) {
    const L = this.leg;
    const L0 = L.femur, L1 = L.tibia;

    // Ankle = foot pulled back along the toe. The toe points forward and down,
    // so a planted foot reads as a foot, not as a knee on the floor.
    const ax = fx - L.toeX * L.meta;
    const ay = fy - L.toeY * L.meta;

    let dx = ax - px, dy = ay - py;
    let d = Math.hypot(dx, dy);
    const dMax = L.chain * 0.998;
    const dMin = Math.abs(L0 - L1) + 0.02;
    if (d < 1e-5) { dx = 1; dy = 0; d = 1; }
    const dc = clamp(d, dMin, dMax);
    const ux = dx / d, uy = dy / d;
    const cx = px + ux * dc, cy = py + uy * dc; // clamped ankle
    out.ankleX = cx;
    out.ankleY = cy;

    // Knee lies off the hip->ankle line at distance h, on the forward side.
    const a = (L0 * L0 - L1 * L1 + dc * dc) / (2 * dc);
    const h2 = L0 * L0 - a * a;
    const h = h2 > 0 ? Math.sqrt(h2) : 0;
    // Perpendicular in the sagittal plane, chosen to push the knee forward (+X).
    let nx = -uy, ny = ux;
    if (nx < 0) { nx = -nx; ny = -ny; }
    out.thighX = px + ux * a + nx * h * kneeBias;
    out.thighY = py + uy * a + ny * h * kneeBias;
    out.thighZ = lerp(pz, fz, 0.55);
    out.shinX = cx;
    out.shinY = cy;
    out.shinZ = lerp(pz, fz, 0.8);
    return out;
  }

  /**
   * The extensor. Each leg has one hip-to-ankle distance constraint whose rest
   * length is written every frame, which turns it from a joint into a muscle: in
   * stance it is commanded long and stiff and holds the animal up, in swing it is
   * commanded to whatever the IK asked for and stops fighting the gait.
   *
   * The alternative that failed: letting the IK place the ankle while a fixed-rest
   * strut held it elsewhere. The two disagreed by 0.12 m for the whole of every
   * stance and the pelvis lost, so the animal ran crouched at half height.
   */
  setExtension(side, rest) {
    const d = this._struts[side];
    if (!d) return;
    d.rest = clamp(rest, this.leg.minSpan, this.leg.maxSpan);
  }

  /** Seconds this leg should spend on the ground at the current speed. */
  stanceDuration(speed) {
    return this.stanceDuty(speed) / Math.max(0.3, this.strideCadence(speed));
  }

  /** Seconds this leg should spend in the air at the current speed. */
  swingDuration(speed) {
    return (1 - this.stanceDuty(speed)) / Math.max(0.3, this.strideCadence(speed));
  }

  stanceDuty(speed) {
    return clamp(0.56 - clamp(speed / this.cfg.maxSpeed, 0, 1) * 0.20, 0.30, 0.62);
  }

  /**
   * Footfall. Each leg owns its own clock, reset when it lands and when it leaves
   * the ground. Keying stance off the global gait phase was the bug that made this
   * run in place: a foot touching down at phase 0.80 was, by the next frame,
   * already past its duty cycle, so the anchor lasted one frame and released. The
   * animal was never standing on anything long enough to push against it.
   */
  driveFeet(speed, dt) {
    const w = this.world;
    if (!this.aliveFlag) return;

    const pelvis = this.i.pelvis;
    const px = w.pos[pelvis * 3], py = w.pos[pelvis * 3 + 1], pz = w.pos[pelvis * 3 + 2];
    const vel = w.getVelocity(pelvis, 1 / 60, w.substeps);
    const air = this.airTime > 0.04;
    const out = this._ik;
    const bodyTarget = this._ducking ? this.cfg.duckHeight : this.cfg.standHeight;

    for (const side of SIDES) {
      const foot = this.i['foot' + side];
      const thigh = this.i['thigh' + side];
      const shin = this.i['shin' + side];
      const b = foot * 3;
      const r = w.radius[foot];
      const laneZ = this.laneZ + SKELETON['foot' + side].z;

      if (this.stance[side]) {
        this.stanceTime[side] += dt;
        const dur = Math.max(0.05, this.stanceDuration(speed));

        // The anchor is a real contact patch: it does not move, and the authored
        // hip travels over it. That is what makes the step grip, and it is why the
        // foot now visibly plants instead of the animal sliding on skis. The one
        // exception is a leg that has run out of reach, where holding the anchor
        // would tear the skeleton apart, so the contact slips backwards at the
        // surplus.
        const ax = this.plantX[side] - this.leg.toeX * this.leg.meta;
        const ay = r - this.leg.toeY * this.leg.meta;
        const want = Math.hypot(px - ax, bodyTarget - ay);
        if (want > this.leg.maxSpan) {
          const excess = want - this.leg.maxSpan;
          const slip = clamp(excess / Math.max(dt, 1e-4), 0, this.cfg.maxLimbSpeed);
          this.plantX[side] -= slip * dt;
          this.placeFoot(side, this.plantX[side], r, this.plantZ[side], -slip, 0, 0);
          this._drift = Math.max(this._drift, slip);
        }

        // The toe is nailed to the sand, so the ankle is known exactly, and the
        // hip height the gait wants is known. That pins the leg length, and the
        // knee follows from the two-bone solution. Nothing here asks the ankle or
        // the toe to move; they are already where they should be.
        this.solveLeg(px, py, pz, this.plantX[side], r, this.plantZ[side], this.cfg.kneeBias, out);
        this.setExtension(side, want);
        this.driveBone(thigh, out.thighX, out.thighY, out.thighZ, dt, this.cfg.postureStiff);

        const behind = px - this.plantX[side];
        if (this.stanceTime[side] >= dur || behind > this.cfg.maxReach || this.stanceTime[side] > 0.6) {
          this.liftOff(side, speed);
          this.swingClock[side] = 0;
        }
        continue;
      }

      // Swing. Track a point that moves from behind the hip to in front of it, so
      // the foot is always arriving and never waiting for the body to catch up.
      const swingDur = Math.max(0.045, this.swingDuration(speed));
      // `t` is read by the touchdown test below, so it has to live outside the
      // branch that computes it. While airborne the clock is deliberately not
      // advanced, which parks the swing where it was and lets it resume on landing
      // rather than restarting its arc from the top.
      let t = this.swingT[side];
      let targetX;
      let targetY;
      if (air) {
        // Committed leap: tuck the legs up under the body.
        //
        // The running swing places the foot at a *world* height just above the
        // sand, which is correct when the hip is at standHeight and the leg needs
        // to reach down. During a jump the hip climbs to about 1.4 m while that
        // same target stays near the ground, so the IK pulls the leg straight down
        // to 0.38 m. The animal's lowest point was then below the top of every
        // obstacle in KINDS (the shortest, a rock, tops out at 0.46 m), which made
        // the game literally un-winnable by jumping: the pelvis sailed over the
        // cactus at 1.4 m and the dangling foot knocked it over anyway. A tuck is
        // hip-relative, so as the body rises the feet rise with it. This is the
        // single change that turns obstacles from walls into hurdles.
        targetX = px + this.cfg.airReach;
        // Floor the target a little below the hip rather than right at it, so the
        // knee has somewhere to go. The IK cannot fold a leg into a point, and a
        // target at the hip makes it solve for a nearly straight leg hanging down.
        targetY = Math.max(r, py - this.cfg.airTuck);
      } else {
        this.swingClock[side] += dt;
        t = clamp(this.swingClock[side] / swingDur, 0, 1);
        this.swingT[side] = t;
        const reach = this.plantReach(speed);
        targetX = px + lerp(-this.cfg.maxReach * 0.55, reach, easeOut(t));
        const lift = this.cfg.swingHeight * Math.sin(Math.PI * clamp(t * 1.05, 0, 1));
        targetY = r + Math.max(0.015, lift);
      }

      this.solveLeg(px, py, pz, targetX, targetY, laneZ, this.cfg.kneeBias, out);
      // The foot leads, the knee follows it. Servoing the foot first and the knee
      // against the same solution keeps the chain coherent instead of three
      // independent springs arguing. The strut is commanded to the same length the
      // IK just asked for, so it is slack and the swing is unresisted.
      this.driveBone(foot, targetX, targetY, laneZ, dt, this.cfg.swingStiff);
      this.driveBone(thigh, out.thighX, out.thighY, out.thighZ, dt, this.cfg.postureStiff);
      this.driveBone(shin, out.shinX, out.shinY, out.shinZ, dt, this.cfg.postureStiff);
      this.setExtension(side, Math.hypot(out.ankleX - px, out.ankleY - py));

      // Touchdown once the swing is nearly spent and the foot is genuinely low
      // enough to reach. Waiting for both is what stops the animal planting a foot
      // in mid-air and pulling itself over an invisible step.
      //
      // The alternation guard is what makes this a run rather than a jump. Two
      // legs on identical clocks land together and the animal is doing hops; the
      // trailing leg has to wait for the leading one to leave the ground. It is a
      // one-sided courtesy though, and it has to expire, because a leg that is
      // being blocked from landing has nowhere to go and the whole gait seizes.
      const other = side === 'L' ? 'R' : 'L';
      const waited = this.stance[other] && this.stanceTime[other] > this.stanceDuration(speed) * 0.5;
      const overdue = this.swingClock[side] > swingDur * 1.6;
      // No planting while the animal is genuinely off the ground. A foot nailed down
      // during the rising half of a jump is an anchor at hip height, and the root
      // then falls back onto it instead of landing, which is what turned a leap into
      // a 0.14 m stutter. The small float at an exchange of support stays under the
      // air threshold, so normal running is unaffected.
      const canLand = (waited || !this.stance[other] || overdue) && !air;
      if (t > 0.62 && canLand && w.pos[b + 1] - r < r + 0.14) {
        this.plant(side);
        this._swingOver[side] = 0;
      } else if (t >= 1) {
        // The clock is spent and the foot did not make it down. Restarting the clock
        // here was the bug that froze the run: the swing retook its arc from the top,
        // the foot was lifted again by the same arc, it could never arrive, and the
        // animal ran at 9 m/s on two legs that never touched the sand. Hold the clock
        // at the end of the arc instead, which parks the target at the low plant pose
        // and lets the servo keep pushing the foot into the ground until it gets
        // there. Persistent failure escalates to the scramble below.
        this.swingClock[side] = swingDur;
        this._swingOver[side] += dt;
      }
    }

    // A leg that has been thrashing in the air for a long time has missed its
    // landing. Flail rather than plant: the previous version pinned the lowest foot
    // here whenever anything was airborne, which meant a foot was being nailed to
    // the sand every single frame, its stance timer reset before it could run, and
    // the other leg blocked forever by the alternation guard. With the root
    // authoritative, gravity already brings the body back to the sand and the swing
    // finds it; this is only the visible panic on top.
    //
    // Panic has to be an actual nudge though, not a lift. Scrambling raised both
    // feet by 1.3 m/s every frame while nothing was in contact, which is a positive
    // feedback loop: no contact, so lift, so still no contact. The feet ended up
    // parked at 0.42 m and the animal hoovered. Throwing them forward is what
    // actually helps, because the swing's touchdown test wants a foot that is
    // arriving, not one that is hovering.
    const stuckAfter = this.cfg.swingStuck ?? 0.22;
    const stuck = this._swingOver.L > stuckAfter || this._swingOver.R > stuckAfter;
    if (this.noContact > 0.16 || stuck) this.scramble(speed);
  }

  /** Kinematic drive of a limb particle toward a target, expressed as a velocity
   *  so the distance constraints still get the last word and the leg bends around
   *  resistance rather than shoving the world over. */
  driveBone(i, x, y, z, dt, tau) {
    const w = this.world;
    if (w.inv[i] === 0) return;
    const b = i * 3;
    const gain = 1 / Math.max(tau, 1e-3);
    const cap = this.cfg.maxLimbSpeed;
    const cur = w.getVelocity(i, 1 / 60, w.substeps);
    const k = clamp(dt / Math.max(tau, 1e-3), 0, 1);
    w.setVelocity(
      i,
      lerp(cur[0], clamp((x - w.pos[b]) * gain, -cap, cap), k),
      lerp(cur[1], clamp((y - w.pos[b + 1]) * gain, -cap, cap), k),
      lerp(cur[2], clamp((z - w.pos[b + 2]) * gain, -cap, cap), k),
      1 / 60, w.substeps,
    );
  }

  /** Freeze a foot at a world point. invMass = 0 makes it a true anchor: the
   *  solver cannot move it, so everything else has to move around it. */
  placeFoot(side, x, y, z, vx, vy, vz) {
    const w = this.world;
    const foot = this.i['foot' + side];
    w.setPos(foot, x, y, z);
    w.setVelocity(foot, vx, vy, vz, 1 / 60, w.substeps);
    if (!w.pinned[foot]) w.setPinned(foot, true);
  }

  plant(side) {
    if (!this.aliveFlag || this.stance[side]) return;
    const w = this.world;
    const foot = this.i['foot' + side];
    const b = foot * 3;
    const r = w.radius[foot];
    const vel = w.getVelocity(foot, 1 / 60, w.substeps);

    this.stance[side] = true;
    this.stanceTime[side] = 0;
    this.plantX[side] = w.pos[b];
    this.plantZ[side] = w.pos[b + 2];
    this.behindTo[side] = this.world.pos[this.i.pelvis * 3] - this.plantX[side];

    // Absorb the arrival instead of keeping it. A foot arriving at 6 m/s and then
    // being frozen is an impulse through the whole skeleton; shedding the vertical
    // part first is what keeps landings from launching the animal.
    this.placeFoot(
      side,
      this.plantX[side], r, this.plantZ[side],
      vel[0] * 0.35,
      Math.max(0, vel[1]) * (1 - this.cfg.landingDamp),
      vel[2] * 0.35,
    );
    this.stepCount++;
  }

  liftOff(side, speed) {
    const w = this.world;
    this.releaseFoot(side);
    const foot = this.i['foot' + side];

    // Toe-off. The foot is free now, so it can be thrown forward and up; the
    // reaction is what the solver sees as the push.
    const cur = w.getVelocity(foot, 1 / 60, w.substeps);
    w.setVelocity(foot, cur[0] + speed * 0.30, 2.0 + speed * 0.18, cur[2], 1 / 60, w.substeps);

    // A run needs a flight phase, and with the root kinematic the only honest way
    // to get one is to launch the root. The hop grows with speed, so a walk has no
    // airtime and a sprint is a sequence of long low bounds.
    if (this.airTime <= 0 && !this.stance.L && !this.stance.R) {
      this.airTime = 0.02;
      this.rootVy = this.cfg.hopLaunch * clamp(speed / this.cfg.maxSpeed, 0.3, 1);
    }
  }

  postStep(dt) {
    const w = this.world;
    const vel = this.velocity();
    const clear = this.clearance();

    // Contact is decided by the feet, not by the lowest point of the body: the tail
    // drags and the chest sags, and either would read as "touching" and cancel a
    // jump that is plainly in the air.
    const footDown =
      (this.stance.L && w.pinned[this.i.footL]) ||
      (this.stance.R && w.pinned[this.i.footR]);

    // A running animal is briefly airborne at every exchange of support, so a short
    // hop is not a jump. Anything under the grace window is cancelled the moment a
    // foot is back down; a real jump clears it easily and keeps its arc.
    if (footDown && this.airTime < this.cfg.jumpGrace) this.airTime = 0;

    if (this.airTime > 0) {
      this.grounded = false;
      this.noContact += dt;
    } else if (footDown || clear < this.cfg.groundTolerance) {
      if (!this.grounded) this.landImpact = clamp(-this.lastFallSpeed / 8, 0, 1);
      this.grounded = true;
      this.noContact = 0;
    } else {
      // Off the sand with nothing under it and no jump on the books: treat it as
      // falling, so gravity takes over instead of the body hanging at hip height.
      this.grounded = false;
      this.airTime = 0.02;
      this.noContact += dt;
    }
    this.lastFallSpeed = vel[1];
    this.landImpact = Math.max(0, this.landImpact - dt * 3);
    if (this.recovered > 0) this.recovered = Math.max(0, this.recovered - dt);

    if (!this.aliveFlag) {
      const still = Math.hypot(vel[0], vel[1], vel[2]);
      if (still < 0.09) {
        // A settled corpse should be genuinely still, not micro-jittering.
        for (let p = 0; p < w.count; p++) {
          if (w.inv[p] === 0) continue;
          w.setVelocity(p, 0, 0, 0, 1 / 60, w.substeps);
        }
      }
    }
  }
}

export { JOINTS, SKELETON as SKELETON_TABLE };
