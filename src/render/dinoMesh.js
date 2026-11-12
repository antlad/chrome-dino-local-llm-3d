// The dino's body, built entirely from the solver.
//
// There is no model file and no authored animation: every entry in `world.bones`
// becomes a tapered capsule between its two particles, every particle becomes a
// joint sphere so the silhouette does not facet at the bends, and the character
// bits (boxy skull, lower jaw, bulging eyes, brow ridges, vestigial arms, back
// scutes, three toes per foot) are rigid children of the bone frame they belong
// to. Ask the solver where the head is, put the eyes there. That is what keeps the
// T-Rex readable while it is dying, which is the whole point of a ragdoll runner.
//
// Orientation contract: `+X` forward, `+Y` up, `+Z` to the dino's left. Every
// detail offset and size below is therefore written as (forward, up, left) in the
// parent bone's frame, so the file reads like a description of a dinosaur rather
// than a wall of matrices.
//
// `update()` is the hot path and allocates nothing: one shared unit geometry per
// shape family, one material per family, and every scratch vector, quaternion,
// matrix and lookup object is created once in the constructor.

const BODY_COLOR = '#5a6b52'; // grey-green Chrome dino; the day/night palette tints it later
const DARK = '#1b1d1a';

// How far the derived colours sit from the base body colour.
const BELLY_LIFT = 0.44; // toward white
const DARK_MIX = 0.86; // toward black

// Role patterns for skeleton names. The skeleton is authored in src/game/dino.js
// and may rename anything, so every pattern is allowed to miss: lookups answer -1
// or an empty list and the caller skips that detail. Nothing here may throw.
const RE_HEAD = /head|skull/;
const RE_SNOUT = /snout|nose|mouth/;
const RE_JAW = /jaw|mandible|chin/;
const RE_EYE = /eye/;
const RE_ARM = /arm|hand|wrist/;
const RE_LEGISH = /foot|toe|ankle|leg|thigh|knee|shin|calf/;
const RE_FOOT = /foot|toe|ankle/;
const RE_BELLY = /belly|stomach|underside|abdomen|jaw/;
const RE_SPINE = /spine|back|tail|neck|chest|pelvis|torso|hip/;
const RE_LIMB = /thigh|knee|shin|calf|foot|toe|ankle|arm|hand|wrist|wing/;
const RE_CHEST = /chest|torso|shoulder|neck/;
const RE_PELVIS = /pelvis|hip|waist/;
const RE_ANY_FRAME = /head|neck|chest|pelvis|spine|back|tail|hip|torso/;
// Particles that exist for the solver's benefit rather than the body's. They get no
// joint sphere. Bone endpoints always draw, so this can only ever hide helpers.
const RE_NOT_BODY = /scratch|target|anchor|ghost|debug|helper|dummy|marker|aux|_ref/;

/** Higher priority wins when choosing which bones carry back scutes. */
function spinePriority(name) {
  if (/spine/.test(name)) return 0;
  if (/back/.test(name)) return 1;
  if (/tail/.test(name)) return 2;
  if (/neck/.test(name)) return 3;
  if (/chest|torso/.test(name)) return 4;
  if (/pelvis|hip/.test(name)) return 5;
  return 9;
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

const NO_BONES = [];
const DEFAULT_RADIUS = 0.06;

export class DinoMesh {
  /**
   * @param {object} opts
   * @param {object} opts.THREE   the vendored three namespace
   * @param {object} opts.world   a PhysicsWorld (reads .pos, .bones, .count, .radius, .names)
   * @param {object} [opts.scene] optional scene; the group is also added by the caller
   */
  constructor({ THREE, world, scene, THREE_ = THREE, color = BODY_COLOR } = {}) {
    const T = THREE_ ?? THREE;
    if (!T) throw new Error('DinoMesh: THREE is required');
    this.THREE = T;
    // An unpopulated world is legal. We render nothing until bones appear, and
    // pick them up later via the lazy rebuild in update().
    this.world = world ?? { pos: null, bones: NO_BONES, count: 0, radius: null, names: [], nameToIndex: new Map() };
    this.scene = scene ?? null;

    this.group = new T.Group();
    this.group.name = 'dino';
    if (this.scene && typeof this.scene.add === 'function') this.scene.add(this.group);

    /** Flip to true to overlay thin wireframes for bones and particles. */
    this.debugSkeleton = false;
    this.limp = 0;

    // ------------------------------------------------------------- scratch
    // Hoisted once. update() must never construct any of these.
    this._posV = new T.Vector3();
    this._dirV = new T.Vector3();
    this._upV = new T.Vector3();
    this._sideV = new T.Vector3();
    this._midV = new T.Vector3();
    this._qAxis = new T.Quaternion(); // minimal twist: +Y onto a bone direction
    this._qBody = new T.Quaternion(); // body frame: X forward, Y up, Z left
    this._mat4 = new T.Matrix4();

    // Readout of the bone currently framed by _readBone / _bodyFrame.
    this._dx = 1; this._dy = 0; this._dz = 0; this._len = 0;
    this._mx = 0; this._my = 0; this._mz = 0;
    this._uy = 1; // world-Y component of the framed bone's local up

    this._geoms = new Set();
    this._mats = new Set();

    this._baseColor = new T.Color();
    this._white = new T.Color().set(0xffffff);
    this._black = new T.Color().set(0x000000);

    // Visual inventory, rebuilt only by rebuild().
    this._boneMeshes = [];
    this._boneDebug = [];
    this._jointMeshes = [];
    this._debugJoints = [];
    this._jointScale = null;
    this._jointKind = null; // 0 hidden, 1 joint, 2 loose fill-in particle
    this._headParts = [];
    this._torsoParts = [];
    this._armParts = [];
    this._toeParts = [];
    this._scuteParts = [];
    this._anchor = { bone: -1, particle: -1 };
    this._builtBoneCount = -1;
    this._rebuildTick = 0;
    this._debugApplied = false;

    this._buildGeometries();
    this._buildMaterials();
    this.setColor(color);
    this.rebuild();
  }

  // ------------------------------------------------------------- assets

  _buildGeometries() {
    const T = this.THREE;
    const grab = (g) => {
      this._geoms.add(g);
      return g;
    };
    // One unit cylinder serves every capsule in the body: radius 1 at both ends,
    // height 1 centred on the origin, aligned to +Y. Per bone we set
    // scale = (r0*2, length, r1*2), so the +Y cap lands on the bone's `b` particle
    // and the -Y cap on `a`. 12 radial segments on purpose: flat shading across 12
    // facets is the look, and it keeps the triangle budget trivial.
    this._unitCyl = grab(new T.CylinderGeometry(1, 1, 1, 12, 1, false));
    this._unitSphere = grab(new T.SphereGeometry(1, 12, 8));
    this._unitBox = grab(new T.BoxGeometry(1, 1, 1));
    // Five sides reads as a keratin plate rather than a traffic cone.
    this._unitCone = grab(new T.ConeGeometry(1, 1, 5, 1, false));
    // The debug overlay gets its own cheap shapes so the real ones stay untouched.
    this._debugCyl = grab(new T.CylinderGeometry(1, 1, 1, 4, 1, true));
    this._debugSphere = grab(new T.SphereGeometry(1, 6, 4));
  }

  _buildMaterials() {
    const T = this.THREE;
    const flat = (color) => {
      const m = new T.MeshLambertMaterial({ color, flatShading: true });
      this._mats.add(m);
      return m;
    };
    // One body material plus a lighter belly, an eye white and a dark for
    // eyes/claws/scutes. Flat shading sells the low-poly stylisation, and there
    // are no textures anywhere in this file.
    this.matBody = flat(0xffffff);
    this.matBelly = flat(0xffffff);
    this.matEye = flat(0xffffff);
    this.matDark = flat(DARK);

    const wire = (color) => {
      const m = new T.MeshBasicMaterial({ color, wireframe: true });
      this._mats.add(m);
      return m;
    };
    this._matDebugBone = wire(0x00ff88);
    this._matDebugJoint = wire(0xff8800);
  }

  /** One mesh factory, so shadow flags are never forgotten on a new part. */
  _mesh(geom, mat, { receive = false, visible = true } = {}) {
    const m = new this.THREE.Mesh(geom, mat);
    m.castShadow = true; // everything casts
    m.receiveShadow = receive; // only the body receives
    m.visible = visible;
    this.group.add(m);
    return m;
  }

  // ------------------------------------------------------- name resilience
  // The skeleton lives elsewhere, so nothing below may throw on a name it does
  // not recognise. Exact lookups return -1, set lookups return nothing.

  /**
   * Particle index -> name, built from `nameToIndex` rather than indexed `names`.
   * The solver only pushes onto `names` for named particles, so `names[i]` is not
   * guaranteed to be particle i's name. `nameToIndex` is the only trustworthy map,
   * and this table is what every role lookup below reads.
   */
  _buildNameTable() {
    const count = Math.max(0, this.world.count | 0);
    const table = new Array(count).fill('');
    const map = this.world.nameToIndex;
    if (map && typeof map.forEach === 'function') {
      map.forEach((idx, name) => {
        if (typeof idx === 'number' && idx >= 0 && idx < count && !table[idx]) table[idx] = String(name);
      });
    }
    // Last resort for a world that only exposes `names`.
    const names = this.world.names;
    if (names && (!map || typeof map.forEach !== 'function')) {
      for (let i = 0; i < count; i++) if (typeof names[i] === 'string') table[i] = names[i];
    }
    this._particleName = table;
  }

  /** Particle index for an exact name, or -1. */
  _particleIndex(name) {
    const world = this.world;
    if (!name || !world.nameToIndex || typeof world.nameToIndex.get !== 'function') return -1;
    const i = world.nameToIndex.get(name);
    return typeof i === 'number' && i >= 0 && i < world.count ? i : -1;
  }

  /** First particle whose name matches the pattern, or -1. `prefer` is tried first. */
  _particleAny(re, prefer = []) {
    for (let i = 0; i < prefer.length; i++) {
      const hit = this._particleIndex(prefer[i]);
      if (hit >= 0) return hit;
    }
    const table = this._particleName;
    if (!table) return -1;
    for (let i = 0; i < table.length; i++) {
      if (table[i] && re.test(table[i])) return i;
    }
    return -1;
  }

  /** First bone whose name matches the pattern, or -1. */
  _boneAny(re) {
    const bones = this.world.bones || NO_BONES;
    for (let i = 0; i < bones.length; i++) {
      const n = bones[i] && bones[i].name;
      if (typeof n === 'string' && re.test(n)) return i;
    }
    return -1;
  }

  /** All bone indices matching `re`, minus `notRe`, ordered by `rank`. */
  _bonesMatching(re, notRe, rank) {
    const bones = this.world.bones || NO_BONES;
    const scored = [];
    for (let i = 0; i < bones.length; i++) {
      const n = bones[i] && bones[i].name;
      if (typeof n !== 'string') continue;
      if (!re.test(n)) continue;
      if (notRe && notRe.test(n)) continue;
      scored.push({ i, r: rank ? rank(n) : 0 });
    }
    scored.sort((a, b) => a.r - b.r);
    return scored.map((e) => e.i);
  }

  /** Particle indices whose names match, left-most first for L/R pairing. */
  _particlesMatching(re) {
    const table = this._particleName;
    const out = [];
    if (!table) return out;
    for (let i = 0; i < table.length; i++) {
      if (table[i] && re.test(table[i])) out.push(i);
    }
    const pos = this.world.pos;
    if (pos) out.sort((a, b) => pos[b * 3 + 2] - pos[a * 3 + 2]);
    return out;
  }

  /**
   * A bone to hang details off when nothing role-specific exists. Without this the
   * face would have nothing to attach to on a minimally named skeleton.
   */
  _fallbackFrameBone() {
    const i = this._boneAny(RE_ANY_FRAME);
    if (i >= 0) return i;
    const bones = this.world.bones || NO_BONES;
    return bones.length > 0 ? 0 : -1;
  }

  // ------------------------------------------------------------ quaternion
  // Aligning +Y with a direction is three.js's `setFromUnitVectors`, which does
  // handle the anti-parallel case, but it routes through a scratch Vector3 we do
  // not want in the hot path. With the source fixed at (0,1,0) the closed form is
  // q = (d.z, 0, -d.x, 1 + d.y) normalised, and the only degenerate input is
  // d = (0,-1,0), where it collapses to zero, so that one case is an explicit
  // half turn about X. `d` must already be normalised.

  _setQFromUnitY(q, x, y, z) {
    if (y < -0.999999) return q.set(1, 0, 0, 0); // +Y -> -Y
    return q.set(z, 0, -x, 1 + y).normalize();
  }

  /** Build-time variant: returns a fresh quaternion. Constructor path only. */
  _qFromUnitY(x, y, z) {
    return this._setQFromUnitY(new this.THREE.Quaternion(), x, y, z);
  }

  _qAxisAngle(x, y, z, angle) {
    const q = new this.THREE.Quaternion();
    const h = angle * 0.5;
    const s = Math.sin(h);
    return q.set(x * s, y * s, z * s, Math.cos(h));
  }

  // -------------------------------------------------------------- framing

  /**
   * Load one bone into the framing fields. Returns false when the entry is missing
   * or its particles are not addressable, which is how a half-built skeleton or a
   * collapsed bone degrades to "that part is hidden" instead of NaN meshes.
   */
  _readBone(i) {
    const world = this.world;
    const bones = world.bones;
    const pos = world.pos;
    if (!bones || !pos) return false;
    const bone = bones[i];
    if (!bone) return false;
    const a = bone.a;
    const b = bone.b;
    if (!(a >= 0 && b >= 0 && a < world.count && b < world.count)) return false;
    const ba = a * 3;
    const bb = b * 3;
    const ax = pos[ba], ay = pos[ba + 1], az = pos[ba + 2];
    const bx = pos[bb], by = pos[bb + 1], bz = pos[bb + 2];
    // Finite-checked below; non-finite is a solver bug we absorb by hiding.
    if (!(Number.isFinite(ax) && Number.isFinite(ay) && Number.isFinite(az)
      && Number.isFinite(bx) && Number.isFinite(by) && Number.isFinite(bz))) return false;
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (!(len > 1e-5)) return false;
    this._dx = dx / len; this._dy = dy / len; this._dz = dz / len;
    this._len = len;
    this._mx = (ax + bx) * 0.5; this._my = (ay + by) * 0.5; this._mz = (az + bz) * 0.5;
    this._ax = ax; this._ay = ay; this._az = az;
    this._bx = bx; this._by = by; this._bz = bz;
    return true;
  }

  /**
   * Full body frame for the bone last read by _readBone: X = forward along the
   * bone, Y = the bone's local up (world up with the bone's own tilt removed),
   * Z = left. Building the basis explicitly instead of using a bare lookAt is what
   * keeps the eyes on top of the skull when the head pitches, and gives the scutes
   * a real "up" to stand on.
   */
  _frameFromDirection() {
    const fx = this._dx, fy = this._dy, fz = this._dz;
    // Gram-Schmidt a perpendicular up out of world Y. A near-vertical bone has no
    // meaningful up in Y, so fall back to world -Z; still deterministic.
    let ux = -fx * fy, uy = 1 - fy * fy, uz = -fz * fy;
    let ul = Math.sqrt(ux * ux + uy * uy + uz * uz);
    if (ul < 1e-4) {
      ux = -fx * fz; uy = -fy * fz; uz = 1 - fz * fz;
      ul = Math.sqrt(ux * ux + uy * uy + uz * uz);
      if (ul < 1e-4) return false;
    }
    ux /= ul; uy /= ul; uz /= ul;
    let sx = fy * uz - fz * uy;
    let sy = fz * ux - fx * uz;
    let sz = fx * uy - fy * ux;
    const sl = Math.sqrt(sx * sx + sy * sy + sz * sz);
    if (!(sl > 1e-6)) return false;
    sx /= sl; sy /= sl; sz /= sl;
    // Re-derive up from the two clean axes so the basis is exactly orthonormal.
    ux = sy * fz - sz * fy;
    uy = sz * fx - sx * fz;
    uz = sx * fy - sy * fx;
    this._dirV.set(fx, fy, fz);
    this._upV.set(ux, uy, uz);
    this._sideV.set(sx, sy, sz);
    this._uy = uy;
    this._midV.set(this._mx, this._my, this._mz);
    this._mat4.makeBasis(this._dirV, this._upV, this._sideV);
    this._qBody.setFromRotationMatrix(this._mat4);
    return true;
  }

  _bodyFrame(i) {
    return this._readBone(i) && this._frameFromDirection();
  }

  /**
   * Frame for a part: its own bone when it has a usable one, else the anchor
   * particle with an identity rotation (world axes are a fine fallback when the
   * skeleton has no frame to give us). `atParticle` then moves the origin onto that
   * particle while keeping the bone's orientation, which is how the face and the
   * toes sit on the body rather than at the midpoint of the bone that describes it.
   */
  _frameFor(part) {
    let framed = false;
    if (part.frameBone >= 0 && this._bodyFrame(part.frameBone)) framed = true;
    const p = part.frameParticle;
    const pos = this.world.pos;
    if (!framed) {
      if (p < 0 || !(p < this.world.count) || !pos) return false;
      const b = p * 3;
      const x = pos[b], y = pos[b + 1], z = pos[b + 2];
      if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z))) return false;
      this._midV.set(x, y, z);
      this._qBody.set(0, 0, 0, 1);
      framed = true;
    }
    const a = part.atParticle;
    if (a >= 0 && a < this.world.count) {
      const b = a * 3;
      const x = pos[b], y = pos[b + 1], z = pos[b + 2];
      if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z))) return false;
      this._midV.set(x, y, z);
    }
    return framed;
  }

  // ---------------------------------------------------------------- build

  /**
   * Re-derive the whole visual inventory from `world.bones`. Called from the
   * constructor, and again from update() if bones appeared after construction,
   * since building the renderer before the ragdoll is a real boot-order risk.
   */
  rebuild() {
    this._clearVisuals();
    this._buildNameTable();
    const bones = this.world.bones || NO_BONES;
    this._builtBoneCount = bones.length;
    this._anchor.bone = this._fallbackFrameBone();
    // Details want a head-ish anchor; the pelvis is only a last resort because a
    // face pinned to the hip is worse than a face pinned to the chest.
    const anchorP = this._particleAny(RE_HEAD, ['head', 'skull', 'snout', 'neck', 'chest', 'pelvis']);
    this._anchor.particle = anchorP >= 0 ? anchorP : 0;

    this._buildBones();
    this._buildJoints();
    this._buildBelly();
    this._buildHead();
    this._buildArms();
    this._buildToes();
    this._buildScutes();
    this._buildDebug();
    this._debugApplied = !this.debugSkeleton;
    this._syncDebugVisibility();
  }

  _clearVisuals() {
    const g = this.group;
    while (g.children.length > 0) g.remove(g.children[g.children.length - 1]);
    this._boneMeshes.length = 0;
    this._boneDebug.length = 0;
    this._jointMeshes.length = 0;
    this._debugJoints.length = 0;
    this._headParts.length = 0;
    this._torsoParts.length = 0;
    this._armParts.length = 0;
    this._toeParts.length = 0;
    this._scuteParts.length = 0;
  }

  /** Underside bones read lighter, as they do on the Chrome dino's belly. */
  _materialForBone(name) {
    return typeof name === 'string' && RE_BELLY.test(name) ? this.matBelly : this.matBody;
  }

  _buildBones() {
    const bones = this.world.bones || NO_BONES;
    for (let i = 0; i < bones.length; i++) {
      const bone = bones[i];
      const mesh = this._mesh(this._unitCyl, this._materialForBone(bone && bone.name), { receive: true });
      mesh.name = 'bone:' + (bone && bone.name ? bone.name : i);
      this._boneMeshes.push(mesh);
    }
  }

  _buildJoints() {
    const world = this.world;
    const count = Math.max(0, world.count | 0);
    const kind = new Uint8Array(count);
    const scales = new Float32Array(count);
    const bones = world.bones || NO_BONES;
    for (let i = 0; i < bones.length; i++) {
      const bone = bones[i];
      if (!bone) continue;
      if (bone.a >= 0 && bone.a < count) kind[bone.a] = 1;
      if (bone.b >= 0 && bone.b < count) kind[bone.b] = 1;
    }
    const radius = world.radius;
    const table = this._particleName;
    for (let i = 0; i < count; i++) {
      const name = table && table[i] ? table[i] : '';
      const r = radius && radius[i] > 0 ? radius[i] : DEFAULT_RADIUS;
      if (kind[i] === 0) {
        // Not a bone endpoint: usually a collision mid-node, which is a body part and
        // should get its sphere. Only a name that clearly says "solver scaffolding"
        // hides it, because a hidden rib node leaves a visible dent in the silhouette.
        if (RE_NOT_BODY.test(name)) { scales[i] = 0; kind[i] = 0; } else { kind[i] = 2; scales[i] = r * 0.85; }
      } else {
        // Feet and paws get a slightly fatter pad; everything else sits inside the
        // solver radius so joints never balloon past the capsule.
        let k = 0.94;
        if (RE_FOOT.test(name) || RE_ARM.test(name)) k = 1.18;
        else if (RE_HEAD.test(name)) k = 1.05;
        scales[i] = r * k;
      }
      const mesh = this._mesh(this._unitSphere, RE_BELLY.test(name) ? this.matBelly : this.matBody, {
        receive: true,
        visible: false,
      });
      mesh.name = 'joint:' + (name || i);
      this._jointMeshes.push(mesh);
    }
    this._jointKind = kind;
    this._jointScale = scales;
  }

  /**
   * The lighter belly. A skeleton rarely names a bone "belly", so the pale underside
   * is built explicitly: two slabs hung under the torso's own particles, slightly
   * narrower than the capsules so only the underside breaks the silhouette. This is
   * what makes the Chrome dino's pale venter read from the chase camera.
   */
  _buildBelly() {
    const radius = this.world.radius;
    const pelvis = this._particleAny(RE_PELVIS, ['pelvis', 'hip']);
    const chest = this._particleAny(RE_CHEST, ['chest']);
    const spots = [pelvis, chest].filter((p) => p >= 0).slice(0, 2);
    for (let i = 0; i < spots.length; i++) {
      const p = spots[i];
      const r = radius && radius[p] > 0 ? radius[p] : DEFAULT_RADIUS;
      const group = { bone: -1, particle: p, atParticle: p };
      this._addPart(this._torsoParts, group, this._unitBox, this.matBelly, {
        sx: r * 1.5, sy: r * 1.05, sz: r * 1.7,
        oy: -r * 0.62,
        lsx: 0.1, lsy: 0.12,
      });
    }
  }

  /**
   * Head furniture. The face is anchored on the head *particle* (not the midpoint of
   * whichever bone happens to mention a head, which on a `neck-head` bone would put
   * the eyes on the neck) and oriented along the head-to-snout axis when the skeleton
   * has one. Every size is a multiple of R, the head's own size, so the face scales
   * with whatever bulk the skeleton author gave the skull.
   */
  _buildHead() {
    const bones = this.world.bones || NO_BONES;
    const headParticle = this._particleAny(RE_HEAD, ['head', 'skull']);
    const snoutParticle = this._particleAny(RE_SNOUT, ['snout', 'nose']);

    // Best frame for a face: the bone that runs out to the snout, because that is the
    // muzzle axis. Failing that, any bone with the head on an end, preferring the one
    // that points forward. Failing that, whatever bone we can name.
    let frameBone = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < bones.length; i++) {
      const b = bones[i];
      if (!b) continue;
      const touchesHead = headParticle >= 0 && (b.a === headParticle || b.b === headParticle);
      const named = typeof b.name === 'string' && RE_HEAD.test(b.name);
      if (!touchesHead && !named) continue;
      let score = touchesHead ? 10 : 0;
      if (this._readBone(i)) {
        const forward = this._dx;
        // whichever end the head sits on, we want the axis pointing away from it
        const headIsA = headParticle >= 0 && b.a === headParticle;
        score += (headIsA ? forward : -forward) * 5;
      }
      if (named) score += 1;
      if (score > bestScore) { bestScore = score; frameBone = i; }
    }
    if (frameBone < 0) frameBone = this._boneAny(RE_HEAD);

    // R comes from the head's own radius, clamped against the head-to-snout reach so a
    // long muzzle does not get a tiny face and a stubby one does not get a giant one.
    let R = 0.15;
    const radius = this.world.radius;
    if (headParticle >= 0 && radius && radius[headParticle] > 0) {
      R = Math.min(0.26, Math.max(0.08, radius[headParticle] * 1.35));
    } else if (frameBone >= 0 && bones[frameBone]) {
      const b = bones[frameBone];
      const r0 = b.r0 > 0 ? b.r0 : 0.14;
      const r1 = b.r1 > 0 ? b.r1 : r0 * 0.8;
      R = Math.max(0.1, (r0 + r1) * 0.5);
    }
    let reach = 0;
    if (headParticle >= 0 && snoutParticle >= 0 && this.world.pos) {
      reach = Math.hypot(
        this.world.pos[snoutParticle * 3] - this.world.pos[headParticle * 3],
        this.world.pos[snoutParticle * 3 + 1] - this.world.pos[headParticle * 3 + 1],
        this.world.pos[snoutParticle * 3 + 2] - this.world.pos[headParticle * 3 + 2],
      );
      if (Number.isFinite(reach) && reach > 0.05) R = Math.max(R, Math.min(0.3, reach * 0.55));
    }
    this.headRadius = R;

    const group = {
      bone: frameBone >= 0 ? frameBone : this._anchor.bone,
      particle: headParticle >= 0 ? headParticle : this._anchor.particle,
      atParticle: headParticle >= 0 ? headParticle : -1,
    };
    this._headGroup = group;

    // Boxy skull around the head capsule. The capsule alone reads as a ball.
    this._addPart(this._headParts, group, this._unitBox, this.matBody, {
      sx: 1.5 * R, sy: 1.3 * R, sz: 1.5 * R,
      ox: 0.15 * R, oy: 0.05 * R,
      lsy: -0.09, lsz: 0.07, // dying: the head sags and spreads
    });
    // Boxy snout, off the snout bone when there is one, else off the head.
    this._addPart(this._headParts, group, this._unitBox, this.matBody, {
      bone: this._boneAny(RE_SNOUT),
      atParticle: snoutParticle >= 0 ? -1 : undefined,
      sx: 1.45 * R, sy: 0.76 * R, sz: 1.1 * R,
      ox: 1.25 * R, oy: -0.18 * R,
      lsy: -0.12, lsz: 0.08, lly: 0.12 * R,
    });
    // Lower jaw. Lighter material so the underside reads, and it drops open as the
    // dino goes limp.
    this._addPart(this._headParts, group, this._unitBox, this.matBelly, {
      bone: this._boneAny(RE_JAW),
      sx: 1.3 * R, sy: 0.32 * R, sz: 0.92 * R,
      ox: 1.0 * R, oy: -0.62 * R,
      lsx: 0.1, lsy: 0.35, lly: 0.2 * R, // slack jowls
    });

    this._buildEyes(group, R);

    // Nostrils, just above the snout's top face.
    for (let s = -1; s <= 1; s += 2) {
      this._addPart(this._headParts, group, this._unitSphere, this.matDark, {
        sx: 0.1 * R, sy: 0.09 * R, sz: 0.1 * R,
        ox: 1.85 * R, oy: 0.22 * R, oz: s * 0.3 * R,
        lly: 0.06 * R,
      });
    }
  }

  _buildEyes(group, R) {
    // Eye bones win when present: the whites then genuinely follow the skull
    // through the solver, so the eyes roll with the head on death.
    const eyeBones = this._bonesMatching(RE_EYE);
    const eyeParticles = this._particlesMatching(RE_EYE);
    if (eyeBones.length >= 2) {
      this._addEye(group, R, 1, { bone: eyeBones[0] });
      this._addEye(group, R, -1, { bone: eyeBones[1] });
      return;
    }
    if (eyeParticles.length >= 2) {
      this._addEye(group, R, 1, { particle: eyeParticles[0] });
      this._addEye(group, R, -1, { particle: eyeParticles[1] });
      return;
    }
    this._addEye(group, R, 1, null);
    this._addEye(group, R, -1, null);
  }

  _addEye(group, R, side, override) {
    const ov = override || {};
    const ownFrame = (typeof ov.bone === 'number' && ov.bone >= 0)
      || (typeof ov.particle === 'number' && ov.particle >= 0);
    // When the skeleton gives us eye bones/particles, that anchor is already close to
    // the socket, so only a modest bias is added. It is deliberately not zero: the
    // whites must still read as front-top of the skull even if the author parked the
    // particle at the centre of the head, and must clear the skull box to be visible.
    const out = (ownFrame ? 0.42 : 0.66) * R;
    const up = (ownFrame ? 0.28 : 0.6) * R;
    const fwd = (ownFrame ? 0.3 : 0.6) * R;
    const spec = { bone: ov.bone, particle: ov.particle };

    // White: a flat-shaded sphere deliberately bulging out of the skull box.
    this._addPart(this._headParts, group, this._unitSphere, this.matEye, {
      ...spec,
      sx: 0.5 * R, sy: 0.5 * R, sz: 0.5 * R,
      ox: fwd, oy: up, oz: side * out,
      lsx: 0.18, lsy: 0.18, lsz: 0.18, // dying: eyes go loose and wide
    });
    // Pupil on the outer-front of the white, so it stays near the front-top of the
    // skull from the camera. Limp pushes it further out and drops it: wide and slack.
    this._addPart(this._headParts, group, this._unitSphere, this.matDark, {
      ...spec,
      sx: 0.26 * R, sy: 0.26 * R, sz: 0.26 * R,
      ox: fwd + 0.24 * R, oy: up + 0.04 * R, oz: side * (out + 0.13 * R),
      lox: 0.07 * R, lly: -0.06 * R, lsx: 0.1, lsy: 0.1, lsz: 0.1,
    });
    // Brow ridge. This is the bit that makes a rectangle look grumpy.
    this._addPart(this._headParts, group, this._unitBox, this.matBody, {
      ...spec,
      sx: 0.56 * R, sy: 0.16 * R, sz: 0.44 * R,
      ox: fwd + 0.1 * R, oy: up + 0.3 * R, oz: side * out,
      lly: -0.05 * R, lsx: 0.06,
    });
  }

  /**
   * Vestigial arms against the chest. They follow arm/hand bones when the skeleton
   * has them and otherwise hang off the chest as fixed stubs, because a T-Rex
   * without tiny arms is just a lizard.
   */
  _buildArms() {
    const chestBone = this._boneAny(RE_CHEST);
    const chestParticle = this._particleAny(RE_CHEST, ['chest']);
    const group = {
      bone: chestBone >= 0 ? chestBone : this._anchor.bone,
      particle: chestParticle >= 0 ? chestParticle : this._anchor.particle,
    };

    // Legs must never be mistaken for arms, so limb names are excluded.
    const armBones = this._bonesMatching(RE_ARM, RE_LEGISH);
    const count = Math.min(armBones.length, 2);
    for (let k = 0; k < count; k++) {
      // Upper arm as a slim capsule laid along the bone itself, so it is driven
      // straight by the solver.
      this._addPart(this._armParts, group, this._unitCyl, this.matBody, {
        bone: armBones[k],
        followBone: true,
        sx: 0.05, sy: 0.16, sz: 0.05,
        lsx: 0.12,
      });
    }
    for (let k = count; k < 2; k++) {
      // Fixed stubs keep two arms in the silhouette on a legs-only skeleton. The
      // chest bone's midpoint is the torso, so these sit just ahead of and below it.
      const side = k === 0 ? 1 : -1;
      this._addPart(this._armParts, group, this._unitCyl, this.matBody, {
        axisDir: [0.55, -0.75, side * 0.36],
        sx: 0.052, sy: 0.2, sz: 0.052,
        ox: 0.055, oy: -0.016, oz: side * 0.067,
        lsx: 0.14,
      });
      // A two-claw hand at the end of each stub, so the arm does not end in a rod.
      for (let s = -1; s <= 1; s += 2) {
        this._addPart(this._armParts, group, this._unitCone, this.matDark, {
          axisDir: [0.7, -0.5, s * 0.5],
          sx: 0.02, sy: 0.05, sz: 0.02,
          ox: 0.12, oy: -0.1, oz: side * 0.075 + s * 0.022,
        });
      }
    }

    // Paws and claws on real hand bones when they exist.
    const hands = this._particlesMatching(/hand|wrist/).slice(0, 2);
    for (let k = 0; k < hands.length; k++) {
      const pg = { bone: -1, particle: hands[k], atParticle: -1 };
      this._addPart(this._armParts, pg, this._unitSphere, this.matBody, {
        sx: 0.055, sy: 0.05, sz: 0.055,
        ox: 0.02, oy: -0.03,
        lsx: 0.15,
      });
      for (let s = -1; s <= 1; s += 2) {
        this._addPart(this._armParts, pg, this._unitCone, this.matDark, {
          axisDir: [0.7, -0.5, s * 0.5],
          sx: 0.02, sy: 0.05, sz: 0.02,
          ox: 0.05, oy: -0.05, oz: s * 0.025,
        });
      }
    }
  }

  /** Three splayed toes per foot, each following its foot bone's frame. */
  _buildToes() {
    const feet = this._particlesMatching(RE_FOOT).slice(0, 3);
    const radius = this.world.radius;
    const footBones = this._bonesMatching(RE_FOOT);
    for (let f = 0; f < feet.length; f++) {
      const p = feet[f];
      const r = radius && radius[p] > 0 ? radius[p] : DEFAULT_RADIUS;
      const toeLen = Math.min(0.22, Math.max(0.08, r * 2.4));
      const toeR = Math.min(0.05, Math.max(0.018, r * 0.5));
      const group = { bone: f < footBones.length ? footBones[f] : -1, particle: p, atParticle: p };
      for (let t = 0; t < 3; t++) {
        const splay = (t - 1) * 0.5; // middle toe points straight ahead
        const dir = this._normalizeTo([0.85, -0.32, splay * 0.5]);
        this._addPart(this._toeParts, group, this._unitCyl, this.matBody, {
          axisDir: dir,
          sx: toeR, sy: toeLen, sz: toeR,
          ox: toeLen * 0.45, oy: -r * 0.55, oz: splay * r * 0.75,
          lsx: 0.14,
        });
        // Dark claw at the tip, curving down off the same direction.
        this._addPart(this._toeParts, group, this._unitCone, this.matDark, {
          axisDir: this._normalizeTo([dir[0], dir[1] - 0.35, dir[2]]),
          sx: toeR * 0.55, sy: toeLen * 0.45, sz: toeR * 0.55,
          ox: toeLen * 0.95, oy: -r * 0.62, oz: splay * r * 0.95,
        });
      }
    }
  }

  /** Build-time helper: normalise a local direction, falling back to +X. */
  _normalizeTo(d) {
    const n = Math.sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]);
    if (!(n > 1e-6)) return [1, 0, 0];
    return [d[0] / n, d[1] / n, d[2] / n];
  }

  /**
   * Back scutes along the spine. Each plate stands on the bone's local up, and its
   * height scales with how much of world up that local up still carries, so the
   * crest is tall along the back and flattens out along the tail and belly.
   */
  _buildScutes() {
    const picks = this._bonesMatching(RE_SPINE, RE_LIMB, spinePriority).slice(0, 12);
    const bones = this.world.bones || NO_BONES;
    for (let k = 0; k < picks.length; k++) {
      const bi = picks[k];
      const bone = bones[bi];
      const r = bone && bone.r0 > 0 ? bone.r0 : 0.09;
      const size = Math.min(0.13, Math.max(0.035, r * 0.72));
      this._addPart(this._scuteParts, { bone: bi, particle: -1 }, this._unitCone, this.matDark, {
        axisDir: [0, 1, 0],
        tilt: -0.45, // lean back, away from the direction of travel
        sx: size * 0.62, sy: size, sz: size * 0.9,
        seat: r * 0.9, // sits on the bone surface along the bone's local up
        lsy: -0.34, // dying: the crest goes flat
        lsx: 0.18,
      });
    }
  }

  _buildDebug() {
    const bones = this.world.bones || NO_BONES;
    for (let i = 0; i < bones.length; i++) {
      const m = this._mesh(this._debugCyl, this._matDebugBone, { visible: false });
      m.name = 'dbg-bone:' + i;
      this._boneDebug.push(m);
    }
    for (let i = 0; i < this._jointMeshes.length; i++) {
      const m = this._mesh(this._debugSphere, this._matDebugJoint, { visible: false });
      m.name = 'dbg-particle:' + i;
      this._debugJoints.push(m);
    }
  }

  /**
   * Register a rigid child of a bone frame. Offsets and sizes are in the parent
   * frame (x forward, y up, z left). `l*` fields are per-unit-limp deltas: what the
   * part adds to its own scale or offset at limp = 1, which keeps setLimp a couple
   * of multiplies per part instead of a second pass over the whole body.
   */
  _addPart(list, group, geom, mat, spec) {
    const mesh = this._mesh(geom, mat, {
      receive: mat === this.matBody || mat === this.matBelly,
    });
    let axisQ = null;
    if (spec.axisDir) {
      const d = spec.axisDir;
      const n = Math.sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]) || 1;
      axisQ = this._qFromUnitY(d[0] / n, d[1] / n, d[2] / n);
    } else if (spec.tilt) {
      axisQ = this._qAxisAngle(0, 0, 1, spec.tilt);
    }
    // An explicit anchor (bone or particle) fully owns the part's frame. Inheriting
    // the group bone in that case would silently pin e.g. an eye back to the skull
    // and throw away the socket the solver gave us.
    const ownBone = typeof spec.bone === 'number' && spec.bone >= 0 ? spec.bone : -1;
    const ownParticle = typeof spec.particle === 'number' && spec.particle >= 0 ? spec.particle : -1;
    const hasOwn = ownBone >= 0 || ownParticle >= 0;
    list.push({
      mesh,
      frameBone: hasOwn ? ownBone : group.bone,
      // A part with its own bone must not fall back to the group particle, or a dead
      // bone would drag the part to the anchor instead of hiding it.
      frameParticle: hasOwn ? ownParticle : group.particle,
      atParticle: spec.atParticle >= 0 ? spec.atParticle : (group.atParticle >= 0 ? group.atParticle : -1),
      followBone: spec.followBone === true,
      ox: spec.ox ?? 0, oy: spec.oy ?? 0, oz: spec.oz ?? 0,
      lox: spec.lox ?? 0, lly: spec.lly ?? 0, loz: spec.loz ?? 0,
      sx: spec.sx ?? 1, sy: spec.sy ?? 1, sz: spec.sz ?? 1,
      lsx: spec.lsx ?? 0, lsy: spec.lsy ?? 0, lsz: spec.lsz ?? 0,
      seat: spec.seat ?? 0,
      axisQ,
    });
  }

  // ---------------------------------------------------------------- update

  /**
   * Place every visual from the solver. `ctx` is accepted for API symmetry with the
   * other renderers but deliberately unused: the body is driven straight from
   * world.pos, which is the more honest source while the ragdoll is tumbling.
   * Allocation-free: field writes, position.set, quaternion.copy/set, scale.set.
   */
  update(ctx) {
    void ctx;
    const world = this.world;
    if (!world || !world.pos) return;
    const bones = world.bones || NO_BONES;

    // Bones appearing after construction means we were built too early. The count
    // compare keeps the steady state at one integer test per frame. We deliberately
    // do not return after rebuilding: placing the fresh meshes now avoids a one-frame
    // pop of everything sitting at the origin.
    if (bones.length !== this._builtBoneCount && ++this._rebuildTick > 30) {
      this._rebuildTick = 0;
      this.rebuild();
    }

    const limp = this.limp;
    const fat = 1 + 0.1 * limp; // slack flesh spreads sideways...
    const short = 1 - 0.045 * limp; // ...and the body settles toward the ground

    this._updateBones(bones, fat, short);
    this._updateJoints(fat);
    this._updateParts(this._torsoParts, limp);
    this._updateParts(this._headParts, limp);
    this._updateParts(this._armParts, limp);
    this._updateParts(this._toeParts, limp);
    this._updateScutes(limp);

    if (this.debugSkeleton !== this._debugApplied) {
      this._debugApplied = this.debugSkeleton;
      this._syncDebugVisibility();
    }
    if (this.debugSkeleton) this._updateDebug(bones);
  }

  _updateBones(bones, fat, short) {
    const list = this._boneMeshes;
    for (let i = 0; i < list.length; i++) {
      const mesh = list[i];
      if (i >= bones.length || !this._readBone(i)) {
        mesh.visible = false;
        continue;
      }
      const bone = bones[i];
      const r0 = bone.r0 > 0 ? bone.r0 : 0.09;
      const r1 = bone.r1 > 0 ? bone.r1 : 0.06;
      mesh.visible = true;
      mesh.position.set(this._mx, this._my, this._mz);
      // Capsules need no roll, so the cheap minimal-twist form is enough here; the
      // full basis is only paid for by the parts that actually need a "up".
      this._setQFromUnitY(this._qAxis, this._dx, this._dy, this._dz);
      mesh.quaternion.copy(this._qAxis);
      // Unit cylinder: the +Y cap is the b particle, so r1 is the far radius.
      mesh.scale.set(r0 * 2 * fat, this._len * short, r1 * 2 * fat);
    }
  }

  _updateJoints(fat) {
    const pos = this.world.pos;
    const kind = this._jointKind;
    const scales = this._jointScale;
    if (!kind || !scales || !pos) return;
    const dbg = this.debugSkeleton;
    for (let i = 0; i < this._jointMeshes.length; i++) {
      const mesh = this._jointMeshes[i];
      const b = i * 3;
      const x = pos[b], y = pos[b + 1], z = pos[b + 2];
      if (kind[i] === 0 || !(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z))) {
        mesh.visible = false;
        if (dbg) this._debugJoints[i].visible = false;
        continue;
      }
      const s = scales[i] * fat;
      mesh.visible = true;
      mesh.position.set(x, y, z);
      mesh.scale.set(s, s, s);
      if (dbg) {
        const d = this._debugJoints[i];
        d.visible = true;
        d.position.set(x, y, z);
        const ds = scales[i] * 0.55;
        d.scale.set(ds, ds, ds);
      }
    }
  }

  _updateParts(list, limp) {
    for (let i = 0; i < list.length; i++) {
      const part = list[i];
      const mesh = part.mesh;
      if (!this._frameFor(part)) {
        mesh.visible = false;
        continue;
      }
      mesh.visible = true;
      const v = this._posV.set(
        part.ox + part.lox * limp,
        part.oy + part.lly * limp,
        part.oz + part.loz * limp,
      ).applyQuaternion(this._qBody);
      mesh.position.set(this._midV.x + v.x, this._midV.y + v.y, this._midV.z + v.z);
      if (part.followBone) {
        // Stretch along the bone and orient by minimal twist, so solver-driven limbs
        // track their bone's length instead of being a fixed-length stub.
        this._setQFromUnitY(this._qAxis, this._dx, this._dy, this._dz);
        mesh.quaternion.copy(this._qAxis);
        mesh.scale.set(part.sx * (1 + part.lsx * limp), this._len, part.sz * (1 + part.lsz * limp));
        continue;
      }
      mesh.quaternion.copy(this._qBody);
      if (part.axisQ) mesh.quaternion.multiply(part.axisQ);
      mesh.scale.set(
        part.sx * (1 + part.lsx * limp),
        part.sy * (1 + part.lsy * limp),
        part.sz * (1 + part.lsz * limp),
      );
    }
  }

  _updateScutes(limp) {
    const list = this._scuteParts;
    for (let i = 0; i < list.length; i++) {
      const part = list[i];
      const mesh = part.mesh;
      if (!this._bodyFrame(part.frameBone)) {
        mesh.visible = false;
        continue;
      }
      const up = this._uy > 0 ? this._uy : 0;
      // Stand the plate on the bone's surface along its local up, and let its
      // height follow that same up: crest on the back, flat on the tail.
      const v = this._posV.set(part.ox, part.seat * (0.45 + 0.75 * up), part.oz)
        .applyQuaternion(this._qBody);
      mesh.visible = true;
      mesh.position.set(this._midV.x + v.x, this._midV.y + v.y, this._midV.z + v.z);
      mesh.quaternion.copy(this._qBody);
      if (part.axisQ) mesh.quaternion.multiply(part.axisQ);
      const grow = 0.35 + 0.65 * up;
      mesh.scale.set(
        part.sx * (1 + part.lsx * limp) * grow,
        part.sy * (1 + part.lsy * limp) * grow,
        part.sz * (1 + part.lsz * limp) * grow,
      );
    }
  }

  _updateDebug(bones) {
    for (let i = 0; i < this._boneDebug.length; i++) {
      const d = this._boneDebug[i];
      if (i >= bones.length || !this._readBone(i)) { d.visible = false; continue; }
      d.visible = true;
      d.position.set(this._mx, this._my, this._mz);
      this._setQFromUnitY(this._qAxis, this._dx, this._dy, this._dz);
      d.quaternion.copy(this._qAxis);
      d.scale.set(0.012, this._len * 1.02, 0.012);
    }
  }

  _syncDebugVisibility() {
    const on = this.debugSkeleton === true;
    for (let i = 0; i < this._boneDebug.length; i++) this._boneDebug[i].visible = on;
    if (!on) {
      for (let i = 0; i < this._debugJoints.length; i++) this._debugJoints[i].visible = false;
    }
  }

  // ------------------------------------------------------------- public API

  /** Recolour the body. Belly, eyes and darks are derived, so one call is enough. */
  setColor(hex) {
    this._baseColor.set(hex);
    this.matBody.color.copy(this._baseColor);
    this.matBelly.color.copy(this._baseColor).lerp(this._white, BELLY_LIFT);
    this.matDark.color.copy(this._baseColor).lerp(this._black, DARK_MIX);
    // Eyes stay near-white; a fully tinted eyeball reads as an injury.
    this.matEye.color.copy(this._baseColor).lerp(this._white, 0.92);
  }

  /** 0 = alive and taut, 1 = fully slack. Deliberately subtle, not cartoonish. */
  setLimp(v) {
    this.limp = clamp01(typeof v === 'number' && Number.isFinite(v) ? v : 0);
  }

  dispose() {
    this._clearVisuals();
    if (this.group.parent) this.group.parent.remove(this.group);
    if (this.scene && typeof this.scene.remove === 'function' && !this.group.parent) {
      this.scene.remove(this.group);
    }
    for (const g of this._geoms) {
      if (g && typeof g.dispose === 'function') g.dispose();
    }
    for (const m of this._mats) {
      if (m && typeof m.dispose === 'function') m.dispose();
    }
    this._geoms.clear();
    this._mats.clear();
    this._jointKind = null;
    this._jointScale = null;
    this._builtBoneCount = -1;
  }
}
