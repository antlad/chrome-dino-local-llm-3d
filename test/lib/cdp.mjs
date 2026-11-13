// Minimal Chrome DevTools Protocol client using Node's built-in fetch + WebSocket.
//
// This exists because the headless smoke test runs against a stubbed GL context. It can
// prove the simulation, but it cannot prove that anything reaches the screen. Only a real
// browser can, and the user's requirement is that this game runs in Chrome, so the check
// that matters most is the one that needs a GPU.
//
// Nothing here shells out to puppeteer or playwright. The project has no runtime
// dependencies and adding a 40 MB dev dependency to drive one page would be a strange
// trade, and Node has had a stable WebSocket and fetch since 22, which is all CDP needs.

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const DEFAULT_PORT = Number(process.env.DINO_CDP_PORT || 9333);

const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  return CHROME_PATHS.find(existsSync) || null;
}

async function newTab(port, url) {
  const res = await fetch(`http://127.0.0.1:${port}/json/new?${new URLSearchParams({ url })}`,
    { method: 'PUT' });
  if (!res.ok) throw new Error(`json/new failed: ${res.status}`);
  return res.json();
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let id = 0;
  const events = [];
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
    } else if (msg.method) {
      events.push(msg);
    }
  });
  const ready = new Promise((r) => ws.addEventListener('open', r));
  return {
    ready,
    events,
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const n = ++id;
        pending.set(n, { resolve, reject });
        ws.send(JSON.stringify({ id: n, method, params }));
      });
    },
    close: () => ws.close(),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdpReady(port, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await sleep(200);
  }
  return false;
}

/**
 * Launch Chrome if no debug port is already listening, and return a killer.
 *
 * The flags are load-bearing in ways that are easy to get wrong:
 *
 *  - The renderer and background throttling switches matter more than anything about
 *    WebGL. CDP input flips the tab to document.hidden (see browser-check.mjs), and a
 *    throttled hidden tab stops producing animation frames entirely, which freezes the
 *    game's state machine with no error anywhere. Disabling throttling is what keeps a
 *    background tab's loop running.
 *  - use-angle=swiftshader gives a software GL that is deterministic and present on
 *    machines with no usable GPU, at the cost of running at roughly 13 fps. That is fine
 *    for assertions and is the reason everything in the browser test polls a condition
 *    with a budget instead of sleeping for a guessed duration.
 *  - A throwaway profile under tmpdir, so this never touches the user's real Chrome
 *    profile, cookies, or session, and so a stale singleton lock cannot wedge the run.
 */
async function launchChrome(port) {
  if (await cdpReady(port, 400)) {
    return { owned: false, port, kill: async () => {} };
  }
  const bin = findChrome();
  if (!bin) {
    throw new Error('no Chrome found. Set CHROME=/path/to/chrome, or start one with '
      + `--remote-debugging-port=${port} yourself.`);
  }
  const profile = join(tmpdir(), `dino-3d-cdp-${port}`);
  mkdirSync(profile, { recursive: true });
  const proc = spawn(bin, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--disable-gpu',
    '--use-angle=swiftshader',
    '--disable-features=RenderDocument,BackForwardCache',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--disable-background-timer-throttling',
    '--disable-hang-monitor',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-dev-shm-usage',
    '--window-size=1280,720',
    'about:blank',
  ], { stdio: 'ignore' });

  const kill = async () => {
    if (proc.exitCode === null) proc.kill('SIGKILL');
  };
  proc.on('error', () => {});

  if (!await cdpReady(port, 25000)) {
    await kill();
    throw new Error(`Chrome started but no CDP endpoint on ${port} within 25s`);
  }
  return { owned: true, port, kill, proc };
}

/**
 * Open the game in a real Chrome tab with the console and Log domains captured.
 *
 * Open about:blank first and navigate afterwards. Creating the tab already at the game
 * URL means the page boots before anything is listening, so a throw during boot is
 * invisible and the only symptom is a missing global, which is a bad way to find out
 * that the server was not up.
 */
export async function openGame(url, opts = {}) {
  const port = opts.port ?? DEFAULT_PORT;
  const chrome = await launchChrome(port);
  const tab = await newTab(port, 'about:blank');
  const c = connect(tab.webSocketDebuggerUrl);
  await c.ready;
  await c.send('Page.enable');
  await c.send('Runtime.enable');
  // Console and Log domains are what turn "it rendered a picture" into "it rendered a
  // picture without throwing". A page can look completely fine while quietly catching
  // errors every frame.
  await c.send('Log.enable').catch(() => {});

  const consoleErrors = () => c.events
    .filter((e) => e.method === 'Runtime.consoleAPICalled'
      && (e.params.type === 'error' || e.params.type === 'warning'))
    .map((e) => e.params.args.map((a) => a.description || a.value).join(' '))
    .concat(c.events
      .filter((e) => e.method === 'Runtime.exceptionThrown')
      .map((e) => e.params.exceptionDetails.exception?.description
        || e.params.exceptionDetails.text))
    .concat(c.events
      .filter((e) => e.method === 'Log.entryAdded' && e.params.entry.level === 'error')
      // The URL is included because "Failed to load resource: 404" on its own is not an
      // actionable message. It cost a detour through the server log to find which one.
      .map((e) => {
        const en = e.params.entry;
        return [en.text, en.url].filter(Boolean).join('  <-  ');
      }));

  await c.send('Page.navigate', { url });
  await sleep(1500);

  const close = async () => {
    c.close();
    await chrome.kill();
  };

  return {
    tab, c, port,
    evaluate: (e) => c.send('Runtime.evaluate',
      { expression: e, awaitPromise: true, returnByValue: true })
      .then((r) => {
        if (r.exceptionDetails) {
          throw new Error('page threw: '
            + JSON.stringify(r.exceptionDetails.exception?.description
              || r.exceptionDetails.text));
        }
        return r.result.value;
      }),
    consoleErrors,
    close,
    owned: chrome.owned,
  };
}

export async function shot(c, path) {
  const { data } = await c.send('Page.captureScreenshot', { format: 'png' });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.from(data, 'base64'));
  return path;
}

export { sleep, findChrome };
