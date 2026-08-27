// White-label branding, resolved at build time.
//
// `vite.config.ts` reads `branding.json` (overridable per-build with the
// ACP_UI_BRAND_NAME / ACP_UI_BRAND_ICON environment variables), validates it
// and injects the result through `define`. Nothing here reads a file or a
// network resource at runtime: the icon arrives as a `data:` URI already
// embedded in the bundle, which is why the webview CSP needs no `asset://`
// or remote-origin allowance to display it.
//
// The `import.meta.env.*` reads below are replaced with string literals by
// the bundler, so the `??` fallbacks only ever apply when this module is
// loaded outside a Vite build (a bare `vue-tsc` type-check, say).

import { isTauriHost } from './platform';

/** The product name shown in the sidebar header, welcome pane and title bar. */
export const brandName: string =
  import.meta.env.VITE_BRAND_NAME || 'ACP UI';

/**
 * `data:` URI for the brand icon, or `''` when the build set no icon.
 *
 * Consumers must handle `''` (render the name alone) and must also handle the
 * image failing to decode, which a malformed icon file will do at runtime even
 * though the build inlined it successfully.
 */
export const brandIcon: string = import.meta.env.VITE_BRAND_ICON || '';

/**
 * Apply the brand name to the window/tab title.
 *
 * `index.html` is already rewritten at build time, so the title is correct
 * before Vue mounts. This additionally drives the *native* Tauri window title,
 * which is set from `tauri.conf.json` and does not follow `document.title`.
 * A rebranded build that only edits `branding.json` would otherwise keep the
 * original name in its title bar.
 */
export async function applyBrandTitle(): Promise<void> {
  if (typeof document !== 'undefined') document.title = brandName;

  if (!isTauriHost()) return;
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().setTitle(brandName);
  } catch (e) {
    // Cosmetic only -- never let a title update break startup.
    console.warn('Could not set the native window title:', e);
  }
}
