// Reconciling the two places a user message can come from.
//
// The composer renders your text immediately (`sendPrompt` pushes it into
// `messages` before the RPC is even sent) so the UI feels responsive. Agents
// then echo the same prompt back as a `session/update` with
// `user_message_chunk` — correctly, because that echo is what `session/load`
// replays history with later. Left alone the two collide: the chunk handler
// appends to the last user message and the bubble reads
// "/Demo/echo foo bar/Demo/echo foo bar".
//
// Rather than suppress the echo by mode ("are we replaying?"), which would
// need a flag threaded through both connect paths and would silently swallow
// live user chunks that are *not* echoes, this consumes the echo against what
// was already rendered. Chunks matching the pending text are dropped; the
// moment one diverges, matching stops and everything from there is rendered.
// Replay needs no special case at all: nothing is pending during
// `session/load`, so every chunk renders.

/** What the client rendered locally and is still expecting to be echoed. */
export interface PendingEcho {
  /** The full text handed to `session/prompt`. */
  readonly text: string;
  /** How much of `text` the agent has echoed back so far. */
  readonly matched: number;
}

export interface EchoResult {
  /** The part of the chunk still to be rendered. Empty means fully consumed. */
  render: string;
  /** Carry into the next chunk; `null` once consumed or diverged. */
  pending: PendingEcho | null;
}

/** Start expecting an echo of `text`. */
export function beginEcho(text: string): PendingEcho | null {
  // An empty prompt has nothing to match against, and a null pending state
  // keeps `consumeEcho` on its fast path.
  return text.length > 0 ? { text, matched: 0 } : null;
}

/**
 * Match one incoming `user_message_chunk` against the pending local echo.
 *
 * Agents chunk their echo however they like — one chunk, one per token, or a
 * chunk that runs past the end of the prompt (a trailing newline is the common
 * case) — so this matches incrementally and hands back only the surplus.
 */
export function consumeEcho(
  pending: PendingEcho | null,
  chunk: string
): EchoResult {
  if (!pending) return { render: chunk, pending: null };

  const remainder = pending.text.slice(pending.matched);

  if (chunk.length <= remainder.length) {
    if (!remainder.startsWith(chunk)) {
      // Diverged: this is not our echo after all. Render it, and stop
      // matching — an agent that rewrites the prompt will keep diverging,
      // and every later chunk belongs to the user.
      return { render: chunk, pending: null };
    }
    const matched = pending.matched + chunk.length;
    return {
      render: '',
      pending: matched >= pending.text.length ? null : { text: pending.text, matched },
    };
  }

  // The chunk runs past the end of what we rendered locally. If it starts with
  // what is left, the overlap is the echo and the surplus is new content.
  if (chunk.startsWith(remainder)) {
    return { render: chunk.slice(remainder.length), pending: null };
  }
  return { render: chunk, pending: null };
}
