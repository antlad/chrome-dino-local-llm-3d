// World dressing for the 3D dino runner: sky, fog, ground, props, weather of the day.
//
// Everything the dino runs through lives here, and everything scrolls toward -X
// while the dino holds x≈0. The renderer lives here too so boot code can stay
// about game logic. Nothing allocates per frame: props, clouds and dust are built
// once and pooled, and update() only touches transforms, scales and uniforms.

import * as THREE from '../../vendor/three.module.js';

// ---------------------------------------------------------------- settings

const GROUND_LEN = 180; // the visible window on an "infinite" strip
const GROUND_HALF = GROUND_LEN / 2;
const GROUND_WIDTH = 34;
const TILE_METRES = 4; // one ground texture tile covers 4 dino metres
const FAR_LEN = 240;
const FAR_HALF = FAR_LEN / 2;
const FAR_WIDTH = 120;
const FAR_PARALLAX = 0.22; // far strip drifts at 22% of world speed
const NEAR_SCROLL = 0.62; // dunes: close enough to read as terrain
const FAR_SCROLL = 0.3; // clouds: slow enough to read as sky
const HILL_X = -96; // everything distant sits up-screen, ahead of the run
const DUNE_TILE = 40;
const CLOUD_TILE = 40;
const SKY_RADIUS = 300; // larger than fog's useful range, smaller than camera far
const SHADOW_FOLLOW = 0.18; // shadow rig lags the dino slightly, so the light
// direction itself changes over a jump instead of the shadow teleporting
const DUST_COUNT = 190;

// Fog density is driven by eye height rather than a fixed constant: at ground
// level the desert has to silt up, from the chase height it has to stay clear
// enough to read a cactus two lanes over.
const FOG_MIN = 0.0055;
const FOG_MAX = 0.03;

const DAY = {
  top: '#2f6fb2',
  mid: '#9cc7e3',
  bot: '#e7d9bb',
  fog: '#d8ccb1',
  sun: '#fff4dd',
  sunI: 2.35,
  hemiSky: '#b9d6e8',
  hemiGround: '#b39a6d',
  hemiI: 0.85,
  glow: '#fff2cf',
  glowPow: 220,
  glowI: 1.1,
  stars: 0,
  haze: 0.35,
  blob: '#2a2418',
  blobOpacity: 0.34,
  cloud: '#ffffff',
  cloudOpacity: 0.92,
  dune: '#cbb58c',
  dust: '#fff6e2',
  dustOpacity: 0.5,
};

// Midnight is a dark navy read, not black: the props still need a silhouette and
// ACES rolls off hard, so anything too dark just becomes mud.
const NIGHT = {
  top: '#050b1c',
  mid: '#12203c',
  bot: '#26304a',
  fog: '#141d33',
  sun: '#9fb4d8',
  sunI: 0.55,
  hemiSky: '#2b3d63',
  hemiGround: '#1b2030',
  hemiI: 0.34,
  glow: '#c8d8f2',
  glowPow: 340,
  glowI: 0.75,
  stars: 1,
  haze: 0.2,
  blob: '#05070d',
  blobOpacity: 0.4,
  cloud: '#38445f',
  cloudOpacity: 0.55,
  dune: '#2b3450',
  dust: '#bcd0f2',
  dustOpacity: 0.7,
};

// Golden hour sits between the two so the cross-fade passes through an orange
// horizon on its way down instead of greying out.
const DUSK = {
  top: '#2a4f7d',
  mid: '#d98f52',
  bot: '#f2c078',
  fog: '#d9a877',
  sun: '#ffcf92',
  sunI: 1.5,
  hemiSky: '#e0a878',
  hemiGround: '#8a6f4d',
  hemiI: 0.62,
  glow: '#ffb469',
  glowPow: 90,
  glowI: 1.7,
  stars: 0.18,
  haze: 0.6,
  blob: '#241a12',
  blobOpacity: 0.3,
  cloud: '#ffc48d',
  cloudOpacity: 0.95,
  dune: '#b78c62',
  dust: '#ffd9a8',
  dustOpacity: 0.6,
};

const KEYS = Object.keys(DAY);

const QUALITY = {
  low: { dpr: 1, shadows: false, shadowMap: 512, dust: false },
  medium: { dpr: 1.25, shadows: true, shadowMap: 1024, dust: true },
  high: { dpr: 1.75, shadows: true, shadowMap: 2048, dust: true },
};

const FALLBACK_DINO = {
  pos: { x: 0, y: 0, z: 0 },
  height: 0,
  vel: { x: 0, y: 0, z: 0 },
};

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0 || 1e-6), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Deterministic build-time randomness: props made from a seed always look alike. */
function rng(seed) {
  let s = (Math.imul(seed | 0, 1664525) + 1013904223) | 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) | 0;
    return ((s >>> 8) & 0xffffff) / 0x1000000;
  };
}

function hashId(id) {
  let h = 2166136261;
  const s = typeof id === 'string' ? id : String(id);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h | 0;
}

// ---------------------------------------------------------------- world

export class WorldScene {
  constructor({ canvas, THREE: provided, quality = 'high' } = {}) {
    /** @type {any} filled on first resize(); a WebGL context costs ~100ms and the
     * menu does not need one before the player has seen anything. */
    this.renderer = null;
    this.scene = new THREE.Scene();
    /** @type {any} */
    this.sun = null;
    /** @type {any} */
    this.sky = null;
    this.groundGroup = new THREE.Group();
    this.groundGroup.name = 'world';
    this.scene.add(this.groundGroup);

    this.quality = QUALITY[quality] ? quality : 'high';
    this.canvas = canvas || null;
    this._T = provided && provided.WebGLRenderer ? provided : THREE;

    this._size = { w: 800, h: 600, dpr: 1 };
    this._fogDensity = FOG_MIN;
    this._eyeHeight = 3;
    this._t = 0;
    this._groundScroll = 0;
    this._flash = 0;
    this._flashX = 0;
    this._flashY = 1;
    this._flashZ = 0;
    this._sunX = 0;
    this._sunY = 1;
    this._sunZ = 0;
    this._duneX = 0;
    this._cloudX = 0;
    this._cloudDrift = 0;
    this._night = 0;

    this.scene.fog = new THREE.FogExp2('#d8ccb1', FOG_MIN);

    this._buildPalettes(this._T);
    this._buildLights(this._T);
    this._buildSky(this._T);
    this._buildGround(this._T);
    this._buildDunes(this._T);
    this._buildClouds(this._T);
    this._buildContactShadow(this._T);
    this._buildDust(this._T);

    this._propPools = new Map();
    this._active = []; // [{group, kind, seed}] rebuilt only when syncProps changes
    // _dustPos, _dustVel and _dustCount are owned by _buildDust, which has already run
    // by this point. The two nulls that used to sit here were written after the build
    // and so overwrote the buffers it had just allocated: dust stayed invisible while
    // speed was low, and the first frame that crossed the fade threshold read index 0
    // of null. Anything that resets these has to reset them together, and with a
    // count, or the loop and the buffer disagree about how many particles there are.
    this._dustTargetSpeed = 4;
    this._dustBaseOpacity = 0.5;
    this._dustSpeed = 0;
    this._applyQuality(this._T);
  }

  // -------------------------------------------------------------- lifecycle

  resize(w, h, dpr = 1) {
    const width = Math.max(1, Math.floor(w));
    const height = Math.max(1, Math.floor(h));
    const ratio = Math.max(0.5, Math.min(3, dpr || 1));
    if (width === this._size.w && height === this._size.h && ratio === this._size.dpr) return;
    this._size.w = width;
    this._size.h = height;
    this._size.dpr = ratio;
    if (!this.renderer) this._initRenderer(this._T);
    const cap = QUALITY[this.quality]?.dpr ?? 1.75;
    this.renderer.setPixelRatio(Math.min(ratio, cap));
    // updateStyle=false: the shell sizes the canvas with CSS, and letting the
    // renderer write inline width/height fights that on every resize.
    this.renderer.setSize(width, height, false);
  }

  update(dt, ctx) {
    const dino = ctx.dino || FALLBACK_DINO;
    const speed = ctx.speed > 0 ? ctx.speed : 0;
    const speedNorm = clamp(ctx.speedNorm || 0, 0, 1);
    this._t += dt;
    this._dt = dt;
    this._cloudDrift += dt * 0.55;

    // Sky, fog and lights first: the fog colour is what everything else fades into.
    this._eyeHeight = Math.max(1.5, Math.min(6, ctx.cameraEyeY || 3));
    this._applyDaylight(ctx.timeOfDay || 0, !!ctx.isNight);

    // The world is static and the dino really runs, so the ground is not scrolled
    // by speed: it is dragged along with the dino in *position* and the slide is
    // cancelled in *UV*. Same trick, opposite cause. Anchor to a coarse grid so
    // the offset stays small and never loses precision over a 10km run.
    const anchor = Math.round(dino.pos.x / TILE_METRES) * TILE_METRES;
    this.groundGroup.position.x = anchor;
    this._groundTex.offset.x = -anchor / TILE_METRES;
    // The far strip is tiled on its own pitch, so its offset cancels against that
    // pitch. Both offsets are derived from the same anchor, which is what keeps
    // the paint nailed to the world instead of sliding on it.
    this._farTex.offset.x = -anchor / 22;

    // Dunes repeat on DUNE_TILE, so they may only jump in whole tiles or the seam
    // shows. Clouds are not tiled, so they follow continuously and read as drift.
    this.dunes.position.x = Math.round(dino.pos.x / DUNE_TILE) * DUNE_TILE;
    this.clouds.position.x = dino.pos.x + this._cloudDrift;

    this._updateSunRig(dino, ctx);
    this._updateContactShadow(dino, dt, speed);
    this._updateFlyers(dt, ctx);
    this._updateDust(dt, speedNorm);
    this._updateFlash(dt);

    this._ensureRenderer();
    if (this.renderer) this.renderer.render(this.scene, this._cameraFor(ctx));
  }

  setQuality(q) {
    if (!QUALITY[q] || q === this.quality) return;
    this.quality = q;
    this._applyQuality(this._T);
  }

  setPalette(timeOfDay, isNight) {
    this._applyDaylight(timeOfDay || 0, !!isNight);
  }

  /** Pool meshes per kind and place them from {id,kind,x,y,z,w,h,d,seed}. */
  syncProps(list) {
    this._active.length = 0;
    if (!list || !list.length) return;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (!p || p.dead || !p.kind) continue;
      const group = this._acquire(p.kind);
      if (!group) continue;
      if (group.visible === false) group.visible = true;
      // Seed drives the variety, id drives the variety *of this prop*: two props
      // with the same kind and seed must not be twins in the same frame.
      const prand = ((hashId(p.id === undefined ? i : p.id) >>> 8) & 0xffff) / 0xffff;
      group.position.set(p.x || 0, p.y || 0, p.z || 0);
      group.rotation.set(0, prand * Math.PI * 2, 0);
      const s = p.w && p.w > 0.2 ? p.w / 1.35 : 1;
      const sc = group.userData.kind === 'flyer' ? s : 1;
      group.scale.set(sc, (p.h && p.h > 0.2 ? p.h / 0.85 : 1) * (sc === 1 ? 1 : 1), sc);
      group.userData.flapPhase = (p.seed || 0) * 0.137 + prand * 6.283;
      this._active.push(group);
    }
  }

  celebrate(milestone) {
    // Called when ctx.milestone flips to 1. Burst at the dino rather than the
    // camera so it reads as coming from the animal, not from the screen.
    this._flash = 1;
    this._flashX = this._blob.position.x;
    this._flashY = this._blob.position.y + 0.7;
    this._flashZ = this._blob.position.z;
    this._flashMilestone = !!milestone;
  }

  dispose() {
    this._disposePools();
    this.scene.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      const m = o.material;
      if (!m) return;
      const list = Array.isArray(m) ? m : [m];
      for (const mat of list) {
        for (const key of Object.keys(mat)) {
          const v = mat[key];
          if (v && v.isTexture) v.dispose();
        }
        mat.dispose();
      }
    });
    this.scene.clear();
    this._propPools.clear();
    this._active.length = 0;
    if (this.renderer) {
      this.renderer.renderLists.dispose();
      this.renderer.dispose();
      this.renderer.forceContextLoss();
      this.renderer = null;
    }
  }

  // -------------------------------------------------------------- internals

  _qualityOrThis() {
    return this.quality;
  }

  _buildPalettes(T) {
    const make = (table) => {
      const out = {};
      for (const k of KEYS) {
        out[k] = typeof table[k] === 'string' ? new T.Color(table[k]) : table[k];
      }
      return out;
    };
    this._palDay = make(DAY);
    this._palNight = make(NIGHT);
    this._palDusk = make(DUSK);
    this._c = {
      top: new T.Color(),
      mid: new T.Color(),
      bot: new T.Color(),
      fog: new T.Color(),
      sun: new T.Color(),
      hemiSky: new T.Color(),
      hemiGround: new T.Color(),
      glow: new T.Color(),
      blob: new T.Color(),
      cloud: new T.Color(),
      dune: new T.Color(),
      dust: new T.Color(),
    };
  }

  _buildLights(T) {
    this.hemi = new T.HemisphereLight('#b9d6e8', '#b39a6d', 0.85);
    this.scene.add(this.hemi);
    this.ambient = new T.AmbientLight('#ffffff', 0.08);
    this.scene.add(this.ambient);

    this.sun = new T.DirectionalLight('#fff4dd', 2.35);
    this.sun.position.set(9, 13, 6);
    this.sun.castShadow = true;
    const s = this.sun.shadow;
    s.mapSize.set(2048, 2048);
    s.bias = -0.0006;
    s.normalBias = 0.022;
    s.radius = 2.4;
    // Tight box around the dino: 6 units of coverage buys a lot of shadow
    // resolution, and the rig follows the pelvis so it stays tight.
    const cam = s.camera;
    cam.left = -3.2;
    cam.right = 3.2;
    cam.top = 3.6;
    cam.bottom = -1.0;
    cam.near = 0.5;
    cam.far = 46;
    cam.updateProjectionMatrix();
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);
  }

  _buildSky(T) {
    const uniforms = {
      topColor: { value: new T.Color('#2f6fb2') },
      midColor: { value: new T.Color('#9cc7e3') },
      botColor: { value: new T.Color('#e7d9bb') },
      glowColor: { value: new T.Color('#fff2cf') },
      glowDir: { value: new T.Vector3(0.55, 0.75, 0.36).normalize() },
      glowPow: { value: DAY.glowPow },
      glowI: { value: DAY.glowI },
      starAmount: { value: 0 },
      starColor: { value: new T.Color('#dfe9ff') },
      haze: { value: DAY.haze },
      time: { value: 0 },
    };
    const geometry = new T.SphereGeometry(SKY_RADIUS, 24, 16);
    const material = new T.ShaderMaterial({
      uniforms,
      side: T.BackSide,
      depthWrite: false,
      depthTest: true,
      fog: false, // the dome *is* the horizon; fogging it double-counts
      vertexShader: [
        'varying vec3 vDir;',
        'void main() {',
        '  vDir = position;',
        '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
        '}',
      ].join('\n'),
      fragmentShader: [
        'uniform vec3 topColor; uniform vec3 midColor; uniform vec3 botColor;',
        'uniform vec3 glowColor; uniform vec3 glowDir; uniform vec3 starColor;',
        'uniform float glowPow; uniform float glowI; uniform float starAmount;',
        'uniform float haze; uniform float time;',
        'varying vec3 vDir;',
        'float hash21(vec2 p) {',
        '  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);',
        '}',
        'void main() {',
        '  vec3 dir = normalize(vDir);',
        '  float y = dir.y;',
        '  float up = pow(clamp(y, 0.0, 1.0), 0.55);',
        '  vec3 col = mix(midColor, topColor, up);',
        '  col = mix(col, botColor, clamp(-y * 3.2, 0.0, 1.0));',
        // A tight band at the horizon is what makes the fog seam disappear.
        '  col = mix(col, midColor, exp(-abs(y) * 7.0) * haze * 0.6);',
        '  float d = max(dot(dir, normalize(glowDir)), 0.0);',
        '  col += glowColor * (pow(d, glowPow) + pow(d, 5.0) * 0.28) * glowI;',
        '  float star = 0.0;',
        '  if (y > 0.02) {',
        // Gnomonic-ish grid over the upper hemisphere: cheap, no texture, and it
        // pins stars to the sky so they rotate with the dome instead of sliding.
        '    vec2 g = dir.xz / max(y, 0.06) * 24.0;',
        '    vec2 cell = floor(g); vec2 f = fract(g) - 0.5;',
        '    float r = hash21(cell);',
        '    float present = step(0.92, r);',
        '    float core = smoothstep(0.06, 0.0, dot(f, f));',
        '    float twinkle = 0.62 + 0.38 * sin(time * (1.5 + r * 4.0) + r * 40.0);',
        '    star = present * core * twinkle * starAmount * smoothstep(0.02, 0.3, y);',
        '  }',
        '  col += starColor * star;',
        '  gl_FragColor = vec4(col, 1.0);',
        '  #include <tonemapping_fragment>',
        '  #include <' + colorSpaceChunk(T) + '>',
        '}',
      ].join('\n'),
    });
    const mesh = new T.Mesh(geometry, material);
    mesh.name = 'sky';
    mesh.frustumCulled = false;
    mesh.renderOrder = -2; // fill cheaply first; everything else draws over it
    this.scene.add(mesh);
    this.sky = mesh;
    this._skyUniforms = uniforms;
  }

  _buildGround(T) {
    this._groundTex = makeGroundTexture(T);
    this._groundTex.repeat.set(GROUND_LEN / TILE_METRES, GROUND_WIDTH / TILE_METRES);

    const groundGeo = new T.PlaneGeometry(GROUND_LEN, GROUND_WIDTH, 1, 1);
    rotateFlat(groundGeo);
    const groundMat = new T.MeshStandardMaterial({
      color: '#c9b48a',
      roughness: 0.97,
      metalness: 0,
      map: this._groundTex,
    });
    this.ground = new T.Mesh(groundGeo, groundMat);
    this.ground.receiveShadow = true;
    this.ground.position.set(0, 0, 0);
    this.groundGroup.add(this.ground);

    // Far strip: low-res haze plane, scrolls slower, reads as the desert beyond
    // the last dune so the horizon never runs out of ground.
    this._farTex = makeFarTexture(T);
    this._farTex.repeat.set(FAR_LEN / 22, FAR_WIDTH / 22);
    const farGeo = new T.PlaneGeometry(FAR_LEN, FAR_WIDTH, 1, 1);
    rotateFlat(farGeo);
    const farMat = new T.MeshStandardMaterial({
      color: '#c2ab80',
      roughness: 1,
      metalness: 0,
      map: this._farTex,
    });
    // Same reason as _duneMat: _applyDaylight tints the far strip with the rest of the
    // desert, and it cannot do that to a material nothing holds a reference to.
    this._farMat = farMat;
    this.farGround = new T.Mesh(farGeo, farMat);
    this.farGround.position.set(0, -0.02, -26);
    this.groundGroup.add(this.farGround);
  }
  _buildDunes(T) {
    this.dunes = new T.Group();
    this.dunes.name = 'dunes';
    const duneMat = new T.MeshLambertMaterial({ color: '#cbb58c', flatShading: true });
    // Kept on the instance because _applyDaylight repaints it. A local here left
    // _duneMat undefined and the first frame threw, which is the kind of bug that only
    // surfaces once the world is actually driven, not while it is being built.
    this._duneMat = duneMat;
    const DUNE_ROWS = 2;
    const DUNE_COLS = 6;
    for (let row = 0; row < DUNE_ROWS; row++) {
      const geometry = new T.PlaneGeometry(DUNE_TILE, 14 + row * 8, 22, 3);
      const rand = rng(1337 + row * 91);
      const pos = geometry.attributes.position;
      const harmonics = [];
      for (let k = 1; k <= 4; k++) {
        harmonics.push({ k, amp: (0.9 + rand() * 1.6) / k, phase: rand() * 6.283 });
      }
      const height = (x) => {
        let h = 0;
        for (let i = 0; i < harmonics.length; i++) {
          const hm = harmonics[i];
          h += hm.amp * Math.sin((x / DUNE_TILE) * Math.PI * 2 * hm.k + hm.phase);
        }
        return h;
      };
      // Heights must match at both tile edges or the wrap shows a seam every 40m.
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        const v = pos.getY(i);
        const nearSide = 0.35 + 0.65 * Math.exp(-Math.pow((v + 4) / 6, 2));
        const h = (height(x) + 1.4) * nearSide * (row === 0 ? 1 : 1.7);
        pos.setZ(i, Math.max(0, h));
      }
      geometry.rotateX(-Math.PI / 2);
      geometry.computeVertexNormals();
      const mesh = new T.Mesh(geometry, duneMat);
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      for (let c = 0; c < DUNE_COLS; c++) {
        const tile = new T.Mesh(geometry, duneMat);
        tile.position.set((c - DUNE_COLS / 2) * DUNE_TILE + DUNE_TILE / 2, 0.01, -18 - row * 16);
        this.dunes.add(tile);
      }
      this.dunes.add(mesh);
      mesh.visible = false;
      mesh.geometry = geometry;
    }
    // Not a child of groundGroup: that group is anchored on a 4 m grid and the
    // dune layer can only tolerate shifts of a whole tile.
    this.scene.add(this.dunes);
  }

  _buildClouds(T) {
    this.clouds = new T.Group();
    this.clouds.name = 'clouds';
    const cloudMat = new T.MeshLambertMaterial({
      color: '#ffffff',
      flatShading: true,
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
    });
    this._cloudMat = cloudMat;
    const puff = new T.IcosahedronGeometry(1, 0);
    const COUNT = 9;
    for (let i = 0; i < COUNT; i++) {
      const rand = rng(4242 + i * 77);
      const cloud = new T.Group();
      const puffs = 3 + ((rand() * 3) | 0);
      for (let p = 0; p < puffs; p++) {
        const m = new T.Mesh(puff, cloudMat);
        m.position.set((p - puffs / 2) * 1.6 + rand() * 0.8, rand() * 0.5, (rand() - 0.5) * 1.2);
        const s = 1 + rand() * 0.9;
        m.scale.set(s * 1.35, s * 0.62, s * 0.95);
        cloud.add(m);
      }
      cloud.position.set(
        (i - COUNT / 2) * (CLOUD_TILE / COUNT) + rand() * 6,
        14 + rand() * 9,
        -26 - rand() * 40
      );
      cloud.userData.drift = 0.25 + rand() * 0.5;
      cloud.userData.baseX = cloud.position.x;
      this.clouds.add(cloud);
    }
    this.groundGroup.add(this.clouds);
  }

  _buildContactShadow(T) {
    this._blobTex = makeRadialTexture(T);
    const geo = new T.PlaneGeometry(1, 1);
    rotateFlat(geo);
    const mat = new T.MeshBasicMaterial({
      map: this._blobTex,
      color: '#2a2418',
      transparent: true,
      opacity: 0.34,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });
    this.contactShadow = new T.Mesh(geo, mat);
    this.contactShadow.renderOrder = 1;
    this.contactShadow.frustumCulled = false;
    this._blob = this.contactShadow;
    this.scene.add(this.contactShadow);
  }

  _buildDust(T) {
    const count = DUST_COUNT;
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    const vel = new Float32Array(count * 3);
    const rand = rng(90210);
    for (let i = 0; i < count; i++) {
      const b = i * 3;
      pos[b] = 6 - rand() * 22;
      pos[b + 1] = 0.05 + rand() * 3.1;
      pos[b + 2] = (rand() - 0.5) * 7;
      vel[b] = 0;
      vel[b + 1] = 0;
      vel[b + 2] = 0;
      const warm = 0.75 + rand() * 0.25;
      col[b] = warm;
      col[b + 1] = warm * (0.85 + rand() * 0.15);
      col[b + 2] = warm * (0.7 + rand() * 0.3);
    }
    const geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.BufferAttribute(pos, 3));
    geo.setAttribute('color', new T.BufferAttribute(col, 3));
    geo.boundingSphere = new T.Sphere(new T.Vector3(0, 1.5, 0), 40);
    const mat = new T.PointsMaterial({
      size: 0.075,
      map: makeRadialTexture(T),
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      sizeAttenuation: true,
      blending: T.AdditiveBlending,
      vertexColors: true,
    });
    this.dust = new T.Points(geo, mat);
    this.dust.frustumCulled = false;
    this.dust.renderOrder = 2;
    this._dustPos = pos;
    this._dustVel = vel;
    this._dustCount = count;
    this.scene.add(this.dust);
  }

  // ------------------------------------------------------------- day / night

  _applyDaylight(timeOfDay, isNight) {
    const tod = clamp(timeOfDay, 0, 1);
    // A solar elevation, not a generic bump. The clock advances day -> night -> day, with
    // game.isNight treating tod around 0 and 0.72..1 as night, so noon belongs at tod = 0.5
    // and midnight at 0. This started out as sin(pi * tod), which peaks at 0.5 in the
    // opposite sense: noon rendered as midnight and midnight as noon, and since isNight was
    // written against the real clock, the HUD reported day while the screen showed stars.
    // Deriving the weight from where the sun actually is makes the pixels and the flag
    // agree, which is the only reason the flag exists.
    const elev = -Math.cos(2 * Math.PI * tod);
    const nightWeight = Math.pow(0.5 - 0.5 * elev, 0.75);
    // Dusk wants the shoulders of the arc, where the sun sits on the horizon, rather than
    // either extreme. Squaring the distance from the horizon keeps it narrow, and the
    // (1 - nightWeight) factor stops the night palette bleeding orange into deep night.
    const duskWeight = Math.pow(clamp((1 - Math.abs(elev)) * 2.1, 0, 1), 2.4) * (1 - nightWeight);

    const c = this._c;
    for (const k of KEYS) {
      const d = this._palDay[k];
      const n = this._palNight[k];
      const u = this._palDusk[k];
      if (typeof d === 'number') {
        c[k] = lerp(lerp(d, n, nightWeight), u, duskWeight);
      } else {
        d.clone(c[k]);
        c[k].lerp(n, nightWeight);
        if (duskWeight > 0.001) c[k].lerp(u, duskWeight);
      }
    }
    this._night = nightWeight;

    const u = this._skyUniforms;
    u.topColor.value.copy(c.top);
    u.midColor.value.copy(c.mid);
    u.botColor.value.copy(c.bot);
    u.glowColor.value.copy(c.glow);
    u.glowPow.value = lerp(lerp(DAY.glowPow, NIGHT.glowPow, nightWeight), DUSK.glowPow, duskWeight);
    u.glowI.value = lerp(lerp(DAY.glowI, NIGHT.glowI, nightWeight), DUSK.glowI, duskWeight);
    u.starAmount.value = lerp(lerp(DAY.stars, NIGHT.stars, nightWeight), DUSK.stars, duskWeight);
    u.haze.value = lerp(lerp(DAY.haze, NIGHT.haze, nightWeight), DUSK.haze, duskWeight);
    u.time.value = this._t;

    this.scene.fog.color.copy(c.fog);

    this.sun.color.copy(c.sun);
    // sunI is the number in the palette and sun is the Color. Assigning the Color to
    // intensity made the light permanently black, because three coerces a non-number to
    // zero, so the whole scene lost its key light and only the ambient survived.
    this.sun.intensity = c.sunI;
    this.hemi.color.copy(c.hemiSky);
    this.hemi.groundColor.copy(c.hemiGround);
    this.hemi.intensity = c.hemiI;
    this.ambient.intensity = 0.05 + 0.09 * nightWeight;

    this.contactShadow.material.color.copy(c.blob);
    this.contactShadow.material.opacity = c.blobOpacity;
    this._cloudMat.color.copy(c.cloud);
    this._cloudMat.opacity = c.cloudOpacity;
    this._duneMat.color.copy(c.dune);
    this._farMat.color.copy(c.dune);
    this.dust.material.color.copy(c.dust);
    this.dust.material.opacity = c.dustOpacity * (0.25 + 0.75 * this._dustSpeed);
  }

  _updateSunRig(dino, ctx) {
    const px = dino.pos.x;
    const py = dino.height > 0 ? dino.height : dino.pos.y;
    const tz = dino.pos.z || 0;

    // Target tracks the pelvis exactly; the light position lags. A lagging target
    // would let the shadow crawl across the ground, whereas a lagging light shifts
    // the sun a little over a long jump, which reads as life rather than error.
    this.sun.target.position.set(px, py * 0.5, tz);
    const k = clamp(SHADOW_FOLLOW * 60 * (this._dt || 1 / 60), 0, 1);
    this._sunX += (px + 9 - this._sunX) * k;
    this._sunY += (13 + py * 0.25 - this._sunY) * k;
    this._sunZ += (tz + 6 - this._sunZ) * k;
    this.sun.position.set(this._sunX, this._sunY, this._sunZ);

    const u = this._skyUniforms;
    const dx = this._sunX - px;
    const dy = this._sunY - py;
    const dz = this._sunZ - tz;
    const dl = Math.hypot(dx, dy, dz) || 1;
    u.glowDir.value.set(dx / dl, dy / dl, dz / dl);

    // Sky follows the camera so the dome never runs out of horizon; the props stay
    // put because only this one object moves.
    const cam = ctx.camera || this._lastCamera;
    if (cam && cam.position) {
      this.sky.position.set(cam.position.x, 0, cam.position.z);
    }
  }

  _updateContactShadow(dino, dt, speed) {
    const m = this.contactShadow.material;
    const h = clamp(dino.height > 0 ? dino.height : 0, 0, 2.2);
    const spread = 1 + h * 0.6;
    const base = 1.75;
    const s = base * spread;
    this.contactShadow.scale.set(s, 1, s * 0.82);
    this.contactShadow.position.set(
      dino.pos.x + 0.06,
      0.026 + Math.min(0.02, h * 0.01),
      dino.pos.z
    );
    // Higher jump = wider, fainter blob, with a short lag so landing feels heavy.
    const target = m.opacity * (1 - 0.46 * clamp(h / 1.6, 0, 1));
    const want = this._night > 0.5 ? target * 0.9 : target;
    this._blobOpacity = lerp(this._blobOpacity === undefined ? want : this._blobOpacity, want, 0.35);
    m.opacity = this._blobOpacity;
  }

  _updateFlyers(dt, ctx) {
    const active = this._active;
    for (let i = 0; i < active.length; i++) {
      const g = active[i];
      const ud = g.userData;
      if (ud.kind !== 'flyer') continue;
      ud.flapPhase += dt * ud.flapRate;
      const s = Math.sin(ud.flapPhase);
      const amp = ud.flapAmp;
      ud.wingL.rotation.x = -amp * s;
      ud.wingR.rotation.x = amp * s;
      ud.wingL.rotation.z = 0.12 * Math.cos(ud.flapPhase);
      ud.wingR.rotation.z = -0.12 * Math.cos(ud.flapPhase);
      if (ud.bob) {
        const drift = ctx.speed > 0 ? ctx.speed : 8;
        ud.bobT += dt * (drift / 6) * 0.5;
        g.position.y = ud.baseY + Math.sin(ud.bobT + ud.bobPhase) * ud.bobAmp;
        g.rotation.z = Math.sin(ud.bobT * 0.7 + ud.bobPhase) * 0.08;
      }
    }
  }

  _updateDust(dt, speedNorm) {
    this._dustSpeed = speedNorm;
    if (!this._dustOn) return;
    const pos = this._dustPos;
    const vel = this._dustVel;
    const count = this._dustCount;
    const g = -2.2;
    const fade = smoothstep(0.3, 0.95, speedNorm);
    this.dust.material.opacity = this._dustBaseOpacity * fade;
    if (fade < 0.01) {
      this.dust.visible = false;
      return;
    }
    this.dust.visible = true;
    const k = clamp(dt * 9, 0, 1);
    for (let i = 0; i < count; i++) {
      const b = i * 3;
      const wantVx = -this._dustTargetSpeed;
      vel[b] += (wantVx - vel[b]) * k;
      vel[b + 1] += g * dt;
      pos[b] += vel[b] * dt;
      pos[b + 1] += vel[b + 1] * dt;
      pos[b + 2] += vel[b + 2] * dt;
      if (pos[b] < -16 || pos[b + 1] < 0.02) {
        // Recycle rather than respawn: reusing the slot keeps the buffer hot and
        // the particle count constant, which is what keeps this allocation-free.
        // _rand is a method returning a number, not a factory returning a generator,
        // so each draw is its own call. It was written as `const r = this._rand()` and
        // then `r()`, which threw the first time any particle fell far enough to need
        // recycling: a crash on a path only taken a few seconds into a fast run.
        pos[b] = 5 + this._rand() * 7;
        pos[b + 1] = 0.15 + this._rand() * 2.4;
        pos[b + 2] = (this._rand() - 0.5) * 6.5;
        vel[b] = -this._dustTargetSpeed * 0.6;
        vel[b + 1] = 0.4 + this._rand() * 1.4;
        vel[b + 2] = (this._rand() - 0.5) * 0.6;
      }
    }
    this._dustTargetSpeed = 4 + speedNorm * 26;
    this.dust.geometry.attributes.position.needsUpdate = true;
  }

  _updateFlash(dt) {
    if (this._flash <= 0.001) {
      if (this._flashMesh) this._flashMesh.visible = false;
      this._flash = 0;
      return;
    }
    this._flash = Math.max(0, this._flash - dt * 1.25);
    if (!this._flashMesh) {
      const T = this._T;
      const geo = new T.PlaneGeometry(1, 1);
      rotateFlat(geo);
      const mat = new T.MeshBasicMaterial({
        map: this._blobTex,
        color: '#fff3d2',
        transparent: true,
        depthWrite: false,
        blending: T.AdditiveBlending,
        opacity: 1,
      });
      this._flashMesh = new T.Mesh(geo, mat);
      this._flashMesh.renderOrder = 3;
      this._flashMesh.frustumCulled = false;
      this.scene.add(this._flashMesh);
    }
    const f = this._flash;
    const s = 1.2 + (1 - f) * 4.2;
    this._flashMesh.visible = true;
    this._flashMesh.scale.set(s, 1, s);
    this._flashMesh.position.set(this._flashX, this._flashY, this._flashZ);
    this._flashMesh.material.opacity = f * f * 0.85;
  }

  // ---------------------------------------------------------------- pooling

  _acquire(kind) {
    let pool = this._propPools.get(kind);
    if (!pool) {
      pool = [];
      this._propPools.set(kind, pool);
    }
    let group = pool.pop();
    if (!group) {
      group = this._buildProp(this._T, kind);
      if (!group) return null;
      group.visible = true;
      this.scene.add(group);
    }
    return group;
  }

  _buildProp(T, kind) {
    if (kind === 'cactus-small' || kind === 'cactus-tall' || kind === 'cactus-cluster') {
      return this._buildCactus(T, kind);
    }
    if (kind === 'pterodactyl-high' || kind === 'pterodactyl-low' || kind === 'bird') {
      return this._buildFlyer(T, kind);
    }
    if (kind === 'rock') return this._buildRock(T);
    return null;
  }

  _disposePools() {
    for (const pool of this._propPools.values()) {
      for (const g of pool) disposeTree(this._T, g);
    }
    this._propPools.clear();
  }

  _buildCactus(T, kind) {
    const group = new T.Group();
    group.name = 'cactus';
    const seed = 77 + kind.length * 13;
    const rand = rng(seed);
    const green = new T.Color('#4a7c44');
    const variant = new T.Color().setHSL(0.29 + rand() * 0.04, 0.34, 0.3 + rand() * 0.07);
    const mat = this._cactusMat || this._makeCactusMaterial(T, variant);
    const capsule = this._capsuleGeo || this._makeCapsuleGeometry(T);

    const trunkH = kind === 'cactus-tall' ? 1.7 : kind === 'cactus-small' ? 0.85 : 1.1;
    const trunkR = kind === 'cactus-small' ? 0.11 : 0.15;

    const addSegment = (parent, x, y, z, len, radius, tilt) => {
      const m = new T.Mesh(capsule, mat);
      m.scale.set(radius * 2, len / 2, radius * 2);
      m.position.set(x, y, z);
      m.rotation.z = tilt || 0;
      m.castShadow = true;
      m.receiveShadow = true;
      parent.add(m);
      return m;
    };

    addSegment(group, 0, trunkH / 2 + trunkR * 0.6, 0, trunkH, trunkR, 0);

    const arm = (side, attachY, tilt, len) => {
      const pivot = new T.Group();
      pivot.position.set(0, attachY, 0);
      pivot.rotation.z = side * tilt;
      addSegment(pivot, side * trunkR * 0.9, len / 2, 0, len, trunkR * 0.72, 0);
      const up = new T.Group();
      up.position.set(side * trunkR * 0.9, len * 0.92, 0);
      up.rotation.z = -side * (tilt + Math.PI / 2 - Math.PI / 2);
      addSegment(up, 0, len * 0.42, 0, len * 0.85, trunkR * 0.62, 0);
      pivot.add(up);
      group.add(pivot);
    };

    if (kind === 'cactus-cluster') {
      addSegment(group, 0.34, 0.42, 0.1, 0.8, trunkR * 0.75, 0.05);
      addSegment(group, -0.3, 0.55, -0.12, 1.05, trunkR * 0.68, -0.04);
      arm(1, trunkH * 0.5, 0.9, 0.4);
    } else if (kind === 'cactus-tall') {
      arm(1, trunkH * 0.45, 0.95, 0.5);
      arm(-1, trunkH * 0.62, 1.02, 0.42);
    } else {
      arm(1, trunkH * 0.55, 1.0, 0.28);
    }

    // A squat root collar hides the seam where the column meets the sand.
    const collar = new T.Mesh(this._collarGeo || this._makeCollarGeometry(T), mat);
    collar.scale.set(trunkR * 2.4, 0.12, trunkR * 2.4);
    collar.position.y = 0.04;
    collar.receiveShadow = true;
    group.add(collar);

    group.userData.kind = 'cactus';
    return group;
  }

  _buildRock(T) {
    const group = new T.Group();
    group.name = 'rock';
    const rand = rng(31337);
    const mat = this._rockMat || this._makeRockMaterial(T);
    const geo = this._rockGeo || this._makeRockGeometry(T);
    const body = new T.Mesh(geo, mat);
    body.castShadow = true;
    body.receiveShadow = true;
    group.add(body);
    for (let i = 0; i < 2; i++) {
      const chip = new T.Mesh(geo, mat);
      chip.castShadow = true;
      chip.receiveShadow = true;
      const s = 0.22 + rand() * 0.22;
      chip.scale.set(s, s * 0.7, s);
      chip.position.set((rand() - 0.5) * 0.9, s * 0.6, (rand() - 0.5) * 0.7);
      chip.rotation.set(rand() * 3, rand() * 3, rand() * 3);
      group.add(chip);
    }
    group.userData.kind = 'rock';
    return group;
  }

  _buildFlyer(T, kind) {
    const group = new T.Group();
    group.name = 'flyer';
    const isBird = kind === 'bird';
    const bodyMat = this._wingMatDay || this._makeFlyerMaterials(T);
    const dark = this._bodyMat;
    const cone = this._coneGeo || this._makeConeGeometry(T);
    const blob = this._rockGeo || this._makeRockGeometry(T);

    const body = new T.Mesh(blob, dark);
    body.scale.set(0.5, 0.26, 0.24);
    body.castShadow = true;
    group.add(body);

    const beak = new T.Mesh(cone, dark);
    beak.scale.set(0.16, 0.5, 0.16);
    beak.rotation.z = -Math.PI / 2;
    beak.position.set(0.52, 0.02, 0);
    beak.castShadow = true;
    group.add(beak);

    const wingGeo = this._wingGeo || this._makeWingGeometry(T);
    const wingL = new T.Group();
    const wingR = new T.Group();
    for (const [pivot, side] of [[wingL, 1], [wingR, -1]]) {
      const membrane = new T.Mesh(wingGeo, bodyMat);
      membrane.position.set(-0.05, 0, side * 0.46);
      membrane.scale.set(isBird ? 0.8 : 1, 1, isBird ? 0.72 : 1);
      membrane.castShadow = true;
      pivot.add(membrane);
      const finger = new T.Mesh(cone, bodyMat);
      finger.scale.set(0.06, 0.34, 0.06);
      finger.rotation.x = side * Math.PI / 2;
      finger.position.set(-0.1, 0.02, side * 0.86);
      pivot.add(finger);
      pivot.position.set(0, 0.06, side * 0.16);
      group.add(pivot);
    }

    const tail = new T.Mesh(cone, bodyMat);
    tail.scale.set(0.12, 0.3, 0.12);
    tail.rotation.z = Math.PI / 2;
    tail.position.set(-0.42, 0.03, 0);
    group.add(tail);

    group.userData.kind = 'flyer';
    group.userData.wingL = wingL;
    group.userData.wingR = wingR;
    group.userData.flapRate = isBird ? 15 : 9.5;
    group.userData.flapAmp = isBird ? 0.95 : 0.72;
    group.userData.bob = true;
    group.userData.bobAmp = isBird ? 0.14 : 0.09;
    group.userData.bobPhase = 0;
    group.userData.bobT = 0;
    group.userData.baseY = 0;
    return group;
  }

  // --------------------------------------------------------------- factories

  _makeCactusMaterial(T, color) {
    this._cactusMat = new T.MeshStandardMaterial({
      color,
      roughness: 0.86,
      metalness: 0,
      flatShading: true,
    });
    return this._cactusMat;
  }

  _makeRockMaterial(T) {
    this._rockMat = new T.MeshStandardMaterial({
      color: '#8e8477',
      roughness: 0.95,
      metalness: 0,
      flatShading: true,
    });
    return this._rockMat;
  }

  _makeFlyerMaterials(T) {
    this._bodyMat = new T.MeshStandardMaterial({
      color: '#7c6a58',
      roughness: 0.8,
      metalness: 0,
      flatShading: true,
    });
    this._wingMatDay = new T.MeshStandardMaterial({
      color: '#a3906f',
      roughness: 0.85,
      metalness: 0,
      flatShading: true,
      side: T.DoubleSide,
    });
    return this._wingMatDay;
  }

  _makeCapsuleGeometry(T) {
    // Unit capsule: radius 0.5, cylinder 1, total height 2, along Y. Every cactus
    // segment is this one buffer scaled, so props never allocate geometry at runtime.
    this._capsuleGeo = new T.CapsuleGeometry(0.5, 1, 4, 8);
    return this._capsuleGeo;
  }

  _makeCollarGeometry(T) {
    this._collarGeo = new T.CylinderGeometry(1, 1.25, 1, 9, 1);
    return this._collarGeo;
  }

  _makeRockGeometry(T) {
    this._rockGeo = new T.IcosahedronGeometry(1, 0);
    return this._rockGeo;
  }

  _makeConeGeometry(T) {
    this._coneGeo = new T.ConeGeometry(1, 1, 6);
    return this._coneGeo;
  }

  _makeWingGeometry(T) {
    const geo = new T.PlaneGeometry(0.62, 0.95, 1, 2);
    // Taper the membrane and droop the trailing edge; a flat quad reads as paper.
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const span = (y + 0.475) / 0.95;
      pos.setX(i, x * (0.45 + 0.55 * (1 - span)));
      pos.setZ(i, -Math.sin(span * 2.2) * 0.06);
    }
    geo.computeVertexNormals();
    geo.rotateX(-Math.PI / 2);
    this._wingGeo = geo;
    return geo;
  }

  // ----------------------------------------------------------------- helpers

  _initRenderer(T) {
    const canvas = this.canvas || document.createElement('canvas');
    if (!this.canvas) {
      this.canvas = canvas;
      canvas.style.position = 'absolute';
      canvas.style.inset = '0';
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      document.body.appendChild(canvas);
    }
    this.renderer = new T.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.setClearColor('#d8ccb1', 1);
    this.renderer.toneMapping = T.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.06;
    this.renderer.outputColorSpace = T.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = T.PCFSoftShadowMap;
    this.renderer.shadowMap.autoUpdate = true;
    this.renderer.setSize(this._size.w, this._size.h, false);
  }

  _ensureRenderer() {
    if (!this.renderer) this._initRenderer(this._T);
  }

  _applyQuality(T) {
    const q = QUALITY[this.quality];
    if (this.renderer) {
      this.renderer.shadowMap.enabled = q.shadows;
      this.renderer.setPixelRatio(Math.min(this._size.dpr, q.dpr));
      this.renderer.shadowMap.needsUpdate = true;
    }
    if (this.sun) {
      this.sun.castShadow = q.shadows;
      const size = q.shadowMap;
      if (this.sun.shadow.mapSize.x !== size) {
        this.sun.shadow.mapSize.set(size, size);
        if (this.sun.shadow.map) {
          this.sun.shadow.map.dispose();
          this.sun.shadow.map = null;
        }
      }
    }
    this._dustOn = q.dust;
    if (this.dust) this.dust.visible = q.dust;
  }

  _cameraFor(ctx) {
    if (ctx && ctx.camera && ctx.camera.isCamera) {
      this._lastCamera = ctx.camera;
      return this._lastCamera;
    }
    if (!this._fallbackCamera) {
      const T = this._T;
      this._fallbackCamera = new T.PerspectiveCamera(
        62,
        this._size.w / this._size.h,
        0.1,
        600
      );
      this._fallbackCamera.position.set(-6.2, 3, 3.4);
      this._fallbackCamera.lookAt(1.2, 0.8, 0);
    }
    this._fallbackCamera.aspect = this._size.w / this._size.h;
    this._fallbackCamera.updateProjectionMatrix();
    this._fallbackCamera.position.set(-6.2, 3, 3.4);
    this._fallbackCamera.lookAt(1.2, 0.8, 0);
    return this._fallbackCamera;
  }
}

// ------------------------------------------------------------------ textures

/** Deterministic scratch randomness for recycling. Stateful on purpose: a fresh
 *  closure per call would hand every recycled particle the same three numbers. */
WorldScene.prototype._rand = function () {
  this._randSeed = (Math.imul(this._randSeed | 0, 1664525) + 1013904223) | 0;
  return ((this._randSeed >>> 8) & 0xffffff) / 0x1000000;
};
WorldScene.prototype._randSeed = 12345;

function colorSpaceChunk(T) {
  // r152 renamed <encodings_fragment>; keep working if the vendor pin is older.
  const chunks = T.ShaderChunk || {};
  return chunks.colorspace_fragment ? 'colorspace_fragment' : 'encodings_fragment';
}

function rotateFlat(geo) {
  geo.rotateX(-Math.PI / 2);
  return geo;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function disposeTree(T, root) {
  root.traverse((o) => {
    if (o.geometry && o.geometry.dispose) o.geometry.dispose();
  });
}

function makeGroundTexture(T) {
  const S = 512;
  const canvas = document.createElement('canvas');
  canvas.width = S;
  canvas.height = S;
  const g = canvas.getContext('2d');
  const rand = rng(20261111);

  g.fillStyle = '#c9b48a';
  g.fillRect(0, 0, S, S);

  // Dust: per-pixel value noise is what stops the tiling from looking like a
  // printed carpet once it is moving at 14 m/s.
  const img = g.getImageData(0, 0, S, S);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rand() - 0.5) * 30;
    d[i] = clamp(d[i] + n, 0, 255);
    d[i + 1] = clamp(d[i + 1] + n * 0.95, 0, 255);
    d[i + 2] = clamp(d[i + 2] + n * 0.8, 0, 255);
  }
  g.putImageData(img, 0, 0);

  // Pebbles, with a darker bottom edge so they read as settled into sand.
  const pebbleCols = ['#b09a72', '#8f7c5c', '#d8c6a0', '#6f6047'];
  for (let i = 0; i < 170; i++) {
    const x = rand() * S;
    const y = rand() * S;
    const rx = 1 + rand() * 3;
    const ry = rx * (0.55 + rand() * 0.4);
    g.fillStyle = pebbleCols[(rand() * pebbleCols.length) | 0];
    g.globalAlpha = 0.35 + rand() * 0.4;
    g.beginPath();
    g.ellipse(x, y, rx, ry, rand() * Math.PI, 0, Math.PI * 2);
    g.fill();
    g.globalAlpha *= 0.5;
    g.fillStyle = '#5a4c37';
    g.beginPath();
    g.ellipse(x, y + ry * 0.5, rx * 0.9, ry * 0.4, 0, 0, Math.PI * 2);
    g.fill();
  }

  // Sparse grass tufts. They are the only vertical detail at ground level, so they
  // do most of the work for speed reading.
  const grassCols = ['#6f7d4a', '#8a955a', '#54603a'];
  for (let i = 0; i < 26; i++) {
    const x = rand() * S;
    const y = rand() * S;
    const blades = 4 + ((rand() * 4) | 0);
    g.strokeStyle = grassCols[(rand() * grassCols.length) | 0];
    g.lineWidth = 1 + rand();
    g.globalAlpha = 0.75;
    for (let b = 0; b < blades; b++) {
      const bx = x + (rand() - 0.5) * 7;
      const lean = (rand() - 0.5) * 9;
      const h = 5 + rand() * 9;
      g.beginPath();
      g.moveTo(bx, y);
      g.quadraticCurveTo(bx + lean * 0.4, y - h * 0.6, bx + lean, y - h);
      g.stroke();
    }
  }

  // Faint lane lines: the runner is on rails, and these make the rails visible so
  // lane changes read as distance rather than guesswork.
  const lanes = [S * 0.185, S * 0.5, S * 0.815];
  for (const ly of lanes) {
    let x = 0;
    let on = true;
    g.globalAlpha = 1;
    while (x < S) {
      const len = on ? 96 : 84;
      if (on) {
        g.fillStyle = 'rgba(255,250,235,0.10)';
        g.fillRect(x, ly - 1.5, len, 3);
        g.fillStyle = 'rgba(96,76,46,0.13)';
        g.fillRect(x, ly + 1.5, len, 1.5);
      }
      x += len;
      on = !on;
    }
  }
  g.globalAlpha = 1;

  const tex = new T.CanvasTexture(canvas);
  tex.wrapS = T.RepeatWrapping;
  tex.wrapT = T.RepeatWrapping;
  tex.colorSpace = T.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

function makeFarTexture(T) {
  const S = 128;
  const canvas = document.createElement('canvas');
  canvas.width = S;
  canvas.height = S;
  const g = canvas.getContext('2d');
  const rand = rng(5150);
  g.fillStyle = '#c2ab80';
  g.fillRect(0, 0, S, S);
  for (let i = 0; i < 90; i++) {
    g.globalAlpha = 0.05 + rand() * 0.12;
    g.fillStyle = rand() > 0.5 ? '#a8916a' : '#dcc9a2';
    const y = rand() * S;
    g.fillRect(0, y, S, 1 + rand() * 3);
  }
  g.globalAlpha = 1;
  const tex = new T.CanvasTexture(canvas);
  tex.wrapS = T.RepeatWrapping;
  tex.wrapT = T.RepeatWrapping;
  tex.colorSpace = T.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function makeRadialTexture(T) {
  const S = 128;
  const canvas = document.createElement('canvas');
  canvas.width = S;
  canvas.height = S;
  const g = canvas.getContext('2d');
  const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  grad.addColorStop(0, 'rgba(0,0,0,0.95)');
  grad.addColorStop(0.45, 'rgba(0,0,0,0.45)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, S, S);
  const tex = new T.CanvasTexture(canvas);
  tex.colorSpace = T.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}
