# Findings — what was verified, what was assumed

Survey conducted 2026-08-30, read-only, against `/Users/dave/dev/other/acp-ui`,
`/Users/dave/dev/other/python-acp`, and the GitHub API. **Nothing was executed and nothing was
modified.** Another agent was active in the python-acp working tree at the time.

## Verified

### python-acp — runtime shape

- 23 modules in `src/python_acp/`, 11,036 lines. Largest: `turn_mcp_router.py` (1,953),
  `commands.py` (1,376), `agent.py` (1,023), `mcp_stdio.py` (911).
- Two direct dependencies, exact-pinned: `agent-client-protocol==0.12.1`, `websockets==17.0.1`.
  Transitive: pydantic, pydantic-core, annotated-types, typing-extensions, typing-inspection.
- Exactly **two** native extensions in the runtime dependency set: `pydantic_core` (required)
  and `websockets.speedups` (optional, pure-Python fallback exists).
- `grep` for `__file__`, `sys.executable`, `importlib.resources`, `pkgutil` across
  `src/python_acp/` returns **nothing** in production code. The only `__file__` in the repo is
  in `scripts/venv_bootstrap.py`, which is build-time.
- `__init__.py:8` hardcodes `__version__` with a comment explaining that it deliberately does
  not call `importlib.metadata`, "so that importing this package never depends on it having been
  installed."
- One subprocess spawn: `mcp_stdio.py:245`, `asyncio.create_subprocess_exec(*self.command, …,
  env=None if self.env is None else {**os.environ, **self.env})`. No shell, no `shutil.which`,
  no `cwd=`.
- One runtime file read: `--mcp-config`, at `mcp_catalogue.py:210`, once at startup.
- CLI surface is four flags on current `main` plus `--mcp-config`: `--transport {ws,stdio}`,
  `--host`, `--port`, `--mcp-config`, `--debug`. Entry point `python-acp = python_acp.cli:run`.
- `transport_stdio.py` binds `acp.stdio_streams` and reserves stdout, swapping `sys.stdout` to
  stderr for the connection — skipped on Windows on purpose.
- `scripts/start-ws.sh` *activates* the venv rather than calling its interpreter by path,
  explicitly so a bare `python` named by a client resolves to that venv.
- No PyInstaller / Nuitka / shiv / zipapp / PyOxidizer work exists. Repo-wide grep for those
  plus `MEIPASS`, `frozen`, `standalone` returns only unrelated hits.

### python-acp — releases

- Three releases; newest **v0.2.0**, tagged 2026-08-24.
- Assets: wheel (122 KB), sdist (237 KB), `python-acp-artifacts.tar.gz` (131 MB),
  `python-acp-container.tar` (132 MB).
- `main` is **47 commits ahead** of v0.2.0; the tag has **17** modules vs 23 on `main`.
- Missing at the tag: `commands.py`, `mcp_catalogue.py`, `announcer.py`, `edits.py`,
  `edit_json.py`, `markdown.py`.
- `git show v0.2.0:src/python_acp/cli.py` confirms four flags, no `--mcp-config`.
- The sdist contains `src/` and `tests/*.py` but **not** `tests/transcripts/*.json`,
  `tests/fixtures/`, or `tests/conftest.py`. There is no `MANIFEST.in`.

### acp-ui — stack and integration points

- Tauri **2** + Vue 3.5 + Pinia + Vite 6 + TypeScript + Vitest.
  `@agentclientprotocol/sdk ^0.13.1`, `@tauri-apps/api ^2.11.1`.
- Rust is small and is a dumb pipe: `main.rs` (6), `lib.rs` (604), `agent.rs` (318),
  `config.rs` (571), `logging.rs` (224). The entire ACP protocol lives in TypeScript
  (`src/lib/acp-bridge.ts`).
- `agent.rs:126-176` spawns stdio agents through a **login shell** (`$SHELL -l -c`, with
  fallbacks) expressly to source the user's profile. Windows uses `cmd /C` with
  `CREATE_NO_WINDOW`.
- Framing is newline-delimited JSON-RPC over pipes, read by two `std::thread`s, re-emitted as
  Tauri events.
- **No `externalBin`, no `resources`, no `tauri-plugin-shell`.** `bundle` is `targets: "all"`,
  icons, and `macOS.signingIdentity: "-"`.
- `agents.json` schema: `AgentsConfig { agents, mcpServers }`, `AgentConfig { transport,
  command, args, env, url, headers }`, `AgentTransport { Stdio, Websocket, Http }`. Hot-reloaded
  via a `notify` watcher. CRUD exposed as Tauri commands.
- Config path is hardcoded as `acp-ui` in `config.rs:407-413`, with a comment saying the
  historical path is kept deliberately.
- `tauri.conf.json` `identifier` is still `formulahendry.acp-ui`; `productName` and
  `mainBinaryName` are already `LocalACP`.
- Release matrix, five desktop targets: macOS-ARM64, macOS-x64, Linux-x64, Linux-ARM64
  (`ubuntu-22.04-arm`), Windows-x64, via `tauri-apps/tauri-action@v0`. No mobile jobs in
  `release.yml`.
- The two projects are already deliberately paired: `docs/agent-integration.md` is written for
  python-acp, `src/lib/schema-form.ts` targets its `parse_command`/`coerce_arguments`, and
  `fixtures/invocation-lines.json` is a cross-language contract fixture.

### acp-ui — history and licensing

- `LICENSE` is **MIT, "Copyright (c) 2026 Jun Han"**.
- 118 commits total. Fork point `cd9c3cb464a4b321bff652101953a64c07473e31`
  ("chore: release v0.1.16", 2026-05-25). 60 upstream commits at/below it, **58 above**.
- `git log HEAD..upstream/main` is **empty** — the fork is at exact parity with upstream.
- The 58 interleave security fixes and features. Security/privacy work is spread across
  `206aa89`, `8d3fd9d`, `11f7052`, `44af83e`, `f6b61f6`, `68c958e`, `62b30f5`, `a35fb2d`;
  feature work sits between and after them.
- `db308460a46610877999b2d1b32626ff9eb1b571` normalises line endings to LF across 47 files.
- `.git-blame-ignore-revs` hardcodes that SHA. It is the only file found that hardcodes one.
- `.beads/` is present.

### GitHub

- `Digital-Dimentia/LocalACP` exists, is **private**, and is **empty**. Created 2026-08-31.
- `Digital-Dimentia/python-acp` is public.
- `dbuschman7/acp-ui` is public, with `upstream` = `formulahendry/acp-ui` (push disabled).

## Not verified — settle in C0 and A

- That PyInstaller actually produces a working binary from the wheel.
- The resulting binary size and cold-start latency (the 25–45 MB and 100–500 ms figures are
  estimates from the measured `site-packages` footprint, not measurements of a build).
- Whether Tauri preserves the executable bit through `externalBin` on every target, and how
  `bundle.resources` behaves for the Windows onedir tree.
- Whether LocalACP's `McpServerConfig` key set is a strict subset of what python-acp's catalogue
  accepts. **A mismatch is a hard startup failure**, because the catalogue rejects unknown keys
  by design.
- Whether the beads Dolt data moves cleanly to the new remote, and whether
  `.beads/issues.jsonl` alone would suffice (it is documented as a *passive* export, so probably
  not).
- Whether ad-hoc signing plus `xattr -dr` still clears Gatekeeper once a nested frozen binary is
  in the bundle. Requires a freshly downloaded build on a clean machine to test at all.
- The real cost of a Rust port. The 11k-line figure is a line count, not an estimate.
