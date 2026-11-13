// Every tunable in one place. Numbers here are the game's whole personality, so
// they live together rather than being scattered through the systems.
//
// The speeds are not aspirational. They are bounded by the ragdoll: the animal
// advances by lifting a planted foot `maxReach` past its hip, so the fastest it
// can travel without becoming a projectile is roughly `maxReach * strideCadence`
// per support leg. `maxSpeed` sits just under the point where the run turns into
// a series of hops, which is the ceiling the gait can actually hold.

export const TICK_MS = 1000 / 60;

export const CONFIG = {
  // --- world -----------------------------------------------------------
  gravity: -24,
  groundY: 0,
  groundTolerance: 0.035,   // a particle this close to the plane counts as touching
  lanes: [-0.28, 0, 0.28],  // the dino drifts a little side to side while running

  // --- running ---------------------------------------------------------
  // baseSpeed is a fairness constraint, not a feel preference. Clearing a prop
  // means keeping the whole hit box above it for (bodyLength + propWidth) / speed,
  // and the animal's hit box is 1.35 m long. At 2.2 m/s that is over half a
  // second spent above the obstacle, which no arc that still looks like a jump
  // can supply, so the slowest run in the game was the one where props were
  // literally impossible. The floor is set where the measured arcs leave real
  // margin, which is around 3 m/s.
  baseSpeed: 3.0,          // m/s at the start of a run
  maxSpeed: 5.4,           // m/s at full difficulty; see the note above
  accelPerMetre: 0.0055,   // m/s gained per metre travelled, ramps the difficulty
  startSpeed: 3.0,         // legacy aliases kept so older call sites stay honest
  accel: 0.055,
  deathDecay: 6.5,         // how fast the world stops after a hit (m/s^2)

  // --- lane changing ---------------------------------------------------
  laneCount: 3,
  laneWidth: 0.62,
  laneSpeed: 1.5,          // m/s of lateral drift for held strafe keys

  // --- jump ------------------------------------------------------------
  // The body arc and the solver use different gravity, on purpose. The legs are
  // solved against `gravity` (-24), which is what makes a footfall snap down and
  // the gait hold its cadence. The root's leap is integrated against
  // `jumpGravity`, which is gentler. That separation is what makes the game
  // playable: hang time has to be long enough for the body to actually travel
  // past an obstacle, and hang time is only reachable at low gravity (height =
  // g*T^2/8, so a long arc does not have to be a tall one). Dropping the global
  // gravity to get a floaty jump instead made the limbs drift and the run
  // collapse, so only the arc gets the gentler pull.
  // jumpVelocity and jumpGravity were solved against a measured clearance
  // budget, not picked for feel: for every obstacle kind, at both the starting
  // speed and the top speed, the arc has to keep the hit box above the prop's top
  // for longer than (body length + prop width) / speed with margin. That test is
  // what `test/obstacle-check.mjs` re-runs, so these cannot silently drift out of
  // the clearable region again. Hang is ~1.2 s for a ~1.1 m rise, which reads as
  // a heavy animal getting airborne rather than a floaty arcade hop.
  jumpVelocity: 3.6,
  jumpGravity: -5.8,       // m/s^2 on the root while airborne
  jumpCutMultiplier: 0.44, // releasing jump early cuts the rise (feels tight)
  coyoteTime: 0.09,
  jumpBuffer: 0.11,
  doubleJumpVelocity: 5.0,
  maxJumps: 2,

  // --- ragdoll ---------------------------------------------------------
  // The legs are placed by a two-bone IK solver, so these numbers are about the
  // gait rather than the joints. The reach numbers are the load-bearing ones: a
  // foot is planted reachMax ahead of the hip and released once the hip has
  // travelled maxReach past it, so one support covers reachMax + maxReach. Two
  // supports happen per gait cycle, which is what strideCadence divides into the
  // commanded speed. Keep maxSpeed under 2 * strideLength * strideCadence or the
  // anchors start sliding and the run turns into a water-ski.
  standHeight: 0.70,
  // The crouch is a gameplay guarantee, not a pose preference. The flyers are
  // authored so that standing hits them and crouching does not, which means the
  // crouched hit box has to be comfortably below their bellies. Measured against
  // test/obstacle-check.mjs: at 0.46 the crouched box peaked at 1.00 m, which is
  // above every flyer's underside and made ducking useless. See AXIAL in dino.js,
  // where the head and snout fold with it.
  duckHeight: 0.40,
  swingHeight: 0.16,       // how high a swinging foot clears the sand
  // During a committed leap the feet are pulled up under the body rather than
  // reaching for the ground. Without this the swing solver drives the toes toward
  // a *world* height near the sand while the hip is at 1.4 m, so the legs hang
  // straight down to 0.38 m and the body's lowest point is below every obstacle's
  // top: no obstacle in the game could be jumped. These are hip-relative.
  airTuck: 0.30,           // m below the hip a tucked foot is held at
  airReach: 0.14,          // m ahead of the hip a tucked foot sits
  supportBlend: 16,        // 1/s: how fast the hip climbs onto the support leg
  forwardBlend: 10,        // 1/s: how hard the planted leg drags the body along
  maxAccel: 26,            // m/s^2: the most the root may chase the commanded speed
  swingStiff: 0.045,       // s: time constant of the foot position servo
  postureStiff: 0.08,      // s: time constant for knee and ankle tracking the IK
  maxLimbSpeed: 14,        // m/s: a limb may not be shoved faster than this
  maxFootSpeed: 14,        // m/s: global solver safety clamp
  kneeBias: 1.0,           // how far forward the IK pushes the knee, 1 = fully
  hopAssist: 0.20,         // fraction of the missing hop the leg is allowed to add
  hopLaunch: 1.35,         // m/s of upward root velocity per toe-off, scaled by speed
  jumpGrace: 0.09,         // s: a hop shorter than this is a footfall, not a jump
  landingDamp: 0.55,       // vertical arrival speed absorbed at touchdown
  reachMin: 0.18,
  reachMax: 0.46,          // how far ahead of the hip a foot is placed
  hopAmplitude: 0.055,
  strideCadence: 3.6,      // hard ceiling: the motors cannot track a faster cycle
  strideMinCadence: 1.0,
  stanceStart: 0.52,       // fraction of the cycle where the foot is planted
  stanceEnd: 0.97,
  maxReach: 0.30,          // pelvis travel past the anchor before toe-off
  gripGain: 9,             // 1/s: how fast an anchor corrects its scripted sweep
  motorRun: 0.42,
  motorAir: 0.2,
  motorDead: 0.0,
  deadFadeTime: 0.16,

  // --- obstacles -------------------------------------------------------
  spawnAhead: 26,
  recycleBehind: 10,
  minGap: 4.2,
  maxGap: 9.0,
  laneSwitchEvery: 2.6,    // seconds between automatic lane changes

  // --- scoring ---------------------------------------------------------
  scorePerMetre: 1,
  milestoneEvery: 100,

  // --- day / night -----------------------------------------------------
  dayLength: 62,           // seconds for a full day-night cycle
  dayNightCycle: 1 / 62,   // cycles per second of run time

  // --- camera ----------------------------------------------------------
  fovBase: 62,
  fovFast: 78,
};

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** Frame-rate independent smoothing factor for exponential decay. */
export function smooth(rate, dt) {
  return 1 - Math.exp(-rate * dt);
}
