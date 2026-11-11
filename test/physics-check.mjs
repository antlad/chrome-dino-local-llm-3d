// Headless solver sanity: a hanging chain and a 3-particle angular limb.
// Run: node test/physics-check.mjs
import assert from 'node:assert/strict';
import { PhysicsWorld, angle3 } from '../src/engine/pbd3d.js';

function test(name, fn) {
  try {
    fn();
    console.log('  ok  ' + name);
  } catch (err) {
    console.log('FAIL  ' + name + '\n      ' + err.message);
    process.exitCode = 1;
  }
}

test('particles fall and rest on the ground', () => {
  const w = new PhysicsWorld({ gravity: -24, substeps: 4, iterations: 4 });
  const p = w.addParticle({ x: 0, y: 3, z: 0, mass: 1, radius: 0.1 });
  for (let i = 0; i < 240; i++) w.step(1 / 60);
  const y = w.pos[p * 3 + 1];
  assert.ok(y > 0.09 && y < 0.12, 'rest height was ' + y);
  const [, vy] = w.getVel(p);
  assert.ok(Math.abs(vy) < 0.5, 'residual vy ' + vy);
});

test('distance constraint holds a chain length', () => {
  const w = new PhysicsWorld({ gravity: -24, substeps: 4, iterations: 6 });
  const top = w.addParticle({ x: 0, y: 4, z: 0, pinned: true, radius: 0.05 });
  let prev = top;
  const parts = [top];
  for (let i = 1; i <= 5; i++) {
    const p = w.addParticle({ x: i * 0.02, y: 4 - i * 0.5, z: 0, mass: 1, radius: 0.05 });
    w.addDistance(prev, p, { rest: 0.5, stiff: 1 });
    prev = p;
    parts.push(p);
  }
  for (let i = 0; i < 300; i++) w.step(1 / 60);
  for (const d of w.dist) {
    const got = w.distance(d.a, d.b);
    assert.ok(Math.abs(got - d.rest) < 0.06, `link ${got.toFixed(3)} vs ${d.rest}`);
  }
});

test('angular constraint tracks its target', () => {
  const w = new PhysicsWorld({ gravity: 0, damping: 1, substeps: 4, iterations: 8 });
  const a = w.addParticle({ x: 1, y: 0, z: 0, mass: 2, radius: 0.05 });
  const b = w.addParticle({ x: 0, y: 0, z: 0, mass: 1, radius: 0.05 });
  // Starts fully folded (theta ~ 0) and must be driven open to 90 degrees.
  const c = w.addParticle({ x: 1, y: 0.02, z: 0, mass: 0.4, radius: 0.05 });
  w.addDistance(a, b, { rest: 1, stiff: 1 });
  w.addDistance(b, c, { rest: 1, stiff: 1 });
  w.addAngle(a, b, c, { target: Math.PI / 2, lo: 0, hi: Math.PI, stiff: 0.6, name: 'knee' });
  for (let i = 0; i < 400; i++) w.step(1 / 60);
  const got = angle3(w.pos, a, b, c);
  assert.ok(Math.abs(got - Math.PI / 2) < 0.15, 'angle ' + got.toFixed(3));
});

test('angular limits are respected', () => {
  const w = new PhysicsWorld({ gravity: 0, damping: 1, substeps: 4, iterations: 8 });
  const a = w.addParticle({ x: 1, y: 0, z: 0, mass: 5, radius: 0.05 });
  const b = w.addParticle({ x: 0, y: 0, z: 0, mass: 1, radius: 0.05 });
  const c = w.addParticle({ x: 1, y: 0.02, z: 0, mass: 0.4, radius: 0.05 });
  w.addDistance(a, b, { rest: 1, stiff: 1 });
  w.addDistance(b, c, { rest: 1, stiff: 1 });
  w.addAngle(a, b, c, { target: 0, lo: Math.PI / 3, hi: Math.PI, stiff: 0.8, limitStiff: 1, name: 'knee' });
  for (let i = 0; i < 300; i++) w.step(1 / 60);
  const got = angle3(w.pos, a, b, c);
  assert.ok(got > Math.PI / 3 - 0.12, 'limit violated: ' + got.toFixed(3));
});

test('nothing tunnels through the ground at speed', () => {
  const w = new PhysicsWorld({ gravity: -24, substeps: 8, iterations: 4 });
  const p = w.addParticle({ x: 0, y: 12, z: 0, mass: 1, radius: 0.12, vy: -18 });
  let minY = Infinity;
  for (let i = 0; i < 300; i++) {
    w.step(1 / 60);
    minY = Math.min(minY, w.pos[p * 3 + 1]);
  }
  assert.ok(minY > -0.02, 'sank to ' + minY.toFixed(3));
});

test('momentum carries a corpse forward while it falls', () => {
  const w = new PhysicsWorld({ gravity: -24, substeps: 4, iterations: 5 });
  const a = w.addParticle({ x: 0, y: 1.2, z: 0, mass: 4, radius: 0.2, vx: 8, friction: 0.9 });
  const b = w.addParticle({ x: 0.8, y: 1.2, z: 0, mass: 2, radius: 0.15, vx: 8, friction: 0.9 });
  w.addDistance(a, b, { rest: 0.8, stiff: 1 });
  for (let i = 0; i < 120; i++) w.step(1 / 60);
  const travel = w.pos[a * 3];
  assert.ok(travel > 2.5, 'only travelled ' + travel.toFixed(2));
  assert.ok(w.pos[a * 3 + 1] < 0.5, 'never fell: ' + w.pos[a * 3 + 1]);
});

console.log(process.exitCode ? '\nFAILED' : '\nall physics checks passed');
