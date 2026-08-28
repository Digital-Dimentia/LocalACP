// Frontend half of the logging pipeline.
//
// The app already had ~50 `console.*` calls that only ever reached the webview
// devtools — invisible in a bundled build, which is exactly where bug reports
// come from. Rather than rewrite every call site, this module forwards the
// console into `tauri-plugin-log`, so webview and Rust records land
// interleaved in the same file (see src-tauri/src/logging.rs).
//
// Level mapping: `console.log`/`console.debug` are treated as *debug* because
// in this codebase they are progress chatter ("Prompt completed", "Config
// hot-reloaded"); `warn`/`error` keep their level and are therefore always
// recorded. That mapping is what makes the debug toggle meaningful — with it
// off the file holds the narrative, with it on the play-by-play.

import { getDebugLogging, hasLogFile } from './host';

type ConsoleMethod = 'log' | 'debug' | 'info' | 'warn' | 'error';
type ConsoleFn = (...args: unknown[]) => void;

/** Mirrors the backend toggle. Kept locally so chatty debug calls don't pay
 * for an IPC round-trip only to be dropped by the Rust-side filter. */
let debugEnabled = false;

/** Re-entrancy guard: the plugin's own transport failing would call
 * `console.error`, which would forward again, and so on. */
let forwarding = false;

let installed = false;

/** The pristine console methods, captured before patching. */
const original: Partial<Record<ConsoleMethod, ConsoleFn>> = {};

/** Render a console argument for a plain-text log line. */
function stringify(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
  try {
    return JSON.stringify(arg) ?? String(arg);
  } catch {
    // Cyclic structures, and DOM nodes with throwing getters.
    return String(arg);
  }
}

function formatArgs(args: unknown[]): string {
  return args.map(stringify).join(' ');
}

/**
 * Tell the forwarder whether debug-level records are being kept. Call this
 * whenever the toggle changes so the change applies without a restart.
 */
export function setDebugForwarding(enabled: boolean): void {
  debugEnabled = enabled;
}

/**
 * Patch `console` so its output is also written to the log file.
 *
 * Idempotent, and a no-op on hosts without a log file (the browser build),
 * where the console is already the only destination there is.
 */
export async function initLogging(): Promise<void> {
  if (installed || !hasLogFile()) return;
  installed = true;

  try {
    debugEnabled = await getDebugLogging();
  } catch {
    // Backend unreachable: keep the console patch anyway so warnings and
    // errors still reach the file once it recovers.
  }

  const plugin = await import('@tauri-apps/plugin-log');

  const sinks: Record<ConsoleMethod, (msg: string) => Promise<void>> = {
    log: plugin.debug,
    debug: plugin.debug,
    info: plugin.info,
    warn: plugin.warn,
    error: plugin.error,
  };

  (Object.keys(sinks) as ConsoleMethod[]).forEach((method) => {
    const passthrough = console[method].bind(console) as ConsoleFn;
    original[method] = passthrough;

    console[method] = ((...args: unknown[]) => {
      passthrough(...args);

      if (forwarding) return;
      // Debug records would be dropped by the Rust filter anyway; skipping
      // them here avoids an IPC call per chatty console.log.
      if ((method === 'log' || method === 'debug') && !debugEnabled) return;

      forwarding = true;
      try {
        // Fire and forget: a log write must never make a caller await, and a
        // failed write is reported through the untouched passthrough.
        void sinks[method](formatArgs(args)).catch(() => {});
      } finally {
        forwarding = false;
      }
    }) as typeof console.log;
  });
}

/** Restore the original console methods. Exists for tests and teardown. */
export function teardownLogging(): void {
  (Object.keys(original) as ConsoleMethod[]).forEach((method) => {
    const fn = original[method];
    if (fn) console[method] = fn as typeof console.log;
  });
  installed = false;
}
