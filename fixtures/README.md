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

It also advertises three slash commands (`/tools`, `/invokeTool`,
`/demo/echo`) via `available_commands_update` right after `session/new`, and
answers any prompt beginning with `/` by reporting the command and parameters
it received rather than running the sequence above. That is what exercises the
command palette and the tool-invocation row.

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

### Tool invocations

Type `/` in the composer to open the palette, then pick `demo/echo`. Selecting
it should clear the composer and drop a row into the transcript rather than
prefilling `/demo/echo ` as text:

```
🔧 /demo/echo   Echo text back
[ --text "hello world"        ]  [ Run ]
/demo/echo --text "hello world"
```

The parameter line takes focus as the row appears, Enter in it runs the call,
and the assembled line shown is exactly what gets sent. After a run
the row stays put with its parameters intact and the button reads **Re-run**,
so trying the same call with one argument changed is an edit and a click.
The mock echoes back the parameters it parsed, which is how you confirm the
line survived the trip — quotes included.

Running it should *not* add a user row for the line: the row already shows it.
The agent's reply attaches to the bottom of the same row, marked unread until
clicked:

```
🔧 /demo/echo   Echo text back    APPROVED  ×1
[ --text "hello world"        ]  [ Re-run ]
▾ 1 tool call
  ⚙️ /demo/echo  /demo/echo --text "hello world"  APPROVED ✓
────────────────────────────────────────────
● RESULT   new — click to dismiss
Invoked `/demo/echo` with params: `--text "hello world"`
```

The assembled line sits under the field until the run produces a tool call,
then rides along on that call's line instead of taking a row of its own. Edit
the parameters afterwards and it reappears under the field, because what the
row *would* send has diverged from what it *did*.

The `tool_call` the mock emits is absorbed into the row, not left as a row of
its own: it is expanded while the run is in flight and folds away once the
answer arrives. Running an unknown command (`/nope`) is the counter-case —
the mock reports that call as `failed`, and a failed call stays expanded,
because a folded failure is a silent one.

`demo/echo` also asks for permission before it runs, and that approval belongs
to the same row. While it is unanswered it renders in full *inside* the row,
never folded, and the composer stays blocked with the sticky bar pointing at
it — nesting must not hide a request. Once answered the outcome shows in the row's
header, where the collapsible list cannot fold it away, and again on the
tool-call line it gated when that list is open:

```
🔧 /demo/echo   Echoes text        APPROVED  ×1
[ --text "Foo Bar"        ]  [ Re-run ]
/demo/echo --text "Foo Bar"
▾ 1 tool call
  ⚙️ /demo/echo                    APPROVED  ✓
```

Deny instead and the header reads REJECTED, the call is reported `failed`, and
the list stays expanded — failures do not fold.

An approval left as its own row below the tool row, or a composer that
unblocks while one is unanswered, is a regression in `allPermissions()` in
`src/stores/session.ts` — everything that asks "is something waiting?" has to
see nested approvals as well as top-level ones.

A reply that renders as its own Assistant row below, or a tool call that
lands as a row after the result, means the routing in `handleSessionUpdate`
has come loose. Tool calls from an ordinary typed prompt (the issue-9
sequence) still get their own rows — the nesting only applies to a run the
user started from a tool row.

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
