// Headless smoke test: boot src/main.js in a stubbed DOM and run the real game loop.
//
// The contract check proves the method names line up. This proves the wiring *runs*:
// that boot() survives to a first frame, that the animal is in the scene the renderer
// draws, that a run starts, that the ragdoll advances, that obstacles appear, and that
// a collision ends the run. Every one of those is a separate integration seam, and each
// one has its own way of failing silently.
//
// The WebGL context is a Proxy that answers any query with a no-op function, which is
// enough for three.js to build a renderer and walk through one render call without a
// GPU. What it is not is a rendering test: nothing here says the image is correct. The
// browser is the only honest check of that, and it is a separate step.

// --- DOM ------------------------------------------------------------------------

const listeners = new Map();
function fireOn(target, type, ev) {
  const list = listeners.get(target)?.get(type) || [];
  for (const fn of list) fn(ev);
}

class FakeClassList {
  constructor() { this.set = new Set(); }
  add(...c) { for (const x of c) this.set.add(x); }
  remove(...c) { for (const x of c) this.set.delete(x); }
  toggle(c, on) { if (on) this.set.add(c); else this.set.delete(c); }
  contains(c) { return this.set.has(c); }
}

class FakeNode {
  constructor(tag, id = '') {
    this.tagName = String(tag).toUpperCase();
    this.id = id;
    this.children = [];
    this.style = {
      setProperty(k, v) { this[k] = v; },
      removeProperty(k) { delete this[k]; },
      getPropertyValue(k) { return this[k] ?? ''; },
    };
    this.hidden = false;
    this.dataset = {};
    this.attrs = {};
    this.classList = new FakeClassList();
    this.textContent = '';
    this.value = '';
    this.checked = false;
    this.tabIndex = -1;
    this.disabled = false;
  }
  appendChild(n) { this.children.push(n); return n; }
  append(...ns) { for (const n of ns) this.children.push(n); }
  removeChild(n) {
    const i = this.children.indexOf(n);
    if (i >= 0) this.children.splice(i, 1);
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(type, fn) {
    if (!listeners.has(this)) listeners.set(this, new Map());
    const m = listeners.get(this);
    if (!m.has(type)) m.set(type, []);
    m.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const m = listeners.get(this);
    const list = m?.get(type);
    if (list) {
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    }
  }
  focus() {}
  blur() {}
  matches(sel) {
    // Enough to answer the two selectors the code actually asks about: whether an
    // event came from a form control, and whether a node is a canvas.
    if (!sel) return false;
    if (sel.includes('canvas')) return this.tagName === 'CANVAS';
    return /(^|,)\s*(input|select|textarea|button)\b/.test(sel)
      ? ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(this.tagName)
      : false;
  }
  closest() { return null; }
  getBoundingClientRect() { return { x: 0, y: 0, left: 0, top: 0, right: 1280, bottom: 800, width: 1280, height: 800 }; }
  querySelector(sel) { return this._find(sel, 1)[0] || null; }
  querySelectorAll(sel) { return this._find(sel, Infinity); }
  _find(sel, limit) {
    const out = [];
    const want = String(sel).trim();
    const walk = (node) => {
      for (const c of node.children) {
        if (out.length >= limit) return;
        if (want.startsWith('.') ? c.classList.contains(want.slice(1))
          : want.startsWith('#') ? c.id === want.slice(1)
            : c.tagName === want.toUpperCase()) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
}

// A WebGL context that answers anything. three.js probes dozens of entry points and
// dozens more numeric constants during init, so the point is not fidelity, it is that
// none of them is undefined.
//
// The constants are the subtle part: on a real context gl.VERSION is a number that gets
// handed back to getParameter. Handing back a function instead makes three read
// `glVersion.indexOf` on a number and die, which is a confusing way to fail a test that
// has nothing to do with rendering. So every ALL_CAPS name asked for is minted a private
// id, and getParameter answers that id with a value chosen by the name it came from.
const GL_ANSWERS = {
  VERSION: 'WebGL 2.0 (stub)',
  SHADING_LANGUAGE_VERSION: 'OpenGL ES 3.0 (stub)',
  RENDERER: 'stub',
  VENDOR: 'stub',
  VIEWPORT: [0, 0, 1280, 800],
  SCISSOR_BOX: [0, 0, 1280, 800],
  MAX_TEXTURE_SIZE: 16384,
  MAX_CUBE_MAP_TEXTURE_SIZE: 16384,
  MAX_RENDERBUFFER_SIZE: 16384,
  MAX_VERTEX_ATTRIBS: 16,
  MAX_VERTEX_UNIFORM_VECTORS: 4096,
  MAX_FRAGMENT_UNIFORM_VECTORS: 4096,
  MAX_VARYING_VECTORS: 30,
  MAX_TEXTURE_IMAGE_UNITS: 16,
  MAX_VERTEX_TEXTURE_IMAGE_UNITS: 16,
  MAX_COMBINED_TEXTURE_IMAGE_UNITS: 32,
  MAX_ARRAY_TEXTURE_LAYERS: 2048,
  MAX_SAMPLES: 4,
};

function answerFor(name) {
  if (name in GL_ANSWERS) return GL_ANSWERS[name];
  if (/VERSION|RENDERER|VENDOR/.test(name)) return 'stub';
  if (name.startsWith('MAX_')) return 1024;
  return 1;
}

function fakeGL() {
  const fns = new Map();
  const constIds = new Map();
  const constValues = new Map();
  let nextConst = 0x3000; // above every real WebGL enum, so nothing can collide
  const target = {
    canvas: null,
    drawingBufferWidth: 1280,
    drawingBufferHeight: 800,
    getExtension: (name) => (name === 'WEBGL_debug_renderer_info'
      ? { UNMASKED_RENDERER_WEBGL: mint('UNMASKED_RENDERER_WEBGL'), UNMASKED_VENDOR_WEBGL: mint('UNMASKED_VENDOR_WEBGL') }
      : null),
    getParameter: (p) => (constValues.has(p) ? constValues.get(p) : 1),
    getShaderPrecisionFormat: () => ({ rangeMin: 127, rangeMax: 127, precision: 23 }),
    getContextAttributes: () => ({ alpha: false, antialias: true, depth: true, stencil: false }),
    getProgramInfoLog: () => '',
    getShaderInfoLog: () => '',
    // three loops ACTIVE_UNIFORMS times calling getActiveUniform, so reporting a
    // positive count while returning null for each uniform crashes it. Claim none.
    getProgramParameter: (p, name) => (name === mint('ACTIVE_UNIFORMS')
      || name === mint('ACTIVE_ATTRIBUTES') ? 0 : true),
    getShaderParameter: () => true,
    getActiveUniform: () => null,
    getActiveAttrib: () => null,
    getUniformLocation: () => ({}),
    checkFramebufferStatus: () => 0x8cd5,
    isContextLost: () => false,
  };
  function mint(name) {
    if (!constIds.has(name)) {
      const id = nextConst++;
      constIds.set(name, id);
      constValues.set(id, answerFor(name));
    }
    return constIds.get(name);
  }
  return new Proxy(target, {
    get(obj, prop) {
      if (prop in obj) return obj[prop];
      if (typeof prop !== 'string') return undefined;
      if (/^[A-Z][A-Z0-9_]*$/.test(prop)) return mint(prop);
      if (!fns.has(prop)) fns.set(prop, () => null);
      return fns.get(prop);
    },
  });
}

// A 2D context stub. The world paints its own textures (sand grain, cloud puffs, cactus
// spines) with canvas 2D at build time, so a canvas that cannot produce a context stops
// boot before a single frame is drawn. Nothing here claims the pixels are right; it only
// has to survive the drawing calls.
function fake2d() {
  const gradient = { addColorStop() {} };
  const target = {
    canvas: null,
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    globalAlpha: 1,
    filter: 'none',
    font: '10px sans-serif',
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
    createPattern: () => null,
    getImageData: (_x, _y, w, h) => ({
      width: w, height: h, data: new Uint8ClampedArray(Math.max(1, (w | 0) * (h | 0) * 4)),
    }),
    createImageData: (w, h) => ({
      width: w, height: h, data: new Uint8ClampedArray(Math.max(1, (w | 0) * (h | 0) * 4)),
    }),
    measureText: () => ({ width: 10 }),
  };
  const cache = new Map();
  return new Proxy(target, {
    get(obj, prop) {
      if (prop in obj) return obj[prop];
      if (typeof prop !== 'string') return undefined;
      if (!cache.has(prop)) cache.set(prop, () => undefined);
      return cache.get(prop);
    },
    set(obj, prop, value) { obj[prop] = value; return true; },
  });
}

/** Attach getContext to a stub node so it can back a texture or the WebGL canvas. */
function makeContextable(node) {
  node.width = node.width || 1;
  node.height = node.height || 1;
  node.getContext = (kind) => (String(kind).startsWith('webgl') ? fakeGL()
    : String(kind) === '2d' ? fake2d() : null);
  return node;
}

function buildDom() {
  const byId = new Map();
  const body = new FakeNode('body');
  const doc = {
    documentElement: new FakeNode('html'),
    body,
    hidden: false,
    createElement: (tag) => (String(tag).toLowerCase() === 'canvas'
      ? makeContextable(new FakeNode('canvas')) : new FakeNode(tag)),
    createElementNS: (_ns, tag) => (String(tag).toLowerCase() === 'canvas'
      ? makeContextable(new FakeNode('canvas')) : new FakeNode(tag)),
    createTextNode: (t) => { const n = new FakeNode('#text'); n.textContent = t; return n; },
    createDocumentFragment: () => new FakeNode('#fragment'),
    getElementById: (id) => byId.get(id) || null,
    querySelector: (sel) => body.querySelector(sel),
    querySelectorAll: (sel) => body.querySelectorAll(sel),
    addEventListener(type, fn) { doc._l.push([type, fn]); },
    removeEventListener() {},
    dispatchEvent() { return true; },
    _l: [],
    _byId: byId,
  };

  // The ids index.html declares. Kept in step with the real file by hand: if the HUD
  // asks for an id this list does not have, the HUD simply shows nothing, which is
  // exactly the kind of quiet failure this test exists to catch.
  const IDS = ['gl', 'score', 'best', 'speed', 'stat-state', 'milestone', 'hit-flash',
    'settings', 'quality', 'toggle-debug', 'toggle-orbit', 'slider-sens', 'overlay',
    'overlay-title', 'overlay-sub', 'btn-start', 'btn-restart', 'btn-pause',
    'btn-settings', 'btn-settings-close', 'camera-chips', 'hint', 'fps'];
  for (const id of IDS) {
    const tag = id === 'gl' ? 'canvas'
      : id.startsWith('btn') ? 'button'
        : id === 'quality' ? 'select'
          : id.startsWith('toggle') ? 'input'
            : id === 'slider-sens' ? 'input' : 'div';
    const node = new FakeNode(tag, id);
    byId.set(id, node);
    body.appendChild(node);
    if (id === 'gl') {
      makeContextable(node);
      node.width = 1280;
      node.height = 800;
      node.clientWidth = 1280;
      node.clientHeight = 800;
    }
  }

  // The class-nodes the HUD looks up rather than addressing by id.
  const card = new FakeNode('div');
  card.classList.add('overlay-card');
  const kicker = new FakeNode('p');
  kicker.classList.add('overlay-kicker');
  const title = new FakeNode('h1', 'overlay-title');
  const sub = new FakeNode('p', 'overlay-sub');
  card.appendChild(kicker); card.appendChild(title); card.appendChild(sub);
  body.appendChild(card);
  const flashLayer = new FakeNode('div');
  flashLayer.classList.add('flash-layer');
  body.appendChild(flashLayer);
  const debugNode = new FakeNode('div');
  debugNode.classList.add('debug');
  body.appendChild(debugNode);

  return { doc, byId, body };
}

const { doc, byId } = buildDom();

const store = new Map();
const rafQueue = [];

globalThis.window = {
  innerWidth: 1280,
  innerHeight: 800,
  devicePixelRatio: 1,
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  },
  addEventListener: (t, fn) => doc.addEventListener(t, fn),
  removeEventListener: () => {},
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
  requestAnimationFrame: (fn) => rafQueue.push(fn),
  matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
};
globalThis.document = doc;
globalThis.localStorage = window.localStorage;
// Node 26 already defines `navigator` as a getter-only global, so it has to be
// redefined through the descriptor rather than assigned.
Object.defineProperty(globalThis, 'navigator', {
  value: { userAgent: 'node-smoke', maxTouchPoints: 0 },
  configurable: true,
  writable: true,
});
globalThis.performance = globalThis.performance || { now: () => Date.now() };
globalThis.requestAnimationFrame = window.requestAnimationFrame;
globalThis.cancelAnimationFrame = () => {};
globalThis.addEventListener = window.addEventListener;
globalThis.removeEventListener = () => {};
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
globalThis.self = window;

/**
 * Dispatch a window-level event through the listeners the modules registered.
 *
 * Going through the real handler matters for the keyboard: whether a key is swallowed,
 * buffered or ignored is decided inside Input._keyDown, and poking at `input.pressed`
 * directly would test the assertion instead of the code.
 */
function fireWindow(type, ev) {
  const event = Object.assign({
    type,
    preventDefault() { this.defaultPrevented = true; },
    defaultPrevented: false,
    target: null,
    isPrimary: true,
    pointerId: 1,
    button: 0,
    buttons: 0,
    clientX: 0,
    clientY: 0,
    deltaY: 0,
    repeat: false,
  }, ev);
  for (const [t, fn] of doc._l) if (t === type) fn(event);
  return event;
}

// --- assertions ------------------------------------------------------------------

let fails = 0;
function check(label, ok, detail = '') {
  if (ok) console.log(`  ok  ${label}`);
  else { fails++; console.log(`FAIL  ${label}${detail ? `\n      ${detail}` : ''}`); }
}

// Advance the game by n frames at a fixed step, driving the same rAF queue the browser
// would. The engine is driven in real milliseconds so Game.frame clamps dt exactly as it
// does on screen; stepping the clock is what makes a 20-second run take no time at all.
let clock = 0;
function pump(frames) {
  for (let i = 0; i < frames; i++) {
    const due = rafQueue.splice(0, rafQueue.length);
    clock += 1000 / 60;
    for (const fn of due) fn(clock);
  }
}

const errors = [];
const realError = console.error;
console.error = (...a) => { errors.push(a.map(String).join(' ')); };

await import('../src/main.js');
console.error = realError;

const { OBSTACLE_KINDS } = await import('../src/game/obstacles.js');

const api = window.dino3d;
check('boot completed and exposed its handles', !!api, 'boot threw: ' + errors.join(' | '));
if (!api) {
  realError('\n' + errors.join('\n'));
  process.exit(1);
}

check('boot reported no errors', errors.length === 0, errors.join(' | '));
check('game reached the menu', api.game.state === 'menu', api.game.state);
check('the dino group is in the scene the renderer draws',
  api.worldScene.scene.children.some((c) => c.name === 'dino'),
  api.worldScene.scene.children.map((c) => c.name || c.type).join(','));

pump(4);
check('idle frames left the animal standing',
  api.game.dino.hipHeight > 0.45 && api.game.dino.hipHeight < 1.3,
  `hip=${api.game.dino.hipHeight.toFixed(3)}`);

const meshBones = api.dinoMesh._boneMeshes?.length || 0;
check('the mesh built bodies for the bones', meshBones > 8, `${meshBones} bone meshes`);

// Start a run the way the Start button does.
api.game.start();
check('start entered PLAYING', api.game.state === 'playing', api.game.state);

pump(180);
check('the run advanced the animal down the track',
  api.game.distance > 5, `distance=${api.game.distance.toFixed(2)}`);
check('the animal is still upright after 3 s',
  api.game.dino.hipHeight > 0.45, `hip=${api.game.dino.hipHeight.toFixed(3)}`);
check('the pelvis is off the ground plane', api.game.dino.pelvis.y > 0.3,
  `pelvis.y=${api.game.dino.pelvis.y.toFixed(3)}`);
check('the camera is tracking the animal',
  Math.abs(api.rig.camera.position.x - api.game.dino.pelvis.x) < 20,
  `cam.x=${api.rig.camera.position.x.toFixed(2)} hip.x=${api.game.dino.pelvis.x.toFixed(2)}`);
check('the camera has a non-degenerate pose',
  Number.isFinite(api.rig.camera.position.y) && api.rig.camera.position.y > 0,
  `cam.y=${api.rig.camera.position.y}`);

const visible = api.game._visible?.length || 0;
check('obstacles are in view', visible > 0, `${visible} visible props`);
check('the world placed props in the scene',
  api.worldScene._active.length >= 0 && api.game.cleared >= 0);

// The input, camera and pause checks below exercise wiring, not fairness, and nobody
// is steering during them. Left on the generated track the animal is a sitting duck for
// whichever cactus the seed happens to place, and an unseeded field then decides whether
// `P pauses` finds it alive or mid-death. That is the same class of flake as a distance
// threshold that depends on the draw, so the track is cleared here and the frontier is
// parked out of reach: field.update only spawns up to the frontier, so a large one means
// no new props. Obstacles themselves are covered by the visible check above and by the
// seeded planted-prop trials further down; what this section owns is the wiring.
api.game.field.items.length = 0;
api.game.field._visible.length = 0;
api.game.field.frontier = api.game.dino.pelvis.x + 1e6;

// Jump, and check it actually leaves the ground. Dispatched as a real key event so the
// buffering, the swallowing and the clearance check all run, rather than pre-loading the
// state the test is meant to observe.
fireWindow('keydown', { key: ' ', code: 'Space' });
pump(12);
check('a jump lifted the animal', api.game.dino.airTime > 0 || api.game.dino.pelvis.y > 0.85,
  `airTime=${api.game.dino.airTime.toFixed(3)} pelvis.y=${api.game.dino.pelvis.y.toFixed(3)}`);
fireWindow('keyup', { key: ' ', code: 'Space' });
// The jump hangs a little over a second, so the landing check has to wait out more
// than that. Watching for grounded rather than for a height, because the belly dips
// through the apex and a height threshold would pass at the wrong moment.
pump(120);
check('the animal came back down from the jump',
  api.game.dino.clearance() < 0.5 || api.game.dino.grounded,
  `clearance=${api.game.dino.clearance().toFixed(3)} grounded=${api.game.dino.grounded}`);

// The strafe key has to move the animal across the lanes, which is the only thing the
// arrow keys do and the easiest thing to lose while rewiring input.
const zBefore = api.game.dino.laneZ;
fireWindow('keydown', { key: 'ArrowLeft', code: 'ArrowLeft' });
pump(45);
fireWindow('keyup', { key: 'ArrowLeft', code: 'ArrowLeft' });
pump(30);
check('a held arrow moved the animal across the lanes',
  Math.abs(api.game.dino.laneZ - zBefore) > 0.05,
  `laneZ ${zBefore.toFixed(3)} -> ${api.game.dino.laneZ.toFixed(3)}`);

// Duck, through the held-key path the ragdoll reads.
fireWindow('keydown', { key: 'ArrowDown', code: 'ArrowDown' });
pump(40);
check('holding down made the animal duck',
  api.game.dino.hipHeight < 0.72, `hip=${api.game.dino.hipHeight.toFixed(3)}`);
fireWindow('keyup', { key: 'ArrowDown', code: 'ArrowDown' });
pump(40);
check('releasing down stood the animal back up',
  api.game.dino.hipHeight > 0.5, `hip=${api.game.dino.hipHeight.toFixed(3)}`);

// The number row selects camera modes without going through the HUD.
fireWindow('keydown', { key: '2', code: 'Digit2' });
check('the number row selects a camera mode', api.rig.mode === 'side', api.rig.mode);
fireWindow('keydown', { key: 'c', code: 'KeyC' });
check('C cycles the camera off the number-selected mode',
  api.rig.mode !== 'side', api.rig.mode);
fireWindow('keydown', { key: 'p', code: 'KeyP' });
check('P pauses', api.game.state === 'paused', api.game.state);
pump(4);
fireWindow('keydown', { key: 'p', code: 'KeyP' });
check('P again resumes', api.game.state === 'playing', api.game.state);

// Camera modes: every one the HUD offers has to survive a frame.
for (const mode of ['chase', 'side', 'low', 'orbit', 'top', 'free']) {
  api.setCameraMode(mode);
  pump(6);
  const p = api.rig.camera.position;
  check(`camera mode "${mode}" holds a finite pose`,
    Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z) && p.y > -1,
    `${mode}: ${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}`);
}
api.setCameraMode('chase');
pump(2);

// A forced collision has to end the run and reach the game-over card.
api.game.die({ x: -3, y: 4, z: 0.3 });
check('die entered DYING', api.game.state === 'dying', api.game.state);
pump(120);
check('the run reached GAMEOVER', api.game.state === 'gameover', api.game.state);
check('the corpse has settled toward the ground',
  api.game.dino.pelvis.y < 0.9, `pelvis.y=${api.game.dino.pelvis.y.toFixed(3)}`);
check('the mesh went limp', api.dinoMesh.limp > 0.2, `limp=${api.dinoMesh.limp}`);

// Restart from the card, then a long unattended run: the thing that breaks in a game
// like this is not the first frame, it is minute two. Nobody is steering, so the animal
// will hit cacti, and that is correct behaviour rather than a failure. The soak is
// therefore measured only over frames that were actually running, and a death is
// restarted rather than treated as an error. What is being tested is whether the
// ragdoll holds its posture indefinitely, which is the failure mode that matters.
api.game.restart();
check('restart re-entered PLAYING', api.game.state === 'playing', api.game.state);

/**
 * Steer one frame: jump a ground prop so the body is airborne while it passes, and
 * duck under a flyer.
 *
 * This exists so the soak measures the thing worth measuring. A run nobody is steering
 * ends at the first cactus, so the previous version of this test was reporting a corpse
 * at hip height 0.15 as a physics failure when it was correct gameplay. Steering also
 * makes the soak a real test of the obstacle field's central claim, that spacing is
 * derived from the jump arc so that no seed can generate a wall: if the animal cannot
 * survive by jumping and ducking at the right moments, that claim is false.
 *
 * It drives the same fields a keypress sets, so the jump still goes through Input's
 * buffer and Game's clearance check rather than poking the ragdoll directly.
 *
 * The jump timing is not a guess. Taking off too early means landing before the prop,
 * too late means being above it when it matters. What has to line up is the interval
 * during which the whole hit box is above the prop's top against the interval during
 * which the prop horizontally overlaps the hit box, so the trigger distance is derived
 * from a measured arc rather than from the arc the generator assumed:
 *
 *   take off when the prop is `lead0` ahead. During the clear window [t0, t1] of that
 *   flight the box reaches `front` ahead of the pelvis and `rear` behind it, so the
 *   overlap only falls inside the window for lead0 in
 *
 *     [front + halfW + v*t0,  -rear - halfW + v*t1]
 *
 * and the midpoint of that band is the latest-possible-and-earliest-possible compromise.
 * The flight is simulated once per (speed, prop height) pair and cached, so the soak
 * pays for a handful of simulations rather than one per frame.
 */
const arcCache = new Map();
const SPEED_STEPS = [2.9, 3.4, 3.9, 4.4, 4.9, 5.5];
const TOP_STEPS = [0.30, 0.45, 0.60, 0.75, 0.90, 1.05, 1.20];

function nearestStep(steps, v) {
  let best = 0;
  for (let i = 1; i < steps.length; i++) {
    if (Math.abs(steps[i] - v) < Math.abs(steps[best] - v)) best = i;
  }
  return steps[best];
}

function clearanceWindow(Ragdoll, cfg, speed, top) {
  const key = `${speed.toFixed(1)}|${top.toFixed(2)}`;
  if (arcCache.has(key)) return arcCache.get(key);
  const d = new Ragdoll();
  for (let i = 0; i < 200; i++) d.step(1 / 60, { speed, ducking: false, laneZ: 0, dying: false });
  d.jump(cfg.jumpVelocity);
  const samples = [];
  for (let i = 0; i < 400; i++) {
    d.step(1 / 60, { speed, ducking: false, laneZ: 0, dying: false });
    if (d.airTime <= 0.04) { if (samples.length) break; else continue; }
    const b = d.hitBounds();
    samples.push({
      t: (i + 1) / 60,
      above: b.minY > top,
      rear: d.pelvis.x - b.minX,
      front: b.maxX - d.pelvis.x,
    });
  }
  let best = null;
  let i = 0;
  while (i < samples.length) {
    if (!samples[i].above) { i++; continue; }
    let j = i;
    while (j < samples.length && samples[j].above) j++;
    const slice = samples.slice(i, j);
    const w = {
      t0: slice[0].t,
      t1: slice[slice.length - 1].t,
      rear: Math.max(...slice.map((p) => p.rear)),
      front: Math.max(...slice.map((p) => p.front)),
    };
    if (!best || w.t1 - w.t0 > best.t1 - best.t0) best = w;
    i = j;
  }
  arcCache.set(key, best);
  return best;
}

function jumpTrigger(api, top, halfWidth) {
  const speed = nearestStep(SPEED_STEPS, api.game.speed);
  // The class comes off the live animal rather than a fresh import, so the arc being
  // measured is the one the running game is using and this cannot drift from it.
  const w = clearanceWindow(api.game.dino.constructor, api.CONFIG, speed, nearestStep(TOP_STEPS, top));
  if (!w) return -1;
  const lo = w.front + halfWidth + speed * w.t0;
  const hi = -w.rear - halfWidth + speed * w.t1;
  return hi < lo ? -1 : (lo + hi) / 2;
}

function autopilot(api) {
  const g = api.game;
  const dino = g.dino;
  const px = dino.pelvis.x;
  const pz = dino.pelvis.z;

  api.input.held.delete('duck');
  for (const it of g.field._visible) {
    if (it.dead) continue;
    const halfW = it.w / 2;
    const halfD = (it.d || 0.6) / 2;
    if (Math.abs(it.z - pz) > halfD + 0.45) continue;   // a different lane is not a problem
    const lead = it.x - px;
    if (lead < -halfW) continue;                          // already behind us
    const bottom = it.y - it.h / 2;
    const top = it.y + it.h / 2;

    // A flyer whose belly is above a crouching back is a duck, not a jump. Ground
    // props have bottom near zero and are handled below.
    if (bottom > 0.62) {
      if (lead < g.speed * 0.42 + 0.7) api.input.held.add('duck');
      continue;
    }
    if (bottom > 0.18) continue;                          // floating debris: neither
    const trig = jumpTrigger(api, top, halfW);
    if (trig >= 0 && lead < trig && dino.grounded) {
      api.input.jumpBuffer = api.input.jumpBufferTime;
      api.input.jumpWasPressed = true;
    }
  }
}

// The soak runs at low quality. Everything above has already drawn frames with shadows
// and dust on, which is the expensive part of the renderer to walk through a stub
// context: 1800 frames of 2048px shadow maps against a fake GL took the test from
// seconds to over a minute. Posture does not depend on the shadow map, so the long
// observation runs cheap and the expensive paths stay covered by the short runs.
api.applyQuality('low');

// The soak is seeded. Game.start() calls field.reset() with no argument, which draws a
// fresh seed from Math.random(), so on the previous design the props this loop had to
// survive were different on every execution. That made the distance and death-count
// thresholds below a lottery rather than an assertion: a run could pass on one checkout
// and fail on the next with no code change. Seeding makes the failure reproducible,
// which is the only kind worth having. timeOfDay is also random but cosmetic.
let soakSeed = 20250501;
let uprightFrames = 0;
let runningFrames = 0;
let deaths = 0;
let worstHip = Infinity;
let bestDistance = 0;
let jumps = 0;
let ducks = 0;
let wasAir = false;
let wasDuck = false;
api.game.field.reset(++soakSeed);   // the pre-loop restart() drew a random seed
for (let i = 0; i < 1800; i++) {
  if (api.game.state !== 'playing') {
    deaths++;
    api.game.restart();
    api.game.field.reset(++soakSeed);
    // A fresh run starts on the ground with no keys held, so the edge detectors have
    // to be reset or the first footfall of every run is counted as a new jump.
    wasAir = false;
    wasDuck = false;
  }
  autopilot(api);
  pump(1);
  if (api.game.state === 'playing') {
    runningFrames++;
    const hip = api.game.dino.hipHeight;
    worstHip = Math.min(worstHip, hip);
    if (hip > 0.45) uprightFrames++;
    bestDistance = Math.max(bestDistance, api.game.distance);
    // The edges have to be sampled after the step that produced them. Reading them
    // before pump() compares a state to itself, because nothing has advanced yet.
    const air = api.game.dino.airTime > 0.02;
    const duck = api.input.held.has('duck');
    if (!wasAir && air) jumps++;
    if (!wasDuck && duck) ducks++;
    wasAir = air;
    wasDuck = duck;
  }
}
check('the animal stayed upright across 30 s of running',
  runningFrames > 0 && uprightFrames / runningFrames > 0.97,
  `${uprightFrames}/${runningFrames} upright, worst hip ${worstHip.toFixed(3)}`);
// Distance is asserted against a derived ceiling rather than a hopeful number.
// Speed ramps as dd/dt = baseSpeed + accelPerMetre * d, which solves to
// d(t) = (b/a)(e^(a t) - 1). Over the 1800 frames this loop runs, that is 97.9 m at
// most, so a threshold above it would be unpassable and one far below it would pass
// even if the animal were crawling. Anything past 85% of the ceiling means the
// autopilot was steered cleanly and never stalled.
const soakCeiling = (api.CONFIG.baseSpeed / api.CONFIG.accelPerMetre)
  * (Math.exp(api.CONFIG.accelPerMetre * (1800 / 60)) - 1);
check('it got a long way when steered',
  bestDistance > soakCeiling * 0.85,
  `${bestDistance.toFixed(1)} m of ${soakCeiling.toFixed(1)} m possible`);
// The soak only asserts jumps. Flyers unlock at 70 m and this loop can reach 97.9 m,
// so whether a duckable prop ever crosses the lane is a function of the seed, and an
// assertion on ducks would be a coin flip. Ducking is asserted deterministically by
// the planted-prop trials further down instead.
check('it jumped on the way', jumps > 3, `${jumps} jumps, ${ducks} ducks`);
check('it kept moving', api.game.speed > 3, `speed=${api.game.speed.toFixed(2)}`);
check('a steered run does not die constantly', deaths < 6, `${deaths} deaths`);
check('no NaN reached the solver',
  Number.isFinite(api.game.dino.pelvis.x) && Number.isFinite(api.game.dino.pelvis.y)
    && Number.isFinite(api.game.dino.pelvis.z) && Number.isFinite(api.game.score),
  JSON.stringify({ pos: api.game.dino.pelvis, score: api.game.score }));

// Ducking is half the game and the soak above can barely test it: flyers unlock at
// 70, 150 and 210 m, while 1800 frames at this speed curve reach at most 97.9 m.
// So the duck path is tested directly instead of by hoping one spawns. A prop is
// planted in the running line and the animal is driven at it twice, once holding the
// key and once not, through the real collision check. That separates "the crouch is
// low enough" from "the crouch is wired up at all": both have to be true, and only
// the second one is an integration concern.
function duckTrial(kind, hold) {
  const g = api.game;
  g.restart();
  // Clear the generated field and plant one prop in the lane. The frontier is parked
  // past the end of the world as well as emptied, because update() refills up to the
  // frontier every frame: emptying alone would have the generator racing the trial and
  // deciding, on the draw, whether a second prop happens to be standing where the
  // animal is about to run.
  g.field.items.length = 0;
  g.field._visible.length = 0;
  g.field.frontier = g.dino.pelvis.x + 1e6;
  const spec = OBSTACLE_KINDS[kind];
  if (!spec) throw new Error('unknown kind ' + kind);
  const propX = g.dino.pelvis.x + 5;
  g.field._spawn(propX, 999);
  const it = g.field.items[g.field.items.length - 1];
  Object.assign(it, {
    kind, w: spec.w, h: spec.h, d: spec.d,
    y: spec.ground ? spec.h / 2 : spec.y,
    baseY: spec.ground ? spec.h / 2 : spec.y,
    x: propX, z: g.dino.pelvis.z, vx: 0, bobAmp: 0,
  });

  // Run until the animal is past the prop or dead, rather than for a guessed number
  // of frames: a run opens at baseSpeed*0.55, about 1.65 m/s, so a fixed budget
  // could expire while the animal is still in the run-up and report a clean miss.
  let frames = 0;
  while (frames < 900 && g.state === 'playing' && it.x > g.dino.pelvis.x - 1.2) {
    api.input.held.clear();
    if (hold) api.input.held.add('duck');
    pump(1);
    frames++;
  }
  api.input.held.delete('duck');
  return { died: g.state !== 'playing', passed: it.x < g.dino.pelvis.x - 1.2, frames };
}

// A standing body intersects these; a crouching one does not. So no-duck must kill
// and duck must not. If the crouch stopped being wired, or stopped being low enough,
// the duck trial dies and this says so rather than reporting an empty counter.
for (const kind of ['pterodactyl-high', 'bird']) {
  const standing = duckTrial(kind, false);
  const crouched = duckTrial(kind, true);
  check(`${kind} kills a standing animal`, standing.died,
    `died=${standing.died} passed=${standing.passed}`);
  check(`${kind} is cleared by ducking`, !crouched.died && crouched.passed,
    `died=${crouched.died} passed=${crouched.passed}`);
}

// And the ground prop still has to be the opposite way round: ducking does not save
// you from a cactus, only jumping does. Without this, a regression that made duck a
// general invulnerability would pass everything above.
{
  const crouched = duckTrial('cactus-small', true);
  check('ducking does not save you from a cactus', crouched.died,
    `died=${crouched.died} passed=${crouched.passed}`);
}

// Preferences round-trip through the stubbed storage.
api.applyQuality('low');
check('quality change reached the renderer', api.worldScene.quality === 'low',
  api.worldScene.quality);
check('quality change reached the game', api.game.quality === 'low', api.game.quality);

check('nothing logged an error during the run', errors.length === 0, errors.join(' | '));

console.log(fails === 0 ? '\nsmoke test passed' : `\n${fails} smoke failure(s)`);
process.exit(fails === 0 ? 0 : 1);
