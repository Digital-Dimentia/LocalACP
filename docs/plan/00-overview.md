# LocalACP — program plan

> **Status:** planning only. Nothing in these documents has been executed. Written
> 2026-08-30 from a read-only survey of `dbuschman7/acp-ui` and
> `Digital-Dimentia/python-acp`.

## What this repo becomes

`Digital-Dimentia/LocalACP` (private) is the desktop app going forward: a Tauri 2 + Vue 3
ACP client that **bundles `python-acp` as a frozen sidecar executable**, so a user installs
one thing and needs no Python on their machine.

It starts as a history-preserving migration of `dbuschman7/acp-ui`, which is a public fork of
`formulahendry/acp-ui` (MIT, © 2026 Jun Han).

## The two repos, after this is done

| Repo | Visibility | Role |
|---|---|---|
| `Digital-Dimentia/python-acp` | public | The ACP↔MCP bridge agent. Released as a wheel. |
| `Digital-Dimentia/LocalACP` | private | The desktop app. Freezes the pinned wheel and ships it inside the bundle. |

`dbuschman7/acp-ui` stays standing and **untouched** — see [01-migration.md](01-migration.md).

## Decisions already taken

| Decision | Choice | Rationale |
|---|---|---|
| How to ship python-acp | **Freeze to one executable per platform**, Tauri sidecar | Not pyo3 embedding; not a Rust rewrite |
| Rust port of the bridge | **Deferred**, evaluate in a future release | External commitment for the next few releases |
| python-acp input | **A published GitHub release**, pinned by version | Not a source checkout of `main` |
| macOS signing | **Ad-hoc for now** | Notarization deferred to first non-technical user |
| History migration | **Graft** — squash upstream only, keep all 58 own commits | Avoids reordering and the LF-normalisation conflict landmine |
| Repo count | **Two**, packaging folded into LocalACP | No separate distribution repo |
| Public fork | **Untouched.** No freeze commit, no new upstream PRs | Upstream author unresponsive; that conversation is out of scope |

## Ordering — the answer to "when"

**Workstream A (migration) goes first, and should go now.**

1. **The fork is at exact parity with upstream right now.** `git log HEAD..upstream/main` is
   empty and `upstream/main..HEAD` is exactly the 58 own commits. This is the cleanest cut
   point that will ever exist, and it only degrades.
2. **Every private feature commit added to the public fork is a leak or a later untangling.**
   The next features are private by decision; each one pushed to `dbuschman7/acp-ui` is public
   the moment it lands.
3. **The packaging work lands in this repo.** Workstream C adds `freeze/` and `pins.toml` here
   and extends the release workflow. Doing that in the fork first means doing it twice.

The other two are blocked or deferred:

- **B (python-acp v0.3.0)** is blocked on that repo's build being fixed, by another agent, in
  another repo. Independent of everything here.
- **C (freeze + bundle)** needs both a migrated LocalACP and a v0.3.0 release. Last by
  dependency, not by priority.

```
now ──────────────────────────────────────────────────────────────────▶

  A. Migrate to LocalACP     ████████
     (unblocked; degrades with delay)

  B. python-acp v0.3.0            ░░░░░░████
     (blocked: build broken, other agent, other repo)

  C. Freeze + bundle                      ████████████████
     (needs A and B)
```

A and B are in different repos and do not touch each other — they can run concurrently the
moment B unblocks.

## Documents

| File | Workstream | State |
|---|---|---|
| [01-migration.md](01-migration.md) | **A** — graft `acp-ui` history into this repo | Ready to execute |
| [02-agent-release.md](02-agent-release.md) | **B** — python-acp v0.3.0 | Blocked, tracked only |
| [03-freeze-and-bundle.md](03-freeze-and-bundle.md) | **C** — PyInstaller freeze + Tauri sidecar | Ready after A and B |
| [04-findings.md](04-findings.md) | — | What was verified vs. assumed, and deferred items |

## Deferred, with triggers

| Item | Trigger to revisit |
|---|---|
| **Rust port of python-acp** | After the current external commitment. Deserves a real module-by-module sizing then, not a guess. |
| **Notarization + Developer ID** | First non-technical macOS user. |
| **Windows Authenticode cert** | If onedir does not quell AV false positives. |
| **Upstream PRs for the security fixes** | Out of scope. Separate conversation already in progress. |
