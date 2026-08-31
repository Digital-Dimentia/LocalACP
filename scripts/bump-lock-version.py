#!/usr/bin/env python3
"""Set the version of the one workspace-local package in Cargo.lock.

Cargo.lock is committed (see the note in .gitignore) and tauri's build
precheck compares it against Cargo.toml, so the release bump has to move
both or the build it is cutting fails on a lockfile mismatch.

This is a text edit rather than `cargo update -p localacp` on purpose: that
needs a resolvable dependency graph, which means either a populated registry
cache (a clean runner has none, so `--offline` fails) or a network round-trip
to crates.io for every dependency -- all to rewrite one line whose value we
already know. Editing the entry directly keeps the job free of a Rust
toolchain entirely, like the sed and jq steps beside it.
"""
import re
import sys

package, version, path = sys.argv[1], sys.argv[2], sys.argv[3]

with open(path, encoding="utf-8") as fh:
    lock = fh.read()

# Anchor on the package's own [[package]] block. Matching `name` first and
# rewriting the `version` line that follows it means a dependency that happens
# to share our version string is never touched.
pattern = re.compile(
    r'(\[\[package\]\]\nname = "%s"\nversion = ")[^"]*(")' % re.escape(package)
)
lock, count = pattern.subn(r"\g<1>%s\g<2>" % version, lock)

if count != 1:
    sys.exit(
        f"error: expected exactly one [[package]] entry named '{package}' in "
        f"{path}, found {count}. Was the crate renamed?"
    )

with open(path, "w", encoding="utf-8") as fh:
    fh.write(lock)
print(f"{path}: {package} -> {version}")
