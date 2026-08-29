# Notes for agent implementers

What acp-ui does with what you send, and what you can send that makes it do
more. Written for python-acp first, but nothing here is specific to it.

**The rule this document keeps:** every suggestion stays inside the ACP
contract. Where ACP has no field for something, the answer is `_meta` — the
protocol's own extensibility point — and never a private method, a magic
string in a message body, or a field invented on a typed struct. An agent that
follows none of this still works; everything below is additive.

acp-ui speaks **ACP v1** and refuses to continue if `initialize` negotiates
anything else (`src/stores/session.ts:72`).

---

## 1. The handshake

acp-ui sends (`src/stores/session.ts:592`):

```json
{
  "clientCapabilities": { "fs": { "readTextFile": true, "writeTextFile": true } },
  "clientInfo": { "name": "acp-ui", "title": "ACP UI", "version": "…" }
}
```

`fs.*` is `true` only on the desktop build, where a real filesystem exists.
**Read it and honour it.** An agent that calls `fs/read_text_file` because it
assumes every client has one gets a method-not-found and a broken turn.

acp-ui reads back exactly two things from your response:

| Field | What it changes |
|---|---|
| `agentCapabilities.loadSession` | Whether sessions are resumable at all |
| `agentCapabilities.mcpCapabilities` | Which MCP transports acp-ui offers you (`src/lib/types.ts`, `toWireMcpServers`) |

`mcpCapabilities` matters more than it looks: acp-ui holds the user's MCP
server list and filters it to the transports you say you support. Understate
your capabilities and servers are silently withheld; overstate them and the
user sees "MCP is broken" when your side fails to connect.

---

## 2. Tool parameter schemas — the ask

This is the one new thing, and the reason the document exists.

**Today.** You announce one `AvailableCommand` per MCP tool. Its `input` is
`UnstructuredCommandInput` — a single free-text `hint` string, which is ACP's
only argument shape. acp-ui renders that hint as a placeholder over a text box
and the user types a command line by hand, learning the flag names, the types
and the legal enum values by trial and error.

**The waste.** You already have the schema. python-acp's `tool_command_hint`
(`commands.py:912`) walks the tool's `inputSchema` — its `properties`, `type`
and `required` — to *build* that hint, and then discards the structure.

**The ask.** Keep the hint exactly as it is, and attach the schema to
`_meta`, which `AvailableCommand` already carries:

```python
AvailableCommand(
    name=f"{server}/{name}",
    description=tool.get("description") or f"MCP tool {name!r}",
    input=AvailableCommandInput(root=UnstructuredCommandInput(hint=tool_command_hint(tool))),
    field_meta={"python-acp/tool": {
        "server": server,
        "tool": name,
        "inputSchema": tool.get("inputSchema"),
    }},
)
```

With that, acp-ui renders a real form: typed inputs, required markers, ranges,
and **enum values as dropdowns** instead of a value the user has to know and
spell correctly.

### Conventions

- **Namespace the key.** ACP says implementations MUST NOT make assumptions
  about `_meta` values. An unnamespaced `inputSchema` is a land grab on a
  shared dict. acp-ui reads `_meta["python-acp/tool"].inputSchema` first and a
  bare `_meta.inputSchema` second, so another agent can adopt the idea without
  adopting our namespace.
- **Omit rather than fake.** A tool that publishes no schema should leave the
  key out. `"inputSchema": null` is noise that every reader has to defend
  against.
- **Pass it through verbatim.** Send what `tools/list` returned. Do not
  normalise, re-order or "clean up" — the client's job is to render your
  server's own vocabulary, and a helpfully-rewritten schema is one more place
  for the form and the parser to disagree.

### What acp-ui uses

`properties`, `required`, and per-property `type`, `title`, `description`,
`default`, `enum` (+ `enumNames` or `oneOf[].title` for labels), `format`,
`minimum` / `maximum` / `multipleOf`, `minLength` / `maxLength`, `pattern`,
and `items` for arrays. It also supports `dependentRequired`.

It does **not** render `if`/`then`/`else`, `dependentSchemas`, `allOf`, or
discriminated `oneOf`. Those are detected and the form steps aside to a raw
line with a reason, rather than rendering a subset of a conditional schema as
though it were the whole thing. If your tools use them, nothing breaks — the
user just gets today's text box.

### The one cost — measure it

`available_commands_update` is re-announced **every turn**. Schemas are much
larger than the one-line hints they summarise, so this multiplies the size of
a per-turn notification. Weigh it before shipping. If it is material, the
options are to send `_meta` only in the once-per-session announcement (at the
cost of the per-turn list disagreeing with it), or to gate it on a client
capability advertised in `clientCapabilities._meta` — more correct, more work.
Do not pre-optimise a payload nobody has weighed.

### Validation stays yours

A client-side form is a convenience. **acp-ui does not treat a locally-valid
form as pre-approved**, and neither should you: keep validating on arrival
(python-acp's `coerce_arguments`, `commands.py:638`). Any client can send any
line. A form that let the agent skip its own checks would be a regression in
exactly the direction that matters.

---

## 3. Slash commands

- `name` is what gets sent back, verbatim, with a leading `/`. Accept it in
  the form you advertised it.
- `description` is one line in a palette. Write it as a label, not a manual.
- `input.hint` should describe a command that really runs. It is the only
  syntax documentation most users will ever see, and until schemas arrive it
  is the *only* thing standing between them and a positional guess.
- Announce commands as early as you can. acp-ui's palette is empty until the
  first `available_commands_update`, and an empty palette reads as "this agent
  has no commands", not "the list has not arrived yet".

---

## 4. Tool calls

`ToolCall` carries `toolCallId`, `title`, `kind`, `status`, `content`,
`locations`, `rawInput`, `rawOutput`. acp-ui renders the first five today and
tracks `rawInput`/`rawOutput` as future work (`acpui-n3z`) — send them anyway,
they cost you nothing and unblock that work with no agent change.

**Send a `tool_call` before the work, and `tool_call_update` after.** acp-ui
handles a call that only ever appears as a terminal update
(`src/stores/session.ts:398`) — it synthesises the opening row — but then the
user sees nothing at all while the tool runs, which on a slow call is
indistinguishable from a hung agent.

**`kind` is a closed vocabulary**: `read`, `edit`, `delete`, `move`, `search`,
`execute`, `think`, `fetch`, `switch_mode`, `other`. Anything else falls back
to a generic wrench icon (`src/lib/tool-icons.ts`). It is worth getting right:
`kind` is the only signal the user has, at a glance, that a call is about to
touch their filesystem rather than read a web page.

**`status` is `pending` → `in_progress` → `completed` | `failed`.** Report
`failed` honestly. acp-ui keeps failed calls expanded when everything else
folds away, precisely so a failure is never silent — that only works if you
mark them.

**`locations` is worth filling in.** It is how a tool call says which file it
touched, in a form the UI can use.

---

## 5. Permission requests

`session/request_permission` carries a `toolCall` and a list of `options`.

**Set `toolCall.toolCallId` to the id of the call it gates.** This is the
single highest-value field in the request. acp-ui collapses an answered
approval onto the very call it authorised
(`src/components/timeline/rows/ToolInvokeRow.vue`); without a matching id the
decision floats as an orphan row that names a call the user has to go find.

**Offer `reject_always`.** ACP defines four `PermissionOptionKind`s, and some
SDKs' defaults ship only three — `allow_once`, `allow_always`, `reject_once` —
so a user can say "always yes" but not "always no" and gets asked again about
a tool they have already turned down. python-acp adds the fourth
(`turn_mcp_router.py`, `PERMISSION_OPTIONS`); that asymmetry is worth fixing
wherever it appears.

acp-ui treats **only** `allow_once` and `allow_always` as permission to
proceed (`isAllowOption`, `src/lib/timeline.ts:197`). An option kind it does
not recognise is not treated as an allow, and an answered request with an
unknown kind is labelled "Answered" rather than "Approved". Do not invent
kinds and expect them to be permissive.

---

## 6. The prompt echo

Agents echo the user's prompt back as a `user_message_chunk`, correctly —
that echo is what `session/load` replays history with. But acp-ui already
rendered the text locally the moment the user hit send, so left alone the two
collide and the bubble reads `/echo foo/echo foo`.

acp-ui consumes the echo against what it already rendered
(`src/lib/prompt-echo.ts`): chunks matching the pending text are dropped, and
the moment one diverges, matching stops and everything from there renders.

**What that asks of you:** echo the prompt back *byte-identically*, or not at
all. An agent that helpfully trims, re-wraps or normalises whitespace on the
echo diverges at the first character it changed, and the user sees their
prompt twice — once as they typed it, once as you rewrote it.

---

## 7. Updates acp-ui ignores today

These are valid ACP and are logged and dropped
(`src/stores/session.ts:434`). Send them if they are cheap — nothing breaks —
but **do not build a feature whose only channel is one of these**, because
today the user will never see it:

`plan`, `plan_update`, `plan_removed`, `session_info_update`, `usage_update`,
`config_option_update`.

`config_option_update` is the notable one: acp-ui offers no UI for session
config options yet, so an agent's `configOptions` are neither shown nor
settable. Keep your defaults working for a client that never touches them.

---

## 8. General rules

1. **Additive, always.** Anything a client might not understand goes in
   `_meta`. A client that ignores it must still get a correct session.
2. **Omit over null.** An absent field says "nothing to say"; a null-shaped
   one says the same thing but makes every reader defend against it.
3. **Degrade, do not fail.** acp-ui treats a malformed `_meta` as absent
   rather than as an error, because a broken schema must never cost the user
   the command. Extend the same courtesy in the other direction.
4. **Assume the client is untrusted, because it is.** Everything a client
   sends can be hand-typed. Client-side validation is UX; yours is the check.
5. **Do not assume anything is rendered.** Section 7 is the current list of
   what falls on the floor, and it will change.

---

## Checklist

| | Cost to you | What the user gets |
|---|---|---|
| `_meta` tool `inputSchema` on per-tool commands | ~3 lines | Typed form, enum dropdowns, required markers |
| `toolCallId` on permission requests | 1 field | The decision sits on the call it authorised |
| `reject_always` among the options | 1 option | "Never ask me this again" |
| `tool_call` before the work, not just after | ordering | Progress instead of an apparent hang |
| Accurate `kind` | vocabulary | A visible difference between reading and deleting |
| Byte-identical prompt echo | do nothing | The prompt appears once |
| `rawInput` / `rawOutput` on tool calls | pass-through | Nothing yet — unblocks `acpui-n3z` |
