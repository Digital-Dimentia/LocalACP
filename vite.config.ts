import { defineConfig, type Plugin } from "vite";
import vue from "@vitejs/plugin-vue";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { extname, relative, resolve, sep } from "node:path";
import { binaryName, brandName, readBrandingFile } from "./scripts/branding-name.mjs";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

const repoRoot = fileURLToPath(new URL(".", import.meta.url));

// Read the package version once at config-evaluation time so we can inject
// it into the web build (the Tauri build reads it from `tauri.conf.json`
// instead via `@tauri-apps/api/app#getVersion`).
const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf-8")
) as { version: string };

// ---------------------------------------------------------------------------
// White-label branding.
//
// The product name and the brand icon are resolved here, at build time, and
// baked into the bundle -- there is no runtime branding config. That is a
// deliberate security choice: the icon is inlined as a `data:` URI, so the
// webview never loads an image from a path or origin chosen after the build,
// and the locked-down CSP in `tauri.conf.json` needs no widening. It also
// matches the rest of a rebrand (product name, bundle identifier, installer
// and dock icons in `tauri.conf.json`), none of which can be changed at
// runtime either.
//
// Every failure below throws rather than falling back. A white-labeller who
// typos an icon path should get a failed build, not a silently unbranded one.
// ---------------------------------------------------------------------------

const ICON_MIME_TYPES: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

interface Branding {
  name: string;
  /** `data:` URI for the brand icon, or `""` when branding sets no icon. */
  icon: string;
  /**
   * `data:` URI for a styled logotype rendered in place of the name text, or
   * `""` to render the name as text.
   */
  wordmark: string;
}

/** Read and inline the image named by a repo-relative path. */
function inlineImage(field: string, iconPath: string): string {
  // Any URI scheme is rejected outright. `https:` would be an outbound
  // beacon on every launch and a hole in the image CSP; `file:` and `data:`
  // would just be confusing ways to spell the two supported cases.
  if (/^[a-z][a-z0-9+.-]*:/i.test(iconPath)) {
    throw new Error(
      `branding ${field} "${iconPath}" is a URI. It must be a path relative to ` +
        `the repo root so it can be inlined into the bundle; remote images are ` +
        `not supported.`
    );
  }

  const absolute = resolve(repoRoot, iconPath);
  const inside = relative(repoRoot, absolute);
  if (inside.startsWith("..") || inside.startsWith(sep)) {
    throw new Error(
      `branding ${field} "${iconPath}" resolves outside the repo (${absolute}). ` +
        `Copy the image into the repo and point at it from there.`
    );
  }

  const mime = ICON_MIME_TYPES[extname(absolute).toLowerCase()];
  if (!mime) {
    throw new Error(
      `branding ${field} "${iconPath}" has an unsupported extension. ` +
        `Supported: ${Object.keys(ICON_MIME_TYPES).join(", ")}.`
    );
  }

  let bytes: Buffer;
  try {
    bytes = readFileSync(absolute);
  } catch (e) {
    throw new Error(
      `branding ${field} "${iconPath}" could not be read (${absolute}): ` +
        `${e instanceof Error ? e.message : String(e)}`
    );
  }
  if (bytes.length === 0) {
    throw new Error(`branding ${field} "${iconPath}" is empty (${absolute}).`);
  }

  return `data:${mime};base64,${bytes.toString("base64")}`;
}

function loadBranding(): Branding {
  // @ts-expect-error process is a nodejs global
  const env = process.env as Record<string, string | undefined>;

  // The name is resolved by `scripts/branding-name.mjs` rather than here,
  // because `scripts/apply-branding.mjs` needs the identical answer when it
  // writes the name into `tauri.conf.json` and `Cargo.toml` -- files this
  // config is read too late to influence. See `assertNativeBrandingApplied()`.
  const file = readBrandingFile();
  const name = brandName(file);

  const inlineField = (field: string, raw: unknown): string => {
    if (typeof raw !== "string") {
      throw new Error(`branding ${field} must be a string path, got ${typeof raw}.`);
    }
    const path = raw.trim();
    return path ? inlineImage(field, path) : "";
  };

  // An explicitly empty icon or wordmark is a legitimate choice: no icon, and
  // the name rendered as text respectively.
  return {
    name,
    icon: inlineField("icon", env.ACP_UI_BRAND_ICON ?? file.icon ?? ""),
    wordmark: inlineField(
      "wordmark",
      env.ACP_UI_BRAND_WORDMARK ?? file.wordmark ?? ""
    ),
  };
}

const branding = loadBranding();

/**
 * Fail the build when the native side is still on the previous brand.
 *
 * The macOS Dock label and the "About X" / "Hide X" / "Quit X" menu items come
 * from `NSRunningApplication.localizedName` -- CFBundleName once bundled, the
 * bare executable filename under `tauri dev`. Neither is reachable from Vite:
 * the Tauri CLI has already read `tauri.conf.json` by the time it runs
 * `beforeBuildCommand`, and the binary name lives in `Cargo.toml`. So they are
 * written ahead of time by `npm run brand:apply` and committed, and checked
 * here so a rebrand that forgets that step fails loudly instead of shipping an
 * app whose menu bar still says "acp-ui".
 *
 * Web builds skip the check: nothing native is involved.
 */
function assertNativeBrandingApplied(brand: Branding): void {
  const read = (relativePath: string) =>
    readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf-8");

  const config = JSON.parse(read("./src-tauri/tauri.conf.json")) as {
    productName?: string;
    mainBinaryName?: string;
    app?: { windows?: { title?: string }[] };
  };
  const bin = binaryName(brand.name);

  const stale: string[] = [];
  if (config.productName !== brand.name) {
    stale.push(`tauri.conf.json productName is "${config.productName}"`);
  }
  if (config.mainBinaryName !== bin) {
    stale.push(`tauri.conf.json mainBinaryName is "${config.mainBinaryName}"`);
  }
  for (const [i, w] of (config.app?.windows ?? []).entries()) {
    if (w.title !== brand.name) {
      stale.push(`tauri.conf.json window ${i} title is "${w.title}"`);
    }
  }
  const cargoBin = /\[\[bin\]\][^[]*?\bname\s*=\s*"([^"]*)"/.exec(
    read("./src-tauri/Cargo.toml")
  );
  if (cargoBin?.[1] !== bin) {
    stale.push(`Cargo.toml [[bin]] name is ${cargoBin ? `"${cargoBin[1]}"` : "absent"}`);
  }

  if (stale.length) {
    throw new Error(
      `Branding name is "${brand.name}" but the native config has not been ` +
        `updated to match: ${stale.join("; ")}. Run \`npm run brand:apply\` ` +
        `and commit the result.`
    );
  }
}

/**
 * Rewrite the branded strings baked into `index.html`.
 *
 * The document title has to be right in the served HTML rather than patched
 * from script on mount, or a rebranded build flashes "ACP UI" in the window
 * chrome and the browser tab before Vue boots.
 */
function brandingHtmlPlugin(brand: Branding): Plugin {
  const escape = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return {
    name: "acp-ui:branding-html",
    transformIndexHtml(html) {
      const name = escape(brand.name);
      return html
        .replace(/<title>[^<]*<\/title>/, `<title>${name}</title>`)
        .replace(
          /(<meta\s+property="og:title"\s+content=")[^"]*(")/,
          `$1${name}$2`
        );
    },
  };
}

// https://vite.dev/config/
export default defineConfig(async ({ mode }) => {
  const isWeb = mode === "web";

  if (!isWeb) assertNativeBrandingApplied(branding);

  return {
    plugins: [vue(), brandingHtmlPlugin(branding)],

    define: {
      // Exposed to the frontend as `import.meta.env.VITE_APP_VERSION`. The
      // host abstraction (`src/lib/host/index.ts`) reads this on the web
      // build and falls back to it when `@tauri-apps/api/app` is unavailable.
      "import.meta.env.VITE_APP_VERSION": JSON.stringify(pkg.version),
      // White-label branding, read by `src/lib/branding.ts`. The icon and
      // wordmark are `data:` URIs inlined at build time -- see `loadBranding()`.
      "import.meta.env.VITE_BRAND_NAME": JSON.stringify(branding.name),
      "import.meta.env.VITE_BRAND_ICON": JSON.stringify(branding.icon),
      "import.meta.env.VITE_BRAND_WORDMARK": JSON.stringify(branding.wordmark),
    },

    // Web builds emit to `dist-web/` so the Tauri build pipeline (which
    // expects `frontendDist: ../dist`) is unaffected.
    build: isWeb
      ? {
          outDir: "dist-web",
          emptyOutDir: true,
        }
      : undefined,

    // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
    //
    // 1. prevent Vite from obscuring rust errors
    clearScreen: false,
    // 2. tauri expects a fixed port, fail if that port is not available
    server: isWeb
      ? {
          // Browser dev server: use Vite defaults so it works behind common
          // proxies / Dev Tunnels without the strict-port behaviour Tauri
          // requires.
          port: 5173,
        }
      : {
          port: 1420,
          strictPort: true,
          host: host || false,
          hmr: host
            ? {
                protocol: "ws",
                host,
                port: 1421,
              }
            : undefined,
          watch: {
            // 3. tell Vite to ignore watching `src-tauri`
            ignored: ["**/src-tauri/**"],
          },
        },
  };
});
