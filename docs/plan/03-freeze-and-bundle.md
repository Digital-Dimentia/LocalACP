# Workstream C — freeze python-acp and bundle it

**Status:** blocked on [A](01-migration.md) and [B](02-agent-release.md).

## Goal

A user installs LocalACP and it works. No Python, no venv, no command line. `python-acp` runs
as a frozen executable inside the app bundle, and the app's existing settings UI configures it.

## Feasibility verdict

**Favourable.** The properties that normally break freezing are all absent from
`src/python_acp/`:

| Freezer hazard | Status |
|---|---|
| `__file__` / `importlib.resources` / package data | **none** — the wheel is `.py` files only |
| `sys.executable` re-invocation | **none** |
| Plugin loading, entry-point discovery | **none** |
| Dynamic imports in first-party code | **none** — `__init__.py:8` hardcodes `__version__` rather than calling `importlib.metadata`, deliberately, "so that importing this package never depends on it having been installed" |
| Native extensions | exactly **two**: `pydantic_core` (required) and `websockets.speedups` (optional, pure-Python fallback exists) |
| Runtime file reads | one: `--mcp-config`, once at startup (`mcp_catalogue.py:210`) |
| Ports bound under `--transport stdio` | none — pure pipe I/O |

On the Tauri side there is nothing to build on: `src-tauri/` has **no `externalBin`, no
`resources`, and no `tauri-plugin-shell`**. `bundle` is icons and ad-hoc macOS signing only.

## Limitations, ordered by likelihood of biting

### 1. GUI PATH starvation — a certain bug, not a risk

Read this one before writing any code.

`mcp_stdio.py:245` spawns MCP servers with `asyncio.create_subprocess_exec` — **no shell, no
`shutil.which`, no `cwd=`** — overlaying `env` onto `os.environ`. Resolution of a bare `python`
or `npx` is whatever `execvp` does with the **inherited PATH**.

Today `scripts/start-ws.sh` *activates* the venv rather than calling its interpreter by path,
precisely so that a client naming a bare `python` in `session/new` resolves. Its own comment
says so. A frozen binary has no `bin/` directory, so that mechanism is gone.

Worse: **a macOS `.app` launched from Finder inherits a minimal PATH** —
`/usr/bin:/bin:/usr/sbin:/sbin`. No Homebrew, no pyenv, no nvm, no Volta. Any MCP server
configured as `npx …`, `uvx …`, or `python3 …` fails to spawn with a bare ENOENT, and the error
surfaces far from its cause.

**The fix already exists in this repo.** `src-tauri/src/agent.rs:126-176` deliberately spawns
agents through a **login shell** — `$SHELL -l -c`, with `bash`/`zsh`/`ksh` getting `-l`, `fish`
relied on to auto-load config, and a probe for `/bin/bash` then `/bin/sh` otherwise — expressly
to source the user's profile. Launch the sidecar through that path and it inherits a login PATH,
and so does every MCP server it spawns beneath it.

**Do not bypass `agent.rs`'s spawn path.** The integration approach below is built around
reusing it, and that is its main justification.

### 2. Per-target builds; no cross-compilation

`pydantic-core` ships a compiled Rust extension, and PyInstaller bundles the CPython it ran
under. The frozen binary is specific to (OS, arch) and effectively to a Python minor version.
It must be built on a **native runner** for each of the five targets in `release.yml:98-111`:

| Target | Runner |
|---|---|
| macOS-ARM64 | `macos-latest` |
| macOS-x64 | `macos-latest` w/ `x86_64-apple-darwin`, or `macos-13` |
| Linux-x64 | `ubuntu-22.04` |
| Linux-ARM64 | `ubuntu-22.04-arm` |
| Windows-x64 | `windows-latest` |

GitHub-hosted runners cover all five, so this is cost, not a blocker.

Freeze on **Python 3.11** — python-acp's floor, and what its own `publish-artifacts.yml` already
uses, so the frozen runtime matches the interpreter that project treats as canonical.

### 3. macOS signing

`tauri.conf.json` is ad-hoc (`"signingIdentity": "-"`) and the README already documents the
Gatekeeper dialog and the `xattr -dr com.apple.quarantine` workaround. A sidecar makes this
**worse, not equal**:

- Nested executables inside a `.app` must be signed with the same identity as the outer bundle,
  or Gatekeeper rejects the *whole* bundle rather than just the sidecar.
- A PyInstaller onefile binary unpacks CPython and `.so` files to a temp directory at each start
  and `dlopen`s them from there. Under the hardened runtime that needs
  `com.apple.security.cs.disable-library-validation`, and it is exactly the pattern Gatekeeper's
  newer checks are hostile to.

**Decision: stay ad-hoc for now.** That makes one verification step non-optional: test a
**freshly downloaded** build on a clean machine. A locally-built app never carries the quarantine
bit, so a build-machine test proves nothing about the case that actually fails.

### 4. Windows antivirus false positives

Unsigned PyInstaller onefile binaries are a well-known Defender/SmartScreen heuristic magnet —
self-extracting, unpacks and executes from `%TEMP%`. **Use onedir on Windows.**

Also: do **not** build `--noconsole` / `--windowed`. It detaches stdio and kills the protocol
wire. Console mode is correct, and `agent.rs:121` already passes `CREATE_NO_WINDOW`, so no
console window appears.

### 5. stdout purity

`transport_stdio.py` documents that once the agent is bound, **stdout is the wire**: it binds
the real stdout into the SDK's writer and then points `sys.stdout` at stderr for the life of the
connection, so a stray `print()` lands in the log rather than in the protocol. Windows is
excluded from that swap on purpose — the SDK's Windows transport resolves `sys.stdout` at *write*
time.

The PyInstaller bootloader has failure paths that print. Any byte on stdout that is not a
JSON-RPC message corrupts the stream, and it surfaces at the client as a parse error far from
whatever emitted it. Assert byte-exact stdout in the harness.

### 6. Hidden imports

Two lazy-import sites need hooks:

- `acp/__init__.py:230` — `importlib.import_module` inside a module-level `__getattr__`, over a
  fixed table of deprecated-name shims.
- pydantic does the same trick; `pyinstaller-hooks-contrib` ships a hook for it.

`acp` needs `--collect-submodules acp` or explicit `hiddenimports` in the spec. The failure mode
is an `ImportError` at runtime on an uncommon code path, which is exactly why the harness must
exercise real flows rather than `--help`.

### 7. Linux glibc floor

PyInstaller links against the build machine's glibc; `ubuntu-22.04` sets a 2.35 floor. Fine for
the `.deb`/`.AppImage`/`.rpm` produced on the same runner. Freeze inside a `manylinux_2_28`
container if broader reach is wanted later.

### 8. Size

Runtime-only `site-packages` is ~11.9 MiB, of which pydantic + pydantic-core are ~85%, plus the
CPython stdlib. Expect **25–45 MB** per frozen binary, roughly 2–3×'ing the installer. Say so in
the release notes.

### 9. Desktop only

`AgentManager` already has a `#[cfg(not(desktop))]` stub returning *"stdio agents are not
supported on this platform; configure a websocket or http transport"*. A sidecar cannot work on
Android, iOS, or the web build. Feature-gate the bundled-agent UI to desktop; web and mobile keep
the existing "connect to a remote python-acp over WebSocket" story.

## Layout

```
LocalACP/
  src/                   # Vue app (unchanged)
  src-tauri/             # Tauri app (+ externalBin in tauri.conf.json)
  pins.toml              # python-acp tag + wheel sha256 + sdist sha256.
                         # Bumping this file IS the agent upgrade.
  freeze/
    entry.py             # 3 lines: from python_acp.cli import run; run()
    python-acp.spec      # PyInstaller spec, checked in — not a CLI invocation
    build.py             # fetch pinned wheel -> build venv -> freeze -> python-acp-<triple>
  conformance/
    run.py               # drives the FROZEN binary over stdio
  .github/workflows/release.yml   # + a freeze matrix job feeding tauri-action
```

python-acp is **never checked out for building**. It is consumed as a released wheel installed
into a throwaway per-target venv, plus the tag's source tarball for test data only. That is also
what keeps this work entirely out of the way of python-acp's `main`.

## Freezing from a wheel, not a source tree

`pip install` the pinned wheel into a clean per-target venv, then point PyInstaller at a
three-line `freeze/entry.py` calling `python_acp.cli:run()`.

This is *better* than freezing from source: what gets frozen is byte-identical to the published
artifact, the dependency set comes from the wheel's own exact pins
(`agent-client-protocol==0.12.1`, `websockets==17.0.1`), and no uncommitted local edit can sneak
in.

- Verify the downloaded wheel against the sha256 in `pins.toml` **before** installing.
- Install with hash-checked pinned requirements, so a transitive resolver cannot drift between
  the five target builds.
- **onefile** on macOS and Linux — one extraction per launch (~100–500 ms), paid once for a
  long-lived agent process.
- **onedir** on Windows, per limitation #4, shipped via `bundle.resources` since `externalBin`
  wants a single file. Accept the asymmetry; it is cheaper than fighting Defender.
- `console=True` everywhere. No `--strip` on macOS — it breaks signing.

## Integration — config-only, no Rust changes

The path that dodges limitation #1 entirely:

1. **Package** the frozen binary with Tauri `bundle.externalBin`. This is the blessed mechanism:
   it handles the `-$TARGET_TRIPLE` filename convention, the executable bit, and registration of
   nested code for macOS signing. Tauri strips the triple suffix at bundle time, so at runtime it
   sits beside the main binary as plain `python-acp`.
2. **Do not** use `tauri-plugin-shell`'s sidecar API to launch it. Instead, on first run, seed an
   `agents.json` entry whose `command` is the **absolute path** to that binary, resolved in
   TypeScript from `@tauri-apps/api/path`.
3. The existing `AgentManager::spawn_agent` then launches it through the **login shell**, exactly
   like any other stdio agent — which is what gives the sidecar, and every MCP server beneath it,
   a real user PATH.

`agents.json` already models everything needed:

```rust
pub enum AgentTransport { #[default] Stdio, Websocket, Http }
pub struct AgentConfig {
    transport, command: Option<String>, args: Option<Vec<String>>,
    env: HashMap<String,String>, url: Option<String>, headers: Option<HashMap<..>>,
}
```

— hot-reloaded by a `notify` watcher (`setup_watcher`), with CRUD Tauri commands
(`add_agent`/`update_agent`/`remove_agent` in `lib.rs`) and a settings UI (`SettingsView.vue`,
`EnvVarEditor.vue`, `AgentSelector.vue`).

**The GUI configuration layer is ~80% already built.** Net Rust diff for the sidecar: zero, or
close to it.

Open question for C2: does the bundled agent **replace or supplement** the default `npx`-based
entries? Recommendation: supplement — add it as an additional entry, leave the rest.

## The MCP catalogue bridge — a free win

python-acp's `--mcp-config` accepts **JSON in the `{"mcpServers": {...}}` shape**, chosen by
suffix, with per-entry `command`, `args`, `env`, `description`, `enabled`. Its own docstring says
why: *"the shape every editor and desktop app already writes"*.

LocalACP's `agents.json` already carries `mcpServers: IndexMap<String, McpServerConfig>` with
`command` / `args` / `env` / `description`.

So LocalACP can write its own `mcpServers` block to a JSON file in the app config dir and pass
`--mcp-config <path>` in the sidecar's `args` — and the user gets a real MCP-server settings GUI
with **no new UI and no new format**.

**Two caveats.**

1. It needs a release that has `mcp_catalogue.py` — see [02-agent-release.md](02-agent-release.md).
2. The catalogue **rejects unknown keys loudly by design** (*"a catalogue that half-parses is
   worse than one that refuses"* — a typo'd `commmand` would otherwise be advertised, toggled on,
   and then fail to spawn). Any extra field LocalACP writes is therefore a hard startup failure.
   Confirm the key sets match; if they diverge, filter on write rather than loosening the parser.

## Phasing

| Phase | Work | Exit criterion |
|---|---|---|
| **C0. Spike** | Freeze on macOS arm64 only; build the conformance harness and run it | Frozen binary completes a full ACP turn against a real MCP server; size and cold-start measured |
| **C1. Build** | `pins.toml`, spec, `build.py`, CI freeze job on all 5 targets | 5 artifacts, each passing conformance on its native runner |
| **C2. Integrate** | `externalBin`, first-run `agents.json` seeding, `--mcp-config` bridge | LocalACP launches the bundled agent on a machine with no Python |
| **C3. Release** | Extend `release.yml`, ad-hoc signing, docs | Clean-machine install works on macOS, Windows, Linux |

**Do C0 before committing to the rest.** It is about a day of work and it retires most of the
risk in this document.

## Verification

### The conformance harness is C0's core deliverable

python-acp's own test suite exercises the bridge **in-process**, so it cannot see freezer
breakage at all. The harness must spawn the *frozen binary* as a subprocess and:

1. **Replay the golden transcripts.** `tests/transcripts/*.json` record the whole JSON-RPC
   conversation for four flows — initialize, session lifecycle, streaming, cancellation — in
   order and in both directions. Driving the frozen binary through them and diffing is the single
   highest-value check available: it catches a missing hidden import, an ordering regression, and
   stdout contamination in one run.
2. **Assert stdout purity** — no non-JSON-RPC byte on stdout, ever, including before the first
   message. Catches limitation #5 and bootloader chatter.
3. **Spawn a real MCP server** via `tests/fixtures/mock_mcp_server.py`, naming it as a **bare
   `python`**. This is the direct regression test for limitation #1. It must be run from a
   GUI-launched context on macOS, not a terminal, or it passes falsely.
4. **Run the cross-repo contract test** — `fixtures/invocation-lines.json` against `commands.py`'s
   `parse_command` + `coerce_arguments` — as a release gate on the pinned pair.
5. **Leak check.** python-acp's `tests/conftest.py` fails its own suite if any subprocess
   transport is left unclosed, naming the test that created it. Mirror that: assert the frozen
   binary and every MCP child it started are gone after shutdown.

### Manual end-to-end, on a machine with no Python installed

```
install LocalACP → launch from Finder/Explorer (NOT a terminal)
  → bundled agent appears in the agent list and connects
  → add an MCP server in Settings
  → new session → invoke a tool → see output
  → quit → confirm no orphan processes
```

Then repeat on a **freshly downloaded** build, so the quarantine bit is present and Gatekeeper is
actually exercised.
