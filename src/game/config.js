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
  baseSpeed: 2.2,          // m/s at the start of a run
  maxSpeed: 5.4,           // m/s at full difficulty; see the note above
  accelPerMetre: 0.0055,   // m/s gained per metre travelled, ramps the difficulty
  startSpeed: 2.2,         // legacy aliases kept so older call sites stay honest
  accel: 0.055,
  deathDecay: 6.5,         // how fast the world stops after a hit (m/s^2)

  // --- lane changing ---------------------------------------------------
  laneCount: 3,
  laneWidth: 0.62,
  laneSpeed: 1.5,          // m/s of lateral drift for held strafe keys

  // --- jump ------------------------------------------------------------
  jumpVelocity: 6.1,       // 2*v/|g| = 0.51 s of airtime, 1.55 m of height
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
  duckHeight: 0.46,
  swingHeight: 0.16,       // how high a swinging foot clears the sand
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
