// The echo reconciliation, which has no other way to be checked.
//
// `consumeEcho` decides whether a `user_message_chunk` is the agent repeating
// back what the composer already rendered, or genuinely new text. Getting it
// wrong is silent in both directions — a doubled prompt bubble, or a user
// message that never appears — and neither shows up in a type check.
//
// These cases were verified ad-hoc via esbuild + node when the module landed
// (acpui-7g5, cf50572); this is that same set, made permanent now that there
// is a runner to hold them.

import { beginEcho, consumeEcho } from './prompt-echo';

const PROMPT = '/demo/echo hello';

describe('beginEcho', () => {
  it('expects an echo of a real prompt', () => {
    expect(beginEcho(PROMPT)).toEqual({ text: PROMPT, matched: 0 });
  });

  it('expects nothing from an empty prompt', () => {
    // Nothing to match against, and `null` is what keeps `consumeEcho` on its
    // fast path rather than comparing every chunk to an empty string.
    expect(beginEcho('')).toBeNull();
  });
});

describe('consumeEcho', () => {
  it('swallows an exact echo arriving in one chunk', () => {
    const result = consumeEcho(beginEcho(PROMPT), PROMPT);
    expect(result).toEqual({ render: '', pending: null });
  });

  it('swallows an echo arriving token by token', () => {
    let pending = beginEcho(PROMPT);
    const rendered: string[] = [];
    for (const token of ['/demo', '/echo', ' hel', 'lo']) {
      const result = consumeEcho(pending, token);
      rendered.push(result.render);
      pending = result.pending;
    }
    expect(rendered.join('')).toBe('');
    // Fully consumed, so nothing is still expected.
    expect(pending).toBeNull();
  });

  it('renders the surplus when a chunk runs past the end of the prompt', () => {
    // The common shape: an agent echoes the prompt and a trailing newline.
    const result = consumeEcho(beginEcho(PROMPT), `${PROMPT}\n`);
    expect(result).toEqual({ render: '\n', pending: null });
  });

  it('renders everything when the agent never echoes', () => {
    const result = consumeEcho(beginEcho(PROMPT), 'Something else entirely');
    expect(result).toEqual({ render: 'Something else entirely', pending: null });
  });

  it('stops matching once a chunk diverges mid-echo', () => {
    // The matched prefix stays consumed — it really was the echo — but from
    // the divergence on, every chunk belongs to the user. An agent that
    // rewrites the prompt will keep diverging, and re-arming would swallow
    // real content.
    const first = consumeEcho(beginEcho(PROMPT), '/demo');
    expect(first.render).toBe('');
    const second = consumeEcho(first.pending, '/NOPE');
    expect(second).toEqual({ render: '/NOPE', pending: null });
  });

  it('renders replayed history, where nothing is pending', () => {
    // `session/load` needs no special case at all: the composer rendered
    // nothing locally, so there is no echo to reconcile against.
    const result = consumeEcho(null, PROMPT);
    expect(result).toEqual({ render: PROMPT, pending: null });
  });

  it('renders a second identical chunk after the first was consumed', () => {
    const first = consumeEcho(beginEcho(PROMPT), PROMPT);
    expect(first.pending).toBeNull();
    // The user genuinely sent the same text twice; only the echo is free.
    expect(consumeEcho(first.pending, PROMPT).render).toBe(PROMPT);
  });
});
