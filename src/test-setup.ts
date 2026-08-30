// Test setup: make the frontend believe it is running in a browser, not Tauri.
//
// Almost nothing here should be load-bearing, and that is by design. Every
// `@tauri-apps/*` import in the app is a dynamic `await import(...)` behind
// `isTauriHost()` (src/lib/host/index.ts), which reads the
// `__TAURI_INTERNALS__` global the Tauri runtime injects. Under happy-dom that
// global is absent, so the web branch is taken and the Tauri packages are
// never reached.
//
// The stubs below exist for the case that assumption stops holding: a module
// that imports a plugin eagerly, or a test that deliberately pretends to be
// Tauri. Without them such a test fails deep inside a plugin trying to reach
// an IPC bridge that does not exist, which is a long way from the thing that
// actually went wrong.

import { vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => undefined),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => undefined),
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: vi.fn(() => ({ setTitle: vi.fn(async () => undefined) })),
}));

vi.mock('@tauri-apps/api/app', () => ({
  getVersion: vi.fn(async () => '0.0.0-test'),
}));

vi.mock('@tauri-apps/plugin-store', () => ({
  load: vi.fn(async () => ({
    get: vi.fn(async () => undefined),
    set: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    save: vi.fn(async () => undefined),
  })),
}));

vi.mock('@tauri-apps/plugin-log', () => ({
  debug: vi.fn(async () => undefined),
  info: vi.fn(async () => undefined),
  warn: vi.fn(async () => undefined),
  error: vi.fn(async () => undefined),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(async () => null),
  save: vi.fn(async () => null),
  confirm: vi.fn(async () => false),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile: vi.fn(async () => ''),
  writeTextFile: vi.fn(async () => undefined),
  stat: vi.fn(async () => ({ size: 0 })),
}));

vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: vi.fn(async () => undefined),
  openPath: vi.fn(async () => undefined),
}));
