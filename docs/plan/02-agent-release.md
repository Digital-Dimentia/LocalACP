# Workstream B — a python-acp release worth pinning

**Status:** blocked. The build is broken and being fixed by another agent, in another repo.
Tracked here only because Workstream C depends on it.

**Not this repo's work.** Nothing in LocalACP should wait on it except C.

## What is needed

A `Digital-Dimentia/python-acp` release — expected **v0.3.0** — cut from current `main`, whose
wheel contains `commands.py` and `mcp_catalogue.py`.

## Why the existing release cannot be used

The newest release is **v0.2.0**, tagged 2026-08-24. Its assets:

| Asset | Size |
|---|---|
| `python_acp-0.2.0-py3-none-any.whl` | 122 KB |
| `python_acp-0.2.0.tar.gz` (sdist) | 237 KB |
| `python-acp-artifacts.tar.gz` | 131 MB |
| `python-acp-container.tar` | 132 MB |

**`main` is 47 commits ahead of that tag, and the tag ships 17 of today's 23 modules.**

Missing at v0.2.0: `commands.py`, `mcp_catalogue.py`, `announcer.py`, `edits.py`,
`edit_json.py`, `markdown.py`.

Two consequences land directly on LocalACP:

### 1. No `--mcp-config`

`mcp_catalogue.py` does not exist at that tag. The v0.2.0 CLI has exactly four flags —
`--transport`, `--host`, `--port`, `--debug` (verified against `git show v0.2.0:src/python_acp/cli.py`).

The MCP catalogue bridge described in [03-freeze-and-bundle.md](03-freeze-and-bundle.md) — the
thing that turns LocalACP's existing `mcpServers` settings UI into a working MCP configuration
screen for free — has nothing to talk to without it.

### 2. No `commands.py`

LocalACP already depends on it:

- `src/lib/schema-form.ts` is written against python-acp's `parse_command` and
  `coerce_arguments`, and says so in its comments.
- `fixtures/invocation-lines.json` is an explicit cross-language contract fixture, asserted
  against that parser from both sides (python-acp commit `9dce735`, "test(contract): assert
  acp-ui's invocation lines against this repo's parser").
- Commit `cd915ad` ("feat(chat): render a tool's parameters as a form from its JSON Schema")
  builds UI on top of it.

Bundling v0.2.0 would ship LocalACP with an agent its own UI is already written past.

## What LocalACP pins

Two artifacts from the same tag, both by digest, both recorded in `pins.toml`:

1. **The wheel** — this is what gets frozen.
2. **The source tarball** — this is where the test data comes from.

### Why the source tarball is also needed

The sdist contains `src/` plus `tests/*.py` — but **not** `tests/transcripts/*.json`,
**not** `tests/fixtures/mock_mcp_server.py`, and **not** `tests/conftest.py`. There is no
`MANIFEST.in`, so setuptools' defaults exclude the non-`.py` test data.

Those three files are exactly what the conformance harness needs: the golden transcripts to
replay, the mock MCP server to spawn, and the subprocess-leak guard. So the release's own sdist
is insufficient and the tag's auto-generated source archive (or a `git archive` of the tag) is
pinned alongside it.

The wheel's sha256 is already published in the GitHub release metadata; record the tarball's
too.

## Exit criterion

A release exists whose wheel contains `commands.py` and `mcp_catalogue.py`, with its tag, wheel
sha256, and source-tarball sha256 written into this repo's `pins.toml`.
