// Obstacle field: what the dino has to jump, duck, or weave through.
//
// The world is static and the dino really runs (+X), so obstacles are *placed*
// rather than scrolled: they get a fixed world x when they are spawned and never
// move again, except flyers, which have their own airspeed. Recycling is
// relative to the dino (`x < dino.x - recycleBehind`), spawning is `x > dino.x +
// spawnAhead`, so the field is unbounded without an unbounded array.
//
// Two rules keep the run fair rather than lucky:
//
//   1. Geometry decides the answer, never a flag. Ground props sit on the plane
//      and must be jumped; high props occupy a band above the ducking silhouette
//      and must be ducked. The collision test is one plain AABB overlap against
//      the ragdoll's measured bounds, so what kills you is what you can see.
//   2. Spacing is derived from the jump arc, not from a random number. Airtime
//      is 2*vy/g, so at speed s an obstacle pair needs `s * airtime` of room to
//      be clearable in sequence. The gap floor is that number plus the props'
//      own widths, which is why no seed can generate a wall.

import { CONFIG, clamp } from './config.js';

/** kind -> shape. y is the centre of the box above the ground plane. */
// Sizes are constrained by the animal, not by taste. The hit box is 1.35 m long,
// and a jump has to keep that whole box above a prop's top for
// (bodyLength + propWidth) / speed. Two props broke that budget outright: the
// cluster at 1.55 m was *wider than the dinosaur*, so it could never be cleared
// horizontally no matter how the jump was timed, and the tall cactus at 1.18 m
// stood taller than the animal's back, so it needed an apex the body could not
// reach. Both now sit inside the measured clearance budget that
// `test/obstacle-check.mjs` enforces against jumpVelocity and jumpGravity.
// Flyer heights are set by the crouch, not by taste. The measured envelopes are a
// standing top of 1.36 m and a crouched top of 0.87 m, so a duckable flyer's belly has
// to sit above 0.87 m in the worst case, and its top has to stay within reach of the
// standing body or it is scenery rather than a question. Worst case is not the nominal
// spec: _spawn scales y down to 0.96, h up to 1.1, and the bob adds a further 0.12 m of
// dip, so the belly lands about 0.15 m below where the numbers below appear to put it.
// That is what the heights are solved against, and `test/obstacle-check.mjs` recomputes
// the whole thing from the ragdoll and this table. Anything lower than the crouch is a
// second jump question (pterodactyl-low, cleared by hopping), not a duck.
const KINDS = {
  'cactus-small':   { w: 0.50, h: 0.60, d: 0.50, y: null, ground: true,  weight: 26 },
  'cactus-tall':    { w: 0.55, h: 1.00, d: 0.55, y: null, ground: true,  weight: 16 },
  'cactus-cluster': { w: 1.10, h: 0.74, d: 0.95, y: null, ground: true,  weight: 12 },
  'rock':           { w: 0.78, h: 0.42, d: 0.74, y: null, ground: true,  weight: 18 },
  'pterodactyl-high': { w: 1.15, h: 0.58, d: 1.05, y: 1.24, ground: false, weight: 14, vx: -0.7, fly: true },
  'pterodactyl-low':  { w: 1.10, h: 0.50, d: 1.00, y: 0.30, ground: false, weight: 12, vx: -0.4, fly: true },
  'bird':             { w: 0.78, h: 0.40, d: 0.92, y: 1.15, ground: false, weight: 10, vx: -1.5, fly: true },
};

/** Kinds that unlock with distance, so the first hundred metres are only hops. */
const UNLOCK = {
  'cactus-cluster': 120,
  'pterodactyl-high': 70,
  'pterodactyl-low': 150,
  'bird': 210,
};

const KIND_LIST = Object.keys(KINDS);

/** Weighted pick over the kinds currently legal at this distance. */
function pickKind(distance, rand) {
  let total = 0;
  for (const k of KIND_LIST) {
    if (distance < (UNLOCK[k] ?? 0)) continue;
    total += KINDS[k].weight;
  }
  if (total <= 0) return 'cactus-small';
  let roll = rand() * total;
  for (const k of KIND_LIST) {
    if (distance < (UNLOCK[k] ?? 0)) continue;
    roll -= KINDS[k].weight;
    if (roll <= 0) return k;
  }
  return 'cactus-small';
}

/** Deterministic-enough PRNG so a run can be reproduced from a seed. */
function makeRand(seed) {
  let s = (seed >>> 0) || 0x9e3779b9;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

export class ObstacleField {
  constructor(opts = {}) {
    this.cfg = { ...CONFIG, ...opts };
    this.items = [];
    this._visible = [];
    this._nextId = 1;
    this.frontier = 0; // furthest x that has been paid for
    this.rand = makeRand(1);
    this.sinceSpawn = 0;
    this.lastKind = null;
    this.passed = 0;
  }

  reset(seed = (Math.random() * 1e9) | 0) {
    this.items.length = 0;
    this._visible.length = 0;
    this._nextId = 1;
    this.rand = makeRand(seed);
    this.frontier = this.cfg.spawnAhead * 0.7;
    this.sinceSpawn = 0;
    this.lastKind = null;
    this.passed = 0;
  }

  /**
   * Airtime of the designed jump, used to keep pairs clearable.
   *
   * This has to be the *real* arc, not the one the solver's gravity implies. The
   * root's leap is integrated against `jumpGravity`, which is gentler than the
   * `-24` the limb solver runs on (see the note in the config), so reading
   * `gravity` here reported 0.53 s for an arc that actually lasts 0.88 s. Every
   * gap downstream of this number was then derived from the wrong number: the
   * field laid obstacles at the distance a dino covers in half a second when it
   * needs nearly a full second, which is precisely the "wall that cannot be
   * jumped" failure this spacing rule exists to prevent.
   */
  get airtime() {
    return (2 * this.cfg.jumpVelocity) / Math.abs(this.cfg.jumpGravity ?? this.cfg.gravity);
  }

  /**
   * Room a pair needs so the second obstacle is reachable after the first.
   *
   * The floor and ceiling are not arbitrary: `minGap` has to clear a full jump
   * (arc distance, plus the body length, plus the moment to re-plant the legs and
   * push off again). If the arc grows without the floor growing with it, the clamp
   * silently pins the gap back down to something unclearable, so the floor is
   * derived from the arc rather than being an independent constant.
   */
  minGapFor(speed) {
    const land = this.airtime * speed;
    const needed = land + 2.0;
    return clamp(Math.max(needed, this.cfg.minGap), this.cfg.minGap, this.cfg.maxGap);
  }

  _spawn(x, distance) {
    let kind = pickKind(distance, this.rand);
    // Two of the same prop back to back reads as a bug even when it is legal.
    if (kind === this.lastKind && this.rand() < 0.6) kind = pickKind(distance, this.rand);
    this.lastKind = kind;
    const spec = KINDS[kind];
    const w = spec.w * (0.88 + this.rand() * 0.26);
    const d = spec.d * (0.9 + this.rand() * 0.2);
    // Flyers are jittered far less than ground props, and the reason is fairness
    // rather than taste. A duckable flyer's belly has to stay above the crouch and
    // below the standing head bob, and those two are only about 0.22 m apart. The
    // ground-prop jitter of +-4 % on y, +10 % on h and a 0.12 m bob swings a belly by
    // 0.31 m on its own, which is more than the whole window: the same prop would be
    // duckable on one roll and lethal on the next, and the player has no way to tell
    // which before committing to the key. Ground props only have to clear the sand, so
    // they can keep their variety. The draw order is identical on both branches so the
    // sequence stays the same regardless of which kind was picked.
    const hy = this.rand();
    const hyi = this.rand();
    const h = spec.h * (spec.fly ? 0.97 + hy * 0.06 : 0.9 + hy * 0.2);
    const y = spec.ground
      ? h / 2
      : spec.y * (spec.fly ? 0.99 + hyi * 0.02 : 0.96 + hyi * 0.08);
    // Ground props hug the running line; flyers get a little lateral wander so a
    // flock never looks like a stencil.
    const laneSpread = spec.ground ? 0.16 : 0.3;
    const z = (this.rand() * 2 - 1) * laneSpread;
    const item = {
      id: this._nextId++,
      kind,
      x, y, z,
      w, h, d,
      vx: (spec.vx ?? 0) * (0.85 + this.rand() * 0.3),
      seed: (this.rand() * 1000) | 0,
      dead: false,
      passed: false,
      bobPhase: this.rand() * Math.PI * 2,
      bobAmp: spec.fly ? 0.015 + this.rand() * 0.01 : 0,
      baseY: y,
    };
    this.items.push(item);
    return item;
  }

  /**
   * Spawn, recycle, move flyers. Returns the live list the renderer should draw.
   * @param {number} dt
   * @param {object} ctx  needs `dino.pos.x`, `speed`, `distance`
   */
  update(dt, ctx) {
    const dinoX = ctx?.dino?.pos?.x ?? 0;
    const speed = Math.max(0, ctx?.speed ?? 0);
    const distance = ctx?.distance ?? 0;

    // Fill ahead until the frontier is comfortably out of view. Camera far plane
    // and spawnAhead both matter here, so the loop is bounded by count, not time.
    let guard = 24;
    while (this.frontier < dinoX + this.cfg.spawnAhead && guard-- > 0) {
      const gap = clamp(
        this.minGapFor(speed) + this.rand() * (this.cfg.maxGap - this.cfg.minGap) * 0.7,
        this.minGapFor(speed),
        this.cfg.maxGap * 1.4,
      );
      this.frontier += gap;
      this._spawn(this.frontier, distance);
    }

    this._visible.length = 0;
    const cull = dinoX - this.cfg.recycleBehind;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      if (it.x < cull) {
        // Swap-pop: order does not matter and the array stays small and dense.
        this.items[i] = this.items[this.items.length - 1];
        this.items.pop();
        continue;
      }
      if (it.vx) {
        it.x += it.vx * dt;
        it.bobPhase += dt * 6;
        it.y = it.baseY + Math.sin(it.bobPhase) * it.bobAmp;
      }
      if (!it.dead) this._visible.push(it);
    }
    return this._visible;
  }

  /** Renderer-facing name from the contract: the list of visible props. */
  sync(ctx) {
    return this._visible.length ? this._visible : this.items;
  }

  /**
   * First obstacle overlapping the ragdoll's AABB, or null.
   *
   * The box is shrunk slightly on purpose. A ragdoll's AABB includes the tail
   * tip and the toe of whichever foot happens to be mid-swing, and losing a run
   * because a tail brushed a cactus reads as unfair, not physical.
   */
  checkHit(bounds) {
    if (!bounds) return null;
    const pad = 0.055;
    const minX = bounds.minX + pad, maxX = bounds.maxX - pad;
    const minY = bounds.minY + pad * 0.5, maxY = bounds.maxY - pad;
    const minZ = bounds.minZ + pad, maxZ = bounds.maxZ - pad;
    let hit = null;
    for (const it of this._visible) {
      if (it.dead) continue;
      const hw = it.w / 2, hh = it.h / 2, hd = it.d / 2;
      if (maxX < it.x - hw || minX > it.x + hw) continue;
      if (maxY < it.y - hh || minY > it.y + hh) continue;
      if (maxZ < it.z - hd || minZ > it.z + hd) continue;
      if (!hit || Math.abs(it.x - 0) < Math.abs(hit.x - 0)) hit = it;
    }
    return hit;
  }

  /** Count props that have fallen behind the dino, for the "obstacles cleared" stat. */
  countPassed(dinoX) {
    let n = 0;
    for (const it of this.items) {
      if (!it.passed && it.x + it.w / 2 < dinoX - 0.35) {
        it.passed = true;
        n++;
      }
    }
    this.passed += n;
    return n;
  }

  get cleared() {
    return this.passed;
  }

  get count() {
    return this.items.length;
  }
}

export { KINDS as OBSTACLE_KINDS };
export default ObstacleField;
