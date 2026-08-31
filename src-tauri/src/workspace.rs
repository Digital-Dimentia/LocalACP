//! User-approved workspace directories, and the fs scope built from them.
//!
//! The fs capability used to allow `path: "**"` for read/write, so a webview
//! escape could read or write anything the deny lists did not carve out. The
//! narrow scope is "the directory the user actually picked", but that needs a
//! trust anchor Rust did not have: the working directory lived entirely in the
//! frontend (`pickFolder()` called the dialog plugin directly, and a resumed
//! session's cwd came from frontend-persisted state), so every input to the
//! decision was attacker-controlled in exactly the scenario the scoping is
//! meant to contain. A plain `set_fs_scope(cwd)` command would have been
//! called with `/` and bought nothing.
//!
//! The anchor is the native folder dialog. It is opened *here*, and only the
//! path it returns is recorded as approved. A compromised webview can ask for
//! a picker, but it cannot fabricate a choice — the user drives that dialog.
//! Approvals are persisted in Rust-owned storage under the app config dir,
//! which the fs capability denies to the webview, so a resumed session cannot
//! widen the scope either.
//!
//! Paths are canonicalized before they are stored or compared, so a symlink
//! planted inside an approved directory cannot be used to reach outside it.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, Runtime, State};

#[cfg(desktop)]
use parking_lot::RwLock;
#[cfg(desktop)]
use tauri_plugin_dialog::DialogExt;
#[cfg(desktop)]
use tauri_plugin_fs::FsExt;

/// File name under the app config dir holding the approved set.
const APPROVALS_FILE: &str = "approved-workspaces.json";

#[derive(Debug, Default, Serialize, Deserialize)]
struct ApprovalsFile {
    /// Absolute, canonicalized directories the user picked at some point.
    directories: Vec<PathBuf>,
}

#[derive(Default)]
pub struct WorkspaceState {
    #[cfg(desktop)]
    approved: RwLock<Vec<PathBuf>>,
    #[cfg(desktop)]
    approvals_path: RwLock<Option<PathBuf>>,
}

/// Is `candidate` the same directory as `approved`, or inside it?
///
/// Both are expected to be canonical already. Comparison is component-wise
/// rather than on strings, so `/home/user/proj-evil` is not treated as being
/// inside `/home/user/proj`.
fn is_within(candidate: &Path, approved: &Path) -> bool {
    candidate == approved || candidate.starts_with(approved)
}

/// The canonical form of a path the user or the frontend named.
///
/// Canonicalization requires the path to exist, which is the correct
/// behaviour here: an approval for a directory that is not there is not
/// something we should be granting scope for.
fn canonicalize(path: &Path) -> Result<PathBuf, String> {
    std::fs::canonicalize(path)
        .map_err(|e| format!("cannot resolve '{}': {}", path.display(), e))
}

#[cfg(desktop)]
impl WorkspaceState {
    /// Load persisted approvals. Called once during setup.
    pub fn load<R: Runtime>(&self, app: &AppHandle<R>) {
        let dir = match app.path().app_config_dir() {
            Ok(d) => d,
            Err(e) => {
                log::error!("No app config dir; workspace approvals will not persist: {}", e);
                return;
            }
        };
        let path = dir.join(APPROVALS_FILE);
        *self.approvals_path.write() = Some(path.clone());

        let raw = match std::fs::read_to_string(&path) {
            Ok(r) => r,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
            Err(e) => {
                log::error!("Failed to read {}: {}", path.display(), e);
                return;
            }
        };
        match serde_json::from_str::<ApprovalsFile>(&raw) {
            // Re-canonicalize on load: a directory may have been moved or
            // deleted since it was approved, and a stale entry must not keep
            // granting scope to whatever now occupies that path.
            Ok(f) => {
                let live: Vec<PathBuf> = f
                    .directories
                    .iter()
                    .filter_map(|d| canonicalize(d).ok())
                    .collect();
                log::info!("Loaded {} approved workspace director(ies)", live.len());
                *self.approved.write() = live;
            }
            Err(e) => log::error!("Malformed {}: {}", path.display(), e),
        }
    }

    fn persist(&self) {
        let Some(path) = self.approvals_path.read().clone() else {
            return;
        };
        let file = ApprovalsFile {
            directories: self.approved.read().clone(),
        };
        if let Some(parent) = path.parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                log::error!("Failed to create {}: {}", parent.display(), e);
                return;
            }
        }
        match serde_json::to_string_pretty(&file) {
            Ok(json) => {
                if let Err(e) = std::fs::write(&path, json) {
                    log::error!("Failed to write {}: {}", path.display(), e);
                }
            }
            Err(e) => log::error!("Failed to serialize workspace approvals: {}", e),
        }
    }

    fn approve(&self, dir: PathBuf) {
        let mut approved = self.approved.write();
        if !approved.contains(&dir) {
            approved.push(dir);
        }
        drop(approved);
        self.persist();
    }

    /// The approved directory containing `candidate`, if any.
    fn approval_for(&self, candidate: &Path) -> Option<PathBuf> {
        self.approved
            .read()
            .iter()
            .find(|a| is_within(candidate, a))
            .cloned()
    }
}

/// Open the native folder picker and record what the user chose.
///
/// This is the only way a directory becomes approved. It deliberately lives in
/// Rust: the frontend can ask for the dialog but cannot supply its answer.
#[tauri::command]
#[cfg(desktop)]
pub async fn pick_workspace_folder<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, WorkspaceState>,
    title: Option<String>,
) -> Result<Option<String>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title(title.unwrap_or_else(|| "Select Working Directory".to_string()))
        .pick_folder(move |picked| {
            let _ = tx.send(picked);
        });

    let Some(picked) = rx.await.map_err(|e| format!("folder picker failed: {}", e))? else {
        return Ok(None); // user cancelled
    };

    let path = picked
        .into_path()
        .map_err(|e| format!("picked folder is not a filesystem path: {}", e))?;
    let canonical = canonicalize(&path)?;
    log::info!("User approved workspace directory: {}", canonical.display());
    state.approve(canonical.clone());
    Ok(Some(canonical.to_string_lossy().into_owned()))
}

/// Grant fs scope for a working directory, if the user has approved it.
///
/// Called before a session starts. The path comes from the frontend and is
/// therefore untrusted; it is only honoured when it resolves inside a
/// directory the user picked through `pick_workspace_folder`. Calling this
/// with `/` — the compromised-webview case — is refused.
#[tauri::command]
#[cfg(desktop)]
pub fn activate_workspace<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, WorkspaceState>,
    path: String,
) -> Result<(), String> {
    let canonical = canonicalize(Path::new(&path))?;
    if !canonical.is_dir() {
        return Err(format!("'{}' is not a directory", canonical.display()));
    }
    let Some(approved) = state.approval_for(&canonical) else {
        log::warn!(
            "Refused fs scope for '{}': not inside any user-approved directory",
            canonical.display()
        );
        return Err(format!(
            "'{}' has not been approved. Choose it with the folder picker first.",
            canonical.display()
        ));
    };

    // Grant the approved root rather than the requested subdirectory: that is
    // what the user actually consented to, and it keeps the granted set equal
    // to the approved set no matter which subdirectory a session names.
    app.fs_scope()
        .allow_directory(&approved, true)
        .map_err(|e| format!("failed to grant fs scope for '{}': {}", approved.display(), e))?;
    log::info!("Granted fs scope for approved workspace: {}", approved.display());
    Ok(())
}

/// The directories the user has approved, for display in settings.
#[tauri::command]
#[cfg(desktop)]
pub fn approved_workspaces(state: State<'_, WorkspaceState>) -> Vec<String> {
    state
        .approved
        .read()
        .iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::is_within;
    use std::path::Path;

    #[test]
    fn a_directory_is_within_itself() {
        assert!(is_within(Path::new("/home/u/proj"), Path::new("/home/u/proj")));
    }

    #[test]
    fn a_subdirectory_is_within_the_approved_root() {
        assert!(is_within(
            Path::new("/home/u/proj/src/lib"),
            Path::new("/home/u/proj")
        ));
    }

    #[test]
    fn a_sibling_with_a_shared_prefix_is_not_within() {
        // The string-prefix mistake: "/home/u/proj-evil" starts with
        // "/home/u/proj" as text but is a different directory.
        assert!(!is_within(
            Path::new("/home/u/proj-evil"),
            Path::new("/home/u/proj")
        ));
    }

    #[test]
    fn a_parent_is_not_within_its_child() {
        assert!(!is_within(Path::new("/home/u"), Path::new("/home/u/proj")));
    }

    #[test]
    fn root_is_not_within_an_approved_project() {
        // The compromised-webview case the approval check exists to refuse.
        assert!(!is_within(Path::new("/"), Path::new("/home/u/proj")));
    }

    #[test]
    fn an_unrelated_tree_is_not_within() {
        assert!(!is_within(Path::new("/etc/passwd"), Path::new("/home/u/proj")));
    }

    // The approval set is what `activate_workspace` consults before it grants
    // anything, so these cover the compromised-webview case at the point the
    // decision is actually made. No approvals path is set, so `persist` is a
    // no-op and nothing is written to disk.
    #[cfg(desktop)]
    mod approvals {
        use super::super::WorkspaceState;
        use std::path::{Path, PathBuf};

        fn state_with(dirs: &[&str]) -> WorkspaceState {
            let s = WorkspaceState::default();
            for d in dirs {
                s.approve(PathBuf::from(d));
            }
            s
        }

        #[test]
        fn nothing_is_approved_before_the_user_picks_anything() {
            let s = WorkspaceState::default();
            assert!(s.approval_for(Path::new("/home/u/proj")).is_none());
        }

        #[test]
        fn a_picked_directory_and_its_children_are_approved() {
            let s = state_with(&["/home/u/proj"]);
            assert_eq!(
                s.approval_for(Path::new("/home/u/proj")),
                Some(PathBuf::from("/home/u/proj"))
            );
            // A subdirectory maps back to the root the user consented to,
            // which is what gets granted -- not the subdirectory itself.
            assert_eq!(
                s.approval_for(Path::new("/home/u/proj/src")),
                Some(PathBuf::from("/home/u/proj"))
            );
        }

        #[test]
        fn root_is_refused_even_with_an_approval_in_hand() {
            // The attack this whole module exists for: a compromised webview
            // calling the scope API with "/" to widen its own access.
            let s = state_with(&["/home/u/proj"]);
            assert!(s.approval_for(Path::new("/")).is_none());
        }

        #[test]
        fn a_sibling_of_an_approved_directory_is_refused() {
            let s = state_with(&["/home/u/proj"]);
            assert!(s.approval_for(Path::new("/home/u/other")).is_none());
            assert!(s.approval_for(Path::new("/home/u/proj-evil")).is_none());
        }

        #[test]
        fn an_unrelated_sensitive_path_is_refused() {
            let s = state_with(&["/home/u/proj"]);
            assert!(s.approval_for(Path::new("/home/u/.ssh")).is_none());
            assert!(s.approval_for(Path::new("/etc")).is_none());
        }

        #[test]
        fn approving_the_same_directory_twice_does_not_duplicate_it() {
            let s = state_with(&["/home/u/proj", "/home/u/proj"]);
            assert_eq!(s.approved.read().len(), 1);
        }

        #[test]
        fn several_directories_can_be_approved_independently() {
            let s = state_with(&["/home/u/a", "/home/u/b"]);
            assert_eq!(s.approval_for(Path::new("/home/u/b/x")), Some(PathBuf::from("/home/u/b")));
            assert!(s.approval_for(Path::new("/home/u/c")).is_none());
        }
    }
}
