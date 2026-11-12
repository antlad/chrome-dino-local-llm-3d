# CONTRACT (frozen — read this, then implement only your assigned file)

3D Chrome-dino ragdoll runner. Plain ES modules, **no build step, no npm deps**.
three.js is vendored at `/vendor/three.module.js`. Dev server: `node server.mjs`
(serves `http://127.0.0.1:8788/`). Test with `node test/physics-check.mjs`.

## Axes and units

- `+X` = forward (the direction the dino runs). `+Y` = up. `+Z` = to the dino's left.
- Right-handed, same as three.js defaults. Ground plane is `y = 0`.
- Units are "dino metres". The animal is ~1.7 long, stands ~0.95 at the hip.
- Gravity in the solver is `-24` (game-feel gravity, not 9.81).
## THE WORLD IS STATIC AND THE DINO REALLY RUNS (supersedes any "scroll" idea)

The 2D treadmill trick is wrong in 3D. If the dino sat at x=0 while the ground
slid past at 8 m/s, a planted foot would have to be dragged ~2 m backwards
relative to the body every stride, impossible for a 0.9 m leg. Real running
contact requires a static world. So:

- **The dino genuinely runs forward in +X.** `ctx.dino.pos.x` grows unbounded.
- **Nothing scrolls on its own.** Ground, props, hills, clouds are world
  anchored. No `texture.offset` scrolling for motion, props do not move
  themselves. All apparent motion is the camera following the dino.
- Tiled ground layers must stay world-anchored: follow the dino in position
  (`mesh.position.x = dino.x`) and cancel the slide with
  `map.offset.x = -dino.x / tileWorldSize`, so the pattern never slides.
- Recycling is relative to the dino: recycle `prop.x < dino.x - 14`, spawn ahead
  at `> dino.x + 55`.
- On death the world speed decays to 0 and the corpse tumbles to rest under its
  own momentum.

## Already implemented (do not rewrite)

- `src/engine/pbd3d.js` — exports `PhysicsWorld`, `angle3(w,a,b,c)`,
  `signedAngleAround`, `clamp`, `wrapPi`. PhysicsWorld API you may rely on:
  - `addParticle({x,y,z,mass,radius,friction,pinned,vx,vy,vz,name}) -> index`
  - `addDistance(a,b,{rest,stiff,compliance,maxForce,tag}) -> id`
  - `addAngle(a,b,c,{target,lo,hi,stiff,limitStiff,name}) -> id`
  - `addBone(a,b,{r0,r1,name}) -> id`  (visual bone; renderer reads `world.bones`)
  - `idx(name)`, `setPos(i,x,y,z)`, `setPosKeepVel`, `setVel(i,vx,vy,vz,dt)`,
    `getVel(i,dt)`, `moveTo(i,x,y,z,blend)`, `setPinned(i,on)`
  - `buildCollisionSkip()` (call once after building constraints),
    `step(dt,{substeps,iterations})`, `pushOut(a,b,cx,cy,cz,r) -> bool`,
    `dump()`
  - live arrays: `world.pos` (Float32Array, `i*3` stride), `world.prev`,
    `world.inv`, `world.count`, `world.bones`, `world.names`, `world.nameToIndex`

## Files and owners

| file | owner | exports |
|---|---|---|
| `src/game/config.js` | main | `CONFIG`, `TICK_MS` |
| `src/game/dino.js` | main | `DinoRagdoll`, `SKELETON` |
| `src/game/obstacles.js` | main | `ObstacleField` |
| `src/game/game.js` | main | `Game` |
| `src/input/input.js` | main | `Input` |
| `src/main.js` | main | bootstrap |
| `src/render/world.js` | worker | `WorldScene` |
| `src/render/dinoMesh.js` | worker | `DinoMesh` |
| `src/camera/cameraRig.js` | worker | `CameraRig` |
| `src/ui/hud.js` | worker | `HUD` |
| `index.html`, `src/ui/styles.css` | worker | shell + styling |

Import three only as `import * as THREE from '../../vendor/three.module.js';`
(adjust relative depth). Never import from CDN. Never `npm install`.

## Shared context object (`ctx`)

`game` is the single source of truth. Renderers/camera/HUD read it, never write
(except `CameraRig` writing camera state). Shape:

```js
ctx = {
  state: 'menu'|'ready'|'running'|'dying'|'dead'|'paused',
  time: number,              // seconds of wall time in the current run
  distance: number,          // metres travelled
  score: number,             // integer, distance-ish
  best: number,
  speed: number,             // metres/second of world scroll
  speedNorm: number,         // 0..1, speed / CONFIG.maxSpeed
  grounded: boolean,
  ducking: boolean,
  jumping: boolean,
  airTime: number,
  timeOfDay: number,         // 0..1, 0 = noon, 0.5 = midnight
  isNight: boolean,
  slowmo: number,            // 1 = normal, <1 = slowed (death cam)
  hitFlash: number,          // 0..1, decays; drives a screen flash
  milestone: number,         // 0 normally; 1 for ~1.2s after each 100m
  dino: {
    pos:    {x,y,z},         // pelvis world position
    vel:    {x,y,z},         // pelvis velocity (world units / s)
    heading: number,         // radians, 0 = facing +X
    height: number,          // pelvis height above ground
    alive: boolean,
    bones: Array,            // === world.bones, each {a,b,r0,r1,name,render}
    world: PhysicsWorld,     // === the solver, read pos directly
  },
  obstacles: Array,          // see ObstacleField below
  cameraMode: string,
}
```

## `src/render/world.js` — `WorldScene`

```js
new WorldScene({ canvas, THREE, quality = 'high' })
  .renderer  // THREE.WebGLRenderer, already attached to canvas
  .scene     // THREE.Scene
  .sun       // THREE.DirectionalLight
  .sky       // object you animate
  .groundGroup

resize(w, h, dpr)                       // set renderer size + pixel ratio
update(dt, ctx)                         // every frame: scroll ground, recycle props,
                                        // animate sky/fog, dust, milestone flash
setQuality(q)                           // 'low' kills shadows + halves DPR
setPalette(timeOfDay, isNight)          // lerp fog/sky/light colours
syncProps(list)                         // list = visible obstacles (see below)
celebrate(milestone)                    // called when ctx.milestone flips to 1
dispose()
```

Must include: gradient sky (shader or big sphere), exponential fog matched to the
sky horizon, hemisphere + directional light with shadow map, a long ground strip
with a repeating procedural texture (canvas-generated is fine) whose UV offset
scrolls by `ctx.speed`, a few distant hill/dune silhouettes and drifting clouds
for parallax, plus a soft contact shadow blob under the dino driven by
`ctx.dino.pos` and `ctx.dino.height`. Night: dark blue palette, stars fade in,
sun becomes a moon. Day/night must cross-fade smoothly, never pop.

## `src/render/dinoMesh.js` — `DinoMesh`

```js
new DinoMesh({ THREE, world, scene, THREE_ = THREE })
  .group        // THREE.Group added to scene by the caller
  .update(ctx)  // read world.pos / world.bones, place every visual
  .setColor(hex)
  .setLimp(v)   // 0..1, extra squash/wobble when dying
  .dispose()
```

Build the dino **from the solver, not from a model file**: for each entry in
`world.bones` place a tapered capsule between `world.pos[a]` and `world.pos[b]`
with radii `r0`/`r1` (a cylinder/capsule mesh oriented by lookAt/quaternion, or
a shared unit geometry scaled — do it with a reusable unit geometry to stay
fast). Add spheres at particles for joints, plus character bits: eyes (whites +
pupils that track forward), a jaw/snout box, back scutes/plates along the spine,
toes on the feet. Flat-shaded stylised look, one material, no textures. Colours:
day `#5a6b52`-ish grey-green like the Chrome dino (`#535353` is canonical),
belly slightly lighter. Everything must cast/receive shadows.

## `src/camera/cameraRig.js` — `CameraRig`

```js
new CameraRig({ THREE, camera, opts })
  .mode                 // 'chase'|'side'|'low'|'orbit'|'top'|'corpse'|'free'
  .setMode(name)
  .cycle(dir = 1)
  .update(dt, ctx)      // MUST set camera.position, camera.lookAt target, fov
  // pointer-driven "play":
  .pointerDown(x, y), .pointerMove(x, y), .pointerUp()
  .wheel(deltaY)
  .resetView()
  .userTouched          // bool: user dragged, so HUD shows a "recenter" hint
```

This is the "you can play with camera" feature, so make it feel good:
- `chase`: behind and above, 3/4 view; FOV widens with `speedNorm` (62 -> 78),
  slight roll into turns, subtle handheld bob synced to `ctx.distance`,
  speed-based dolly-in.
- `side`: classic platformer profile, slight lag behind the dino, low angle.
- `low`: ground-level heroic angle, big FOV, motion-blur-ish shake at speed.
- `orbit`: slow automatic orbit around the dino; drag rotates, wheel zooms.
- `top`: bird's eye showing obstacle lanes.
- `corpse`: on death, swing down and in around the ragdoll, slow, drifting.
- `free`: pure user control (drag = yaw/pitch, wheel = dolly), no auto motion.
- Dragging in any auto mode blends to user control temporarily, then eases back
  over ~1.5s unless mode is `free`/`orbit`.
- Everything is critically damped / lerped — no snapping, no jitter, no drift.
- Keep the dino framed: clamp so the pelvis stays inside the frustum, and never
  let the camera go below `y = 0.25`.

## `src/ui/hud.js` — `HUD`

```js
new HUD({ root, opts })
  .sync(ctx, uiState)
  .flash(text, kind)          // '+100', 'PERFECT', etc. kind: 'good'|'bad'
  .setCameraMode(name)
  .setPaused(v)
  .showGameOver({ score, best, isRecord })
  .hideGameOver()
  .bindHandlers({ onStart, onRestart, onPause, onCamera, onQuality, onToggle: {} })
```

`uiState` = `{ cameraMode, quality, showDebug, sound, sensitivity }`.
Required DOM ids (main.js queries these; keep the names exactly):
`#score`, `#best`, `#speed`, `#stat-state`, `#milestone`, `#hit-flash`,
`#overlay`, `#overlay-title`, `#overlay-sub`, `#btn-start`, `#btn-restart`,
`#btn-pause`, `#camera-chips`, `#hint`, `#fps`, `#settings`, `#quality`,
`#toggle-debug`, `#toggle-orbit`, `#slider-sens`.
Camera chips must be buttons with `data-mode="chase|side|low|orbit|top|corpse|free"`.

## `index.html` + `src/ui/styles.css`

A polished dark UI over a full-bleed canvas. No external fonts, no CDNs, no
frameworks, no images. Use system font stacks. Requirements: top-left score
block with a monospace tabular feel, top-right controls, bottom-centre keyboard
hint strip, a slide-in settings panel, pill buttons with hover/active states, a
`#hit-flash` full-screen red vignette (opacity driven by JS), a milestone popup
that pops and fades, and an overlay card for menu / game-over with a clear
primary CTA. Respect `prefers-reduced-motion`. Must look good at 1280x800 and
on a phone. Keep all CSS in `src/ui/styles.css`; keep `index.html` to markup
only with the ids above and these script tags at the end of `<body>`:
`<script type="module" src="./src/main.js"></script>`.

## Obstacles (read-only for render workers)

`ObstacleField.sync(ctx)` gives `[{ id, kind, x, y, z, w, h, d, dead, seed }]`
with `kind` in `'cactus-small'|'cactus-tall'|'cactus-cluster'|'pterodactyl-high'|
'pterodactyl-low'|'rock'|'bird'`. `x` decreases over time. Props whose `x < -12`
are dead and recycled by the field, not the renderer.

## Style rules

- Plain modern JS, `const`/`let`, no classes-without-purpose, no TypeScript.
- Every file starts with a short comment on what it is and why.
- Comment the *why*, not the *what*. No commented-out code, no TODOs.
- No `console.log` left behind except a single boot line in `main.js`.
- Performance target: 60fps on a laptop iGPU. Reuse geometries and materials,
  pool everything that spawns, allocate nothing per frame in the hot path.
- Write ONLY the files you are assigned. Do not touch `src/game/*`, `src/engine/*`,
  or another worker's files.
