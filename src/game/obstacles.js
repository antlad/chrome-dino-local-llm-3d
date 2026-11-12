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
const KINDS = {
  'cactus-small':   { w: 0.52, h: 0.66, d: 0.52, y: null, ground: true,  weight: 26 },
  'cactus-tall':    { w: 0.58, h: 1.18, d: 0.58, y: null, ground: true,  weight: 16 },
  'cactus-cluster': { w: 1.55, h: 0.82, d: 1.15, y: null, ground: true,  weight: 12 },
  'rock':           { w: 0.86, h: 0.46, d: 0.82, y: null, ground: true,  weight: 18 },
  'pterodactyl-high': { w: 1.15, h: 0.58, d: 1.05, y: 1.22, ground: false, weight: 14, vx: -0.7, fly: true },
  'pterodactyl-low':  { w: 1.10, h: 0.50, d: 1.00, y: 0.30, ground: false, weight: 12, vx: -0.4, fly: true },
  'bird':             { w: 0.78, h: 0.40, d: 0.92, y: 0.97, ground: false, weight: 10, vx: -1.5, fly: true },
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

  /** Airtime of the designed jump, used to keep pairs clearable. */
  get airtime() {
    return (2 * this.cfg.jumpVelocity) / Math.abs(this.cfg.gravity);
  }

  /** Room a pair needs so the second obstacle is reachable after the first. */
  minGapFor(speed) {
    const land = this.airtime * speed;
    return clamp(land + 1.4, this.cfg.minGap, this.cfg.maxGap);
  }

  _spawn(x, distance) {
    let kind = pickKind(distance, this.rand);
    // Two of the same prop back to back reads as a bug even when it is legal.
    if (kind === this.lastKind && this.rand() < 0.6) kind = pickKind(distance, this.rand);
    this.lastKind = kind;
    const spec = KINDS[kind];
    const w = spec.w * (0.88 + this.rand() * 0.26);
    const h = spec.h * (0.9 + this.rand() * 0.2);
    const d = spec.d * (0.9 + this.rand() * 0.2);
    const y = spec.ground ? h / 2 : spec.y * (0.96 + this.rand() * 0.08);
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
      bobAmp: spec.fly ? 0.05 + this.rand() * 0.07 : 0,
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
