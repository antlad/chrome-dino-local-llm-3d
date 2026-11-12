// Keyboard and pointer intent.
//
// This file turns devices into decisions and nothing else. It never touches game
// state: `game` polls `held`/`pressed` and asks for clearance before consuming an
// edge. Two rules make that safe at 60 Hz:
//
//   pressed  -> an edge that is *claimed* by whoever consumes it. Unclaimed edges
//              are dropped when the frame ends, so a key mashed during the menu
//              cannot queue up a jump for the first frame of the next run.
//   held     -> level state, only meaningful while the game accepts input.
//
// Jump buffering lives here rather than in the ragdoll, because a buffered
// command can be discarded (the run ended first) and the ragdoll has no business
// knowing about that. Pointer events are forwarded straight to the camera rig:
// the camera owns its own pointer state, and duplicating it here would let the
// two drift apart.

import { CONFIG } from '../game/config.js';

/** key -> action. Case-insensitive, layout-independent enough for the common ones. */
const KEY_MAP = {
  space: 'jump',
  arrowup: 'jump',
  w: 'jump',
  keyj: 'jump',
  arrowdown: 'duck',
  s: 'duck',
  keyk: 'duck',
  arrowleft: 'strafeLeft',
  keya: 'strafeLeft',
  arrowright: 'strafeRight',
  keyd: 'strafeRight',
  enter: 'start',
  numpadenter: 'start',
  keyr: 'restart',
  keyp: 'pause',
  escape: 'pause',
  keyc: 'camera',
  keyv: 'cameraBack',
  keyn: 'recenter',
  keyf: 'fps',
};

/** Camera modes reachable with the number row, matching the HUD chip order. */
const CAMERA_MODE_KEYS = {
  digit1: 'chase',
  digit2: 'side',
  digit3: 'low',
  digit4: 'orbit',
  digit5: 'top',
  digit6: 'corpse',
  digit7: 'free',
};

/** Keys the browser would otherwise scroll the page or focus a button with. */
const SWALLOW = new Set([
  'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
]);

export class Input {
  constructor({ target = window, onAction = () => {} } = {}) {
    this.target = target;
    this.onAction = onAction;
    this.held = new Set();
    this.pressed = new Set();
    this.blocked = false; // a modal is up: no gameplay keys at all

    // Buffer, not a queue. One pending jump is all a platformer ever needs and
    // it keeps a frantic fist from banking five jumps.
    this.jumpBuffer = 0;
    this.jumpBufferTime = CONFIG.jumpBuffer;
    this.jumpWasPressed = false;
    this.jumpCutPending = false;

    this.pointerButtons = 0;
    this.pointers = new Map(); // pointerId -> {x,y}, so multi-touch does not teleport the orbit

    this._tick = this._tick.bind(this);
    this._attach();
  }

  // ------------------------------------------------------------------ wiring

  _attach() {
    const t = this.target;
    this._onKeyDown = (ev) => this._keyDown(ev);
    this._onKeyUp = (ev) => this._keyUp(ev);
    this._onBlur = () => this.releaseAll();
    t.addEventListener('keydown', this._onKeyDown);
    t.addEventListener('keyup', this._onKeyUp);
    t.addEventListener('blur', this._onBlur);
    window.addEventListener('pointerdown', (ev) => this._pointerDown(ev), { passive: true });
    window.addEventListener('pointermove', (ev) => this._pointerMove(ev), { passive: true });
    window.addEventListener('pointerup', (ev) => this._pointerUp(ev), { passive: true });
    window.addEventListener('pointercancel', (ev) => this._pointerUp(ev), { passive: true });
    this._tickId = setInterval(this._tick, 16);
  }

  /** Hook the camera in after construction; keeps Input free of camera imports. */
  bindCamera(rig, canvas) {
    this.camera = rig;
    this.canvas = canvas;
  }

  dispose() {
    const t = this.target;
    t.removeEventListener('keydown', this._onKeyDown);
    t.removeEventListener('keyup', this._onKeyUp);
    t.removeEventListener('blur', this._onBlur);
    clearInterval(this._tickId);
  }

  // ------------------------------------------------------------------ keys

  _actionFor(ev) {
    const key = String(ev.key || '').toLowerCase();
    return KEY_MAP[key] || KEY_MAP[ev.code] || null;
  }

  _keyDown(ev) {
    if (ev.repeat) {
      if (SWALLOW.has(ev.code)) ev.preventDefault();
      return;
    }
    const isUI = ev.target && ev.target.matches && ev.target.matches(
      'input, select, textarea, button, [contenteditable]',
    );
    const mode = CAMERA_MODE_KEYS[ev.code];
    if (mode) {
      if (isUI) return;
      ev.preventDefault();
      this.onAction('cameraMode', mode);
      return;
    }
    const action = this._actionFor(ev);
    if (!action) return;
    if (SWALLOW.has(ev.code)) ev.preventDefault();
    if (isUI && (action === 'jump' || action === 'duck' || action === 'start')) {
      // Space on a focused button should press the button, not also jump.
      return;
    }
    if (this.blocked && action !== 'pause') return;

    this.held.add(action);
    this.pressed.add(action);
    if (action === 'jump') {
      this.jumpBuffer = this.jumpBufferTime;
      this.jumpWasPressed = true;
    }
    if (action === 'start') this.onAction('start');
    if (action === 'restart') this.onAction('restart');
    if (action === 'pause') this.onAction('pause');
    this.onAction('keydown', action);
  }

  _keyUp(ev) {
    const action = this._actionFor(ev);
    if (!action) return;
    this.held.delete(action);
    if (action === 'jump' && this.jumpWasPressed) {
      // Only cut a jump we actually started; a release after a death is noise.
      this.jumpCutPending = true;
      this.jumpWasPressed = false;
    }
  }

  releaseAll() {
    this.held.clear();
    this.pressed.clear();
    this.jumpBuffer = 0;
    this.jumpWasPressed = false;
    this.pointers.clear();
    this.pointerButtons = 0;
    if (this.camera) this.camera.pointerUp();
  }

  // ---------------------------------------------------------------- pointer

  /** Pointer input belongs to the camera, with two exceptions: a tap on the
   *  canvas while the game is over or waiting starts a run. */
  onCanvasTap = null;

  _pointerDown(ev) {
    if (!ev.isPrimary) {
      this.pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      return;
    }
    this.pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    this.pointerButtons = ev.buttons;
    const overCanvas = ev.target === this.canvas || this.canvas?.contains?.(ev.target);
    if (overCanvas) {
      this._tapStart = { x: ev.clientX, y: ev.clientY, t: performance.now() };
      this.camera?.pointerDown(ev.clientX, ev.clientY, { shift: ev.shiftKey, ctrl: ev.ctrlKey });
    } else {
      this._tapStart = null;
    }
  }

  _pointerMove(ev) {
    if (!this.pointers.has(ev.pointerId)) return;
    this.pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (ev.isPrimary && this._tapStart) {
      this.camera?.pointerMove(ev.clientX, ev.clientY, { shift: ev.shiftKey, ctrl: ev.ctrlKey });
    }
  }

  _pointerUp(ev) {
    this.pointers.delete(ev.pointerId);
    if (!ev.isPrimary) return;
    this.camera?.pointerUp();
    const start = this._tapStart;
    this._tapStart = null;
    if (!start) return;
    const moved = Math.hypot(ev.clientX - start.x, ev.clientY - start.y);
    const held = performance.now() - start.t;
    // A tap, not a drag or a long press: the orbit stays the drag gesture.
    if (moved < 6 && held < 400) this.onCanvasTap?.(ev);
  }

  _wheel(ev) {
    if (ev.target !== this.canvas && !this.canvas?.contains?.(ev.target)) return;
    ev.preventDefault();
    this.camera?.wheel(ev.deltaY);
  }

  attachWheel(element) {
    element.addEventListener('wheel', (ev) => this._wheel(ev), { passive: false });
  }

  // ------------------------------------------------------------------- pump

  _tick() {
    if (this.jumpBuffer > 0) this.jumpBuffer = Math.max(0, this.jumpBuffer - 0.016);
  }

  // ------------------------------------------------------------- consumption

  /** True if a jump was requested within the buffer window. Consumes it. */
  takeJump() {
    if (this.jumpBuffer <= 0) return false;
    this.jumpBuffer = 0;
    this.pressed.delete('jump');
    return true;
  }

  takeJumpCut() {
    if (!this.jumpCutPending) return false;
    this.jumpCutPending = false;
    return true;
  }

  takeEdge(action) {
    if (!this.pressed.has(action)) return false;
    this.pressed.delete(action);
    return true;
  }

  /** -1 / 0 / +1 strafe intent from the held keys. */
  strafeAxis() {
    let a = 0;
    if (this.held.has('strafeLeft')) a += 1;
    if (this.held.has('strafeRight')) a -= 1;
    return a;
  }

  get ducking() {
    return this.held.has('duck');
  }
}

export default Input;
