#!/usr/bin/env node
// Mock ACP agent that opens its turn with a `tool_call` and sends no assistant
// message or thought chunk first — the sequence reported in
// https://github.com/formulahendry/acp-ui/issues/9.
//
// ACP allows `tool_call` as a standalone update, but ACP UI used to attach one
// only when an assistant message already existed, so these calls rendered as
// nothing at all. This fixture reproduces that sequence on demand; see
// fixtures/README.md for how to point a build at it.
//
// It also asks for one tool-call approval per turn, which is how the inline
// permission row in the transcript gets exercised.
//
//   node fixtures/mock-acp-agent.mjs            # stdio — desktop / Tauri build
//   node fixtures/mock-acp-agent.mjs --ws 8791  # websocket — web build (needs `ws`)

const SESSION_ID = 'mock-session-1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeAgent(send) {
  const note = (update) =>
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: SESSION_ID, update } });

  // Agent -> client requests (`session/request_permission`) need their replies
  // matched back up, so unlike notifications they are tracked by id.
  let nextRequestId = 1;
  const pending = new Map();
  function request(method, params) {
    const id = `agent-${nextRequestId++}`;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      send({ jsonrpc: '2.0', id, method, params });
    });
  }

  // The four beats that made #9 visible, in order.
  async function runTurn() {
    // 1. A tool call with nothing before it. The turn has no assistant message
    //    yet, so this is the update that used to be dropped outright.
    note({
      sessionUpdate: 'tool_call',
      toolCallId: 'call_123',
      title: 'Searching docs',
      kind: 'search',
      status: 'in_progress',
    });
    await sleep(600);

    // 2. Its update, which can only land if beat 1 created an entry.
    note({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call_123',
      status: 'completed',
      title: 'Searched docs',
    });
    await sleep(300);

    // 3. An update for a call whose `tool_call` never arrived — what a
    //    terminal-state-only agent or a mid-stream reconnect looks like.
    note({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call_orphan',
      title: 'Orphan update',
      status: 'completed',
    });
    await sleep(300);

    // 4. Assistant text mid-turn, between the tool calls and the approval.
    note({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Found it. ' } });
    await sleep(300);

    // 5. An approval, so the inline permission row can be exercised: the four
    //    ACP option kinds, a tool call to attribute them to, and a follow-up
    //    that reports back which one the user picked.
    const result = await request('session/request_permission', {
      sessionId: SESSION_ID,
      toolCall: {
        toolCallId: 'call_edit',
        title: 'Edit fixtures/README.md',
        kind: 'edit',
        status: 'pending',
        locations: [{ path: '/tmp/mock/fixtures/README.md' }],
      },
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'allow-always', name: 'Allow always', kind: 'allow_always' },
        { optionId: 'reject-once', name: 'Deny', kind: 'reject_once' },
        { optionId: 'reject-always', name: 'Deny always', kind: 'reject_always' },
      ],
    });

    const outcome = result?.outcome ?? {};
    const chosen = outcome.outcome === 'selected' ? outcome.optionId : 'cancelled';
    const allowed = chosen === 'allow-once' || chosen === 'allow-always';

    note({
      sessionUpdate: 'tool_call',
      toolCallId: 'call_edit',
      title: 'Edit fixtures/README.md',
      kind: 'edit',
      status: allowed ? 'completed' : 'failed',
      locations: [{ path: '/tmp/mock/fixtures/README.md' }],
    });
    await sleep(200);

    note({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: `You answered: ${chosen}.` },
    });
  }

  return async function handle(msg) {
    const { id, method, params } = msg;
    if (id !== undefined && method === undefined) {
      // A reply to one of our own requests, not a call to answer.
      const resolve = pending.get(id);
      if (resolve) {
        pending.delete(id);
        resolve(msg.result);
      }
      return;
    }
    if (id === undefined) return; // notification ($/ping, session/cancel) — nothing to answer
    const reply = (result) => send({ jsonrpc: '2.0', id, result });
    switch (method) {
      case 'initialize':
        return reply({
          protocolVersion: params?.protocolVersion ?? 1,
          agentCapabilities: { loadSession: false, promptCapabilities: {} },
          authMethods: [],
          agentInfo: { name: 'mock-issue9', version: '0.0.1' },
        });
      case 'session/new':
        return reply({ sessionId: SESSION_ID });
      case 'session/prompt':
        await runTurn();
        return reply({ stopReason: 'end_turn' });
      case 'authenticate':
        return reply({});
      default:
        return send({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        });
    }
  };
}

/** Split an incoming byte stream into newline-delimited JSON-RPC frames. */
function framer(onLine) {
  let buf = '';
  return (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) onLine(line);
    }
  };
}

const onError = (e) => process.stderr.write(`mock agent: ${e}\n`);

const wsIdx = process.argv.indexOf('--ws');
if (wsIdx === -1) {
  const handle = makeAgent((m) => process.stdout.write(JSON.stringify(m) + '\n'));
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', framer((line) => handle(JSON.parse(line)).catch(onError)));
} else {
  let WebSocketServer;
  try {
    ({ WebSocketServer } = await import('ws'));
  } catch {
    process.stderr.write(
      'mock agent: --ws needs the `ws` package, which acp-ui does not depend on.\n' +
        'Install it somewhere on NODE_PATH (e.g. `npm i --no-save ws`) or use stdio mode.\n'
    );
    process.exit(1);
  }
  const port = Number(process.argv[wsIdx + 1] || 8791);
  const wss = new WebSocketServer({
    port,
    // The web build negotiates `acp.v1`; extra entries carry a bearer token.
    handleProtocols: (protos) => (protos.has('acp.v1') ? 'acp.v1' : false),
  });
  wss.on('connection', (ws) => {
    const handle = makeAgent((m) => ws.send(JSON.stringify(m)));
    ws.on('message', (data) => handle(JSON.parse(data.toString())).catch(onError));
  });
  process.stderr.write(`mock agent listening on ws://127.0.0.1:${port}\n`);
}
