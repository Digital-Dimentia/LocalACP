#!/usr/bin/env node
// Mock ACP agent that opens its turn with a `tool_call` and sends no assistant
// message or thought chunk first — the sequence reported in
// https://github.com/formulahendry/acp-ui/issues/9.
//
// ACP allows `tool_call` as a standalone update, but LocalACP used to attach one
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

// Advertised so the command palette has something in it, and so the
// tool-invocation row can be exercised. Shapes and names mirror python-acp's
// `/tools` and `/invokeTool`, including the `a/b` sugar for a single tool.
//
// The per-tool entries carry their JSON Schema in `_meta`, the way an agent is
// asked to in docs/agent-integration.md, so the schema-driven parameter form
// can be developed and exercised without a live agent and real MCP servers
// behind it. Between them they cover every control the form renders:
//
//   demo/echo    required string, enum with labels, integer bounds, boolean,
//                optional string with a default
//   demo/search  array of enums (repeated flags), object, untyped property,
//                a long string that becomes a textarea, a pattern
//   demo/deploy  a conditional schema, which the form must refuse to render
//                rather than show half of
//
// `_meta` is namespaced because ACP says implementations must not assume
// anything about values there; an unnamespaced `inputSchema` would be a land
// grab on a shared dict.
const schemaMeta = (server, tool, inputSchema) => ({
  'python-acp/tool': { server, tool, inputSchema },
});

const COMMANDS = [
  { name: 'tools', description: 'List the tools this session can call' },
  {
    name: 'invokeTool',
    description: 'Call one tool by name',
    input: { hint: '<tool> --param value' },
  },
  {
    name: 'demo/echo',
    description: 'Echo text back',
    input: { hint: '--text <text> [--case <string>] [--times <integer>] [--shout]' },
    _meta: schemaMeta('demo', 'echo', {
      type: 'object',
      required: ['text'],
      properties: {
        text: {
          type: 'string',
          title: 'Text',
          description: 'What to echo back.',
        },
        case: {
          type: 'string',
          title: 'Case',
          description: 'How to case the reply.',
          enum: ['upper', 'lower', 'title'],
          enumNames: ['UPPERCASE', 'lowercase', 'Title Case'],
          default: 'lower',
        },
        times: {
          type: 'integer',
          title: 'Times',
          description: 'How many copies to send back.',
          minimum: 1,
          maximum: 10,
          default: 1,
        },
        shout: {
          type: 'boolean',
          title: 'Shout',
          description: 'Append an exclamation mark.',
        },
        prefix: {
          type: 'string',
          title: 'Prefix',
          description: 'Put in front of every copy.',
          default: '> ',
        },
      },
    }),
  },
  {
    name: 'demo/search',
    description: 'Search things, with the awkward parameter types',
    input: { hint: '--query <string> [--kind <string>] [--filter <object>]' },
    _meta: schemaMeta('demo', 'search', {
      type: 'object',
      required: ['query'],
      // `notes` becomes required the moment `filter` is used, which is the one
      // kind of dependency the form does honour.
      dependentRequired: { filter: ['notes'] },
      properties: {
        query: {
          type: 'string',
          title: 'Query',
          pattern: '^[^*].*',
          description: 'Must not start with a wildcard.',
        },
        kind: {
          type: 'array',
          title: 'Kinds',
          description: 'Repeat to search more than one kind.',
          items: {
            type: 'string',
            // A `oneOf` of consts, which is the schema-blessed way to label
            // choices — the form reads it as an enum rather than refusing it.
            oneOf: [
              { const: 'file', title: 'Files' },
              { const: 'symbol', title: 'Symbols' },
              { const: 'commit', title: 'Commits' },
            ],
          },
        },
        filter: {
          type: 'object',
          title: 'Filter',
          description: 'Arbitrary JSON, passed through as-is.',
        },
        notes: {
          type: 'string',
          title: 'Notes',
          description: 'Long enough that a single-line box is the wrong shape.',
          maxLength: 400,
        },
        cursor: {
          title: 'Cursor',
          description: 'No declared type, so the honest box is a JSON one.',
        },
      },
    }),
  },
  {
    name: 'demo/deploy',
    description: 'A conditional schema the form must decline to render',
    input: { hint: '--target <string> [--host <string>]' },
    _meta: schemaMeta('demo', 'deploy', {
      type: 'object',
      required: ['target'],
      properties: {
        target: { type: 'string', enum: ['local', 'remote'] },
        host: { type: 'string' },
      },
      // The point of this fixture: `host` is required only for `remote`, and a
      // form that rendered the unconditional half would look validated and not
      // be. The row falls back to the raw line and says why.
      if: { properties: { target: { const: 'remote' } } },
      then: { required: ['host'] },
    }),
  },
];

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

  /**
   * A prompt that starts with `/` is answered as a command invocation: the
   * mock reports the command and parameters it received, so the tool-call row
   * can be checked against what actually arrived on the wire.
   */
  async function runCommand(text) {
    const [, name, rest = ''] = /^\/(\S+)\s*([\s\S]*)$/.exec(text) ?? [];
    const known = COMMANDS.some((c) => c.name === name);
    const toolCallId = `call_${name}`;

    // `demo/echo` asks first, which is what puts an approval *inside* a
    // tool-invocation row: the request names the call listed in that row, so
    // the two have to end up in one place rather than two.
    let denied = false;
    if (name === 'demo/echo') {
      note({
        sessionUpdate: 'tool_call',
        toolCallId,
        title: `/${name}`,
        kind: 'execute',
        status: 'pending',
      });
      const answer = await request('session/request_permission', {
        sessionId: SESSION_ID,
        toolCall: { toolCallId, title: `/${name}`, kind: 'execute', status: 'pending' },
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Deny', kind: 'reject_once' },
        ],
      });
      denied = answer?.outcome?.outcome !== 'selected' || answer.outcome.optionId !== 'allow-once';
      note({
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status: denied ? 'failed' : 'completed',
      });
      await sleep(200);
      note({
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: denied
            ? `Refused: \`/${name}\` was not permitted.`
            : `Invoked \`/${name}\` with params: \`${rest || '(none)'}\``,
        },
      });
      return;
    }

    note({
      sessionUpdate: 'tool_call',
      toolCallId,
      title: `/${name}`,
      kind: 'execute',
      status: known ? 'completed' : 'failed',
    });
    await sleep(200);
    note({
      sessionUpdate: 'agent_message_chunk',
      content: {
        type: 'text',
        text: known
          ? `Invoked \`/${name}\` with params: \`${rest || '(none)'}\``
          : `No such command: \`/${name}\`. Try: ${COMMANDS.map((c) => '/' + c.name).join(', ')}`,
      },
    });
  }

  // The beats that made #9 visible, in order.
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
        // Commands are a notification, so they can only go out once the reply
        // to `session/new` has given the client a session to attach them to.
        setTimeout(
          () => note({ sessionUpdate: 'available_commands_update', availableCommands: COMMANDS }),
          0
        );
        return reply({ sessionId: SESSION_ID });
      case 'session/prompt': {
        const text = (params?.prompt ?? [])
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('');
        if (text.startsWith('/')) await runCommand(text);
        else await runTurn();
        return reply({ stopReason: 'end_turn' });
      }
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
      'mock agent: --ws needs the `ws` package, which LocalACP does not depend on.\n' +
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
