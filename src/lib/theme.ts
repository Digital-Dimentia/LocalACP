// Appearance preference: follow the OS, or pin light / dark explicitly.
//
// The choice is expressed as a `data-theme` attribute on the document element
// and read by the palette rules in `App.vue` (and the component-level dark
// blocks in TrafficMonitor / ModelPicker / ModePicker). "system" removes the
// attribute entirely, which is what leaves `prefers-color-scheme` in charge.
//
// Persistence deliberately uses `localStorage` rather than the `preferences.json`
// KVStore that holds `lastCwd` and the telemetry opt-in. The theme has to be
// applied before the first paint or the window flashes the wrong palette on
// every launch, and that demands a *synchronous* read: on Tauri the KVStore is
// backed by plugin-store, which is an async round-trip to a file. `localStorage`
// is synchronous and present in both the Tauri webview and the browser build.
// An inline bootstrap script in `index.html` would be the other way to do it,
// but the CSP is `script-src 'self'` and inline script is (correctly) refused.

export type ThemePreference = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'acp-ui:theme';

function isThemePreference(v: unknown): v is ThemePreference {
  return v === 'system' || v === 'light' || v === 'dark';
}

/** Read the stored preference, defaulting to following the OS. */
export function loadThemePreference(): ThemePreference {
  if (typeof localStorage === 'undefined') return 'system';
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return isThemePreference(raw) ? raw : 'system';
  } catch (e) {
    // Private mode and similar can throw on access rather than return null.
    console.warn('Failed to read the theme preference:', e);
    return 'system';
  }
}

/** Reflect a preference into the DOM. Safe to call before Vue mounts. */
export function applyTheme(pref: ThemePreference): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (pref === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', pref);
}

/** Apply a preference and persist it for the next launch. */
export function setThemePreference(pref: ThemePreference): void {
  applyTheme(pref);
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, pref);
  } catch (e) {
    // Quota or private mode: the theme still applies for this session.
    console.warn('Failed to persist the theme preference:', e);
  }
}
