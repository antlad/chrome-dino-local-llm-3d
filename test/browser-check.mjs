// Real-browser check: drives the actual game in actual Chrome over CDP.
//
// This is the only test in the repo that proves anything reaches a screen. The smoke
// test boots main.js against a Proxy GL context, which is enough for three.js to build a
// renderer and walk one render call, but it cannot tell you the animal is visible, that
// the sky is the right colour, or that WebGL2 was obtained at all. Since the requirement
// is specifically that this runs in Chrome, that gap is the biggest one in the suite.
//
// It needs Chrome and a network port, so it is deliberately NOT part of `npm test`,
// which stays dependency-free and offline:
//
//   npm run test:browser
//
// It will start its own server and its own headless Chrome if neither is already
// running, so it works on a clean checkout with nothing else open.
//
// ---------------------------------------------------------------------------
// The single most important thing in this file
//
// CDP input has a side effect that took a long time to find: dispatching a key flips the
// tab to document.hidden. A hidden tab gets no animation frames at all, and main.js
// releases every key on visibilitychange. Both of those are correct behaviour for a real
// player who tabs away. Together they were close to undiagnosable, because they produced
// three separate "game bugs":
//
//   - space did not jump      (the jump edge was released before any frame consumed it)
//   - death never finished    (the dying timer had no frames to advance on)
//   - the sky would not recolour (uniforms kept whatever the last frame set)
//
// None of them threw, and all three looked like broken game code. The game was right in
// every case. Raising the tab with Page.bringToFront *before* each dispatch is what fixes
// it; raising it afterwards only un-freezes the loop, by which time the key is gone.
// ---------------------------------------------------------------------------

import { mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openGame, shot, sleep } from './lib/cdp.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = process.env.DINO_SHOTS || join(ROOT, '.shots-browser');
const CDP_PORT = Number(process.env.DINO_CDP_PORT || 9333);

mkdirSync(OUT, { recursive: true });

const fails = [];
function ok(label, cond, detail = '') {
  console.log((cond ? '  ok  ' : 'FAIL  ') + label + (detail ? `\n      ${detail}` : ''));
  if (!cond) fails.push(label);
}

// --- dev server, started only if something is not already serving -------------------

async function alive(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1200) });
    return res.ok;
  } catch {
    return false;
  }
}

let serverProc = null;
async function ensureServer() {
  const wanted = Number(process.env.DINO_PORT || 8788);
  for (const p of [wanted, wanted + 1, wanted + 2, wanted + 3]) {
    const url = `http://127.0.0.1:${p}/`;
    if (await alive(url)) return { url, owned: false };
  }
  // Nothing listening: start our own and read the port back off its banner, because the
  // server walks forward past occupied ports rather than failing.
  const proc = spawn(process.execPath, [join(ROOT, 'server.mjs')], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('dev server did not report a port')), 8000);
    proc.stdout.on('data', (b) => {
      const m = String(b).match(/http:\/\/127\.0\.0\.1:(\d+)\//);
      if (m) { clearTimeout(timer); resolve(`http://127.0.0.1:${m[1]}/`); }
    });
    proc.stderr.on('data', (b) => {
      const text = String(b).trim();
      if (text && !/deprecat/i.test(text)) console.error('[server] ' + text);
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`dev server exited (${code}) before binding a port`));
    });
  });
  // The banner precedes listen() completing in the same tick, so confirm properly.
  for (let i = 0; i < 40 && !await alive(url); i++) await sleep(100);
  return { url, owned: true, proc };
}

const srv = await ensureServer();
const URL = srv.url;
serverProc = srv.proc;
console.log(`browser check against ${URL}\n`);

const g = await openGame(URL, { port: CDP_PORT });
const { c, evaluate, consoleErrors } = g;

await sleep(2500);

// Page-side frame wait that cannot hang. Under headless SwiftShader the page runs at
// about 13 fps, and if a tab ever stops producing frames then a bare
// `await new Promise(r => requestAnimationFrame(r))` inside a loop never resolves, which
// is how an earlier revision of this check hung for ten minutes with no output. A rAF
// that has not landed within its budget is treated as a tick anyway: every loop below
// re-checks a game condition each turn, so a spurious extra iteration is harmless while
// an unbreakable await loses the whole run.
await evaluate(`window.__tick = (budget) => new Promise((res) => {
  let done = false;
  const t = setTimeout(() => { if (!done) { done = true; res('timeout'); } }, budget || 500);
  requestAnimationFrame(() => { if (!done) { done = true; clearTimeout(t); res('raf'); } });
});`);

// --- boot --------------------------------------------------------------------------

const boot = await evaluate(`(() => {
  const a = window.dino3d;
  if (!a) return { err: 'no api' };
  const gl = a.worldScene.renderer.getContext();
  return {
    state: a.game.state,
    webgl2: !!gl && typeof WebGL2RenderingContext !== 'undefined'
      && gl instanceof WebGL2RenderingContext,
    lost: gl ? gl.isContextLost() : true,
    w: a.worldScene.renderer.domElement.width,
    h: a.worldScene.renderer.domElement.height,
    calls: a.worldScene.renderer.info.render.calls,
    tris: a.worldScene.renderer.info.render.triangles,
    progs: a.worldScene.renderer.info.programs
      ? a.worldScene.renderer.info.programs.length : -1,
    bones: (a.dinoMesh._boneMeshes || []).length,
  };
})()`);
ok('booted in real Chrome', !boot.err, JSON.stringify(boot));
ok('has a live WebGL context', boot.webgl2 && !boot.lost, JSON.stringify(boot));
ok('drew real geometry', boot.tris > 5000 && boot.calls > 3, JSON.stringify(boot));
ok('built bone meshes for the ragdoll', boot.bones > 8, 'bones=' + boot.bones);
await shot(c, OUT + '/01-menu.png');

// --- running ------------------------------------------------------------------------

await evaluate(`window.dino3d.game.start()`);
await sleep(1800);
const run = await evaluate(`(() => { const a = window.dino3d; return {
  state: a.game.state, dist: a.game.distance, speed: a.game.speed,
  hip: a.game.dino.hipHeight,
  tris: a.worldScene.renderer.info.render.triangles }; })()`);
ok('run is progressing', run.state === 'playing' && run.dist > 2, JSON.stringify(run));
await shot(c, OUT + '/02-running.png');

// --- the three verbs, through real key events ---------------------------------------

// The codes the page's listeners actually branch on. Going through the real key path
// rather than setting input.held is the point of this section: whether a key is buffered,
// swallowed or ignored is decided inside Input, and that is what a player exercises.
const VK = { Space: 32, ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, KeyP: 80 };

async function visible() {
  await c.send('Page.bringToFront');
  // bringToFront is not enough on its own, and this is the thing that made the jump test
  // pass against a long-running Chrome and fail against a freshly launched one: raising
  // the tab is a request, and a key dispatched while the tab still counts as hidden gets
  // dropped by the release-on-hide handler. So the precondition is waited for rather than
  // assumed. If it never becomes visible the dispatch is still made, because the
  // assertion below should report a game failure rather than the harness timing out.
  for (let i = 0; i < 40; i++) {
    if (await evaluate(`document.visibilityState === 'visible'`)) return true;
    await sleep(25);
  }
  return false;
}

async function key(type, keyName, code) {
  await visible();
  await c.send('Input.dispatchKeyEvent', {
    type, key: keyName, code,
    windowsVirtualKeyCode: VK[code], nativeVirtualKeyCode: VK[code],
  });
  await visible();
}
const press = (k, code) => key('keyDown', k, code);
const release = (k, code) => key('keyUp', k, code);

await press(' ', 'Space');
await sleep(350);
const air = await evaluate(`window.dino3d.game.dino.airTime`);
ok('space makes it jump in the browser', air > 0, 'airTime=' + air);
await shot(c, OUT + '/03-jump.png');
await release(' ', 'Space');
await sleep(1600);
const landed = await evaluate(`window.dino3d.game.dino.airTime`);
ok('it comes back down', landed <= 0.05, 'airTime=' + landed);

await press('ArrowDown', 'ArrowDown');
await sleep(900);
const duckHip = await evaluate(`window.dino3d.game.dino.hipHeight`);
ok('down ducks in the browser', duckHip < 0.72, 'hip=' + duckHip);
await shot(c, OUT + '/04-duck.png');
// Released for real, through the key path, rather than by mutating `held` later on. The
// trials that follow need a standing animal, and a stale held key is invisible in their
// results: the first revision of this file reported that a flyer had missed a standing
// dino when in fact it had been crouched the whole time.
await release('ArrowDown', 'ArrowDown');
await sleep(400);

// --- fairness on the real page -------------------------------------------------------

// Imported by URL, which hits the same module record the page already loaded, so the
// specs being planted are the ones actually in play rather than a copy that could have
// drifted. The headless tests prove fairness against a stubbed renderer; this proves the
// same thing with a GPU and a real collision test in the loop.
await evaluate(`window.__K = import('/src/game/obstacles.js').then(m => m.OBSTACLE_KINDS)`);
ok('obstacle module loads in the page', await evaluate(`!!window.__K`));

// A trial that does not verify the posture it claims to be testing is worse than no
// trial, because "the flyer missed" and "the animal was never standing" produce the same
// result. So the trial asserts its own setup: it plants the prop far enough away that the
// gait can settle, and refuses to score the run until the hit box has actually reached the
// height the trial is nominally about.
async function fairnessTrial(kind, hold) {
  return evaluate(`(async () => {
    const a = window.dino3d, G = a.game;
    const spec = (await window.__K)[${JSON.stringify(kind)}];
    a.input.held.clear();
    a.input.pressed && a.input.pressed.clear();
    G.restart();
    G.field.items.length = 0;
    G.field._visible.length = 0;
    G.field.frontier = G.dino.pelvis.x + 1e6;
    const propX = G.dino.pelvis.x + 9;
    G.field._spawn(propX, 999);
    const it = G.field.items[G.field.items.length - 1];
    Object.assign(it, { kind: ${JSON.stringify(kind)}, w: spec.w, h: spec.h, d: spec.d,
      y: spec.ground ? spec.h / 2 : spec.y,
      baseY: spec.ground ? spec.h / 2 : spec.y,
      x: propX, z: G.dino.pelvis.z, vx: 0, bobAmp: 0 });
    if (${hold}) a.input.held.add('duck'); else a.input.held.delete('duck');

    // Top of the body ignoring the tail, which is what a flyer actually has to clear.
    const topOf = () => {
      const w = G.dino.world;
      let t = 0;
      for (let p = 0; p < w.count; p++)
        if (!/^tail/.test(w.names[p])) t = Math.max(t, w.pos[p * 3 + 1] + w.radius[p]);
      return t;
    };

    let posture = ${hold} ? 99 : 0;
    const settle = performance.now();
    while (performance.now() - settle < 1200 && it.x - G.dino.pelvis.x > 3.0
           && G.state === 'playing') {
      await window.__tick(700);
      posture = ${hold} ? Math.min(posture, topOf()) : Math.max(posture, topOf());
    }

    let peak = 0, trough = 99;
    const t0 = performance.now();
    while (performance.now() - t0 < 8000 && G.state === 'playing'
           && it.x > G.dino.pelvis.x - 1.2) {
      await window.__tick(700);
      if (Math.abs(it.x - G.dino.pelvis.x) < 0.9) {
        const t = topOf();
        peak = Math.max(peak, t);
        trough = Math.min(trough, t);
      }
    }
    a.input.held.delete('duck');
    return { died: G.state !== 'playing', passed: it.x < G.dino.pelvis.x - 1.2,
      hold: ${hold}, posture: +posture.toFixed(3),
      peak: +peak.toFixed(3), trough: +trough.toFixed(3),
      bellyLow: +(it.y - it.h / 2).toFixed(3),
      bellyHigh: +(it.y + it.h / 2).toFixed(3) };
  })()`);
}

// The trials die on purpose, so every later section has to ask for a run rather than
// assume one is still going. The camera and pause paths only do anything while state is
// playing, and checking them silently against a corpse is how an earlier revision
// reported six failures that were not real.
async function ensureRunning() {
  return evaluate(`(async () => {
    const a = window.dino3d;
    if (a.game.state !== 'playing') { a.game.restart(); a.input.held.clear(); }
    a.game.field.items.length = 0;
    a.game.field._visible.length = 0;
    a.game.field.frontier = a.game.dino.pelvis.x + 1e6;
    const t0 = performance.now();
    while (performance.now() - t0 < 4000 && a.game.dino.pelvis.x < 4
           && a.game.state === 'playing')
      await window.__tick(700);
    return a.game.state;
  })()`);
}

for (const kind of ['pterodactyl-high', 'bird']) {
  const stand = await fairnessTrial(kind, false);
  const duck = await fairnessTrial(kind, true);
  // Posture gates asserted separately from the outcomes, for the reason above.
  ok(`${kind}: trial really ran standing`, stand.posture > 1.02, JSON.stringify(stand));
  ok(`${kind}: trial really ran crouched`, duck.posture < 0.95, JSON.stringify(duck));
  ok(`${kind} kills a standing animal in the browser`, stand.died, JSON.stringify(stand));
  ok(`${kind} is cleared by ducking in the browser`, !duck.died && duck.passed,
    JSON.stringify(duck));
  await shot(c, OUT + `/04-duck-${kind}.png`);
}
{
  // The opposite way round: ducking must not be a general invulnerability.
  const duck = await fairnessTrial('cactus-small', true);
  ok('ducking does not save you from a cactus', duck.died, JSON.stringify(duck));
}

// --- cameras on the real renderer ----------------------------------------------------

await ensureRunning();
for (const mode of ['side', 'low', 'orbit', 'top', 'free', 'chase']) {
  await ensureRunning();
  await evaluate(`window.dino3d.setCameraMode('${mode}')`);
  await sleep(280);
  const cam = await evaluate(`(() => { const p = window.dino3d.rig.camera.position;
    return { mode: window.dino3d.rig.mode, x: p.x, y: p.y, z: p.z,
      tris: window.dino3d.worldScene.renderer.info.render.triangles }; })()`);
  ok(`camera "${mode}" renders`, cam.mode === mode && Number.isFinite(cam.x)
    && Number.isFinite(cam.y) && cam.tris > 1000, JSON.stringify(cam));
  await shot(c, OUT + `/05-cam-${mode}.png`);
}

// --- pause, death, restart -----------------------------------------------------------

await ensureRunning();
await press('p', 'KeyP'); await sleep(200);
ok('P pauses', (await evaluate(`window.dino3d.game.state`)) === 'paused');
await shot(c, OUT + '/06-paused.png');
await press('p', 'KeyP'); await sleep(200);
ok('P resumes', (await evaluate(`window.dino3d.game.state`)) === 'playing');

// Polled rather than slept on a fixed guess: the dying state advances on the render loop,
// and in a headless tab the frame rate is nothing like the 60 Hz those timings were
// authored against, so a hardcoded sleep just races the animation.
await evaluate(`window.dino3d.game.die({ x: -3, y: 4, z: 0.3 })`);
await evaluate(`(async () => {
  const t0 = performance.now();
  while (window.dino3d.game.state === 'dying' && performance.now() - t0 < 12000)
    await window.__tick(700);
})()`);
const over = await evaluate(`(() => { const a = window.dino3d; return {
  state: a.game.state, limp: a.dinoMesh.limp, pelvis: a.game.dino.pelvis.y }; })()`);
ok('death reaches game over', over.state === 'gameover', JSON.stringify(over));
ok('corpse is limp and down', over.limp > 0.2 && over.pelvis < 1.0, JSON.stringify(over));
await shot(c, OUT + '/07-gameover.png');

await evaluate(`window.dino3d.game.restart()`);
await sleep(700);
ok('restart plays again', (await evaluate(`window.dino3d.game.state`)) === 'playing');

// --- day/night -----------------------------------------------------------------------

// The sky is a ShaderMaterial rather than scene.background, so what appears on screen is
// decided by uniform values. Comparing scene.background would pass while the sky stayed
// wrong, which is exactly the bug that was here: the darkness weight used
// pow(sin(pi * tod), 0.75), which peaks at tod = 0.5, so noon rendered as midnight while
// the HUD's own isNight flag said otherwise.
const skyRead = `(() => { const u = window.dino3d.worldScene._skyUniforms;
  const h = (c) => '#' + c.getHexString();
  return { top: h(u.topColor.value), mid: h(u.midColor.value),
    stars: +u.starAmount.value.toFixed(3),
    fog: '#' + window.dino3d.worldScene.scene.fog.color.getHexString() }; })()`;

// Driven through the same entry point frame() uses, rather than waiting for a frame to
// happen to arrive. Waiting on frame delivery made this check measure the harness's
// tab-visibility luck instead of the lighting; the lighting is a pure function of
// timeOfDay, so it can be exercised directly and deterministically.
const setTOD = (t, night) => evaluate(
  `(() => { const g = window.dino3d.game; g.timeOfDay = ${t}; g.isNight = ${night};
     window.dino3d.worldScene.setPalette(${t}, ${night}); })()`);

await setTOD(0.5, false);
const day = await evaluate(skyRead);
await shot(c, OUT + '/08-day.png');
await setTOD(0.02, true);
const night = await evaluate(skyRead);
await shot(c, OUT + '/09-night.png');
ok('night actually darkens the sky', day.top !== night.top && day.stars < night.stars,
  `day ${JSON.stringify(day)} vs night ${JSON.stringify(night)}`);
// The claim that matters, stated directly: noon is brighter than midnight.
const lum = (h) => {
  const n = parseInt(h.slice(1), 16);
  return ((n >> 16 & 255) + (n >> 8 & 255) + (n & 255)) / 3;
};
ok('noon is brighter than midnight', lum(day.top) > lum(night.top),
  `day top ${day.top} (${lum(day.top).toFixed(0)}) vs `
  + `night top ${night.top} (${lum(night.top).toFixed(0)})`);

// --- console --------------------------------------------------------------------------

// Captured by CDP rather than by a hook the page could install and hide.
const errs = consoleErrors();
ok('page logged no errors or warnings', !errs.length, JSON.stringify(errs).slice(0, 600));

console.log(fails.length ? `\n${fails.length} browser failure(s)` : '\nbrowser test passed');
console.log(`screenshots -> ${OUT}`);

await g.close();
if (serverProc) serverProc.kill('SIGKILL');
process.exit(fails.length ? 1 : 0);
