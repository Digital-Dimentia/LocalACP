# Fixtures

Hand-run fixtures for reproducing agent behaviour that is awkward to trigger
with a real agent. They are plain Node scripts with no dependencies on the app,
so they can be pointed at a dev build, a packaged build, or the web build.

## `mock-acp-agent.mjs`

A minimal ACP agent that answers `initialize`, `session/new` and
`session/prompt`, and responds to any prompt with the update sequence from
[issue #9](https://github.com/formulahendry/acp-ui/issues/9):

1. `tool_call` (`call_123`, *Searching docs*) — **with no assistant message or
   thought chunk before it**. This is the update that used to be dropped: the
   store attached tool calls only when an assistant message already existed.
2. `tool_call_update` for `call_123` — changes its status to `completed` and its
   title to *Searched docs*. It can only apply if step 1 created an entry.
3. `tool_call_update` for `call_orphan` — an update whose opening `tool_call`
   never arrived, as sent by an agent that reports only terminal state, or seen
   after a mid-stream reconnect.
4. `agent_message_chunk` — assistant text, arriving *after* the tools.
5. `session/request_permission` for `call_edit` (*Edit fixtures/README.md*),
   offering all four ACP option kinds. The turn blocks here until answered.
6. The `call_edit` `tool_call` — `completed` if the answer allowed it, `failed`
   otherwise — followed by assistant text naming the option that was chosen.

### What correct rendering looks like

Rows in the order the events happened, with the approval answerable in line:

```
  🔍 Searched docs    ✓
  🔧 Orphan update    ✓
Assistant
  Found it.
🔐 Permission required                          ✏️ edit
Edit fixtures/README.md
📁 /tmp/mock/fixtures/README.md
[ Allow once ] [ Allow always ∞ ] [ Deny ] [ Deny always ∞ ] [ Cancel ]
```

While that row is unanswered the composer is disabled and an *Approval
required* bar sits above it; clicking the bar scrolls back to the row.
Answering flips the row to a decision (`✅ Allow once`) that stays in the
transcript, and the last two rows arrive.

A missing tool row, a tool stuck at `in_progress`, or an approval that never
appears indicate a regression in `handleSessionUpdate` in
`src/stores/session.ts`. Rows that render blank point at the registry in
`src/components/timeline/registry.ts`.

Switching **Settings → Approvals** to *Blocking dialog* should move the buttons
into the old modal while the row stays as the record.

### Desktop (stdio)

`npm run start:mock` registers the agent for you and starts the dev build; add
`-- --setup` to only write the config. It merges into whatever agents you
already have and backs the file up first. To do it by hand instead, add it to
your agent config — `~/.config/acp-ui/agents.json` on Linux,
`~/Library/Application Support/acp-ui/agents.json` on macOS,
`%APPDATA%\acp-ui\agents.json` on Windows — using an absolute path:

```json
{
  "agents": {
    "mock-issue9": {
      "command": "node",
      "args": ["/absolute/path/to/acp-ui/fixtures/mock-acp-agent.mjs"]
    }
  }
}
```

Then `npm run tauri dev`, pick **mock-issue9**, and send any prompt.

### Web (websocket)

The web build only talks to remote agents, so run the fixture as a WebSocket
server. It negotiates the `acp.v1` subprotocol the web transport expects. `ws`
is not an app dependency, so install it transiently:

```sh
npm i --no-save ws
npm run start:mock -- --ws 8791   # or: node fixtures/mock-acp-agent.mjs --ws 8791
```

Then `npm run dev:web`, add a WebSocket agent pointing at
`ws://127.0.0.1:8791`, and send any prompt.
