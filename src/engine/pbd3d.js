// 3D position-based dynamics core.
//
// Flat Float32Arrays, Gauss-Seidel projection, substepped. Y is up, X is the
// run direction (+x is forward, +z is to the dino's left).
//
// Velocities are implicit, Verlet style: v = (p - prev) / dt. That is what makes
// the death scene cheap: un-pin the root, fade the motors, and gravity plus the
// contact impulses already in the solver do the rest. No scripted fall.
//
// Units are "dino metres": the animal is about 1.6 units long, gravity is
// -9.81 * SCALE-ish. We keep numbers near unity so constraint tolerances behave.

/** Small angle utilities shared with the ragdoll. */
export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export function wrapPi(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/** Angle at vertex b, in the plane of a-b-c. Returns radians in [0, PI]. */
export function angle3(w, a, b, c) {
  const ax = w[a * 3] - w[b * 3];
  const ay = w[a * 3 + 1] - w[b * 3 + 1];
  const az = w[a * 3 + 2] - w[b * 3 + 2];
  const cx = w[c * 3] - w[b * 3];
  const cy = w[c * 3 + 1] - w[b * 3 + 1];
  const cz = w[c * 3 + 2] - w[b * 3 + 2];
  const la = Math.hypot(ax, ay, az);
  const lc = Math.hypot(cx, cy, cz);
  if (la < 1e-6 || lc < 1e-6) return 0;
  const dot = clamp((ax * cx + ay * cy + az * cz) / (la * lc), -1, 1);
  return Math.acos(dot);
}

/** Signed angle of `p` around the (from->to) axis, measured from `ref`. */
export function signedAngleAround(w, from, to, p, ref) {
  const ax = w[to * 3] - w[from * 3];
  const ay = w[to * 3 + 1] - w[from * 3 + 1];
  const az = w[to * 3 + 2] - w[from * 3 + 2];
  const vx = w[p * 3] - w[from * 3];
  const vy = w[p * 3 + 1] - w[from * 3 + 1];
  const vz = w[p * 3 + 2] - w[from * 3 + 2];
  // Reference direction projected into the plane normal to a.
  const rx = w[ref * 3] - w[from * 3];
  const ry = w[ref * 3 + 1] - w[from * 3 + 1];
  const rz = w[ref * 3 + 2] - w[from * 3 + 2];
  const al = Math.hypot(ax, ay, az) || 1;
  const nx = ax / al, ny = ay / al, nz = az / al;
  const drop = (d) => {
    const k = d[0] * nx + d[1] * ny + d[2] * nz;
    return [d[0] - nx * k, d[1] - ny * k, d[2] - nz * k];
  };
  const r = drop([rx, ry, rz]);
  const v = drop([vx, vy, vz]);
  const rl = Math.hypot(r[0], r[1], r[2]) || 1;
  const vl = Math.hypot(v[0], v[1], v[2]) || 1;
  const dot = clamp((r[0] * v[0] + r[1] * v[1] + r[2] * v[2]) / (rl * vl), -1, 1);
  const crx = r[1] * v[2] - r[2] * v[1];
  const cry = r[2] * v[0] - r[0] * v[2];
  const crz = r[0] * v[1] - r[1] * v[0];
  const sign = Math.sign(crx * nx + cry * ny + crz * nz) || 1;
  return Math.acos(dot) * sign;
}

export class PhysicsWorld {
  constructor(opts = {}) {
    this.gravity = opts.gravity ?? -24.0; // snappier than 9.81 for a game
    this.damping = opts.damping ?? 0.995;
    this.groundY = opts.groundY ?? 0;
    this.iterations = opts.iterations ?? 4;
    this.substeps = opts.substeps ?? 4;
    this.corrections = []; // scratch, consumed by caller each step

    /** @type {Float32Array|null} */
    this.pos = null;
    this.prev = null;
    this.inv = null;
    this.radius = null;
    this.friction = null;
    this.pinned = null;
    this.alive = null;
    this.count = 0;
    this.names = [];
    this.nameToIndex = new Map();

    this.dist = []; // {a,b,rest,stiff,compliance,breakAt?}
    this.angles = []; // {a,b,c,rest,lo,hi,stiff}
    this.bones = []; // {a,b,r0,r1,thickness,name}

    this._scratch = { w: null };
  }

  addParticle(spec) {
    const i = this.count++;
    const grow = () => {
      const cap = Math.max(32, this.count * 2);
      const re3 = (src) => {
        const next = new Float32Array(cap * 3);
        if (src) next.set(src.subarray(0, src.length));
        return next;
      };
      const re1 = (src) => {
        const next = new Float32Array(cap);
        if (src) next.set(src.subarray(0, src.length));
        return next;
      };
      this.pos = re3(this.pos);
      this.prev = re3(this.prev);
      this.inv = re1(this.inv);
      this.radius = re1(this.radius);
      this.friction = re1(this.friction);
      this.pinned = re1(this.pinned);
      this.alive = re1(this.alive);
    };
    if (!this.pos || this.count * 3 > this.pos.length) grow();

    const x = spec.x ?? 0, y = spec.y ?? 0, z = spec.z ?? 0;
    const b = i * 3;
    this.pos[b] = x; this.pos[b + 1] = y; this.pos[b + 2] = z;
    this.prev[b] = x - (spec.vx ?? 0) / 60;
    this.prev[b + 1] = y - (spec.vy ?? 0) / 60;
    this.prev[b + 2] = z - (spec.vz ?? 0) / 60;
    const mass = spec.mass ?? 1;
    this.inv[i] = spec.pinned ? 0 : 1 / Math.max(1e-4, mass);
    this.radius[i] = spec.radius ?? 0.06;
    this.friction[i] = spec.friction ?? 0.6;
    this.pinned[i] = spec.pinned ? 1 : 0;
    this.alive[i] = 1;
    if (spec.name) {
      this.names.push(spec.name);
      this.nameToIndex.set(spec.name, i);
    }
    return i;
  }

  idx(name) {
    const i = this.nameToIndex.get(name);
    if (i === undefined) throw new Error('no particle named ' + name);
    return i;
  }

  setPinned(i, on) {
    this.pinned[i] = on ? 1 : 0;
    if (on) {
      const b = i * 3;
      this.prev[b] = this.pos[b];
      this.prev[b + 1] = this.pos[b + 1];
      this.prev[b + 2] = this.pos[b + 2];
    }
  }

  setPos(i, x, y, z) {
    const b = i * 3;
    this.pos[b] = x; this.pos[b + 1] = y; this.pos[b + 2] = z;
  }

  /** Move a particle and keep the Verlet history consistent (impulse-free). */
  setPosKeepVel(i, x, y, z) {
    const b = i * 3;
    const vx = this.pos[b] - this.prev[b];
    const vy = this.pos[b + 1] - this.prev[b + 1];
    const vz = this.pos[b + 2] - this.prev[b + 2];
    this.pos[b] = x; this.pos[b + 1] = y; this.pos[b + 2] = z;
    this.prev[b] = x - vx; this.prev[b + 1] = y - vy; this.prev[b + 2] = z - vz;
  }

  setVel(i, vx, vy, vz, dt = 1 / 60) {
    const b = i * 3;
    this.prev[b] = this.pos[b] - vx * dt;
    this.prev[b + 1] = this.pos[b + 1] - vy * dt;
    this.prev[b + 2] = this.pos[b + 2] - vz * dt;
  }

  getVel(i, dt = 1 / 60) {
    const b = i * 3;
    return [
      (this.pos[b] - this.prev[b]) / dt,
      (this.pos[b + 1] - this.prev[b + 1]) / dt,
      (this.pos[b + 2] - this.prev[b + 2]) / dt,
    ];
  }

  addDistance(a, b, opts = {}) {
    const rest = opts.rest ?? this.distance(a, b);
    this.dist.push({
      a, b, rest,
      stiff: opts.stiff ?? 1,
      compliance: opts.compliance ?? 0,
      maxForce: opts.maxForce ?? Infinity,
      broken: false,
      tag: opts.tag ?? '',
    });
    return this.dist.length - 1;
  }

  /**
   * Angular constraint at vertex b. `lo`/`hi` clamp the angle; a target inside
   * the range is held with `stiff`, anything outside is a hard limit.
   */
  addAngle(a, b, c, opts = {}) {
    const rest = opts.rest ?? angle3(this.pos, a, b, c);
    const rec = {
      a, b, c,
      rest,
      target: opts.target ?? rest,
      lo: opts.lo ?? 0,
      hi: opts.hi ?? Math.PI,
      stiff: opts.stiff ?? 0.35,
      limitStiff: opts.limitStiff ?? 0.9,
      name: opts.name ?? '',
    };
    this.angles.push(rec);
    return this.angles.length - 1;
  }

  addBone(a, b, opts = {}) {
    this.bones.push({
      a, b,
      r0: opts.r0 ?? 0.09,
      r1: opts.r1 ?? 0.06,
      name: opts.name ?? `${this.names[a] || a}-${this.names[b] || b}`,
      render: opts.render ?? null, // set by the renderer: {mesh, len}
    });
    return this.bones.length - 1;
  }

  distance(a, b) {
    const ba = a * 3, bb = b * 3;
    return Math.hypot(
      this.pos[ba] - this.pos[bb],
      this.pos[ba + 1] - this.pos[bb + 1],
      this.pos[ba + 2] - this.pos[bb + 2],
    );
  }

  angleAt(name) {
    const rec = this.angles.find((r) => r.name === name);
    if (!rec) throw new Error('no angle ' + name);
    return angle3(this.pos, rec.a, rec.b, rec.c);
  }

  /** Kinematic drag of a particle toward a target this step (root motion). */
  moveTo(i, x, y, z, blend = 1) {
    const b = i * 3;
    this.pos[b] += (x - this.pos[b]) * blend;
    this.pos[b + 1] += (y - this.pos[b + 1]) * blend;
    this.pos[b + 2] += (z - this.pos[b + 2]) * blend;
  }

  // ---------------------------------------------------------------- stepping

  step(dt, opts = {}) {
    const substeps = opts.substeps ?? this.substeps;
    const iterations = opts.iterations ?? this.iterations;
    const h = dt / substeps;
    for (let s = 0; s < substeps; s++) {
      this.integrate(h);
      for (let k = 0; k < iterations; k++) this.solve();
      this.collide(h);
    }
  }

  integrate(h) {
    const { pos, prev, inv, gravity, damping } = this;
    const g = gravity * h * h;
    for (let i = 0; i < this.count; i++) {
      if (inv[i] === 0) continue;
      const b = i * 3;
      const x = pos[b], y = pos[b + 1], z = pos[b + 2];
      pos[b] = x + (x - prev[b]) * damping;
      pos[b + 1] = y + (y - prev[b + 1]) * damping + g;
      pos[b + 2] = z + (z - prev[b + 2]) * damping;
      prev[b] = x; prev[b + 1] = y; prev[b + 2] = z;
    }
  }

  solve() {
    this.solveDistances();
    this.solveAngles();
  }

  solveDistances() {
    const { pos, inv } = this;
    for (const d of this.dist) {
      if (d.broken) continue;
      const wa = inv[d.a], wb = inv[d.b];
      const wsum = wa + wb;
      if (wsum === 0) continue;
      const ba = d.a * 3, bb = d.b * 3;
      let dx = pos[bb] - pos[ba];
      let dy = pos[bb + 1] - pos[ba + 1];
      let dz = pos[bb + 2] - pos[ba + 2];
      const len = Math.hypot(dx, dy, dz);
      if (len < 1e-9) continue;
      if (d.maxForce !== Infinity && Math.abs(len - d.rest) > d.maxForce) {
        d.broken = true;
        continue;
      }
      const k = d.compliance > 0 ? 1 / (1 + d.compliance) : d.stiff;
      const diff = ((len - d.rest) / len) * k;
      dx *= diff; dy *= diff; dz *= diff;
      const fa = wa / wsum, fb = wb / wsum;
      pos[ba] += dx * fa;
      pos[bb] -= dx * fb;
      pos[ba + 1] += dy * fa;
      pos[bb + 1] -= dy * fb;
      pos[ba + 2] += dz * fa;
      pos[bb + 2] -= dz * fb;
    }
  }

  solveAngles() {
    const { pos, inv } = this;
    for (const a of this.angles) {
      const wa = inv[a.a], wb = inv[a.b], wc = inv[a.c];
      const wsum = wa + wb + wc;
      if (wsum === 0) continue;

      const ba = a.a * 3, bb = a.b * 3, bc = a.c * 3;
      let d0x = pos[ba] - pos[bb], d0y = pos[ba + 1] - pos[bb + 1], d0z = pos[ba + 2] - pos[bb + 2];
      let d1x = pos[bc] - pos[bb], d1y = pos[bc + 1] - pos[bb + 1], d1z = pos[bc + 2] - pos[bb + 2];
      const l0 = Math.hypot(d0x, d0y, d0z);
      const l1 = Math.hypot(d1x, d1y, d1z);
      if (l0 < 1e-6 || l1 < 1e-6) continue;
      d0x /= l0; d0y /= l0; d0z /= l0;
      d1x /= l1; d1y /= l1; d1z /= l1;

      const dot = clamp(d0x * d1x + d0y * d1y + d0z * d1z, -1, 1);
      const theta = Math.acos(dot);

      let err = 0;
      let stiff = a.stiff;
      if (theta < a.lo) { err = a.lo - theta; stiff = a.limitStiff; }
      else if (theta > a.hi) { err = theta - a.hi; stiff = a.limitStiff; }
      else if (a.target !== null && a.target !== undefined) {
        err = a.target - theta;
        stiff = a.stiff;
      }
      if (Math.abs(err) < 1e-5) continue;

      // Gradient of theta wrt the outer particles.
      let nx = d0y * d1z - d0z * d1y;
      let ny = d0z * d1x - d0x * d1z;
      let nz = d0x * d1y - d0y * d1x;
      const nl = Math.hypot(nx, ny, nz);
      if (nl < 1e-4) continue; // near-parallel, gradient undefined
      const sinT = nl; // |d0 x d1| == sin(theta) for unit vectors
      nx /= nl; ny /= nl; nz /= nl;

      // True gradients of theta. For unit d0 (b->a) and d1 (b->c):
      //   grad_a = (d0*cos - d1) / sin,  grad_c = (d1*cos - d0) / sin
      // which is -(I - d0 d0^T) d1 / sin and its mirror. Moving each particle
      // along +grad * (target - theta) increases theta toward the target.
      const cosT = dot;
      let gax = (d0x * cosT - d1x) / sinT;
      let gay = (d0y * cosT - d1y) / sinT;
      let gaz = (d0z * cosT - d1z) / sinT;
      let gcx = (d1x * cosT - d0x) / sinT;
      let gcy = (d1y * cosT - d0y) / sinT;
      let gcz = (d1z * cosT - d0z) / sinT;
      const gbx = -(gax + gcx), gby = -(gay + gcy), gbz = -(gaz + gcz);

      const s = err * stiff;
      // Scale each gradient by its own invMass, normalised by the squared sum.
      const denom = wa * (gax * gax + gay * gay + gaz * gaz)
        + wb * (gbx * gbx + gby * gby + gbz * gbz)
        + wc * (gcx * gcx + gcy * gcy + gcz * gcz);
      if (denom < 1e-9) continue;
      const lambda = s / denom;

      pos[ba] += gax * lambda * wa;
      pos[ba + 1] += gay * lambda * wa;
      pos[ba + 2] += gaz * lambda * wa;
      pos[bb] += gbx * lambda * wb;
      pos[bb + 1] += gby * lambda * wb;
      pos[bb + 2] += gbz * lambda * wb;
      pos[bc] += gcx * lambda * wc;
      pos[bc + 1] += gcy * lambda * wc;
      pos[bc + 2] += gcz * lambda * wc;
    }
  }

  collide(h) {
    const { pos, prev, inv, radius, groundY } = this;
    const restitution = 0.12;
    for (let i = 0; i < this.count; i++) {
      if (inv[i] === 0) continue;
      const b = i * 3;
      const r = radius[i];
      if (pos[b + 1] - r < groundY) {
        const vy = pos[b + 1] - prev[b + 1];
        pos[b + 1] = groundY + r;
        // Tangential friction, stronger the deeper the contact.
        const mu = this.friction[i];
        prev[b] += (pos[b] - prev[b]) * mu;
        prev[b + 2] += (pos[b + 2] - prev[b + 2]) * mu;
        // Bounce: only when actually moving down.
        prev[b + 1] = vy < 0 ? pos[b + 1] + vy * restitution : pos[b + 1];
      }
    }
    this.collidePairs();
  }

  /** Particle-vs-particle separation. Bones are capsules made of endpoint
   *  spheres plus a mid-node where it matters; that is enough for a dino. */
  collidePairs() {
    const { pos, prev, inv, radius } = this;
    const n = this.count;
    const skip = this._skip;
    for (let i = 0; i < n; i++) {
      if (inv[i] === 0) continue;
      for (let j = i + 1; j < n; j++) {
        if (inv[j] === 0) continue;
        if (skip && skip(i, j)) continue;
        const ri = radius[i], rj = radius[j];
        const need = ri + rj;
        const bi = i * 3, bj = j * 3;
        let dx = pos[bj] - pos[bi];
        let dy = pos[bj + 1] - pos[bi + 1];
        let dz = pos[bj + 2] - pos[bi + 2];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= need * need || d2 < 1e-12) continue;
        const d = Math.sqrt(d2);
        const k = (need - d) / d;
        const wi = inv[i], wj = inv[j];
        const wsum = wi + wj;
        dx *= k; dy *= k; dz *= k;
        pos[bi] -= dx * (wi / wsum);
        pos[bi + 1] -= dy * (wi / wsum);
        pos[bi + 2] -= dz * (wi / wsum);
        pos[bj] += dx * (wj / wsum);
        pos[bj + 1] += dy * (wj / wsum);
        pos[bj + 2] += dz * (wj / wsum);
        // Ground contact friction for scraped limbs.
        if (pos[bi + 1] - ri <= this.groundY + 1e-4) {
          prev[bi] += (pos[bi] - prev[bi]) * this.friction[i];
          prev[bi + 2] += (pos[bi + 2] - prev[bi + 2]) * this.friction[i];
        }
      }
    }
  }

  /** Skip self-collision for directly connected particles (a bone never
   *  collides with itself). */
  buildCollisionSkip() {
    const bad = new Set();
    const key = (i, j) => (i < j ? i * 10000 + j : j * 10000 + i);
    for (const d of this.dist) bad.add(key(d.a, d.b));
    for (const a of this.angles) {
      bad.add(key(a.a, a.b));
      bad.add(key(a.b, a.c));
      bad.add(key(a.a, a.c));
    }
    for (const b of this.bones) bad.add(key(b.a, b.b));
    this._skip = (i, j) => bad.has(key(i, j));
  }

  /** Push the nearest of two capsule endpoints out of an obstacle. Used by the
   *  game for cacti / pterodactyl hits and for corpse-vs-prop contact. */
  pushOut(a, b, cx, cy, cz, r) {
    const { pos, inv } = this;
    const ba = a * 3, bb = b * 3;
    // Closest point on segment ab to c.
    const ax = pos[ba], ay = pos[ba + 1], az = pos[ba + 2];
    const ex = pos[bb] - ax, ey = pos[bb + 1] - ay, ez = pos[bb + 2] - az;
    const len2 = ex * ex + ey * ey + ez * ez || 1e-6;
    let t = ((cx - ax) * ex + (cy - ay) * ey + (cz - az) * ez) / len2;
    t = clamp(t, 0, 1);
    const px = ax + ex * t, py = ay + ey * t, pz = az + ez * t;
    let dx = px - cx, dy = py - cy, dz = pz - cz;
    const d = Math.hypot(dx, dy, dz);
    const need = r;
    if (d > need) return false;
    if (d < 1e-6) { dx = 0; dy = 1; dz = 0; } else { dx /= d; dy /= d; dz /= d; }
    const push = need - d;
    const wa = inv[a], wb = inv[b];
    const wsum = wa + wb || 1;
    const fa = wa / wsum, fb = wb / wsum;
    pos[ba] += dx * push * fa; pos[ba + 1] += dy * push * fa; pos[ba + 2] += dz * push * fa;
    pos[bb] += dx * push * fb; pos[bb + 1] += dy * push * fb; pos[bb + 2] += dz * push * fb;
    return true;
  }

  /** Snapshot for tests / debug overlays. */
  dump() {
    const out = [];
    for (let i = 0; i < this.count; i++) {
      const b = i * 3;
      out.push({
        name: this.names[i] ?? String(i),
        x: +this.pos[b].toFixed(3),
        y: +this.pos[b + 1].toFixed(3),
        z: +this.pos[b + 2].toFixed(3),
      });
    }
    return out;
  }
}
