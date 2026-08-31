// The prompt timeout used to be an absolute 60s deadline armed on every
// request. A `session/prompt` for a real task routinely runs longer than that
// while streaming updates the whole time, so turns that were succeeding --
// tokens visibly rendering -- rejected with `Request timeout: session/prompt`.
//
// These tests pin the replacement: an *idle* budget that any traffic on the
// request's session resets, so a rejection means the agent actually went
// silent. Everything runs on fake timers; the "70 seconds" below cost nothing.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { AcpClientBridge } from './acp-bridge';
import type { AcpTransport, Unsubscribe } from './transport/types';

vi.mock('./platform', () => ({ hasLocalFs: () => false }));
vi.mock('./host', () => ({ readTextFile: vi.fn(), writeTextFile: vi.fn() }));

const IDLE_BUDGET_MS = 60000;
const SESSION = 'sess-1';

/** An in-memory transport that records what the bridge sends and lets a test
 *  push agent traffic back in, standing in for fixtures/mock-acp-agent.mjs. */
class FakeTransport implements AcpTransport {
  sent: unknown[] = [];
  private messageHandler: ((msg: string) => void) | null = null;
  private closeHandler: ((reason?: string) => void) | null = null;

  async send(message: string): Promise<void> {
    this.sent.push(JSON.parse(message));
  }
  onMessage(handler: (msg: string) => void): Unsubscribe {
    this.messageHandler = handler;
    return () => {
      this.messageHandler = null;
    };
  }
  onClose(handler: (reason?: string) => void): Unsubscribe {
    this.closeHandler = handler;
    return () => {
      this.closeHandler = null;
    };
  }
  async close(): Promise<void> {}

  /** Deliver a raw JSON-RPC frame from the "agent". */
  deliver(frame: unknown): void {
    this.messageHandler?.(JSON.stringify(frame));
  }
  /** A streamed assistant chunk — the traffic a long turn produces. */
  streamChunk(text: string, sessionId = SESSION): void {
    this.deliver({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } },
    });
  }
  /** Answer the pending `session/prompt` request. */
  finishTurn(stopReason = 'end_turn'): void {
    const prompt = this.sent.find((m) => (m as { method?: string }).method === 'session/prompt') as
      | { id: number }
      | undefined;
    this.deliver({ jsonrpc: '2.0', id: prompt?.id, result: { stopReason } });
  }
  drop(reason: string): void {
    this.closeHandler?.(reason);
  }
}

function newBridge() {
  const transport = new FakeTransport();
  return { transport, bridge: new AcpClientBridge(transport) };
}

/** Settle the microtask queue so promise callbacks run between timer jumps.
 *  Must go through the fake clock — a real setTimeout would never fire here. */
const flush = () => vi.advanceTimersByTimeAsync(0);

describe('AcpClientBridge request timeouts', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does not time out a turn that streams for well over the idle budget', async () => {
    const { transport, bridge } = newBridge();
    const turn = bridge.prompt({ sessionId: SESSION, prompt: [{ type: 'text', text: 'hi' }] } as never);
    const settled = vi.fn();
    turn.then(() => settled('ok'), () => settled('rejected'));

    // 70 seconds of streaming, a chunk every 5s. Under the old absolute
    // deadline the request was already rejected by the 12th chunk.
    for (let elapsed = 0; elapsed < 70000; elapsed += 5000) {
      await vi.advanceTimersByTimeAsync(5000);
      transport.streamChunk(`token ${elapsed}`);
    }
    await flush();
    expect(settled).not.toHaveBeenCalled();

    transport.finishTurn();
    await expect(turn).resolves.toMatchObject({ stopReason: 'end_turn' });
  });

  it('still rejects when the agent goes silent, within the idle budget', async () => {
    const { transport, bridge } = newBridge();
    const turn = bridge.prompt({ sessionId: SESSION, prompt: [{ type: 'text', text: 'hi' }] } as never);
    const guard = expect(turn).rejects.toThrow('Request timeout: session/prompt');

    transport.streamChunk('one');
    await vi.advanceTimersByTimeAsync(30000);
    transport.streamChunk('two'); // resets the budget
    await vi.advanceTimersByTimeAsync(IDLE_BUDGET_MS - 1);
    await vi.advanceTimersByTimeAsync(2); // now past it, with no traffic since
    await guard;
  });

  it('does not count another session\'s traffic as progress', async () => {
    const { transport, bridge } = newBridge();
    const turn = bridge.prompt({ sessionId: SESSION, prompt: [{ type: 'text', text: 'hi' }] } as never);
    const guard = expect(turn).rejects.toThrow('Request timeout: session/prompt');

    for (let elapsed = 0; elapsed < IDLE_BUDGET_MS + 5000; elapsed += 5000) {
      await vi.advanceTimersByTimeAsync(5000);
      transport.streamChunk('busy elsewhere', 'other-session');
    }
    await guard;
  });

  it('does not time out while the agent is blocked on an unanswered permission prompt', async () => {
    const { transport, bridge } = newBridge();
    const turn = bridge.prompt({ sessionId: SESSION, prompt: [{ type: 'text', text: 'hi' }] } as never);
    const settled = vi.fn();
    turn.then(() => settled('ok'), () => settled('rejected'));

    transport.deliver({
      jsonrpc: '2.0',
      id: 900,
      method: 'session/request_permission',
      params: {
        sessionId: SESSION,
        toolCall: { toolCallId: 'call_edit', title: 'Edit README' },
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
      },
    });
    await flush();
    expect(bridge.pendingPermissionRequest.value).not.toBeNull();

    // The user takes five minutes to decide. No traffic arrives in that time,
    // and none should be expected: the agent is waiting on us.
    await vi.advanceTimersByTimeAsync(5 * 60000);
    await flush();
    expect(settled).not.toHaveBeenCalled();

    bridge.resolvePermission('allow');
    await flush();
    transport.streamChunk('done');
    transport.finishTurn();
    await expect(turn).resolves.toMatchObject({ stopReason: 'end_turn' });
  });

  it('rejects in-flight requests when the transport drops', async () => {
    const { transport, bridge } = newBridge();
    const turn = bridge.prompt({ sessionId: SESSION, prompt: [{ type: 'text', text: 'hi' }] } as never);
    const guard = expect(turn).rejects.toThrow('transport closed: agent exited');
    transport.drop('agent exited');
    await guard;
  });
});
