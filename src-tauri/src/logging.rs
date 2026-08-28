//! Persistent application logging.
//!
//! Wires up `tauri-plugin-log` with two targets: a rotating file in the OS log
//! directory (`~/Library/Logs/formulahendry.acp-ui/LocalACP.log` on macOS) and
//! stdout, which is only visible during `tauri dev`. The frontend logs through
//! the same pipeline via `@tauri-apps/plugin-log`, so webview and Rust output
//! interleave in one file — the whole point, since a failed agent launch
//! usually spans both sides.
//!
//! ## The debug toggle
//!
//! `info` and above are always recorded: they are low-volume and are what a
//! bug report needs. `debug`/`trace` are gated behind a user toggle because
//! they include agent stderr, which can echo prompt text and file paths — and
//! this app's default posture is to keep that off disk unless the user asks.
//!
//! The gate is a process-wide `AtomicBool` consulted by the dispatch filter on
//! every record, rather than a `LevelFilter` fixed at plugin-build time. That
//! is what makes the toggle take effect immediately instead of at next launch;
//! the plugin's own max level is pinned at `Trace` so the filter is the only
//! thing deciding.
//!
//! The flag is persisted next to `agents.json` in its own file rather than in
//! the `preferences.json` KV store the frontend owns, so it can be read during
//! `setup` — otherwise everything logged during startup, which is exactly what
//! people turn debug logging on to see, would be filtered out before the
//! webview ever came up to report the preference.
//!
//! ## Why the plugin is registered from `setup` rather than on the builder
//!
//! `tauri-plugin-log` creates the log directory while its plugin setup runs,
//! and a plugin registered on the builder that fails setup takes down
//! `Builder::run` with it. A read-only or sandboxed home would therefore stop
//! the app from launching at all — a steep price for a missing log file.
//! Registering through `AppHandle::plugin` instead hands us the error, so the
//! app carries on with no logger.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_log::{Target, TargetKind, TimezoneStrategy};

/// Base name of the log file; the plugin appends `.log`.
const LOG_FILE_STEM: &str = "LocalACP";

/// Keep a single file, rotated at 5 MB. Debug logging is chatty enough that
/// the plugin's 40 KB default would discard the beginning of the very session
/// being debugged.
const MAX_LOG_FILE_SIZE: u128 = 5 * 1024 * 1024;

static DEBUG_LOGGING: AtomicBool = AtomicBool::new(false);

/// True when `debug`/`trace` records should be written.
pub fn debug_logging_enabled() -> bool {
    DEBUG_LOGGING.load(Ordering::Relaxed)
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct LoggingSettings {
    #[serde(default)]
    debug: bool,
}

/// Location of the persisted toggle. Mirrors `config::get_config_path` so the
/// two files sit side by side in the directory users already know about.
fn settings_path(_app: &AppHandle) -> Option<PathBuf> {
    #[cfg(desktop)]
    {
        return dirs::config_dir().map(|p| p.join("acp-ui").join("logging.json"));
    }
    #[cfg(not(desktop))]
    {
        return _app
            .path()
            .app_config_dir()
            .ok()
            .map(|p| p.join("logging.json"));
    }
}

/// Read the toggle from disk. Every failure mode — no file yet, unreadable,
/// truncated JSON — means "off", which is the safe default for a setting whose
/// only job is to put more detail on disk.
fn read_flag(path: &PathBuf) -> bool {
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<LoggingSettings>(&raw).ok())
        .map(|s| s.debug)
        .unwrap_or(false)
}

fn write_flag(path: &PathBuf, enabled: bool) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let body = serde_json::to_string_pretty(&LoggingSettings { debug: enabled })
        .map_err(|e| e.to_string())?;
    fs::write(path, body).map_err(|e| e.to_string())
}

/// Register the log plugin and load the persisted debug toggle.
///
/// Call this first thing in `setup`, before anything worth logging happens.
/// Failure is reported but not fatal: an app that runs without a log file is
/// strictly better than one that refuses to start because it has no log file.
pub fn init(app: &AppHandle) {
    // Load the toggle before the plugin so the very first records — the
    // startup banner and agent spawns — are already filtered correctly.
    if let Some(path) = settings_path(app) {
        DEBUG_LOGGING.store(read_flag(&path), Ordering::Relaxed);
    }

    if let Err(e) = app.plugin(plugin()) {
        // The logger is what we would normally report this through, so stderr
        // is all that is left. Visible under `tauri dev`.
        eprintln!("Failed to initialize logging: {}", e);
    }
}

/// Flip the toggle for this process and persist it for the next launch.
pub fn set_debug_logging(app: &AppHandle, enabled: bool) -> Result<(), String> {
    DEBUG_LOGGING.store(enabled, Ordering::Relaxed);

    let path = settings_path(app)
        .ok_or_else(|| "Could not resolve the logging settings path".to_string())?;
    write_flag(&path, enabled)?;

    // Logged at info so the transition is visible in the file itself; without
    // it a log that simply stops carrying debug lines is ambiguous.
    log::info!(
        "Debug logging {}",
        if enabled { "enabled" } else { "disabled" }
    );
    Ok(())
}

/// Absolute path of the current log file, for the Settings UI to show and reveal.
pub fn log_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_log_dir()
        .map_err(|e| format!("Could not resolve the log directory: {}", e))
        .map(|dir| dir.join(format!("{}.log", LOG_FILE_STEM)))
}

/// Build the configured log plugin.
fn plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri_plugin_log::Builder::new()
        .clear_targets()
        .target(Target::new(TargetKind::LogDir {
            file_name: Some(LOG_FILE_STEM.to_string()),
        }))
        // Stdout only reaches a terminal during `tauri dev`; in a bundled app
        // it goes nowhere, which is why the file target is the real one.
        .target(Target::new(TargetKind::Stdout))
        .max_file_size(MAX_LOG_FILE_SIZE)
        .timezone_strategy(TimezoneStrategy::UseLocal)
        // Pinned at Trace so the runtime filter below is the sole gate.
        .level(log::LevelFilter::Trace)
        .filter(|metadata| metadata.level() <= log::Level::Info || debug_logging_enabled())
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Unique temp path per test; the suite runs threaded and these tests all
    /// touch the filesystem.
    fn temp_path(name: &str) -> PathBuf {
        std::env::temp_dir()
            .join(format!("acp-ui-logging-test-{}", name))
            .join("logging.json")
    }

    #[test]
    fn flag_roundtrips_through_the_settings_file() {
        let path = temp_path("roundtrip");
        let _ = fs::remove_dir_all(path.parent().unwrap());

        write_flag(&path, true).unwrap();
        assert!(read_flag(&path));

        write_flag(&path, false).unwrap();
        assert!(!read_flag(&path));

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    /// First launch: no file exists, and debug logging must stay off rather
    /// than defaulting to writing agent stderr to disk.
    #[test]
    fn missing_settings_file_means_off() {
        let path = temp_path("missing");
        let _ = fs::remove_dir_all(path.parent().unwrap());
        assert!(!read_flag(&path));
    }

    /// A half-written or hand-edited file must not be worse than no file.
    #[test]
    fn malformed_settings_file_means_off() {
        let path = temp_path("malformed");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "{ not json").unwrap();
        assert!(!read_flag(&path));

        // Right shape, wrong type for `debug`.
        fs::write(&path, r#"{"debug":"yes"}"#).unwrap();
        assert!(!read_flag(&path));

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    /// `debug_logging_enabled` is what the dispatch filter consults on every
    /// record, so the toggle has to be visible without a restart.
    #[test]
    fn enabled_flag_is_process_wide() {
        DEBUG_LOGGING.store(true, Ordering::Relaxed);
        assert!(debug_logging_enabled());
        DEBUG_LOGGING.store(false, Ordering::Relaxed);
        assert!(!debug_logging_enabled());
    }
}
