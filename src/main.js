// Bootstrap. Everything here exists to answer one question: in what order do the
// parts get built, so that no part is ever handed a half-initialised other part.
//
//   1. THREE, the canvas, and a camera this file owns.
//   2. Game. It builds its own DinoRagdoll and ObstacleField, and the ragdoll builds
//      its own PhysicsWorld, which the mesh then reads particle positions out of.
//   3. WorldScene and CameraRig, which need the canvas and the camera respectively.
//   4. DinoMesh, wired to the ragdoll's own world object, because it reads the
//      solver through that reference rather than being fed positions.
//   5. Input, which the Game was constructed without, and which is attached here.
//   6. HUD, which owns its own DOM wiring and needs the Game to exist to point at.
//
// There is exactly one rAF loop, and it is the Game's. Reimplementing it here was
// the first draft and it was wrong: Game.frame owns dt clamping, fps smoothing and
// the fixed-step accumulator, and a second loop would have meant two clocks.
//
// Key events are owned by Input alone. Input attaches its own window listeners and
// forwards pointer gestures to the camera rig it is given, so the one thing this file
// has to do about the keyboard is stay out of its way and pass it the rig.
import * as THREE from '../vendor/three.module.js';
import { CONFIG } from './game/config.js';
import { WorldScene } from './render/world.js';
import { DinoMesh } from './render/dinoMesh.js';
import { CameraRig } from './camera/cameraRig.js';
import { Input } from './input/input.js';
import { HUD } from './ui/hud.js';
import { Game } from './game/game.js';

const STORE_KEY = 'dino3d.ui.v1';
const BEST_KEY = 'dino3d.best.v1';

/**
 * Read a stored object without letting it take the game down.
 *
 * localStorage throws in private mode, under quota pressure, and on a value written
 * by a future version of this file that no longer parses. Preferences are not worth
 * losing a run over, so every failure path returns null and the caller falls back.
 */
function readJson(key) {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function writeJson(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignored for the same reason as above.
  }
}

function readBest() {
  try {
    const raw = Number(window.localStorage.getItem(BEST_KEY));
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
  } catch {
    return 0;
  }
}

function boot() {
  const canvas = document.getElementById('gl');
  if (!canvas) throw new Error('index.html is missing <canvas id="gl">');

  const saved = readJson(STORE_KEY) || {};
  // index.html only offers high and low, and Game's own downgrade ladder reaches for
  // medium, which exists in the world's QUALITY table. Restoring whatever was last in
  // effect means a machine that dropped to medium keeps medium rather than being
  // pushed back up to high on every reload and dropping again.
  const quality = ['high', 'medium', 'low'].includes(saved.quality) ? saved.quality : 'high';

  // A camera this file owns, not one the rig builds. The renderer and the rig have to
  // write and read the same object, and letting the rig own it invites a second
  // camera that quietly renders nothing at all.
  const camera = new THREE.PerspectiveCamera(62, 1, 0.1, 400);

  const game = new Game({});

  const worldScene = new WorldScene({ canvas, THREE, quality });

  // The mesh reads particle positions through the ragdoll's own world object rather
  // than being handed them, so the two have to be the same object, not two copies
  // that agree. It hangs its bodies off the world's scene, which is the one scene the
  // renderer draws: a group added anywhere else is a dinosaur that does not exist.
  // It picks up bones lazily on its first update().
  const dinoMesh = new DinoMesh({ THREE, world: game.dino.world, scene: worldScene.scene });

  const rig = new CameraRig({ THREE, camera });

  const input = new Input({ onAction: (name, arg) => onAction(name, arg) });

  // The camera is owned by the shell and read by the world for fog placement, so
  // wiring it after construction means three assignments rather than two more
  // constructor arguments. Input is last because its constructor attaches window
  // listeners, which cannot mean anything until the Game exists to act on them, and
  // because Game's constructor sets input.onCanvasTap, which is what makes a tap on
  // the canvas start a run rather than silently do nothing.
  game.input = input;
  game.dinoMesh = dinoMesh;
  game.worldRef = worldScene;
  game.camera = rig;

  // The Game reports a new record through this callback rather than touching storage
  // itself, because a game module that reads localStorage is a game module that cannot
  // be run twice in the same test.
  game.onBest = (best) => {
    try {
      window.localStorage.setItem(BEST_KEY, String(Math.floor(best)));
    } catch {
      // Same reasoning as readJson: a run must survive an unusable storage.
    }
  };

  // Input forwards pointer gestures to whatever `camera` is, in the coordinate form
  // the rig expects: client-space numbers, with the canvas as the hit test.
  input.bindCamera(rig, canvas);

  const hud = new HUD({});
  game.hud = hud;

  /**
   * UI state, owned here and pushed to the HUD every frame.
   *
   * The HUD's `sync(ctx, uiState)` writes the controls from this object, and the
   * HUD's own toggles call back into it. Keeping it in one place is what stops the
   * settings panel from showing a quality that the renderer is not using.
   */
  const ui = {
    cameraMode: typeof saved.cameraMode === 'string' ? saved.cameraMode : 'chase',
    quality,
    showDebug: !!saved.showDebug,
    orbitAuto: !!saved.orbitAuto,
    sensitivity: typeof saved.sensitivity === 'number' ? saved.sensitivity : 1,
  };

  let saveQueued = 0;
  function saveUi() {
    // Toggles arrive in bursts (a slider fires per pixel of drag), and each write is a
    // synchronous disk round trip, so saves are coalesced to one per beat.
    if (saveQueued) return;
    saveQueued = window.setTimeout(() => {
      saveQueued = 0;
      writeJson(STORE_KEY, {
        cameraMode: ui.cameraMode,
        quality: ui.quality,
        showDebug: ui.showDebug,
        orbitAuto: ui.orbitAuto,
        sensitivity: ui.sensitivity,
      });
    }, 400);
  }

  function setCameraMode(mode) {
    const applied = rig.setMode(mode);
    ui.cameraMode = typeof applied === 'string' ? applied : rig.mode;
    hud.setCameraMode(ui.cameraMode);
    saveUi();
  }

  function applyQuality(q) {
    if (!['high', 'medium', 'low'].includes(q)) return;
    ui.quality = q;
    game.setQuality(q);
    worldScene.setQuality(q);
    // The renderer caps device pixel ratio at the quality's own limit, so a quality
    // change is a size change and the viewport has to be re-presented to it.
    applyViewport();
    saveUi();
  }

  // Input knows nothing about the game: it reports named actions. This is the only
  // place where an action becomes a game command.
  //
  // Note the shape of Input's contract. It fires onAction(action) for the four gestures
  // it consumes itself (start, restart, pause, cameraMode) and, for every key it
  // recognised, additionally fires onAction('keydown', action). So the keys it does not
  // consume, which are camera-cycle, reverse-cycle and recenter, only ever arrive
  // through the second form, carrying their meaning in the *second* argument. Unwrapping
  // that into one variable and switching on it once is what keeps the two halves from
  // drifting apart; switching on `name` alone left C, V and N dead with no clue in the
  // UI that they were meant to do anything at all.
  function onAction(name, arg) {
    const action = name === 'keydown' ? arg : name;

    // The jump key doubles as the confirm key on the two overlay cards. Space maps to
    // 'jump' rather than 'start', so without this the card that says "Space to jump"
    // ignores Space. Only while an overlay is up: mid-run the branch is inert and the
    // jump is consumed by the ragdoll's own buffering.
    if (action === 'jump' && (game.state === 'menu' || game.state === 'gameover')) {
      game.advance();
      return;
    }

    switch (action) {
      case 'start':
        game.advance();
        break;
      case 'restart':
        game.restart();
        break;
      case 'pause':
        game.togglePause();
        break;
      case 'camera':
        game.cycleCamera(false);
        ui.cameraMode = rig.mode;
        saveUi();
        break;
      case 'cameraBack':
        game.cycleCamera(true);
        ui.cameraMode = rig.mode;
        saveUi();
        break;
      case 'cameraMode':
        setCameraMode(arg);
        break;
      case 'recenter':
        rig.resetView();
        break;
      default:
        break;
    }
  }

  hud.bindHandlers({
    onStart: () => game.start(),
    onRestart: () => game.restart(),
    onPause: () => game.togglePause(),
    onCamera: (mode) => setCameraMode(mode),
    onQuality: (q) => applyQuality(q),
    // The HUD accepts either shape; a single function keeps the four toggles in one
    // readable place instead of four sibling closures.
    onToggle: (name, value) => {
      if (name === 'debug') {
        ui.showDebug = !!value;
        hud.setDebug(!!value);
        dinoMesh.debugSkeleton = !!value;
      } else if (name === 'orbit') {
        ui.orbitAuto = !!value;
        if (rig.setAutoRotate) rig.setAutoRotate(!!value);
      } else if (name === 'sensitivity') {
        ui.sensitivity = Number(value) || 1;
        rig.setSensitivity(ui.sensitivity);
      }
      saveUi();
    },
  });

  function applyViewport() {
    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight);
    // The canvas is sized in CSS by the stylesheet; here we only hand the world the
    // numbers it needs to size its renderer, and keep the camera's aspect correct.
    worldScene.resize(w, h, window.devicePixelRatio || 1);
    rig.setViewport(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  let resizeTimer = 0;
  function onResize() {
    // Layout is not settled during a rotation and rebuilding the projection matrix
    // per event is wasted work, so resizes are coalesced to one per beat.
    if (resizeTimer) window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      resizeTimer = 0;
      applyViewport();
    }, 90);
  }
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onResize);
  applyViewport();

  // A hidden tab is not a pause the player chose, but it is a gap in the clock, and
  // Game.frame clamps dt rather than repaying it. Releasing held keys is the part
  // that actually matters: a duck held through a tab switch would otherwise still be
  // held when the tab comes back, and the player would run crouching with no key down.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) input.releaseAll();
  });

  window.addEventListener('blur', () => input.releaseAll());

  // Restored preferences, applied after every object exists so the controls on screen
  // and the state of the systems agree before the first frame is drawn.
  rig.setSensitivity(ui.sensitivity);
  setCameraMode(ui.cameraMode);
  hud.applyUiState(ui);
  dinoMesh.debugSkeleton = ui.showDebug;

  game.ready({ best: readBest() });
  game.startLoop();

  // Exposed for the console and for the headless smoke test. A game you cannot poke at
  // from the outside is a game you can only debug by editing it.
  window.dino3d = {
    game, worldScene, rig, dinoMesh, input, hud, ui, THREE,
    CONFIG,
    setCameraMode,
    applyQuality,
    reset: () => game.restart(),
  };
  return window.dino3d;
}

// A module script that throws during boot leaves a black canvas and no explanation,
// which is indistinguishable from a slow load. Say something instead.
try {
  boot();
} catch (err) {
  console.error('[dino3d] failed to start', err);
  const card = document.querySelector('.overlay-card');
  if (card) {
    const title = card.querySelector('#overlay-title');
    const sub = card.querySelector('#overlay-sub');
    if (title) title.textContent = 'Could not start';
    if (sub) sub.textContent = String((err && err.message) || err);
  }
}
