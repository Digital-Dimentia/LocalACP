import { defineConfig, type Plugin } from "vite";
import vue from "@vitejs/plugin-vue";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { extname, relative, resolve, sep } from "node:path";

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

const DEFAULT_BRAND_NAME = "ACP UI";

/** Longest name the sidebar header renders without ellipsing. */
const MAX_BRAND_NAME_LENGTH = 64;

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
}

/** Read and inline the icon named by a repo-relative path. */
function inlineIcon(iconPath: string): string {
  // Any URI scheme is rejected outright. `https:` would be an outbound
  // beacon on every launch and a hole in the image CSP; `file:` and `data:`
  // would just be confusing ways to spell the two supported cases.
  if (/^[a-z][a-z0-9+.-]*:/i.test(iconPath)) {
    throw new Error(
      `branding icon "${iconPath}" is a URI. The icon must be a path relative ` +
        `to the repo root so it can be inlined into the bundle; remote icons ` +
        `are not supported.`
    );
  }

  const absolute = resolve(repoRoot, iconPath);
  const inside = relative(repoRoot, absolute);
  if (inside.startsWith("..") || inside.startsWith(sep)) {
    throw new Error(
      `branding icon "${iconPath}" resolves outside the repo (${absolute}). ` +
        `Copy the icon into the repo and point at it from there.`
    );
  }

  const mime = ICON_MIME_TYPES[extname(absolute).toLowerCase()];
  if (!mime) {
    throw new Error(
      `branding icon "${iconPath}" has an unsupported extension. ` +
        `Supported: ${Object.keys(ICON_MIME_TYPES).join(", ")}.`
    );
  }

  let bytes: Buffer;
  try {
    bytes = readFileSync(absolute);
  } catch (e) {
    throw new Error(
      `branding icon "${iconPath}" could not be read (${absolute}): ` +
        `${e instanceof Error ? e.message : String(e)}`
    );
  }
  if (bytes.length === 0) {
    throw new Error(`branding icon "${iconPath}" is empty (${absolute}).`);
  }

  return `data:${mime};base64,${bytes.toString("base64")}`;
}

function loadBranding(): Branding {
  // @ts-expect-error process is a nodejs global
  const env = process.env as Record<string, string | undefined>;

  let file: { name?: unknown; icon?: unknown } = {};
  try {
    file = JSON.parse(
      readFileSync(fileURLToPath(new URL("./branding.json", import.meta.url)), "utf-8")
    );
  } catch (e) {
    // A missing branding.json is fine -- the defaults below stand in. A
    // malformed one is not: it means someone tried to rebrand and failed.
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw new Error(
        `branding.json is unreadable or not valid JSON: ` +
          `${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  const rawName = env.ACP_UI_BRAND_NAME ?? file.name ?? DEFAULT_BRAND_NAME;
  if (typeof rawName !== "string") {
    throw new Error(`branding name must be a string, got ${typeof rawName}.`);
  }
  const name = rawName.trim();
  if (!name) {
    throw new Error(`branding name is empty. Remove it to keep the default.`);
  }
  if (name.length > MAX_BRAND_NAME_LENGTH) {
    throw new Error(
      `branding name is ${name.length} characters; the sidebar header ellipses ` +
        `anything past roughly ${MAX_BRAND_NAME_LENGTH}. Pick a shorter name.`
    );
  }

  // An explicitly empty icon means "name only", which is a legitimate choice.
  const rawIcon = env.ACP_UI_BRAND_ICON ?? file.icon ?? "";
  if (typeof rawIcon !== "string") {
    throw new Error(`branding icon must be a string path, got ${typeof rawIcon}.`);
  }
  const iconPath = rawIcon.trim();

  return { name, icon: iconPath ? inlineIcon(iconPath) : "" };
}

const branding = loadBranding();

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

  return {
    plugins: [vue(), brandingHtmlPlugin(branding)],

    define: {
      // Exposed to the frontend as `import.meta.env.VITE_APP_VERSION`. The
      // host abstraction (`src/lib/host/index.ts`) reads this on the web
      // build and falls back to it when `@tauri-apps/api/app` is unavailable.
      "import.meta.env.VITE_APP_VERSION": JSON.stringify(pkg.version),
      // White-label branding, read by `src/lib/branding.ts`. The icon is a
      // `data:` URI inlined at build time -- see `loadBranding()` above.
      "import.meta.env.VITE_BRAND_NAME": JSON.stringify(branding.name),
      "import.meta.env.VITE_BRAND_ICON": JSON.stringify(branding.icon),
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
