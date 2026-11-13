// Headless suite runner.
//
// This replaces `node --test test/`, which was reporting `tests 0 / pass 0 / fail 0` and
// exiting 0. Node's test runner only discovers files matching *.test.js / test-*.js and
// friends, and these files are named *-check.mjs, so nothing matched. The result was a
// test command that was green without running anything, which is the most dangerous kind
// of broken test setup: it looks like the opposite.
//
// The suites are not written against node:test. Four of them roll their own
// pass/fail counter and exit non-zero, and obstacle-check happens to be compatible with
// both, since it uses node:test assertions but also runs standalone. So the honest way to
// run them is as child processes and to trust their exit codes.
//
// The browser check is deliberately absent. It needs Chrome, a network port, and about a
// minute of software-rasterised rendering, so `npm test` stays offline, dependency-free
// and fast enough to run on every save. Run it explicitly with `npm run test:browser`.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

// Ordered cheapest-first, so the fast structural checks fail before the slow soak starts.
const SUITES = [
  ['contract-check', 'method names and shapes across module seams'],
  ['physics-check', 'the PBD solver itself'],
  ['dino-check', 'the ragdoll: gait, jump, duck, death'],
  ['obstacle-check', 'obstacle envelopes and fairness margins'],
  ['smoke-check', 'boot and the real loop in a stubbed DOM'],
];

function runSuite(name) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [join(HERE, `${name}.mjs`)], {
      cwd: dirname(HERE),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (b) => { out += b; });
    child.stderr.on('data', (b) => { out += b; });
    child.on('close', (code) => resolve({
      name,
      ok: code === 0,
      code,
      ms: Date.now() - started,
      lines: out.trimEnd().split('\n'),
    }));
  });
}

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const selected = only.length
  ? SUITES.filter(([n]) => only.some((a) => n === a || n === `${a}.mjs` || n.includes(a)))
  : SUITES;

if (!selected.length) {
  console.error(`no suite matched ${only.join(' ')}. known: `
    + SUITES.map(([n]) => n).join(', '));
  process.exit(2);
}

const results = [];
for (const [name, what] of selected) {
  process.stdout.write(`${name} (${what}) ... `);
  const r = await runSuite(name);
  results.push(r);
  process.stdout.write(`${r.ok ? 'ok' : `FAIL (exit ${r.code})`}  ${r.ms} ms\n`);
  if (!r.ok) {
    // Only a failing suite prints, so the passing path stays readable enough to scan.
    console.log(r.lines.map((l) => '    ' + l).join('\n'));
  }
}

const failed = results.filter((r) => !r.ok);
const total = results.reduce((s, r) => s + r.ms, 0);
console.log(`\n${results.length - failed.length}/${results.length} headless suites passed`
  + ` in ${(total / 1000).toFixed(1)} s`);
if (failed.length) {
  console.log('failed: ' + failed.map((r) => r.name).join(', '));
  console.log('\nThe browser check is separate: npm run test:browser');
  process.exit(1);
}
console.log('browser check is separate: npm run test:browser');
