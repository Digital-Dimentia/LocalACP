#!/usr/bin/env node
// Browser smoke test for the web build.
//
// The vitest suite mounts components; this drives the assembled app in a real
// browser. It starts its own vite dev server and its own copy of
// `fixtures/mock-acp-agent.mjs` over WebSocket, connects one to the other
// through the UI, plays a whole turn — prompt, tool rows, permission request,
// answer — and asserts on what actually rendered. Both children are killed on
// the way out, whichever way it exits.
//
// Run it with `make smoke` (or `npm run test:smoke`).
//
// Three things about this environment are load-bearing; change them and the
// test hangs or dies rather than failing cleanly:
//
//   1. It drives **chrome-headless-shell**, never the full Chromium build.
//      Playwright's `chromium-<rev>/…/Google Chrome for Testing.app` starts a
//      gpu-process and two crashpad handlers and then never reaches the
//      renderer under a sandboxed shell.
//   2. It passes **`--single-process`**. Chromium registers a Mach bootstrap
//      service (`MachPortRendezvousServer`) only when the browser prepares to
//      spawn child processes, and a sandbox that withholds `mach-register`
//      turns that into a fatal `bootstrap_check_in … (1100)` at startup. One
//      process needs no rendezvous.
//   3. It talks to **localhost**, not 127.0.0.1. Vite binds `[::1]` only, so
//      the dotted-quad form is refused outright.

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const SHOT_DIR = join(REPO, 'logs', 'smoke');
const PROMPT = 'hello from the smoke test';

// ---------------------------------------------------------------------------
// Finding the browser
// ---------------------------------------------------------------------------

/**
 * Locate chrome-headless-shell in Playwright's browser cache.
 *
 * The revision is whatever `playwright install` happened to put there, so it is
 * discovered rather than pinned — the binary is handed to Playwright as an
 * explicit `executablePath`, which sidesteps the version handshake entirely.
 */
function findHeadlessShell() {
  // An override that points at nothing is a typo, not a reason to fall back to
  // whatever happens to be in the cache — say so rather than launching something
  // the caller did not ask for.
  const override = process.env.PLAYWRIGHT_HEADLESS_SHELL;
  if (override) return existsSync(override) ? override : null;

  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    join(homedir(), 'Library', 'Caches', 'ms-playwright'), // macOS
    join(homedir(), '.cache', 'ms-playwright'), // Linux
    join(process.env.LOCALAPPDATA ?? '', 'ms-playwright'), // Windows
  ].filter(Boolean);

  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root)) {
      if (!entry.startsWith('chromium_headless_shell-')) continue;
      for (const platform of readdirSync(join(root, entry))) {
        for (const name of ['chrome-headless-shell', 'chrome-headless-shell.exe']) {
          const candidate = join(root, entry, platform, name);
          if (existsSync(candidate)) return candidate;
        }
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Children
// ---------------------------------------------------------------------------

const children = [];

/** Spawn under its own process group so a hung child's children die with it. */
function start(command, args, name) {
  const child = spawn(command, args, { cwd: REPO, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.name = name;
  children.push(child);
  return child;
}

function stopAll() {
  for (const child of children) {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      // Already gone, or never got a process group — nothing to do either way.
    }
  }
}

/** Resolve once `pattern` shows up on a child's output, or reject on timeout. */
function waitForLine(child, pattern, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    let buffered = '';
    const timer = setTimeout(() => {
      reject(new Error(`${child.name} did not print ${pattern} within ${timeoutMs}ms:\n${buffered}`));
    }, timeoutMs);
    const onData = (chunk) => {
      buffered += chunk;
      const match = buffered.match(pattern);
      if (!match) return;
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.stderr.off('data', onData);
      resolve(match);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`${child.name} exited with ${code} before it was ready:\n${buffered}`));
    });
  });
}

/** A port the OS says is free. Racy in principle; fine for a local fixture. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

const checks = [];

function check(description, condition, detail = '') {
  checks.push({ description, ok: Boolean(condition), detail });
  console.log(`${condition ? '  ✓' : '  ✗'} ${description}${condition || !detail ? '' : `\n      ${detail}`}`);
}

// ---------------------------------------------------------------------------
// The test
// ---------------------------------------------------------------------------

async function main() {
  const shell = findHeadlessShell();
  if (!shell) {
    console.error(
      'chrome-headless-shell was not found.\n' +
        'Install it with:  npx playwright install chromium-headless-shell\n' +
        'Or point PLAYWRIGHT_HEADLESS_SHELL at an existing binary.'
    );
    process.exit(2);
  }

  let chromium;
  try {
    ({ chromium } = await import('playwright-core'));
  } catch {
    console.error("playwright-core is not installed — run 'npm install'.");
    process.exit(2);
  }

  mkdirSync(SHOT_DIR, { recursive: true });

  const agentPort = await freePort();
  const agent = start('node', ['fixtures/mock-acp-agent.mjs', '--ws', String(agentPort)], 'mock agent');
  await waitForLine(agent, /listening on ws:\/\//);

  const vite = start('npm', ['run', 'dev:web', '--', '--strictPort', '--port', String(await freePort())], 'vite');
  // Vite prints the URL it settled on; take it from there rather than assuming.
  const [, base] = await waitForLine(vite, /(http:\/\/localhost:\d+)\//);

  console.log(`\nweb build ${base} · mock agent ws://localhost:${agentPort}\n`);

  const browser = await chromium.launch({
    executablePath: shell,
    args: ['--no-sandbox', '--single-process', '--disable-gpu'],
  });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  // Anything the app logs as an error is a failure, even if the DOM looks right.
  const consoleErrors = [];
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

  try {
    // --- boot ------------------------------------------------------------
    await page.goto(base, { waitUntil: 'networkidle' });
    check('the app boots', (await page.title()) === 'LocalACP', `title was ${await page.title()}`);
    check('the shell renders', (await page.locator('body').innerText()).includes('Welcome to LocalACP'));
    await page.screenshot({ path: join(SHOT_DIR, '1-boot.png') });

    // --- register the mock agent -----------------------------------------
    // Written straight to the key the web host reads (src/lib/host/index.ts)
    // rather than clicked through settings: the settings form is covered by
    // its own component test, and this keeps the smoke test about the turn.
    await page.evaluate(
      (url) =>
        localStorage.setItem(
          'localacp:agents',
          JSON.stringify({ agents: { 'smoke-mock': { transport: 'websocket', url } } })
        ),
      `ws://localhost:${agentPort}`
    );
    await page.reload({ waitUntil: 'networkidle' });

    const agentPicker = page.locator('select').first();
    await agentPicker.selectOption('smoke-mock');
    // A remote agent runs somewhere else, so the app requires an explicit cwd.
    await page.locator('input.cwd-input').fill(REPO);
    await page.getByRole('button', { name: 'New Session' }).click();

    await page.getByRole('button', { name: 'Disconnect' }).waitFor({ timeout: 20_000 });
    check('a session connects over the websocket transport', true);
    await page.screenshot({ path: join(SHOT_DIR, '2-connected.png') });

    // --- play a turn ------------------------------------------------------
    await page.locator('textarea').first().fill(PROMPT);
    await page.getByRole('button', { name: 'Send', exact: true }).click();

    // The fixture blocks the turn on a permission request; it is the one point
    // where the transcript cannot advance without the user.
    await page.getByText(/Permission required/i).waitFor({ timeout: 20_000 });
    const options = (await page.locator('[class*=permission] button').allInnerTexts())
      .map((s) => s.trim())
      .filter(Boolean);
    check(
      'the permission request offers all four ACP option kinds',
      ['Allow once', 'Allow always', 'Deny', 'Deny always'].every((kind) =>
        options.some((o) => o.startsWith(kind))
      ),
      `options were: ${options.join(' / ')}`
    );
    await page.screenshot({ path: join(SHOT_DIR, '3-permission.png') });

    await page.getByRole('button', { name: /Allow once/i }).first().click();
    await page.getByText(/You answered: allow-once/).waitFor({ timeout: 20_000 });

    // --- assert on the transcript ----------------------------------------
    const transcript = await page.locator('body').innerText();
    check('the prompt is echoed back as the user turn', transcript.includes(PROMPT));
    check(
      'a tool call that arrived before any assistant message is rendered',
      transcript.includes('Searched docs'),
      'this is the issue-9 regression: the store used to drop it'
    );
    check('an update whose opening tool_call never arrived is rendered', transcript.includes('Orphan update'));
    check('assistant text that arrives after the tools is rendered', transcript.includes('Found it.'));
    check('the answered permission stays in the transcript', transcript.includes('APPROVED'));
    check('the turn completes after the answer', transcript.includes('You answered: allow-once.'));
    check('the app logged no console errors', consoleErrors.length === 0, consoleErrors.join(' ;; '));
    await page.screenshot({ path: join(SHOT_DIR, '4-transcript.png'), fullPage: true });
  } finally {
    await page.screenshot({ path: join(SHOT_DIR, 'last.png') }).catch(() => {});
    await browser.close();
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} passed · screenshots in logs/smoke/`);
  return failed.length === 0;
}

process.on('exit', stopAll);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(130));

// `process.exit` rather than falling off the end: the dev server and the mock
// agent are still holding their pipes open, so the event loop would never
// drain on its own. `stopAll` runs on the way out either way.
main().then(
  (ok) => process.exit(ok ? 0 : 1),
  (err) => {
    console.error(`\nsmoke test failed: ${err.message}`);
    process.exit(1);
  }
);
