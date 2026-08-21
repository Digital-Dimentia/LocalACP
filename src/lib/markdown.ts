// Safe rendering of agent-supplied markdown.
//
// Everything an ACP agent streams back is untrusted input. It is not only a
// hostile agent we guard against: an agent that reads a file, fetches a web
// page, or quotes a dependency's README and forwards it into `session/update`
// is enough to carry an injected payload on the completely normal path.
//
// `marked` removed its built-in `sanitize` option in v5 (we are on v17), so
// any inline HTML in a markdown string reaches the DOM verbatim. Rendering
// that through `v-html` would give the agent script execution inside the
// webview -- and because the Tauri host exposes `__TAURI_INTERNALS__.invoke()`
// to page scripts, script execution there escalates to running commands as the
// user. So the markdown pipeline sanitizes before it ever reaches `v-html`.
//
// This module is the ONLY sanctioned way to turn agent text into HTML. Do not
// call `marked.parse()` directly at a `v-html` site.

import { marked } from 'marked';
import DOMPurify from 'dompurify';

// Tags that carry script, load remote content, or fake UI chrome. DOMPurify's
// default allowlist already drops most of these; naming them explicitly means
// a future DOMPurify default change cannot silently widen our surface.
const FORBID_TAGS = [
  'script',
  'style',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'link',
  'meta',
  'base',
  'form',
  'input',
  'button',
  'select',
  'textarea',
];

// `style` is stripped because markdown never emits it -- only raw inline HTML
// from the agent would -- and it enables overlay / clickjacking tricks against
// the surrounding app chrome.
const FORBID_ATTR = ['style'];

let hooksInstalled = false;

function installHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;

  // Any link that survives sanitizing still points somewhere the agent chose,
  // so deny it access to `window.opener` and drop referrer information.
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A' && node.hasAttribute('href')) {
      node.setAttribute('rel', 'noopener noreferrer nofollow');
    }
  });
}

/**
 * Render untrusted markdown to HTML that is safe to hand to `v-html`.
 *
 * Legitimate markdown -- code fences, tables, links, emphasis, lists -- is
 * preserved. Script-bearing constructs are removed: `<script>`, inline event
 * handlers such as `onerror`, and `javascript:` URLs.
 */
export function renderMarkdown(content: string): string {
  installHooks();
  const html = marked.parse(content, { async: false }) as string;
  return DOMPurify.sanitize(html, {
    FORBID_TAGS,
    FORBID_ATTR,
    // Agent content has no reason to set `data-*`, and they are a common
    // vector for feeding attacker-chosen values into app-side scripts.
    ALLOW_DATA_ATTR: false,
    // Keep `<svg>`/MathML out entirely; markdown does not produce them and
    // they carry their own script and xlink:href surface.
    USE_PROFILES: { html: true },
  });
}
