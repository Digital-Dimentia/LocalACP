//! Invariants for the filesystem scope in `capabilities/default.json`.
//!
//! Read and write used to carry a blanket `path: "**"` allow, so any webview
//! escape could reach every file the deny lists had not carved out. Access is
//! now granted at runtime, per session, for directories the user picked
//! through the native dialog (`src/workspace.rs`). A path is permitted if
//! *either* scope allows it, so putting a build-time allow entry back here --
//! `"**"`, or anything broad enough to cover a home directory -- silently
//! restores the old surface no matter what the runtime scope does. That is the
//! regression this file exists to break the build over.
//!
//! These are static assertions about the config. They cannot tell you the app
//! still works under it; that needs a desktop run with a real agent.

use serde_json::Value;
use std::fs;
use std::path::PathBuf;

fn capability() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("capabilities/default.json");
    let raw = fs::read_to_string(&path).expect("capabilities/default.json is readable");
    serde_json::from_str(&raw).expect("capabilities/default.json is valid JSON")
}

/// The scoped permission entry for `identifier`, which must be an object --
/// a bare string would mean the permission carries no deny list at all.
fn scoped(identifier: &str) -> Value {
    let cap = capability();
    let permissions = cap["permissions"]
        .as_array()
        .expect("capability has a permissions array");
    for p in permissions {
        if p.is_string() {
            assert_ne!(
                p.as_str(), Some(identifier),
                "{identifier} is present as a bare string, which drops its deny list"
            );
            continue;
        }
        if p["identifier"].as_str() == Some(identifier) {
            return p.clone();
        }
    }
    panic!("{identifier} is not granted; the fs RPCs would stop working entirely");
}

fn deny_paths(identifier: &str) -> Vec<String> {
    scoped(identifier)["deny"]
        .as_array()
        .unwrap_or_else(|| panic!("{identifier} has a deny array"))
        .iter()
        .filter_map(|e| e["path"].as_str().map(str::to_string))
        .collect()
}

const FS_PERMISSIONS: [&str; 2] = ["fs:allow-read-text-file", "fs:allow-write-text-file"];

#[test]
fn no_build_time_allow_entry_widens_the_runtime_scope() {
    for identifier in FS_PERMISSIONS {
        let entry = scoped(identifier);
        let allow = &entry["allow"];
        assert!(
            allow.is_null() || allow.as_array().is_some_and(|a| a.is_empty()),
            "{identifier} has a build-time allow entry ({allow}). Access must come \
             from the runtime scope in workspace.rs, which is limited to directories \
             the user picked; a static allow here bypasses that entirely."
        );
    }
}

#[test]
fn the_credential_deny_lists_survive() {
    // Defence in depth: deny beats allow in both the static and the runtime
    // scope, so these still hold even for a directory the user did approve --
    // a project that happens to sit above ~/.ssh, or a symlink planted inside
    // one. Losing them makes the runtime scope solely load-bearing.
    for identifier in FS_PERMISSIONS {
        let denied = deny_paths(identifier);
        for required in [
            "$HOME/.ssh/**",
            "$HOME/.aws/**",
            "$HOME/.gnupg/**",
            "$HOME/.kube/**",
            "$HOME/.config/gh/**",
            "$HOME/.netrc",
            "$HOME/.git-credentials",
            "$APPCONFIG/**",
        ] {
            assert!(
                denied.iter().any(|d| d == required),
                "{identifier} no longer denies {required}"
            );
        }
    }
}

#[test]
fn writes_still_cannot_reach_shell_profiles_or_git_hooks() {
    // These are write-only denials: a file the agent can write is a file that
    // runs code the next time a shell opens or a git command is run, which
    // turns a contained fs write into execution.
    let denied = deny_paths("fs:allow-write-text-file");
    for required in [
        "$HOME/.zshrc",
        "$HOME/.zprofile",
        "$HOME/.bashrc",
        "$HOME/.bash_profile",
        "$HOME/.profile",
        "$HOME/.config/fish/**",
        "**/.git/config",
        "**/.git/hooks/**",
    ] {
        assert!(
            denied.iter().any(|d| d == required),
            "writes no longer deny {required}"
        );
    }
}

#[test]
fn the_approvals_store_is_not_reachable_through_the_fs_rpcs() {
    // approved-workspaces.json lives in the app config dir. If the webview
    // could write it, it could approve `/` for itself and the native-dialog
    // trust anchor would be worth nothing.
    for identifier in FS_PERMISSIONS {
        assert!(
            deny_paths(identifier).iter().any(|d| d == "$APPCONFIG/**"),
            "{identifier} must deny $APPCONFIG/** so the approvals file cannot be forged"
        );
    }
}
