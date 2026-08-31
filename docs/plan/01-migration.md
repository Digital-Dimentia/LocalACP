# Workstream A — migrate `acp-ui` into this repo

**Status:** ready to execute. Unblocked, and the cheapest it will ever be.

## Goal

Import `dbuschman7/acp-ui` into `Digital-Dimentia/LocalACP` with the 60 upstream commits
collapsed into a single "pre-history" commit, and all 58 of your own commits preserved intact
— original order, original messages, original author dates.

## The shape of the history

Facts, verified 2026-08-30:

| | Value |
|---|---|
| Total commits on `dbuschman7/acp-ui` `main` | 118 |
| Fork point (last upstream commit) | `cd9c3cb464a4b321bff652101953a64c07473e31` |
| Fork point date / subject | 2026-05-25 · `chore: release v0.1.16` |
| Upstream commits at/below fork point | 60 |
| Your commits above it | 58 |
| First of yours | `d4a9d41` 2026-08-20 · `fix: commit Cargo.lock and align npm tauri deps…` |
| Last of yours | `8a3f1d9` · `fix(settings): stop popover copy inheriting the title's uppercase` |
| `git log HEAD..upstream/main` | **empty** — the fork is at exact parity |

Target result — 59 commits:

```
<root>    pre-history: acp-ui @ cd9c3cb — Jun Han, MIT
d4a9d41'  fix: commit Cargo.lock and align npm tauri deps with Rust crates
14a34b6'  chore: add beads issue-tracker scaffolding for AI coding agents
206aa89'  fix(security): define a real webview CSP instead of csp: null
...       (all 58, untouched, in original order)
8a3f1d9'  fix(settings): stop popover copy inheriting the title's uppercase
```

(Primes because every SHA changes — see "The one thing this breaks".)

## Why graft rather than replay

The alternative considered was a three-tier squash: pre-history, then all security fixes
squashed into one commit, then features as individual commits. It was rejected because your
58 commits **interleave**. The CSP fix is `206aa89` (3rd), but the CSP regression test
`62b30f5` and the worker-src tightening `a35fb2d` land ~25 commits later, after feature work.
Collecting them means reordering.

And reordering crosses a landmine: **`db308460a46610877999b2d1b32626ff9eb1b571` — "chore:
normalise all line endings to LF [mechanical]" — rewrites the line terminators of 47 files.**
Anything cherry-picked across it fights CRLF/LF on every hunk.

The graft replays nothing, so none of that applies. Zero conflicts, by construction.

The only deviation from the originally sketched spec is that the security fixes remain
separate commits rather than one squash. That is a cosmetic loss and worth it.

## Licensing — one obligation, easily met

Upstream is **MIT, "Copyright (c) 2026 Jun Han"**. MIT is permissive, not copyleft: taking a
derivative private is explicitly allowed. The one hard requirement is that *"the above
copyright notice and this permission notice shall be included in all copies or substantial
portions of the Software."*

Therefore:

- **Keep `LICENSE` byte-identical.** Jun Han's copyright line stays. Add your own line
  beneath it rather than replacing his.
- **Credit the origin in the README.** Costs nothing; it is the difference between a fork and
  an appropriation.
- Squashing his commits does not affect any of this. Attribution lives in the license file and
  in the pre-history commit message, not in commit granularity.

## Procedure

Work on a scratch clone, not on your working copy of `acp-ui`. Nothing here should touch
`dbuschman7/acp-ui`, and nothing should be pushed until the result has been inspected.

### 1. Prepare a scratch clone

```bash
git clone /Users/dave/dev/other/acp-ui /tmp/localacp-migrate
cd /tmp/localacp-migrate
git checkout main
```

Confirm the starting state matches the table above before touching anything:

```bash
git rev-list --count HEAD                    # expect 118
git rev-list --count cd9c3cb                 # expect 60
git rev-list --count cd9c3cb..HEAD           # expect 58
```

### 2. Build the pre-history commit

Create a parentless commit holding upstream's tree exactly as it stood at the fork point.
`git commit-tree` does this without touching the working directory:

```bash
PREHISTORY=$(git commit-tree cd9c3cb^{tree} -m "pre-history: acp-ui @ cd9c3cb (squashed)

This repository begins as a fork of https://github.com/formulahendry/acp-ui
by Jun Han, licensed MIT.

This single commit collapses the 60 upstream commits from the project's
first commit through cd9c3cb464a4b321bff652101953a64c07473e31
(\"chore: release v0.1.16\", 2026-05-25), which was the fork point. The
tree here is byte-identical to upstream's at that commit. No upstream
authorship is claimed; the original history remains at the URL above.

The LICENSE file, including its copyright notice, is retained unmodified
as MIT requires.

Every commit after this one is original work.")
echo "$PREHISTORY"
```

The message is the only place this provenance survives in the new history. It must be
self-describing — assume the reader has no other context.

### 3. Graft your 58 commits onto it

```bash
git replace --graft "$(git rev-list --max-parents=1 cd9c3cb..HEAD | tail -1)" "$PREHISTORY"
```

That re-parents your **first** commit (`d4a9d41`) onto the pre-history commit instead of onto
`cd9c3cb`. Verify the graft reads correctly before making it permanent:

```bash
git log --oneline | wc -l      # expect 59
git log --oneline | tail -3    # your first commit, then pre-history
```

Then make it real. `git filter-repo` bakes in replacements and drops the now-unreferenced
upstream commits:

```bash
git filter-repo --force
```

> If `git filter-repo` is unavailable, `git-filter-branch` works but is slow and error-prone;
> install filter-repo (`brew install git-filter-repo`).

### 4. Verify before pushing

```bash
git log --oneline | wc -l                       # 59
git log --format='%an <%ae>' | sort -u          # your identity + nothing unexpected
git diff --stat <original-HEAD-sha>             # MUST be empty: the tree is unchanged
git cat-file -p HEAD:LICENSE | head -3          # "Copyright (c) 2026 Jun Han"
```

**The `git diff --stat` against the original HEAD is the important one.** The graft must
change history only, never content. Any output there means something went wrong.

### 5. Push to the new remote

```bash
git remote set-url origin git@github.com:Digital-Dimentia/LocalACP.git
git push -u origin main
```

`/Users/dave/dev/other/LocalACP` is already a clone of that remote with no commits, so it can
simply `git pull` afterward — or be re-cloned.

### 6. Regenerate `.git-blame-ignore-revs` — do this last

See below. It is a normal commit on top, made after the rewrite is final.

## The one thing this breaks

**Every commit SHA changes.** Each commit's parent changes, so every hash from the root down
is new. That invalidates `.git-blame-ignore-revs`, which currently names:

```
db308460a46610877999b2d1b32626ff9eb1b571
# chore: normalise all line endings to LF [mechanical] -- localacp-w1a
# 47 files, line terminators only, verified byte-identical under CRLF->LF.
```

Left stale, that file silently stops working and `git blame` attributes every line in the repo
to the formatting pass — the exact problem the file exists to prevent.

**Fix as the final step of the migration**, after the rewrite is final:

```bash
git log --format='%H %s' | grep 'normalise all line endings'
# put the NEW sha into .git-blame-ignore-revs, keeping the comment block
git commit -m "chore: repoint .git-blame-ignore-revs after the history graft"
```

`.git-blame-ignore-revs` is the only file found that hardcodes a SHA. Grep once more after the
rewrite to be sure nothing else does.

## Identity still pointing at upstream

Deliberately kept separate from the graft — these are user-visible, and one of them migrates
user data.

| Thing | Current value | Action |
|---|---|---|
| `src-tauri/tauri.conf.json` → `identifier` | `formulahendry.acp-ui` | **Change it.** Cheap, and wrong as-is. |
| Config dir (`src-tauri/src/config.rs:407-413`) | `~/.config/acp-ui/agents.json`, `%APPDATA%\acp-ui`, `~/Library/Application Support/acp-ui` | **Leave for now.** |
| `productName` / `mainBinaryName` | `LocalACP` | Already done. |

The config dir already carries a code comment saying the `acp-ui` path is kept *historical*
deliberately. Changing it strands every existing user's `agents.json`, so it needs a
read-old/write-new migration step — its own task, not part of this one.

Note that changing the `identifier` alone does not move the config dir, because `config.rs`
hardcodes the string rather than deriving it from the bundle identifier. The two are
independent, which is what makes deferring one of them safe.

## Beads

`acp-ui` has a `.beads/` directory. Per the beads architecture note, issues live in a local
Dolt DB and sync via `refs/dolt/data` **on the git remote** — so the issue history is attached
to `dbuschman7/acp-ui`, not to the working tree. Moving the repo means re-pushing that data to
the new remote, or the issue history is left behind.

`.beads/issues.jsonl` is described as a *passive* export, so do not assume it is sufficient.
Confirm the right move with `bd` before or immediately after the push.

## The public fork: out of scope

`dbuschman7/acp-ui` and any existing PRs stay **exactly as they are**. No freeze commit, no
README note, no new upstream PRs. The original author has been unresponsive and the upstream
repo may be abandoned; whether he wants the security work is a separate conversation already in
progress, and it is not a dependency of anything here.

The one thing that does not change: **do not delete the fork.** It is the attribution trail and
it costs nothing to leave standing.

## Exit criteria

- [ ] Fresh clone of `Digital-Dimentia/LocalACP` builds: `npm ci && npm run build`.
- [ ] `cargo test` passes (there is one Rust test, `src-tauri/tests/csp_policy.rs`).
- [ ] The Vitest suite added in `9a24596` passes.
- [ ] `git log --oneline | wc -l` is **59**; the 58 show original authorship and dates.
- [ ] `git diff` between the new HEAD tree and the old HEAD tree is **empty**.
- [ ] `LICENSE` is byte-identical to upstream's, Jun Han's copyright intact.
- [ ] `.git-blame-ignore-revs` regenerated; `git blame` on an LF-normalised file attributes
      real authors.
- [ ] `tauri.conf.json` `identifier` no longer says `formulahendry`.
- [ ] Beads data reachable from the new remote.
- [ ] `dbuschman7/acp-ui` untouched.
