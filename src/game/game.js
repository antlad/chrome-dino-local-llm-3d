// The game loop and state machine: the only file that owns a frame.
//
// Composition is by ownership, not by import order. The ragdoll owns the body,
// the field owns the obstacles, the camera owns the lens, the HUD owns the DOM.
// This file owns *time* and *consequence*: it decides when a step is simulated,
// when a run has ended, and what every other module is told about it.
//
// Ordering inside a frame matters and is not arbitrary:
//
//   1. sample input            (nothing has moved yet, so edges are this frame's)
//   2. advance speed / lane    (the body is driven by these, not the reverse)
//   3. dino.step               (one fixed sub-framed simulation)
//   4. obstacle update + hit   (needs the *new* position, or a jump is a frame late)
//   5. camera update           (needs the settled body, or the lens trails the physics)
//   6. world sync + render     (one draw, after everything has its final transform)
//
// Physics runs on a fixed 1/120 accumulator with a clamp on the backlog. Without
// the clamp a background tab coming back to the foreground would try to repay
// thirty seconds of simulation in one frame and hang the page.

import { CONFIG, clamp, lerp } from './config.js';
import { DinoRagdoll } from './dino.js';
import { ObstacleField } from './obstacles.js';

/** The five states a run moves through. Nothing else is allowed to be a state. */
export const STATE = {
  LOADING: 'loading',
  MENU: 'menu',
  PLAYING: 'playing',
  DYING: 'dying',
  GAMEOVER: 'gameover',
  PAUSED: 'paused',
};

// Exported because the envelope tests have to sample the body at the step the game
// actually simulates at. The gait is dt-sensitive, so a test that stepped at a
// different rate would be measuring an animal the player never plays.
export const FIXED = 1 / 120;
const MAX_FRAME = 0.1;          // never repay more than 100ms of lost time
// Derived from MAX_FRAME rather than chosen alongside it, because the two only make
// sense together: 0.1 s of backlog at 1/120 is 12 steps, plus a couple for a frame that
// lands just over the clamp and for whatever was left in the accumulator. Stated as a
// multiple, so raising MAX_FRAME cannot silently turn this cap into the live limit.
//
// Worth being honest about what this guard is for. While MAX_FRAME holds, a frame can
// reach at most 12 substeps, so this cap never fires and the backlog-drop below is
// unreachable. It is not dead weight: it is what stands between a future edit to
// MAX_FRAME and a simulation that tries to repay thirty seconds in one frame and hangs
// the tab. The stall tests in smoke-check cover the pair of them, and they do catch it:
// with both guards removed, real time never comes back after a starved tab and the game
// runs in permanent slow motion.
const MAX_SUBSTEPS = Math.ceil(MAX_FRAME / FIXED) + 2;
const DEATH_DECAY = 3.6;        // how fast the corpse's forward speed bleeds off
const SLOWMO_TIME = 0.32;
const SLOWMO_SCALE = 0.34;
const CAMERA_REATTACH = 0.55;   // seconds of corpse watching before the prompt

export class Game {
  constructor({ world, camera, hud, dinoMesh, input, onBest } = {}) {
    this.worldRef = world;
    this.camera = camera;
    this.hud = hud;
    this.dinoMesh = dinoMesh;
    this.input = input;
    this.onBest = onBest || (() => {});

    this.dino = new DinoRagdoll();
    this.field = new ObstacleField();

    this.state = STATE.LOADING;
    this.paused = false;
    this.speed = 0;
    this.distance = 0;
    this.score = 0;
    this.best = 0;
    this.startX = 0;
    this.laneZ = 0;
    this.targetLaneZ = 0;
    this.timeOfDay = 0.22;
    this.isNight = false;
    this.deathTimer = 0;
    this.slowmo = 1;
    this.hitFlash = 0;
    this.milestoneAt = CONFIG.milestoneEvery;
    this.milestonePulse = 0;
    this.cleared = 0;
    this.runTime = 0;
    this.fps = 60;
    this.lowFpsFrames = 0;
    this.quality = 'high';

    this._acc = 0;
    this._lastTime = 0;
    this._raf = 0;
    this._ctx = this._makeCtx();
    this._view = { pos: { x: 0, y: 0.92, z: 0 }, height: 0.92, vel: { x: 0, y: 0, z: 0 } };

    if (this.input) {
      this.input.onCanvasTap = () => this.advance();
    }
  }

  // ------------------------------------------------------------- transitions

  /** Called once the shell has its renderer and the first frame is ready to draw. */
  ready({ best = 0 } = {}) {
    this.best = best;
    this.setState(STATE.MENU);
  }

  /**
   * The one place the HUD's overlays are driven.
   *
   * The HUD does not have a setState, and it should not: it is a projection of a
   * context object, and the two panels it owns are not states, they are two
   * separately-shaped things that happen to be triggered by states. So the
   * transitions are spelled out here rather than forwarded and hoped for. An
   * earlier version called hud.setState on every transition and nothing happened,
   * because that method does not exist, which meant the game ran forever with no
   * menu and no game-over panel and no error anywhere to say so.
   */
  setState(next) {
    if (this.state === next) return;
    this.state = next;
    this.paused = next === STATE.PAUSED;
    if (this.input) this.input.blocked = next === STATE.PAUSED || next === STATE.LOADING;

    const hud = this.hud;
    if (!hud) return;
    switch (next) {
      case STATE.MENU:
        hud.showMenu?.({ best: this.best, score: this.score });
        hud.setPaused?.(false);
        break;
      case STATE.PLAYING:
        hud.hideGameOver?.();
        hud.setPaused?.(false);
        break;
      case STATE.GAMEOVER:
        hud.showGameOver?.({
          score: this.score,
          best: this.best,
          isRecord: this.score > 0 && this.score >= this.best,
        });
        break;
      case STATE.PAUSED:
        hud.setPaused?.(true);
        break;
      default:
        // LOADING and DYING own no chrome of their own.
        break;
    }
  }

  /**
   * Space / tap / Enter: do the only thing that makes sense for this state.
   * Public because the shell, the canvas tap and the keyboard all mean the same
   * gesture here, and none of them should have to guess whether a start is legal.
   */
  advance() {
    switch (this.state) {
      case STATE.MENU:
        this.start();
        return;
      case STATE.GAMEOVER:
        if (this.deathTimer > CAMERA_REATTACH) this.start();
        return;
      case STATE.PAUSED:
        this.resume();
        return;
      case STATE.PLAYING:
        this.pause();
        return;
      default:
    }
  }

  start() {
    this.dino.respawn(0);
    this.field.reset();
    this.startX = 0;
    this.distance = 0;
    this.score = 0;
    this.speed = CONFIG.baseSpeed * 0.55;
    this.laneZ = 0;
    this.targetLaneZ = 0;
    this.deathTimer = 0;
    this.slowmo = 1;
    this.hitFlash = 0;
    this.cleared = 0;
    this.runTime = 0;
    this.milestoneAt = CONFIG.milestoneEvery;
    this.milestonePulse = 0;
    this.timeOfDay = Math.random();
    this.isNight = false;
    this._acc = 0;
    this._lastTime = 0;
    // A new run starts from the shell's default lens, not wherever the player had
    // dragged it. resetView clears the user's orbital offsets and setMode returns to
    // the chase pose; the camera has no single reset that does both.
    this.camera?.resetView?.();
    this.camera?.setMode?.('chase');
    this.setState(STATE.PLAYING);
  }

  restart() {
    this.start();
  }

  pause() {
    if (this.state !== STATE.PLAYING) return;
    this.input?.releaseAll();
    this.setState(STATE.PAUSED);
  }

  resume() {
    if (this.state !== STATE.PAUSED) return;
    this._lastTime = 0;
    this.setState(STATE.PLAYING);
  }

  togglePause() {
    if (this.state === STATE.PAUSED) this.resume();
    else if (this.state === STATE.PLAYING) this.pause();
  }

  /** A collision has been decided elsewhere; make it a death here. */
  die(knockback) {
    if (this.state !== STATE.PLAYING) return;
    this.dino.die(knockback);
    this.deathTimer = 0;
    this.slowmo = SLOWMO_TIME;
    this.hitFlash = 1;
    // The screen flash is the HUD's own job: hitFlash is carried in the context
    // every frame and the HUD ramps a vignette off it. This is the one-shot text
    // tag over the top, which is a different thing and needs its own call.
    this.hud?.flash?.('Wiped out', 'bad');
    this.setState(STATE.DYING);
  }

  setQuality(q) {
    this.quality = q;
    this.worldRef?.setQuality?.(q);
  }

  setCameraMode(mode) {
    const m = this.camera?.setMode?.(mode);
    this.hud?.setCameraMode?.(m || mode);
  }

  cycleCamera(back = false) {
    const m = this.camera?.cycle?.(back ? -1 : 1);
    this.hud?.setCameraMode?.(m || this.camera?.mode);
  }

  // -------------------------------------------------------------------- loop

  startLoop() {
    if (this._raf) return;
    const tick = (t) => {
      this._raf = requestAnimationFrame(tick);
      this.frame(t);
    };
    this._raf = requestAnimationFrame(tick);
  }

  stopLoop() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
  }

  /** One animation frame. Split out so the shell can drive it manually in tests. */
  frame(nowMs) {
    const now = nowMs || performance.now();
    let dt = this._lastTime ? (now - this._lastTime) / 1000 : 1 / 60;
    this._lastTime = now;
    dt = clamp(dt, 0, MAX_FRAME);
    this.fps = lerp(this.fps, 1 / Math.max(dt, 1e-4), 0.08);

    if (this.state === STATE.PAUSED) {
      this._drawOnce();
      return;
    }

    this._sampleInput(dt);

    // The simulation is advanced in whole FIXED steps and the remainder is carried,
    // rather than being handed the frame's dt. This is not tidiness. The gait is a
    // driven spring system, so its answer depends on the step it is given: fed 1/60 it
    // runs with its head at about 1.12 m, and fed the ~1/23 a stalled or backgrounded
    // tab produces it collapses to roughly 0.90 m. That number is not cosmetic. A
    // duckable flyer has to pass over the crouch and under the standing head, a window
    // only about 0.22 m wide, so a frame-rate-dependent head height means whether the
    // player is killed by the same obstacle depends on their refresh rate. Clamping to
    // MAX_FRAME first is what stops a tab returning to the foreground from repaying
    // thirty seconds of physics in one frame.
    this._acc += dt;
    let steps = 0;
    while (this._acc >= FIXED && steps < MAX_SUBSTEPS) {
      if (this.state === STATE.PLAYING || this.state === STATE.DYING) {
        this._simulate(FIXED);
      } else {
        // Menu and game-over still need the body to settle and the world to tick,
        // but nobody is asking for clearance or hits.
        this._simulateIdle(FIXED);
      }
      this._acc -= FIXED;
      steps++;
    }
    // Dropping the backlog instead of banking it. Carrying a large remainder after
    // hitting the cap would make the next frame try to catch up as well, and the
    // slow-down would compound into the simulation never returning to real time.
    if (steps >= MAX_SUBSTEPS) this._acc = 0;

    this._updateCamera(dt);
    this._present(dt);
  }

  // ------------------------------------------------------------------ input

  _sampleInput(dt) {
    const input = this.input;
    if (!input) return;

    if (this.state === STATE.PLAYING) {
      if (input.takeJump()) {
        // Clearance is the arbiter, not a flag. A buffered jump that arrives the
        // frame the foot touches down still counts, which is what makes landing
        // feel responsive instead of precise.
        if (this.dino.grounded || this.dino.clearance() < CONFIG.groundTolerance * 2.2) {
          this.dino.jump(CONFIG.jumpVelocity);
        }
      }
      if (input.takeJumpCut() && this.dino.airTime > 0.02) this.dino.jumpCut();

      const axis = input.strafeAxis();
      const range = CONFIG.laneCount > 1 ? (CONFIG.laneCount - 1) / 2 : 0.5;
      this.targetLaneZ = clamp(this.targetLaneZ + axis * CONFIG.laneSpeed * dt,
        -range * CONFIG.laneWidth, range * CONFIG.laneWidth);

      this.ducking = input.ducking;
    } else {
      // Do not let a menu mashing leak into the first frame of the next run.
      input.takeJump();
      input.takeJumpCut();
      this.ducking = false;
    }
  }

  // -------------------------------------------------------------- simulation

  _simulate(dt) {
    const cfg = CONFIG;

    if (this.state === STATE.PLAYING) {
      this.runTime += dt;
      // Speed is a curve of distance, not of time, so the run gets harder the
      // further you get rather than the longer you dawdle.
      const want = clamp(
        cfg.baseSpeed + this.distance * cfg.accelPerMetre,
        cfg.baseSpeed * 0.5,
        cfg.maxSpeed,
      );
      this.speed = lerp(this.speed, want, clamp(dt * 1.6, 0, 1));

      this.dino.speedInput = this.speed;
      this.dino.step(dt, {
        speed: this.speed,
        ducking: !!this.ducking,
        laneZ: this.targetLaneZ,
        dying: false,
        slowmo: 1,
      });
      this.laneZ = this.dino.laneZ;

      const pelvis = this.dino.pelvis;
      this.distance = Math.max(this.distance, pelvis.x - this.startX);
      this.score = Math.floor(this.distance * CONFIG.scorePerMetre);
      if (this.score > this.best) {
        this.best = this.score;
        this.onBest(this.best);
      }

      if (this.score >= this.milestoneAt) {
        this.milestonePulse = 1;
        this.milestoneAt += CONFIG.milestoneEvery;
        this.worldRef?.celebrate?.(true);
      }

      // Day/night is driven by distance so a run always shows the same weather
      // for the same distance, and the loop is long enough to be atmosphere
      // rather than a strobe.
      this.timeOfDay = (this.timeOfDay + dt * CONFIG.dayNightCycle) % 1;
      this.isNight = this.timeOfDay > 0.72 || this.timeOfDay < 0.08;

      if (this.slowmo > 0) this.slowmo = Math.max(0, this.slowmo - dt);

      this._fieldAndUpdate(dt, true);
      return;
    }

    // DYING: the corpse keeps running out its momentum under its own weight, so
    // the world speed has to decay with it or the dune field outruns the body.
    this.deathTimer += dt;
    this.speed = Math.max(0, this.speed - DEATH_DECAY * dt);
    const scale = this.slowmo > 0 ? SLOWMO_SCALE : 1;
    this.dino.step(dt, {
      speed: this.speed,
      ducking: false,
      laneZ: this.dino.laneZ,
      dying: true,
      slowmo: scale,
    });
    this._fieldAndUpdate(dt, false);

    if (this.deathTimer > 0.9 && this.state === STATE.DYING) {
      if (this.deathTimer > 0.9 + CAMERA_REATTACH) this.setState(STATE.GAMEOVER);
      else if (!this._cameraSwitched) {
        // Pull back to the corpse for the last half second of the tumble before
        // the panel appears, so the death reads as a scene, not a cut.
        this._cameraSwitched = true;
        this.setCameraMode('corpse');
      }
    }
  }

  _fieldAndUpdate(dt, checkHits) {
    const pelvis = this.dino.pelvis;
    this._visible = this.field.update(dt, {
      dino: { pos: pelvis },
      speed: this.speed,
      distance: this.distance,
    });
    this.cleared = this.field.countPassed(pelvis.x);

    if (!checkHits) return;
    // hitBounds, not bounds: the tail is decorative and must not end a run. See
    // DinoRagdoll.hitBounds for the two ways a whole-body box lies about contact.
    const hit = this.field.checkHit(this.dino.hitBounds());
    if (hit) {
      // Knockback opposes the obstacle's motion and shoves the dino off its
      // centre line, so the corpse tumbles away from the thing that killed it.
      const dz = (pelvis.z - hit.z) || 0.2;
      this.die({
        x: -this.speed * 0.35 + (hit.vx || 0) * 0.6,
        y: 4.2 + Math.min(2.5, this.speed * 0.18),
        z: clamp(dz * 2.4, -1.6, 1.6),
      });
    }
  }

  _simulateIdle(dt) {
    // Keep the animal breathing and the world lit without simulating a run.
    this.dino.step(dt, {
      speed: this.state === STATE.GAMEOVER ? this.speed : 0,
      ducking: false,
      laneZ: this.dino.laneZ,
      dying: !this.dino.aliveFlag,
      slowmo: 1,
    });
    if (this.state === STATE.GAMEOVER) {
      this.speed = Math.max(0, this.speed - DEATH_DECAY * dt);
      this.deathTimer += dt;
    }
    if (this.input) {
      this.input.takeJump();
      this.input.takeJumpCut();
    }
  }

  // ----------------------------------------------------------------- camera

  _updateCamera(dt) {
    const view = this._view;
    const speedNorm = clamp(this.speed / CONFIG.maxSpeed, 0, 1);
    // The rig poses itself from speedNorm, not speed: it is a 0..1 fraction of the
    // difficulty ceiling and the whole feel curve is authored in those terms. Read
    // the eye height off the camera it owns rather than asking for a method that
    // does not exist, because the world uses that number to place its fog.
    const cameraEyeY = this.camera?.camera?.position?.y ?? 3;
    this.camera?.update?.(dt, {
      dino: view,
      velocity: view.vel,
      speed: this.state === STATE.PLAYING ? this.speed : Math.abs(view.vel.x),
      speedNorm,
      distance: this.distance,
      state: this.state,
      strafe: this.input?.strafeAxis?.() ?? 0,
      grounded: this.dino.grounded,
      hipHeight: this.dino.hipHeight,
      hitFlash: this.hitFlash,
    });
    this._cameraEyeY = cameraEyeY;
  }

  // ---------------------------------------------------------------- present

  _makeCtx() {
    return {
      dino: this._view,
      camera: null,
      speed: 0,
      speedNorm: 0,
      timeOfDay: 0,
      isNight: false,
      cameraEyeY: 3,
      milestone: 0,
      grounded: true,
    };
  }

  _present(dt) {
    const pelvis = this.dino.pelvis;
    const view = this._view;
    view.pos.x = pelvis.x;
    view.pos.y = pelvis.y;
    view.pos.z = pelvis.z;
    const v = this.dino.velocity();
    view.vel.x = v[0];
    view.vel.y = v[1];
    view.vel.z = v[2];
    view.height = Math.max(0, this.dino.clearance());
    // The rig and the world both read these off the same view object. `world` lets
    // the camera find the head particle, `heading` is the lean into a lane change.
    view.world = this.dino.world;
    view.heading = this.dino.heading;

    const speedNorm = clamp(this.speed / CONFIG.maxSpeed, 0, 1);

    // The mesh reads the solver straight out of the world it was built against, so
    // there is nothing to hand it beyond the ctx it wants. What does have to be
    // pushed is limpness: the body goes slack as the death motors fade, and the
    // mesh has no idea the animal died unless it is told.
    this.dinoMesh?.setLimp?.(1 - this.dino.motor);
    this.dinoMesh?.update?.();

    const ctx = this._ctx;
    ctx.dino = view;
    ctx.camera = this.camera?.camera ?? null;
    ctx.speed = this.speed;
    ctx.speedNorm = speedNorm;
    ctx.timeOfDay = this.timeOfDay;
    ctx.isNight = this.isNight;
    ctx.cameraEyeY = this._cameraEyeY ?? 3;
    ctx.grounded = this.dino.grounded;
    ctx.milestone = this.milestonePulse > 0 ? 1 : 0;

    this.worldRef?.syncProps?.(this._visible || []);
    this.worldRef?.update?.(dt, ctx);

    if (this.milestonePulse > 0) this.milestonePulse = Math.max(0, this.milestonePulse - dt * 2);

    if (this.hud) {
      // The HUD takes one context for the readouts and one for the chrome it owns,
      // so a state change cannot desync a checkbox from what is actually on.
      this.hud.sync?.({
        score: this.score,
        best: this.best,
        distance: this.distance,
        speed: this.speed,
        speedNorm,
        state: this.state,
        timeOfDay: this.timeOfDay,
        isNight: this.isNight,
        fps: this.fps,
        cleared: this.cleared,
        hitFlash: this.hitFlash,
        milestone: this.milestonePulse > 0 ? 1 : 0,
        grounded: this.dino.grounded,
        heading: this.dino.heading,
      }, {
        cameraMode: this.camera?.mode ?? 'chase',
        quality: this.quality,
      });
      if (this.hitFlash > 0) this.hitFlash = Math.max(0, this.hitFlash - dt * 3.2);
    }

    this._autoQuality(dt);
  }

  /** Drop one quality tier if the average frame time stays bad. Never drop below low. */
  _autoQuality() {
    if (this.fps > 46) {
      this.lowFpsFrames = 0;
      return;
    }
    this.lowFpsFrames++;
    if (this.lowFpsFrames < 120) return;
    this.lowFpsFrames = 0;
    if (this.quality === 'high') this.setQuality('medium');
    else if (this.quality === 'medium') this.setQuality('low');
  }

  _drawOnce() {
    // Paused: still present the current pose so the pause overlay composites over
    // a live image instead of a stale one, but do not advance anything.
    this._present(0);
  }
}

export default Game;
