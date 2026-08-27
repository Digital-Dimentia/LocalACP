#!/usr/bin/env node
// Push the brand name from `branding.json` into the two native-side files
// that Vite cannot reach: `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`.
//
// Why this is a separate, committed step rather than part of the build:
//
//   * The Tauri CLI reads `tauri.conf.json` before it runs `beforeBuildCommand`,
//     so a build-time rewrite would be one build too late for `productName`.
//   * `Cargo.toml` is an input to cargo, and a build that edits it dirties the
//     working tree on every run.
//
// So this mirrors `generate-brand.sh`: run it after editing `branding.json`,
// commit what it writes. `vite.config.ts` fails the build if the two drift,
// so a forgotten run cannot ship half-rebranded.
//
// The name reaches macOS through three different mechanisms, which is why it
// has to be written in three places:
//
//   productName     -> CFBundleName in the bundled .app. The Dock hover label
//                      and the "About X" / "Hide X" / "Quit X" menu items all
//                      come from NSRunningApplication.localizedName, which is
//                      CFBundleName once the app is bundled.
//   [[bin]] name    -> the executable's filename. Under `tauri dev` there is no
//                      .app, so localizedName falls back to this. Without it the
//                      whole application menu reads "acp-ui" during development.
//   mainBinaryName  -> tells `tauri build` which cargo output to bundle, now
//                      that the binary is no longer named after the package.
//
// Usage: node scripts/apply-branding.mjs [--check]
//   --check exits non-zero and writes nothing if the files are out of date.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { brandName, binaryName } from './branding-name.mjs';

const repoRoot = new URL('../', import.meta.url);
const check = process.argv.includes('--check');

const name = brandName();
const bin = binaryName(name);
const drift = [];

/** Read, transform, and write back (or record drift under --check). */
function patch(relativePath, transform) {
  const path = fileURLToPath(new URL(relativePath, repoRoot));
  const before = readFileSync(path, 'utf-8');
  const after = transform(before);
  if (after === before) return;
  if (check) {
    drift.push(relativePath);
    return;
  }
  writeFileSync(path, after);
  console.log(`updated ${relativePath}`);
}

patch('src-tauri/tauri.conf.json', (source) => {
  // Edited as text rather than parsed and re-serialised so the file keeps its
  // key order, its formatting and the long CSP strings exactly as authored.
  const config = JSON.parse(source);
  let out = source;

  const replaceValue = (key, value) => {
    const pattern = new RegExp(`("${key}"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`);
    if (!pattern.test(out)) {
      throw new Error(
        `src-tauri/tauri.conf.json has no "${key}" key to update. Add it (any ` +
          `value will do) and re-run scripts/apply-branding.mjs.`
      );
    }
    out = out.replace(pattern, `$1${JSON.stringify(value)}`);
  };

  replaceValue('productName', name);
  replaceValue('mainBinaryName', bin);

  // The window title is also set at runtime by `applyBrandTitle()`, but the
  // config value is what the window is created with -- leaving it stale flashes
  // the old name in the title bar until the frontend boots.
  if (config.app?.windows?.length !== 1) {
    throw new Error(
      `scripts/apply-branding.mjs assumes exactly one configured window; found ` +
        `${config.app?.windows?.length ?? 0}. Teach it to rewrite each title.`
    );
  }
  replaceValue('title', name);

  return out;
});

patch('src-tauri/Cargo.toml', (source) => {
  const pattern = /(\[\[bin\]\][^[]*?\bname\s*=\s*)"[^"]*"/;
  if (!pattern.test(source)) {
    throw new Error(
      `src-tauri/Cargo.toml has no [[bin]] section with a name to update. ` +
        `Add one pointing at src/main.rs and re-run scripts/apply-branding.mjs.`
    );
  }
  return source.replace(pattern, `$1"${bin}"`);
});

if (check && drift.length) {
  console.error(
    `Brand name "${name}" is not applied to: ${drift.join(', ')}.\n` +
      `Run \`npm run brand:apply\` and commit the result.`
  );
  process.exit(1);
}
