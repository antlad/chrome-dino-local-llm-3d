// Camera rig: the "you can play with camera" feature.
//
// One spherical rig drives every mode. A mode only describes a *desired pose*
// (yaw / pitch / distance / look-at / fov / roll) and the rig springs toward it.
// Keeping the smoothing in pose space rather than in world coordinates is what
// stops mode changes reading as cuts: a switch from chase to top is a move, not
// a teleport, and the look-at can lag the dino (that lag is the whole feel of a
// platformer camera) without the camera ever drifting off its own accreted error.
//
// Pointer "play" layers on top of any mode: dragging adds a user yaw/pitch/zoom
// offset (right-drag or shift-drag pans). In the auto modes that offset eases
// back to zero over ~1.5s; in `free` and `orbit` the user is the camera, so it
// persists until resetView().
import * as THREE from '../../vendor/three.module.js';

export const CAMERA_MODES = ['chase', 'side', 'low', 'orbit', 'top', 'corpse', 'free'];

/** Modes where the user's drag offset *is* the camera, so it must persist. */
const PERSISTING = new Set(['free', 'orbit']);
/** Modes the death cam is allowed to hijack. */
const AUTO_MODES = new Set(['chase', 'side', 'low', 'top', 'orbit']);
/** States that mean "the run is over, play the death cam". */
const DEAD_STATES = new Set(['dying', 'dead']);
/** States that mean the run is live again and the camera belongs to the mode. */
const LIVE_STATES = new Set(['menu', 'ready', 'running']);

const MIN_Y = 0.25; // never go under the sand
const MIN_DIST = 1.2;
const MAX_DIST = 18;
const FOV_MIN = 50;
const FOV_MAX = 95;
const FREE_PITCH_LIMIT = 1.40; // ~80deg: clears the poles, so no gimbal flip
const DEG = Math.PI / 180;
const SHAKE_ROLL = 0.05;
const SHAKE_TILT = 0.035;

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function wrapPi(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function finite(v, fallback) {
  return Number.isFinite(v) ? v : fallback;
}

/**
 * Frame-rate independent exponential approach. alpha = 1 - exp(-rate*dt) makes
 * `rate` a physical property (an inverse time constant) instead of a per-frame
 * fudge factor that only behaves at 60fps. Used for the inputs we differentiate
 * (speed, heading), where a spring would add overshoot we do not want.
 */
export function damp(current, target, rate, dt) {
  if (!(rate > 0) || !(dt > 0)) return current;
  const alpha = 1 - Math.exp(-rate * dt);
  return current + (target - current) * alpha;
}

/**
 * Scalar critically damped spring, integrated in closed form.
 *
 * For x'' = -2w x' - w^2 (x - target), over a step dt with constant target:
 *   E   = exp(-w dt)
 *   e'  = (e + (v + w e) dt) E
 *   v'  = (v - w (v + w e) dt) E
 * Exact for a constant target, so a 30fps frame and four 120fps frames land on
 * the same pose. Critically damped means it arrives as fast as possible without
 * overshooting, which is what "no snap, no jitter, no drift" actually requires:
 * position AND velocity are continuous, so a retarget mid-flight is a curve, not
 * a cut. `wrap` folds the error through PI so yaw takes the short way round.
 */
export class CritSpring {
  constructor(value = 0, { omega = 8, wrap = false } = {}) {
    this.x = value;
    this.v = 0;
    this.target = value;
    this.omega = omega;
    this.wrap = wrap;
  }

  /** Teleport: value, velocity and target all agree, so nothing can drift. */
  set(value) {
    this.x = value;
    this.v = 0;
    this.target = value;
  }

  /** Impulse, used for the death cam's swing-around. */
  kick(velocity) {
    this.v += velocity;
  }

  step(dt) {
    const w = this.omega;
    if (!(w > 0) || !(dt > 0)) return this.x;
    const e = this.wrap ? wrapPi(this.x - this.target) : this.x - this.target;
    const decay = Math.exp(-w * dt);
    const temp = (this.v + w * e) * dt;
    this.x = this.target + (e + temp) * decay;
    this.v = (this.v - w * temp) * decay;
    if (!Number.isFinite(this.x)) {
      this.x = finite(this.target, 0);
      this.v = 0;
    }
    if (!Number.isFinite(this.v)) this.v = 0;
    return this.x;
  }
}

export class CameraRig {
  constructor({ THREE: T = THREE, camera, opts = {} } = {}) {
    if (!camera) throw new Error('CameraRig needs a camera');
    this.THREE = T;
    this.camera = camera;
    this.opts = {
      sensitivity: 1,
      userEaseTime: 1.5, // auto modes hand the drag offset back over this long
      userFollowRate: 20, // how briskly the drag offset tracks the pointer
      positionOmega: 8.5,
      targetOmega: 7.0,
      fovOmega: 6,
      rollOmega: 5.5,
      viewportWidth: 1280,
      viewportHeight: 800,
      sideFrameX: 0.35, // dino sits at 35% of screen width in side mode
      orbitSpeed: 0.22, // rad/s of the automatic orbit
      corpseOrbitSpeed: 0.16, // rad/s of the slow drift around the ragdoll
      ...opts,
    };

    this.mode = 'chase';
    this.userTouched = false;
    this._preCorpseMode = 'chase';
    this._autoCorpse = false;

    // Smoothed pose. Position lives in spherical space around the look-at, so
    // every mode is expressible and every transition is a single arc.
    this.yaw = new CritSpring(Math.PI - 0.3, { omega: this.opts.positionOmega, wrap: true });
    this.pitch = new CritSpring(0.3, { omega: this.opts.positionOmega });
    this.dist = new CritSpring(4.6, { omega: this.opts.positionOmega });
    this.fov = new CritSpring(62, { omega: this.opts.fovOmega });
    this.roll = new CritSpring(0, { omega: this.opts.rollOmega });

    this.target = new THREE.Vector3(0, 1, 0);
    this._targetX = new CritSpring(0, { omega: this.opts.targetOmega });
    this._targetY = new CritSpring(1, { omega: this.opts.targetOmega });
    this._targetZ = new CritSpring(0, { omega: this.opts.targetOmega });

    // User "play" offsets, layered on top of the mode pose. Dragging never
    // writes the pose directly, it writes these, which is why releasing the
    // pointer can be an ease instead of a snap.
    this._uYaw = new CritSpring(0, { omega: this.opts.userFollowRate, wrap: true });
    this._uPitch = new CritSpring(0, { omega: this.opts.userFollowRate });
    this._uDist = new CritSpring(0, { omega: this.opts.userFollowRate });
    this._uPanF = new CritSpring(0, { omega: this.opts.userFollowRate }); // forward
    this._uPanY = new CritSpring(0, { omega: this.opts.userFollowRate }); // up
    // ~1% of the offset left after userEaseTime seconds.
    this._easeOmega = 6.6 / Math.max(0.3, this.opts.userEaseTime);
    this._dragging = false;
    this._dragPan = false;
    this._lastX = 0;
    this._lastY = 0;

    // Base pose for `free` only. The user offsets sit on top of it, so a
    // "recenter" is one resetView() rather than reconstructing a pose.
    this._baseYaw = Math.PI - 0.4;
    this._basePitch = 0.26;
    this._baseDist = 5.2;
    this._orbitAngle = Math.PI * 0.5; // orbit mode's own slow spin
    this._corpseYaw = Math.PI * 0.75;

    // The mode's own pose before user offsets, remembered for the input handlers
    // so clamping a drag or a wheel never reads back a clamped value and ratchets.
    this._poseDist = 5.6;
    this._posePitch = 0.3;

    // Impact shake: decaying, rotation only, so it never fights the framing.
    this._shake = new CritSpring(0, { omega: 7 });
    this._prevHitFlash = 0;
    this._time = 0;
    this._prevHeading = 0;
    this._headingRate = 0;
    this._speedSmooth = 0;
    this._world = null;
    this._worldSeen = null;
    this._headIndex = -1;

    // Scratch vectors and the one reusable pose record. Nothing in update()
    // allocates: the game is meant to hold 60fps on a laptop iGPU.
    this._camPos = new THREE.Vector3();
    this._look = new THREE.Vector3();
    this._head = { x: 0, y: 1, z: 0 };
    this._pose = {
      yaw: 0, pitch: 0, dist: 5, fov: 62, roll: 0,
      tx: 0, ty: 1, tz: 0,
      distLo: MIN_DIST, distHi: MAX_DIST,
      pitchLo: -1.2, pitchHi: 1.2,
      bobX: 0, bobY: 0, bobZ: 0,
    };
  }

  // ---------------------------------------------------------------- public API

  setMode(name) {
    if (!CAMERA_MODES.includes(name) || name === this.mode) return this.mode;
    const toPersistent = PERSISTING.has(name);
    if (name !== 'corpse') this._autoCorpse = false;

    // Entering a user-owned mode has to be continuous, so the smoothed pose is
    // handed over as that mode's base instead of snapping to its defaults.
    // Leaving one needs nothing: _stepUserSprings eases the offsets back down.
    if (toPersistent) {
      if (name === 'free') {
        this._baseYaw = wrapPi(this.yaw.x);
        this._basePitch = clamp(this.pitch.x, -FREE_PITCH_LIMIT, FREE_PITCH_LIMIT);
        this._baseDist = clamp(this.dist.x, MIN_DIST, MAX_DIST);
        this._uYaw.set(0);
        this._uPitch.set(0);
        this._uDist.set(0);
      } else {
        // orbit owns its yaw; pitch and zoom stay relative to the user
        this._orbitAngle = wrapPi(this.yaw.x - this._uYaw.x);
      }
    }

    if (name === 'corpse') this._enterCorpse();
    this.mode = name;
    return this.mode;
  }

  cycle(dir = 1) {
    const step = dir >= 0 ? 1 : -1;
    const i = CAMERA_MODES.indexOf(this.mode);
    const next = CAMERA_MODES[(i + step + CAMERA_MODES.length) % CAMERA_MODES.length];
    return this.setMode(next);
  }

  /** `mods` is optional: { button, shiftKey }. button 2 or shift means pan. */
  pointerDown(x, y, mods) {
    this._dragging = true;
    this._dragPan = !!mods && (mods.button === 2 || mods.shiftKey === true);
    this._lastX = finite(x, 0);
    this._lastY = finite(y, 0);
    this.userTouched = true;
  }

  pointerMove(x, y, mods) {
    if (!this._dragging) return;
    const nx = finite(x, this._lastX);
    const ny = finite(y, this._lastY);
    const dx = nx - this._lastX;
    const dy = ny - this._lastY;
    this._lastX = nx;
    this._lastY = ny;
    if (mods) this._dragPan = mods.button === 2 || mods.shiftKey === true;

    const height = Math.max(1, this.opts.viewportHeight);
    if (this._dragPan) {
      // Grab the world: the look-at moves against the pointer, scaled by how
      // far away it is so a pan feels like the same physical distance at any zoom.
      const scale = (this.dist.x / height) * 1.8;
      this._uPanF.target -= dx * scale;
      this._uPanY.target += dy * scale;
      this._clampPanTargets();
    } else {
      // Grab the world: dragging right swings the world right, down tilts up.
      const k = (2.6 / height) * clamp(this.opts.sensitivity, 0.1, 5);
      this._uYaw.target -= dx * k;
      this._uPitch.target += dy * k;
      this._clampPitchTargets();
    }
    this.userTouched = true;
  }

  pointerUp() {
    if (!this._dragging) return;
    this._dragging = false;
    this._dragPan = false;
    if (!PERSISTING.has(this.mode)) {
      for (const sp of [this._uYaw, this._uPitch, this._uDist, this._uPanF, this._uPanY]) {
        sp.target = 0;
      }
    }
  }

  /** Wheel: dolly. Smoothing is the distance spring, so this stays a velocity. */
  wheel(deltaY) {
    if (!Number.isFinite(deltaY)) return;
    // Rate against the *resting* distance, never the animated one: scaling by
    // this.dist.x would make scroll-out faster than scroll-in and the wheel
    // would not round-trip.
    const base = this.mode === 'free' ? this._baseDist : this._poseDist;
    const amount = clamp(deltaY, -240, 240) * 0.0016 * clamp(base, MIN_DIST, MAX_DIST);
    const lo = MIN_DIST - base;
    const hi = MAX_DIST - base;
    const next = clamp(this._uDist.target + amount, Math.min(0, lo), Math.max(0, hi));
    this._uDist.target = next;
    this.userTouched = true;
  }

  /** Recentre: drop every user offset and hand the camera back to the mode. */
  resetView() {
    this._uYaw.set(0);
    this._uPitch.set(0);
    this._uDist.set(0);
    this._uPanF.set(0);
    this._uPanY.set(0);
    this._baseYaw = Math.PI - 0.4;
    this._basePitch = 0.26;
    this._baseDist = 5.2;
    this._shake.set(0);
    this.userTouched = false;
  }

  setSensitivity(v) {
    if (Number.isFinite(v)) this.opts.sensitivity = clamp(v, 0.1, 5);
  }

  setViewport(w, h) {
    if (Number.isFinite(w) && w > 0) this.opts.viewportWidth = w;
    if (Number.isFinite(h) && h > 0) this.opts.viewportHeight = h;
  }

  debugInfo() {
    return {
      mode: this.mode,
      yaw: wrapPi(this.yaw.x),
      pitch: this.pitch.x,
      distance: this.dist.x,
      fov: this.fov.x,
      userTouched: this.userTouched,
    };
  }

  // -------------------------------------------------------------------- update

  update(dt, ctx) {
    const step = clamp(finite(dt, 1 / 60), 0, 0.1);
    if (step <= 0) return;
    this._time += step;

    const c = ctx || {};
    const dino = c.dino || {};
    this._world = dino.world || null;
    const pos = dino.pos || c.dino || {};
    const pelvisX = finite(pos.x, 0);
    const pelvisY = clamp(finite(pos.y, 0.95), 0.2, 6);
    const pelvisZ = clamp(finite(pos.z, 0), -4, 4);
    const vel = dino.vel || { x: 0, y: 0, z: 0 };
    const speedNormRaw = clamp(finite(c.speedNorm, 0), 0, 1);
    const speed = clamp(finite(c.speed, 0), 0, 60);
    const distance = finite(c.distance, 0);
    const state = c.state || 'running';
    const grounded = c.grounded !== false;

    // Inputs we differentiate are low-passed first, or a noisy solver shows up
    // as a noisy camera. damp() keeps that filter frame-rate independent.
    this._speedSmooth = damp(this._speedSmooth, speedNormRaw, 5, step);
    this._trackHeading(dino.heading, step);
    this._driveShake(step, c.hitFlash);
    this._autoCorpseCam(state);
    if (this.mode === 'orbit' && !this._dragging) {
      this._orbitAngle = wrapPi(this._orbitAngle + this.opts.orbitSpeed * step);
    }
    if (this.mode === 'corpse' && !this._dragging) {
      this._corpseYaw = wrapPi(this._corpseYaw + this.opts.corpseOrbitSpeed * step);
    }

    const s = this._pose;
    this._fillPose(this.mode, s, {
      pelvisX, pelvisY, pelvisZ, vel, speed, distance, grounded, state,
      speedNorm: this._speedSmooth,
    });

    // Pointer offsets go on top of the mode pose, then everything is clamped
    // into legal space before it reaches the springs: clamping the springs'
    // targets (not their outputs) is what keeps the motion smooth.
    this._poseDist = clamp(s.dist, MIN_DIST, MAX_DIST);
    this._posePitch = s.pitch;
    const dist = clamp(s.dist + this._uDist.x,
      Math.max(MIN_DIST, s.distLo), Math.min(MAX_DIST, s.distHi));
    const tx = s.tx + this._uPanF.x;
    const ty = clamp(s.ty + this._uPanY.x, 0.1, 8);
    const tz = s.tz;

    // Keep the camera out of the sand by limiting pitch, rather than clipping
    // the position afterwards, which would read as the camera sliding along
    // the floor. sin(pitch) >= (floor - targetY) / distance.
    const sandPitch = Math.asin(clamp((MIN_Y + 0.08 - ty) / Math.max(0.5, dist), -1, 1));
    const pitch = clamp(s.pitch + this._uPitch.x, Math.max(sandPitch, s.pitchLo), s.pitchHi);

    this._stepUserSprings(step);
    const followOmega = this._dragging ? 12 : this.opts.positionOmega;
    this.yaw.omega = followOmega;
    this.yaw.target = s.yaw + this._uYaw.x;
    this.pitch.omega = followOmega;
    this.pitch.target = pitch;
    this.dist.omega = this._dragging ? 12 : this.opts.positionOmega;
    this.dist.target = dist;
    this.fov.target = clamp(s.fov, FOV_MIN, FOV_MAX);
    this.roll.target = s.roll;
    this._targetX.target = tx;
    this._targetY.target = ty;
    this._targetZ.target = tz;

    this.yaw.step(step);
    this.pitch.step(step);
    this.dist.step(step);
    this.fov.step(step);
    this.roll.step(step);
    this._targetX.step(step);
    this._targetY.step(step);
    this._targetZ.step(step);

    // Camera basis from the smoothed pose.
    const tx2 = this._targetX.x;
    const ty2 = this._targetY.x;
    const tz2 = this._targetZ.x;
    const cosP = Math.cos(this.pitch.x);
    this._camPos.set(
      tx2 + this.dist.x * cosP * Math.cos(this.yaw.x),
      ty2 + this.dist.x * Math.sin(this.pitch.x),
      tz2 + this.dist.x * cosP * Math.sin(this.yaw.x),
    );
    this._look.set(tx2, ty2, tz2);

    this._frameClamp(pelvisX, pelvisY, pelvisZ);
    this.target.copy(this._look);

    // Handheld bob rides on the camera only, so the view direction stays put,
    // and it is sampled against ctx.distance, so it freezes with the dino
    // instead of buzzing on the wall clock.
    if (s.bobX !== 0 || s.bobY !== 0 || s.bobZ !== 0) {
      this._camPos.x += s.bobX;
      this._camPos.y += s.bobY;
      this._camPos.z += s.bobZ;
    }
    if (!(this._camPos.y >= MIN_Y)) this._camPos.y = MIN_Y;

    const cam = this.camera;
    cam.position.copy(this._camPos);
    if (cam.up && cam.up.set) cam.up.set(0, 1, 0);
    if (cam.lookAt) cam.lookAt(this.target);

    const shake = this._shake.x;
    if (shake > 1e-4 && cam.rotateZ) {
      cam.rotateZ(this.roll.x + shake * SHAKE_ROLL * this._noise(this._time * 31, 0));
      cam.rotateY(shake * SHAKE_TILT * this._noise(this._time * 27, 4.2));
      cam.rotateX(shake * SHAKE_TILT * this._noise(this._time * 23, 8.7));
    } else if (cam.rotateZ && Math.abs(this.roll.x) > 1e-4) {
      cam.rotateZ(this.roll.x);
    }

    const fov = clamp(this.fov.x, FOV_MIN, FOV_MAX);
    if (Math.abs(finite(cam.fov, 0) - fov) > 0.01) {
      cam.fov = fov;
      if (cam.updateProjectionMatrix) cam.updateProjectionMatrix();
    }
  }

  // ------------------------------------------------------------------ the modes

  _fillPose(mode, s, i) {
    s.bobX = 0;
    s.bobY = 0;
    s.bobZ = 0;
    s.roll = 0;
    switch (mode) {
      case 'side': this._poseSide(s, i); break;
      case 'low': this._poseLow(s, i); break;
      case 'orbit': this._poseOrbit(s, i); break;
      case 'top': this._poseTop(s, i); break;
      case 'corpse': this._poseCorpse(s, i); break;
      case 'free': this._poseFree(s, i); break;
      default: this._poseChase(s, i); break;
    }
  }

  /**
   * Behind and above, 3/4 view, looking ahead of the dino by a speed-scaled
   * amount so incoming obstacles are readable before they arrive. FOV 62->78
   * and a dolly-in sell the acceleration; a slight bank into heading changes
   * keeps the horizon alive.
   */
  _poseChase(s, { pelvisX, pelvisY, pelvisZ, vel, speedNorm, distance, grounded }) {
    s.yaw = Math.PI - 0.3;
    s.pitch = 0.3 + 0.05 * speedNorm;
    s.dist = 4.6 - 0.6 * speedNorm; // dolly in as the run gets fast
    s.distLo = 2.6;
    s.distHi = 8;
    s.pitchLo = 0.08;
    s.pitchHi = 0.85;
    s.tx = pelvisX + 0.9 + 0.7 * speedNorm;
    s.ty = pelvisY + 0.12;
    s.tz = pelvisZ;
    s.fov = 62 + 16 * speedNorm;
    s.roll = clamp(-finite(vel.z, 0) * 0.03 - this._headingRate * 0.11, -0.07, 0.07);
    const gait = (grounded ? 0.35 + 0.65 * speedNorm : 0.12) * (0.4 + 0.6 * speedNorm);
    s.bobX = 0.03 * gait * this._noise(distance * 1.9, 2.1);
    s.bobY = 0.045 * gait * this._noise(distance * 2.2, 0.7);
    s.bobZ = 0.05 * gait * this._noise(distance * 1.6, 5.3);
  }

  /**
   * Classic platformer profile: camera on the dino's left (+Z), looking back at
   * -Z, which puts the run direction +X on screen right. The look-at sits *ahead*
   * of the dino: at 35% framing that offset is (0.5 - 0.35) * 2 * halfWidth, and
   * because the look-at spring lags, the dino keeps drifting forward in frame as
   * the run speeds up instead of being welded to a fixed pixel.
   */
  _poseSide(s, { pelvisX, pelvisY, pelvisZ, vel, speed, speedNorm }) {
    const fov = 55;
    const dist = 5.9;
    const aspect = clamp(finite(this.camera.aspect, 1.6), 0.4, 4);
    const halfW = dist * Math.tan((fov * DEG) / 2) * aspect;
    const ahead = (0.5 - clamp(this.opts.sideFrameX, 0.1, 0.9)) * 2 * halfW;
    s.yaw = Math.PI / 2 + 0.13; // +0.13 swings it a touch from behind
    s.pitch = 0.13 + 0.03 * speedNorm;
    s.dist = dist;
    s.distLo = 3.2;
    s.distHi = 11;
    s.pitchLo = 0.02;
    s.pitchHi = 0.7;
    s.tx = pelvisX + ahead + 0.05 * speed; // the lag term: dino drifts forward in frame
    s.ty = pelvisY + 0.05;
    s.tz = pelvisZ;
    s.fov = fov;
    s.roll = clamp(finite(vel.z, 0) * 0.01, -0.03, 0.03);
  }

  /**
   * Ground-level heroic angle: big FOV, tilted up at the dino, shake amplitude
   * scaling with speed. The shake is smooth noise against ctx.distance, not
   * Math.random per frame, so it stays a rumble at any frame rate and dies the
   * moment the dino stops.
   */
  _poseLow(s, { pelvisX, pelvisY, pelvisZ, speedNorm, distance }) {
    const dist = 3.2;
    const headY = clamp(pelvisY + 0.5, 0.4, 4);
    s.yaw = Math.PI - 0.52;
    s.pitch = Math.asin(clamp((0.5 - headY) / dist, -0.95, 0.95));
    s.dist = dist;
    s.distLo = 2.1;
    s.distHi = 7;
    s.pitchLo = -0.62;
    s.pitchHi = 0.4;
    s.tx = pelvisX + 0.45 + 1.3 * speedNorm;
    s.ty = headY;
    s.tz = pelvisZ;
    s.fov = 78 + 8 * speedNorm;
    const amp = 0.015 + 0.085 * speedNorm;
    s.roll = 0.02 * this._noise(distance * 1.1, 1.9);
    s.bobX = amp * 0.5 * this._noise(distance * 5.5, 3.3);
    s.bobY = amp * 0.3 * this._noise(distance * 6.3, 7.1);
    s.bobZ = amp * 0.6 * this._noise(distance * 4.7, 9.5);
  }

  /** Slow automatic orbit. The user's pitch/zoom offsets persist next to it. */
  _poseOrbit(s, { pelvisX, pelvisY, pelvisZ, speedNorm }) {
    s.yaw = this._orbitAngle;
    s.pitch = 0.34 + 0.13 * this._noise(this._time * 0.22, 1.3);
    s.dist = 6.6 - 0.9 * speedNorm;
    s.distLo = 2.4;
    s.distHi = 13;
    s.pitchLo = 0.04;
    s.pitchHi = 1.15;
    s.tx = pelvisX + 0.15;
    s.ty = pelvisY + 0.18;
    s.tz = pelvisZ;
    s.fov = 60;
    s.roll = 0.015 * this._noise(this._time * 0.3, 6.1);
  }

  /**
   * Bird's eye, deliberately not straight down: ~57deg keeps lane positions and
   * the gaps between obstacles readable as depth instead of as a flat plan.
   */
  _poseTop(s, { pelvisX, pelvisY, pelvisZ, speedNorm }) {
    s.yaw = Math.PI + 0.05 * this._noise(this._time * 0.25, 2.7);
    s.pitch = 0.99 + 0.06 * speedNorm;
    s.dist = 9.4;
    s.distLo = 5;
    s.distHi = 15;
    s.pitchLo = 0.5;
    s.pitchHi = 1.3;
    s.tx = pelvisX + 1.4 + 2.0 * speedNorm;
    s.ty = pelvisY * 0.3;
    s.tz = pelvisZ;
    s.fov = 55;
  }

  /**
   * Death cam: swings down and around the ragdoll, slow and drifting, framing
   * the midpoint of pelvis and head so both stay in shot as the body settles.
   */
  _poseCorpse(s, { pelvisX, pelvisY, pelvisZ, state }) {
    const head = this._headPoint(pelvisX, pelvisY, pelvisZ, state);
    const t = this._time;
    s.yaw = this._corpseYaw;
    s.pitch = 0.2 + 0.11 * this._noise(t * 0.19, 0.4);
    s.dist = 3.0 + 0.45 * this._noise(t * 0.13, 3.9);
    s.distLo = 1.6;
    s.distHi = 7;
    s.pitchLo = 0.06;
    s.pitchHi = 0.9;
    s.tx = (pelvisX + head.x) * 0.5;
    s.ty = clamp((pelvisY + head.y) * 0.5, 0.35, 3);
    s.tz = (pelvisZ + head.z) * 0.5;
    s.fov = 54 + 2.5 * this._noise(t * 0.11, 7.3);
    s.roll = 0.05 * this._noise(t * 0.09, 5.1);
  }

  /**
   * Free: pure user control on a spherical rig about the pelvis. Pitch is
   * clamped clear of the poles so the up vector cannot flip, distance is
   * clamped 1.2..18. No term here depends on the wall clock.
   */
  _poseFree(s, { pelvisX, pelvisY, pelvisZ }) {
    s.yaw = this._baseYaw;
    s.pitch = clamp(this._basePitch, -FREE_PITCH_LIMIT, FREE_PITCH_LIMIT);
    s.dist = clamp(this._baseDist, MIN_DIST, MAX_DIST);
    s.distLo = MIN_DIST;
    s.distHi = MAX_DIST;
    s.pitchLo = -FREE_PITCH_LIMIT;
    s.pitchHi = FREE_PITCH_LIMIT;
    s.tx = pelvisX;
    s.ty = pelvisY + 0.15;
    s.tz = pelvisZ;
    s.fov = 62;
  }

  // ------------------------------------------------------------------ internals

  /**
   * Smooth 1D noise: three sines at irrational ratios. Deterministic and
   * C-infinity, which is what a handheld shake needs. Per-frame Math.random
   * reads as vibration and is different at every frame rate, breaking the
   * "30fps must match 120fps" property the rest of this file has.
   */
  _noise(x, seed = 0) {
    if (!Number.isFinite(x)) return 0;
    return (
      Math.sin(x + seed) * 0.55 +
      Math.sin(x * 2.31 + seed * 1.7 + 1.3) * 0.3 +
      Math.sin(x * 4.87 + seed * 0.9 + 2.9) * 0.15
    );
  }

  _trackHeading(heading, dt) {
    const h = finite(heading, 0);
    if (dt > 0) {
      const rate = wrapPi(h - this._prevHeading) / dt;
      this._headingRate = damp(this._headingRate, clamp(rate, -6, 6), 6, dt);
    }
    this._prevHeading = h;
  }

  /** Decaying rotation-only kick, re-armed on a rising hitFlash. */
  _driveShake(dt, hitFlash) {
    const hf = clamp(finite(hitFlash, 0), 0, 1);
    if (hf - this._prevHitFlash > 0.12) this._shake.kick(6 + 10 * hf);
    this._prevHitFlash = hf;
    if (hf > 0.001) this._shake.x = Math.max(this._shake.x, 0.3 * hf);
    this._shake.target = 0;
    this._shake.step(dt);
    if (Math.abs(this._shake.x) < 1e-4 && Math.abs(this._shake.v) < 1e-4) this._shake.set(0);
  }

  _stepUserSprings(dt) {
    const springs = [this._uYaw, this._uPitch, this._uDist, this._uPanF, this._uPanY];
    const persist = PERSISTING.has(this.mode);
    let maxAbs = 0;
    for (let i = 0; i < springs.length; i++) {
      const sp = springs[i];
      if (this._dragging || persist) {
        sp.omega = this.opts.userFollowRate; // hold it where the user left it
      } else {
        sp.omega = this._easeOmega; // hand the camera back over ~1.5s
        sp.target = 0;
      }
      sp.step(dt);
      maxAbs = Math.max(maxAbs, Math.abs(sp.x));
    }
    // Nothing left to recenter means nothing left to hint about.
    if (!this._dragging && maxAbs < 0.002) this.userTouched = false;
  }

  /** Stop the pitch offset running past the mode's legal range while dragging. */
  _clampPitchTargets() {
    const base = this.mode === 'free' ? this._basePitch : this._posePitch;
    const lo = -FREE_PITCH_LIMIT - base;
    const hi = FREE_PITCH_LIMIT - base;
    this._uPitch.target = clamp(this._uPitch.target, Math.min(lo, hi), Math.max(lo, hi));
  }

  _clampPanTargets() {
    this._uPanF.target = clamp(this._uPanF.target, -8, 8);
    this._uPanY.target = clamp(this._uPanY.target, -4, 6);
  }

  _enterCorpse() {
    // Start the death orbit from wherever the camera already is and give it a
    // velocity kick: that is the "swing down and around" instead of a cut.
    this._corpseYaw = wrapPi(this.yaw.x);
    this.yaw.kick(1.15);
  }

  _autoCorpseCam(state) {
    if (DEAD_STATES.has(state)) {
      if (AUTO_MODES.has(this.mode)) {
        this._preCorpseMode = this.mode;
        this.mode = 'corpse';
        this._autoCorpse = true;
        this._enterCorpse();
      }
    } else if (LIVE_STATES.has(state) && this.mode === 'corpse' && this._autoCorpse) {
      // Hand back on restart. The springs are still holding the corpse pose, so
      // the return to chase is a move, not a cut to the run camera.
      this.mode = CAMERA_MODES.includes(this._preCorpseMode) ? this._preCorpseMode : 'chase';
      this._autoCorpse = false;
    }
  }

  /**
   * The head, for framing the corpse. Read from the solver when the skeleton
   * names it (resolved once per world, not once per frame), otherwise inferred
   * forward and above the pelvis with a slump once the run is over.
   */
  _headPoint(pelvisX, pelvisY, pelvisZ, state) {
    const out = this._head;
    const world = this._world;
    if (world && this._worldSeen !== world) {
      this._worldSeen = world;
      this._headIndex = -1;
      if (typeof world.idx === 'function' && world.pos) {
        const names = ['head', 'skull', 'head_top', 'neck'];
        for (const n of names) {
          const i = world.idx(n);
          if (typeof i === 'number' && i >= 0 && i < finite(world.count, 0)) {
            this._headIndex = i;
            break;
          }
        }
      }
    }
    if (this._headIndex >= 0 && world && world.pos) {
      const i = this._headIndex * 3;
      const hx = world.pos[i];
      const hy = world.pos[i + 1];
      const hz = world.pos[i + 2];
      if (Number.isFinite(hx) && Number.isFinite(hy) && Number.isFinite(hz)) {
        out.x = hx;
        out.y = clamp(hy, 0.1, 6);
        out.z = clamp(hz, -4, 4);
        return out;
      }
    }
    const slump = state === 'dead' ? 0.2 : 0.55;
    out.x = pelvisX + 0.72;
    out.y = clamp(pelvisY * slump + 0.22, 0.15, 6);
    out.z = pelvisZ;
    return out;
  }

  /**
   * Keep the pelvis inside the frustum. If it has escaped the view box, slide
   * the look-at and the camera by the same amount along the view's right/up:
   * that corrects the framing without rotating anything, so the mode's angle is
   * preserved and the distance is untouched.
   */
  _frameClamp(px, py, pz) {
    const cam = this._camPos;
    const look = this._look;
    const fx = look.x - cam.x;
    const fy = look.y - cam.y;
    const fz = look.z - cam.z;
    const len = Math.hypot(fx, fy, fz);
    if (!(len > 1e-4)) return;
    const inv = 1 / len;
    const nx = fx * inv;
    const ny = fy * inv;
    const nz = fz * inv;
    // right = normalize(cross(forward, worldUp)) = (-nz, 0, nx) normalised
    let rx = -nz;
    let rz = nx;
    const rl = Math.hypot(rx, rz);
    if (!(rl > 1e-4)) return; // looking straight up or down: no horizontal axis
    rx /= rl;
    rz /= rl;
    // up = cross(right, forward). right.y is 0, which collapses three of the
    // six multiply-adds; left out on purpose so the hot path stays short.
    const upx = -rz * ny;
    const upy = rz * nx - rx * nz;
    const upz = rx * ny;
    const halfH = len * Math.tan((clamp(this.fov.x, FOV_MIN, FOV_MAX) * DEG) / 2) * 0.85;
    const halfW = halfH * clamp(finite(this.camera.aspect, 1.6), 0.4, 4);
    const dx = px - look.x;
    const dy = py - look.y;
    const dz = pz - look.z;
    const offR = dx * rx + dz * rz;
    const offU = dx * upx + dy * upy + dz * upz;

    let shiftR = 0;
    if (offR > halfW) shiftR = offR - halfW;
    else if (offR < -halfW) shiftR = offR + halfW;
    let shiftU = 0;
    if (offU > halfH) shiftU = offU - halfH;
    else if (offU < -halfH) shiftU = offU + halfH;

    if (shiftR !== 0) {
      const mx = rx * shiftR;
      const mz = rz * shiftR;
      look.x += mx;
      look.z += mz;
      cam.x += mx;
      cam.z += mz;
    }
    if (shiftU !== 0) {
      const mx = upx * shiftU;
      const my = upy * shiftU;
      const mz = upz * shiftU;
      look.x += mx;
      look.y += my;
      look.z += mz;
      cam.x += mx;
      cam.y += my;
      cam.z += mz;
      if (!(cam.y >= MIN_Y)) cam.y = MIN_Y;
    }
  }
}

export default CameraRig;
