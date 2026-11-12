// HUD for the 3D runner: the only module allowed to touch the DOM per frame.
//
// sync() runs once per animation frame, so the whole file is built around one
// rule: nothing is queried, allocated or written unless a value actually
// changed. Ids resolve once in the constructor, formatted strings are cached
// and compared, and the transient labels come out of a fixed pool so a burst of
// events reuses nodes instead of growing the DOM. Every lookup is guarded, so a
// page missing an optional element still boots.

const CAMERA_MODES = [
  { mode: 'chase', label: 'Chase' },
  { mode: 'side', label: 'Side' },
  { mode: 'low', label: 'Low' },
  { mode: 'orbit', label: 'Orbit' },
  { mode: 'top', label: 'Top' },
  { mode: 'corpse', label: 'Corpse' },
  { mode: 'free', label: 'Free' },
];

// Death cam is driven by the game, not chosen by the player, so it lights no chip.
const CHIPLESS_MODES = ['corpse'];

const SCORE_PAD = 5;
const FLASH_POOL = 6;
const MILESTONE_TTL = 1200;  // matches milestone-pop
const DEBUG_HZ = 8;          // debug text is a readout, not a 60Hz stream
const FPS_HZ = 500;

const DEFAULTS = {
  milestoneTtl: MILESTONE_TTL,
  nightHold: 0.5, // timeOfDay past this reads as night on the way back up
  debugHz: DEBUG_HZ,
};

function pad5(n) {
  const v = Number.isFinite(n) && n > 0 ? (n | 0) : 0;
  const s = String(v);
  return s.length >= SCORE_PAD ? s : '00000'.slice(0, SCORE_PAD - s.length) + s;
}

function num(v, fallback) {
  return Number.isFinite(v) ? v : fallback;
}

function own(obj, key) {
  return obj != null && Object.prototype.hasOwnProperty.call(obj, key);
}

function now() {
  return typeof performance !== 'undefined' && performance.now
    ? performance.now() : Date.now();
}

export class HUD {
  constructor({ root, opts } = {}) {
    this.root = root && typeof root.querySelector === 'function' ? root : document;
    this.opts = Object.assign({}, DEFAULTS, opts || {});
    this.handlers = {};

    // Elements may live inside `root` or on the page; both expose lookups here.
    const q = (id) => typeof this.root.getElementById === 'function'
      ? this.root.getElementById(id)
      : this.root.querySelector('#' + id);

    // Resolved once and never looked up again.
    this.el = {
      score: q('score'),
      best: q('best'),
      speed: q('speed'),
      state: q('stat-state'),
      milestone: q('milestone'),
      hitFlash: q('hit-flash'),
      overlay: q('overlay'),
      overlayTitle: q('overlay-title'),
      overlaySub: q('overlay-sub'),
      btnStart: q('btn-start'),
      btnRestart: q('btn-restart'),
      btnPause: q('btn-pause'),
      chips: q('camera-chips'),
      hint: q('hint'),
      fps: q('fps'),
      settings: q('settings'),
      quality: q('quality'),
      toggleDebug: q('toggle-debug'),
      toggleOrbit: q('toggle-orbit'),
      sliderSens: q('slider-sens'),
      // HUD-only hooks. These are classes rather than ids so the page carries
      // exactly the ids the contract lists, and nothing else depends on them.
      overlayCard: this.root.querySelector('.overlay-card'),
      overlayKicker: this.root.querySelector('.overlay-kicker'),
      overlayScore: this.root.querySelector('.overlay-score'),
      overlayBest: this.root.querySelector('.overlay-best-v'),
      overlayRecord: this.root.querySelector('.overlay-record'),
      btnSettings: q('btn-settings'),
      btnSettingsClose: this.root.querySelector('.js-settings-close'),
      sensOut: this.root.querySelector('.sens-out'),
      debug: this.root.querySelector('.debug'),
      flashLayer: this.root.querySelector('.flash-layer'),
    };

    // Cache of last-written values keyed by a stable logical name, not by node.
    // Comparing a cached string is far cheaper than touching the DOM.
    this._textCache = new Map();
    this._attrCache = new Map();
    this._classCache = new Map();

    this._night = null;
    this._paused = null;
    this._cameraMode = null;
    this._chips = [];
    this._ctx = null;
    this._milestoneOn = false;
    this._milestoneAt = -1e9;
    this._hitOpacity = -1;
    this._fpsAt = -1;
    this._frames = 0;
    this._fpsShown = -1;
    this._debugAt = -1e9;
    this._debugOn = null;
    this._settingsOpen = false;
    this._overlayOpen = null;

    // The pill label is a child node: rewriting the button's textContent would
    // destroy the CSS-drawn icon, so grab the child once.
    this._pauseLabel = this.el.btnPause && typeof this.el.btnPause.querySelector === 'function'
      ? this.el.btnPause.querySelector('.pill-label') : null;

    // The card, not the CTA, takes focus when the overlay opens: focusing a
    // button would make the player's first Space fire both the button and the
    // jump handler.
    if (this.el.overlayCard) this.el.overlayCard.tabIndex = -1;

    this._chipClick = (ev) => {
      const btn = ev.currentTarget;
      const mode = btn && btn.dataset ? btn.dataset.mode : null;
      if (!mode) return;
      this.setCameraMode(mode); // optimistic, so the click feels instant
      const h = this.handlers.onCamera;
      if (h) h(mode);
    };
    this._closeOnPointer = (ev) => this._handleOutsidePointer(ev);
    // Escape is wired while the panel is open so it can never trap the keyboard,
    // even if main.js does not route keys to handleKey().
    this._onKey = (ev) => this.handleKey(ev);

    this._pool = [];
    this._poolHead = 0;
    this._buildFlashPool();
    this.buildCameraChips();
    this._wireChrome();
    this._applySensFill(this.el.sliderSens ? this.el.sliderSens.value : '1');
  }

  /* ------------------------------------------------------------ internals -- */

  _write(node, key, value) {
    if (!node) return;
    if (this._textCache.get(key) === value) return;
    this._textCache.set(key, value);
    node.textContent = value;
  }

  _attr(node, name, key, value) {
    if (!node) return;
    const ck = key + '|' + name;
    if (this._attrCache.get(ck) === value) return;
    this._attrCache.set(ck, value);
    if (value == null) node.removeAttribute(name);
    else node.setAttribute(name, value);
  }

  _class(node, key, cls, on) {
    if (!node) return;
    const ck = key + '|' + cls;
    const want = !!on;
    if (this._classCache.get(ck) === want) return;
    this._classCache.set(ck, want);
    node.classList.toggle(cls, want);
  }

  _buildFlashPool() {
    const layer = this.el.flashLayer;
    if (!layer) return;
    for (let i = 0; i < FLASH_POOL; i++) {
      const node = document.createElement('div');
      node.className = 'flash-tag';
      layer.appendChild(node);
      this._pool.push(node);
    }
  }

  /** Build the camera chip row once. Repeating it is a no-op, not a duplicate. */
  buildCameraChips() {
    const host = this.el.chips;
    if (!host || this._chips.length) return;
    // The row is HUD-owned markup; anything already in it is stale.
    host.textContent = '';
    const frag = document.createDocumentFragment();
    for (let i = 0; i < CAMERA_MODES.length; i++) {
      const spec = CAMERA_MODES[i];
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chip';
      btn.dataset.mode = spec.mode;
      btn.textContent = spec.label;
      // 1-7 are the real shortcuts, so the tooltip teaches them.
      btn.title = spec.label + ' camera (' + (i + 1) + ')';
      btn.setAttribute('aria-label', spec.label + ' camera');
      btn.addEventListener('click', this._chipClick);
      frag.appendChild(btn);
      this._chips.push(btn);
    }
    host.appendChild(frag);
  }

  _wireChrome() {
    const el = this.el;

    const tap = (node, name, arg) => {
      if (!node) return;
      node.addEventListener('click', () => {
        const h = this.handlers[name];
        if (h) h(arg);
      });
    };
    tap(el.btnStart, 'onStart');
    tap(el.btnRestart, 'onRestart');
    tap(el.btnPause, 'onPause');

    if (el.quality) {
      el.quality.addEventListener('change', () => {
        const h = this.handlers.onQuality;
        if (h) h(el.quality.value);
      });
    }

    const flip = (node, name, read) => {
      if (!node) return;
      node.addEventListener('change', () => {
        this._emitToggle(name, read ? read(node) : node.checked);
      });
    };
    flip(el.toggleDebug, 'debug');
    flip(el.toggleOrbit, 'orbit');

    if (el.sliderSens) {
      el.sliderSens.addEventListener('input', () => {
        const value = num(parseFloat(el.sliderSens.value), 1);
        this._write(el.sensOut, 'sensOut', value.toFixed(1) + '\u00d7');
        this._applySensFill(el.sliderSens.value);
        this._emitToggle('sensitivity', value);
      });
    }

    if (el.btnSettings) {
      el.btnSettings.addEventListener('click', () => this.toggleSettings());
    }
    if (el.btnSettingsClose) {
      el.btnSettingsClose.addEventListener('click', () => this.setSettingsOpen(false));
    }
  }

  _applySensFill(raw) {
    const node = this.el.sliderSens;
    if (!node || !node.style) return;
    const min = num(parseFloat(node.min), 0.2);
    const max = num(parseFloat(node.max), 3);
    const val = num(parseFloat(raw), 1);
    const span = (max - min) || 1;
    const pct = Math.max(0, Math.min(1, (val - min) / span)) * 100;
    // One custom property drives the filled track, so no extra element is needed.
    node.style.setProperty('--fill', pct.toFixed(1) + '%');
  }

  /* -------------------------------------------------------------- settings -- */

  setSettingsOpen(on) {
    const want = !!on;
    if (this._settingsOpen === want) return;
    this._settingsOpen = want;

    this._class(this.el.settings, 'settings', 'is-open', want);
    this._attr(this.el.settings, 'aria-hidden', 'settings', want ? 'false' : 'true');
    this._attr(this.el.btnSettings, 'aria-expanded', 'btnSettings', want ? 'true' : 'false');

    // Outside-click is only live while the panel is up, so the canvas never
    // eats a stray pointerdown mid-run.
    if (typeof document.addEventListener === 'function') {
      const mode = want ? 'addEventListener' : 'removeEventListener';
      document[mode]('pointerdown', this._closeOnPointer, true);
      // Escape is wired here rather than only via handleKey so the panel can
      // never trap the keyboard if main.js does not route keys to us.
      document[mode]('keydown', this._onKey, true);
    }

    if (want) {
      if (this.el.quality && typeof this.el.quality.focus === 'function') this.el.quality.focus();
    } else if (this.el.btnSettings && typeof this.el.btnSettings.focus === 'function') {
      this.el.btnSettings.focus();
    }
  }

  toggleSettings() {
    this.setSettingsOpen(!this._settingsOpen);
  }

  isSettingsOpen() {
    return this._settingsOpen;
  }

  _handleOutsidePointer(ev) {
    if (!this._settingsOpen) return;
    const t = ev.target;
    const panel = this.el.settings;
    const gear = this.el.btnSettings;
    if (panel && panel.contains && panel.contains(t)) return;
    if (gear && gear.contains && gear.contains(t)) return; // the gear toggles itself
    this.setSettingsOpen(false);
  }

  /**
   * Escape close. main.js owns the keyboard, so it can route keys here; the HUD
   * also listens itself so the panel is never a trap. Returns true if consumed.
   */
  handleKey(ev) {
    if (!ev || ev.key !== 'Escape' || !this._settingsOpen) return false;
    this.setSettingsOpen(false);
    return true;
  }

  /**
   * The contract types onToggle as an object, but a single function is the more
   * natural shape. Accept both: a map dispatches by name, a function gets
   * (name, value).
   */
  _emitToggle(name, value) {
    const t = this.handlers.onToggle;
    if (!t) return;
    if (typeof t === 'function') { t(name, value); return; }
    const h = t[name];
    if (typeof h === 'function') h(value);
  }

  /* ------------------------------------------------------------------ sync -- */

  /**
   * Per-frame update. `ctx` is the shared game state, `uiState` the UI-owned
   * state ({ cameraMode, quality, showDebug, sound, sensitivity, orbitAuto }).
   * Allocation-light: the only per-frame strings are the ones that changed.
   */
  sync(ctx, uiState) {
    if (ctx) this._ctx = ctx;

    if (ctx) {
      this._write(this.el.score, 'score', pad5(ctx.score));
      this._write(this.el.best, 'best', pad5(ctx.best));
      this._write(this.el.speed, 'speed', num(ctx.speed, 0).toFixed(1));
      this._write(this.el.state, 'state', String(ctx.state || 'menu'));

      const night = !!ctx.isNight
        || (Number.isFinite(ctx.timeOfDay) && ctx.timeOfDay > this.opts.nightHold);
      if (night !== this._night) {
        this._night = night;
        this._attr(document.documentElement, 'data-night', 'root', night ? 'true' : 'false');
      }

      this._syncHit(ctx.hitFlash);
      this._syncMilestone(ctx.milestone, ctx.distance);
      if (this._debugOn) this._syncDebugText(ctx);
    }

    if (uiState) {
      if (own(uiState, 'cameraMode')) this.setCameraMode(uiState.cameraMode);
      if (own(uiState, 'quality')) this._setSelect(this.el.quality, uiState.quality);
      if (own(uiState, 'showDebug')) this.setDebug(!!uiState.showDebug);
      if (own(uiState, 'orbitAuto')) this._setChecked(this.el.toggleOrbit, uiState.orbitAuto);
      if (own(uiState, 'sound')) this._setChecked(this.el.toggleSound, uiState.sound);
      if (own(uiState, 'sensitivity')) this._setRange(uiState.sensitivity);
    }

    this._tickFps();
  }

  _setSelect(node, value) {
    if (node && value != null && node.value !== value) node.value = value;
  }

  _setChecked(node, value) {
    const want = !!value;
    if (node && node.checked !== want) node.checked = want;
  }

  _setRange(value) {
    const node = this.el.sliderSens;
    if (!node) return;
    const v = num(typeof value === 'number' ? value : parseFloat(value), null);
    if (v == null) return;
    // Never fight the player mid-drag.
    if (typeof document !== 'undefined' && document.activeElement === node) return;
    const next = String(v);
    if (node.value === next) return;
    node.value = next;
    this._write(this.el.sensOut, 'sensOut', v.toFixed(1) + '\u00d7');
    this._applySensFill(next);
  }

  _syncHit(v) {
    const node = this.el.hitFlash;
    if (!node) return;
    // Two decimals: sub-percent changes would thrash the style.
    const next = Math.round(Math.max(0, Math.min(1, num(v, 0))) * 100) / 100;
    if (next === this._hitOpacity) return;
    this._hitOpacity = next;
    node.style.opacity = next === 0 ? '0' : String(next);
  }

  _syncMilestone(flag, distance) {
    const node = this.el.milestone;
    if (!node) return;
    const on = Number.isFinite(flag) ? flag > 0.001 : !!flag;
    const t = now();

    if (on && !this._milestoneOn) {
      this._milestoneOn = true;
      this._milestoneAt = t;
      const metres = Number.isFinite(distance) ? Math.floor(distance / 100) * 100 : 0;
      this._write(node, 'milestone', metres + ' m');
      this._restart(node, 'milestone', 'is-on');
    } else if (!on && this._milestoneOn) {
      this._milestoneOn = false;
      this._classCache.set('milestone|is-on', false);
      node.classList.remove('is-on');
    } else if (on && this._milestoneOn && t - this._milestoneAt > this.opts.milestoneTtl) {
      // The flag is being held high: let the animation restart so a long
      // window cannot leave the banner stuck on screen.
      this._milestoneOn = false;
      this._classCache.set('milestone|is-on', false);
      node.classList.remove('is-on');
    }
  }

  /** Drop and re-add a class, forcing the keyframes to replay. */
  _restart(node, key, cls) {
    node.classList.remove(cls);
    void node.offsetWidth; // style flush, the one deliberate reflow in the file
    node.classList.add(cls);
    this._classCache.set(key + '|' + cls, true);
  }

  _tickFps() {
    const node = this.el.fps;
    if (!node) return;
    const t = now();
    this._frames++;
    if (this._fpsAt < 0) { this._fpsAt = t; return; }
    if (t - this._fpsAt < FPS_HZ) return;
    const fps = this._frames * 1000 / (t - this._fpsAt);
    this._frames = 0;
    this._fpsAt = t;
    const shown = Math.round(fps);
    if (shown === this._fpsShown) return;
    this._fpsShown = shown;
    this._write(node, 'fps', shown + ' fps');
  }

  _syncDebugText(ctx) {
    const node = this.el.debug;
    if (!node) return;
    const t = now();
    if (t - this._debugAt < 1000 / this.opts.debugHz) return;
    this._debugAt = t;

    const d = ctx.dino;
    if (!d || !d.pos || !d.vel) return;
    const parts = d.world && Number.isFinite(d.world.count) ? d.world.count : '-';
    const line = 'pos  ' + d.pos.x.toFixed(1) + '  ' + d.pos.y.toFixed(2) + '  ' + d.pos.z.toFixed(1) +
      '\nvel  ' + d.vel.x.toFixed(1) + '  ' + d.vel.y.toFixed(1) + '  ' + d.vel.z.toFixed(1) +
      '\npart ' + parts + '   cam ' + (ctx.cameraMode || '-');
    this._write(node, 'debug', line);
  }

  /* --------------------------------------------------------------- widgets -- */

  setCameraMode(name) {
    if (!name || name === this._cameraMode) return;
    this._cameraMode = name;
    const lit = CHIPLESS_MODES.indexOf(name) === -1;
    for (let i = 0; i < this._chips.length; i++) {
      const btn = this._chips[i];
      const mode = btn.dataset.mode;
      this._class(btn, 'chip-' + mode, 'is-active', lit && mode === name);
      this._attr(btn, 'aria-pressed', 'chip-' + mode, lit && mode === name ? 'true' : 'false');
    }
    this._attr(this.el.chips, 'data-mode', 'chips', name);
  }

  setPaused(v) {
    const on = !!v;
    if (this._paused === on) return;
    this._paused = on;
    this._attr(this.el.btnPause, 'aria-pressed', 'btnPause', on ? 'true' : 'false');
    this._class(this.el.btnPause, 'btnPause', 'is-armed', on);
    this._write(this._pauseLabel, 'pauseLabel', on ? 'Resume' : 'Pause');
  }

  setDebug(on) {
    const want = !!on;
    if (this._debugOn === want) return;
    this._debugOn = want;
    this._class(this.el.debug, 'debug', 'is-on', want);
    this._setChecked(this.el.toggleDebug, want);
    if (want && this._ctx) this._syncDebugText(this._ctx);
  }

  /**
   * Queue a short-lived floating label. Nodes come out of a ring buffer, so the
   * DOM never grows no matter how many events fire.
   */
  flash(text, kind) {
    if (!text || !this._pool.length) return;
    const idx = this._poolHead;
    this._poolHead = (idx + 1) % this._pool.length;
    const node = this._pool[idx];

    node.className = kind === 'good' ? 'flash-tag is-good'
      : kind === 'bad' ? 'flash-tag is-bad' : 'flash-tag';
    node.textContent = String(text);
    this._restart(node, 'flash-' + idx, 'is-live');
  }

  showGameOver({ score, best, isRecord } = {}) {
    const record = !!isRecord;
    this._write(this.el.overlayKicker, 'overlayKicker', 'Run complete');
    this._write(this.el.overlayTitle, 'overlayTitle', record ? 'New best!' : 'Wiped out');
    this._write(this.el.overlaySub, 'overlaySub', record
      ? 'You beat your own record. Space or R to run it again.'
      : 'Space or R to run it again. Drag to orbit the wreck.');
    this._write(this.el.overlayScore, 'overlayScore', pad5(score));
    this._write(this.el.overlayBest, 'overlayBest', pad5(best));
    this._class(this.el.overlayRecord, 'overlayRecord', 'is-hidden', !record);
    this._class(this.el.overlay, 'overlay', 'is-record', record);
    this._write(this.el.btnStart, 'btnStartLabel', 'Run again');
    this._setOverlayOpen(true);
    this.setPaused(false);
  }

  hideGameOver() {
    this._write(this.el.overlayKicker, 'overlayKicker', 'Chrome Dino 3D');
    this._write(this.el.overlayTitle, 'overlayTitle', 'Ready when you are');
    this._write(this.el.overlaySub, 'overlaySub',
      'Space to jump, Down to duck. Drag to orbit the camera, scroll to zoom.');
    this._write(this.el.btnStart, 'btnStartLabel', 'Start');
    this._class(this.el.overlayRecord, 'overlayRecord', 'is-hidden', true);
    this._class(this.el.overlay, 'overlay', 'is-record', false);
    this._setOverlayOpen(false);
  }

  /** Menu copy at boot, so the card is never in a stale half-state. */
  showMenu({ best, score } = {}) {
    this._write(this.el.overlayKicker, 'overlayKicker', 'Chrome Dino 3D');
    this._write(this.el.overlayTitle, 'overlayTitle', 'Ready when you are');
    this._write(this.el.overlaySub, 'overlaySub',
      'Space to jump, Down to duck. Drag to orbit the camera, scroll to zoom.');
    this._write(this.el.overlayScore, 'overlayScore', pad5(score));
    this._write(this.el.overlayBest, 'overlayBest', pad5(best));
    this._write(this.el.btnStart, 'btnStartLabel', 'Start');
    this._class(this.el.overlayRecord, 'overlayRecord', 'is-hidden', true);
    this._class(this.el.overlay, 'overlay', 'is-record', false);
    this._setOverlayOpen(true);
  }

  _setOverlayOpen(on) {
    if (this._overlayOpen === on) return;
    this._overlayOpen = on;
    this._class(this.el.overlay, 'overlay', 'is-open', on);
    this._attr(this.el.overlay, 'aria-hidden', 'overlay', on ? 'false' : 'true');
    if (!on) return;
    // Hand focus to the card (tabIndex -1) rather than a button, and clear any
    // focused pill, so the first Space of a run only reaches the game.
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    if (active && active !== this.el.overlayCard && typeof active.blur === 'function') {
      active.blur();
    }
    if (this.el.overlayCard && typeof this.el.overlayCard.focus === 'function') {
      this.el.overlayCard.focus({ preventScroll: true });
    }
  }

  /** Dim the control strip once the player is clearly past the tutorial. */
  setHintsMuted(on) {
    this._class(this.el.hint, 'hint', 'is-muted', on);
  }

  /* ---------------------------------------------------------------- wiring -- */

  bindHandlers(handlers) {
    if (!handlers) return this;
    const fn = ['onStart', 'onRestart', 'onPause', 'onCamera', 'onQuality'];
    for (let i = 0; i < fn.length; i++) {
      const n = fn[i];
      if (typeof handlers[n] === 'function') this.handlers[n] = handlers[n];
    }
    if (handlers.onToggle && (typeof handlers.onToggle === 'function' || typeof handlers.onToggle === 'object')) {
      this.handlers.onToggle = handlers.onToggle;
    }
    return this;
  }

  /** Reflect a uiState on its own (settings reset, persistence load, boot). */
  applyUiState(uiState) {
    this.sync(null, uiState);
    return this;
  }

  /** Drop the per-frame caches after an external DOM edit. */
  invalidate() {
    this._textCache.clear();
    this._attrCache.clear();
    this._classCache.clear();
    this._hitOpacity = -1;
    this._fpsShown = -1;
    return this;
  }
}

export { CAMERA_MODES };
export default HUD;
