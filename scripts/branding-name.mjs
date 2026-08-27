// The brand *name*, resolved once and shared by everything that needs it
// before the frontend exists: `vite.config.ts` (which bakes it into the
// bundle) and `apply-branding.mjs` (which writes it into the Tauri config and
// Cargo manifest). Keeping one resolver means the JavaScript bundle and the
// native app can never disagree about what the product is called.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DEFAULT_BRAND_NAME = 'ACP UI';

/** Longest name the sidebar header renders without ellipsing. */
export const MAX_BRAND_NAME_LENGTH = 64;

/** Parsed `branding.json`, or `{}` when the file is absent. */
export function readBrandingFile() {
  try {
    return JSON.parse(
      readFileSync(fileURLToPath(new URL('../branding.json', import.meta.url)), 'utf-8')
    );
  } catch (e) {
    // A missing branding.json is fine -- the defaults stand in. A malformed
    // one is not: it means someone tried to rebrand and failed.
    if (e.code !== 'ENOENT') {
      throw new Error(
        `branding.json is unreadable or not valid JSON: ` +
          `${e instanceof Error ? e.message : String(e)}`
      );
    }
    return {};
  }
}

/**
 * The product name: `$ACP_UI_BRAND_NAME`, else `branding.json`, else the
 * default. Throws rather than falling back on anything malformed.
 */
export function brandName(file = readBrandingFile()) {
  const raw = process.env.ACP_UI_BRAND_NAME ?? file.name ?? DEFAULT_BRAND_NAME;
  if (typeof raw !== 'string') {
    throw new Error(`branding name must be a string, got ${typeof raw}.`);
  }
  const name = raw.trim();
  if (!name) {
    throw new Error(`branding name is empty. Remove it to keep the default.`);
  }
  if (name.length > MAX_BRAND_NAME_LENGTH) {
    throw new Error(
      `branding name is ${name.length} characters; the sidebar header ellipses ` +
        `anything past roughly ${MAX_BRAND_NAME_LENGTH}. Pick a shorter name.`
    );
  }
  return name;
}

/**
 * The cargo target name for the main binary.
 *
 * This is the name macOS shows in the Dock and in the application menu while
 * the app runs unbundled under `tauri dev`, so it wants to be the brand name
 * itself -- but a cargo target name may only contain letters, digits, `-` and
 * `_`, so anything else collapses to a hyphen. A bundled build is unaffected:
 * there the name comes from CFBundleName, which is the brand name verbatim.
 */
export function binaryName(name = brandName()) {
  const slug = name
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug || !/^[A-Za-z0-9_]/.test(slug)) {
    throw new Error(
      `branding name "${name}" has no characters usable in a binary name. ` +
        `It must contain at least one letter, digit or underscore.`
    );
  }
  return slug;
}
