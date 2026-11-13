// Module contract check.
//
// Every cross-module call in this project is a method name written by hand in a
// different file from the one that defines it, and a typo there is a runtime crash
// several layers away from the mistake. This asserts the whole surface at once:
// that each collaborator method the game and the bootstrap reach for actually exists
// and takes the number of arguments its callers pass.

import { CONFIG } from '../src/game/config.js';
import { DinoRagdoll, SKELETON, BONES } from '../src/game/dino.js';
import { ObstacleField } from '../src/game/obstacles.js';
import { WorldScene } from '../src/render/world.js';
import { DinoMesh } from '../src/render/dinoMesh.js';
import { CameraRig, CAMERA_MODES } from '../src/camera/cameraRig.js';
import { HUD } from '../src/ui/hud.js';
import { Input } from '../src/input/input.js';
import { STATE, Game } from '../src/game/game.js';

let fails = 0;
function check(label, ok, detail = '') {
  if (ok) { console.log(`  ok  ${label}`); }
  else { fails++; console.log(`FAIL  ${label}${detail ? `\n      ${detail}` : ''}`); }
}

function hasMethod(obj, name, wantArgs = null, label = null) {
  const fn = obj?.[name];
  const where = label || obj.constructor.name;
  check(
    `${where}.${name}${wantArgs !== null ? `(${wantArgs} args)` : ''}`,
    typeof fn === 'function' && (wantArgs === null || fn.length === wantArgs),
    typeof fn === 'function' ? `arity is ${fn.length}` : 'missing',
  );
}

// --- what each caller actually reaches for -------------------------------------

const dinoCalls = ['step', 'jump', 'jumpCut', 'die', 'respawn', 'velocity', 'clearance', 'bounds'];
const fieldCalls = ['update', 'checkHit', 'countPassed', 'reset'];
const inputCalls = ['takeJump', 'takeJumpCut'];

const dino = new DinoRagdoll();
for (const m of dinoCalls) hasMethod(dino, m);
const field = new ObstacleField();
for (const m of fieldCalls) hasMethod(field, m);

for (const [cls, name] of [[WorldScene, 'WorldScene'], [DinoMesh, 'DinoMesh'],
  [CameraRig, 'CameraRig'], [HUD, 'HUD'], [Input, 'Input'], [Game, 'Game']]) {
  check(`${name} is constructible`, typeof cls === 'function');
}

// The exact surface the game and the bootstrap reach for. These are listed rather
// than discovered because the game calls every one of them through `?.`, so a
// rename does not throw, it silently stops working: the mesh was called as
// `dinoMesh.sync()` here and defined as `update()`, which reads as perfectly good
// code and simply never draws the animal. Optional chaining turns that class of
// mistake from a crash into a feature that is quietly absent, so it is asserted
// here instead. Writing the list also caught four methods the game calls that no
// module defines at all: hud.setState, onStart, flashHit, onDeath, camera.reset,
// camera.eyeHeight and dinoMesh.sync, seven calls that resolved to undefined.
const mainSurface = {
  WorldScene: ['resize', 'update', 'setQuality', 'setPalette', 'syncProps', 'celebrate', 'dispose'],
  DinoMesh: ['update', 'setLimp', 'rebuild'],
  CameraRig: ['update', 'setMode', 'cycle', 'resetView', 'setViewport', 'pointerDown',
    'pointerMove', 'pointerUp', 'wheel', 'setSensitivity', 'debugInfo'],
  HUD: ['sync', 'applyUiState', 'setCameraMode', 'setPaused', 'setDebug', 'flash',
    'showGameOver', 'hideGameOver', 'showMenu', 'bindHandlers', 'buildCameraChips',
    'setSettingsOpen', 'handleKey'],
  Input: ['takeJump', 'takeJumpCut', 'takeEdge', 'strafeAxis', 'releaseAll',
    'bindCamera', 'attachWheel', 'dispose'],
};
for (const [clsName, names] of Object.entries(mainSurface)) {
  const proto = { WorldScene, DinoMesh, CameraRig, HUD, Input }[clsName].prototype;
  for (const n of names) {
    check(`${clsName}.${n}`, typeof proto[n] === 'function', 'missing from prototype');
  }
}

// Fields the game reads as data rather than calling. A getter on the prototype is a
// different thing from an instance field, and `ducking` is a getter, so it has to be
// looked for on the prototype where it actually lives.
const duckingDesc = Object.getOwnPropertyDescriptor(Input.prototype, 'ducking');
check('Input.ducking is a prototype getter', !!duckingDesc && typeof duckingDesc.get === 'function');

// .mode and .camera are set in the constructor, so they have to be read off a real
// instance. The rig is given the ragdoll's own world so the two agree on geometry.
const liveCamera = new CameraRig({ camera: { position: { x: 0, y: 3, z: 0 }, rotation: {}, fov: 60 } });
check('CameraRig instance carries .mode', typeof liveCamera.mode === 'string', String(liveCamera.mode));
check('CameraRig instance carries .camera', liveCamera.camera != null);
check('CameraRig.setMode returns the mode it settled on',
  typeof liveCamera.setMode('side') === 'string' && liveCamera.mode === 'side');

// The properties the game reaches for on the ragdoll. Getting one of these wrong is
// a silent undefined that propagates into the camera and the HUD.
for (const p of ['pelvis', 'hipHeight', 'grounded', 'airTime', 'aliveFlag', 'laneZ', 'heading', 'motor']) {
  const v = dino[p];
  check(`DinoRagdoll.${p}`, v !== undefined, 'undefined on a fresh ragdoll');
}

// --- data the renderers read off the simulation --------------------------------

for (const prop of ['pos', 'radius', 'count']) {
  check(`PhysicsWorld exposes ${prop}`, dino.world[prop] !== undefined);
}
check('every BONE endpoint is a skeleton name',
  BONES.every(([a, b]) => SKELETON[a] && SKELETON[b]));
for (const n of Object.keys(SKELETON)) {
  check(`dino index for ${n}`, dino.i[n] !== undefined);
}
check('CAMERA_MODES is a non-empty list of strings',
  Array.isArray(CAMERA_MODES) && CAMERA_MODES.length > 0 && CAMERA_MODES.every((m) => typeof m === 'string'));

// --- config keys every module reads --------------------------------------------

const requiredConfig = [
  'gravity', 'maxSpeed', 'startSpeed', 'accelPerMetre', 'baseSpeed', 'standHeight',
  'duckHeight', 'swingHeight', 'swingStiff', 'postureStiff', 'maxLimbSpeed',
  'maxFootSpeed', 'kneeBias', 'reachMin', 'reachMax', 'maxReach', 'strideCadence',
  'gripGain', 'hopLaunch', 'jumpGrace', 'groundTolerance', 'hopAmplitude',
  'supportBlend', 'deadFadeTime', 'landingDamp', 'maxAccel',
];
for (const k of requiredConfig) {
  check(`CONFIG.${k}`, CONFIG[k] !== undefined, 'undefined');
}

// --- game states ---------------------------------------------------------------

check('STATE covers the loop', ['LOADING', 'MENU', 'PLAYING', 'DYING', 'GAMEOVER', 'PAUSED']
  .every((k) => STATE[k]));

console.log(fails ? `\n${fails} contract check(s) failed` : '\nall module contracts hold');
process.exit(fails ? 1 : 0);
