use serde::{Deserialize, Serialize};

#[cfg(desktop)]
use parking_lot::RwLock;
#[cfg(desktop)]
use std::collections::HashMap;
#[cfg(desktop)]
use std::io::{BufRead, BufReader, Write};
#[cfg(desktop)]
use std::process::{Child, Command, Stdio};
#[cfg(desktop)]
use std::sync::Arc;
#[cfg(desktop)]
use std::thread;
use tauri::AppHandle;
#[cfg(desktop)]
use tauri::Emitter;
#[cfg(desktop)]
use uuid::Uuid;

#[cfg(all(desktop, target_os = "windows"))]
use std::os::windows::process::CommandExt;

#[cfg(all(desktop, not(target_os = "windows")))]
use shell_escape;

use crate::config::{AgentConfig, AgentTransport};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentInstance {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentMessage {
    pub agent_id: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentStderr {
    pub agent_id: String,
    pub line: String,
}

#[cfg(desktop)]
struct RunningAgent {
    #[allow(dead_code)]
    child: Child,
    stdin: Arc<RwLock<std::process::ChildStdin>>,
}

#[cfg(desktop)]
pub struct AgentManager {
    agents: Arc<RwLock<HashMap<String, RunningAgent>>>,
}

#[cfg(not(desktop))]
pub struct AgentManager {
    // Mobile builds keep the type so command handlers compile, but the
    // stdio transport is unavailable: any spawn attempt errors out and the
    // app is expected to use a remote (websocket/http) transport instead.
    _phantom: std::marker::PhantomData<()>,
}

/// Build the PATH for a spawned stdio agent on macOS.
///
/// A GUI app launched from Finder/Dock inherits launchd's minimal PATH, so
/// Homebrew binaries (`claude`, `npx`) are unresolvable and the spawn fails
/// with "command not found". Fix it by APPENDING a fixed, auditable set of
/// directories rather than by sourcing the user's shell profile.
///
/// Append, never prepend: entries already on PATH keep precedence, so a
/// group-writable /usr/local/bin can never shadow a system binary. An explicit
/// PATH from the agent's config is used as the base and kept in full.
#[cfg(all(desktop, target_os = "macos"))]
fn build_spawn_path(config_path: Option<&str>, inherited_path: &str) -> String {
    let base = config_path.unwrap_or(inherited_path);
    let mut entries: Vec<&str> = base.split(':').filter(|s| !s.is_empty()).collect();
    for extra in ["/opt/homebrew/bin", "/usr/local/bin"] {
        if !entries.contains(&extra) {
            entries.push(extra);
        }
    }
    entries.join(":")
}

#[cfg(desktop)]
impl AgentManager {
    pub fn new() -> Self {
        Self {
            agents: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub fn spawn_agent(
        &self,
        name: String,
        config: &AgentConfig,
        app_handle: AppHandle,
    ) -> Result<AgentInstance, String> {
        // Reject non-stdio agents on the spawn path. Remote agents are
        // handled entirely on the frontend (browser WebSocket / fetch),
        // so we should never get here for them.
        if config.transport != AgentTransport::Stdio {
            return Err(format!(
                "Agent '{}' uses '{:?}' transport which is not stdio; spawn_agent is stdio-only",
                name, config.transport
            ));
        }

        let command = config
            .command
            .as_ref()
            .ok_or_else(|| format!("stdio agent '{}' is missing 'command'", name))?;
        let args: &[String] = config.args.as_deref().unwrap_or(&[]);

        let agent_id = Uuid::new_v4().to_string();

        // Info level: the command line is config the user wrote, not agent
        // traffic, and knowing what was actually executed is the first thing
        // any "the agent won't start" report needs.
        log::info!(
            "Spawning agent '{}' ({}): {} {}",
            name,
            agent_id,
            command,
            args.join(" ")
        );

        // On Windows, we need to use cmd.exe to properly resolve .cmd/.bat files like npx
        #[cfg(target_os = "windows")]
        let mut child = {
            let mut cmd = Command::new("cmd");
            cmd.arg("/C")
                .arg(command)
                .args(args)
                .envs(&config.env)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .creation_flags(0x08000000); // CREATE_NO_WINDOW
            cmd.spawn()
                .map_err(|e| format!("Failed to spawn agent: {}", e))?
        };

        #[cfg(not(target_os = "windows"))]
        let mut child = {
            use std::borrow::Cow;

            // Build shell command with proper quoting for command and arguments
            let escaped_command = shell_escape::escape(Cow::Borrowed(command.as_str()));
            let shell_command = if args.is_empty() {
                escaped_command.to_string()
            } else {
                let quoted_args: Vec<String> = args
                    .iter()
                    .map(|arg| shell_escape::escape(Cow::Borrowed(arg.as_str())).to_string())
                    .collect();
                format!("{} {}", escaped_command, quoted_args.join(" "))
            };

            // Spawn through /bin/sh -c, NOT through the user's $SHELL as a
            // login shell. A login shell sources the user's profile, which
            // (a) executes arbitrary user code from a path we cannot validate,
            // (b) prints whatever it likes onto the child's stdout -- the exact
            // pipe the ACP client parses as line-delimited JSON-RPC, so any
            // banner breaks the connection, (c) can reassign PATH and clobber
            // the agent's configured env, and (d) can block forever on an
            // interactive prompt. PATH is instead enriched deterministically
            // below, which is what the profile was being sourced for.
            let mut cmd = Command::new("/bin/sh");
            cmd.arg("-c").arg(&shell_command).envs(&config.env);

            // config.env is applied first so the merged PATH below wins over a
            // raw config value; the merge itself preserves the user's PATH in
            // full and only appends after it.
            #[cfg(target_os = "macos")]
            {
                let effective_path = build_spawn_path(
                    config.env.get("PATH").map(String::as_str),
                    &std::env::var("PATH").unwrap_or_default(),
                );
                log::debug!(
                    "Spawning agent '{}' with /bin/sh -c (no login shell); PATH={}",
                    name,
                    effective_path
                );
                cmd.env("PATH", effective_path);
            }

            #[cfg(not(target_os = "macos"))]
            log::debug!(
                "Spawning agent '{}' with /bin/sh -c (no login shell); PATH={}",
                name,
                config
                    .env
                    .get("PATH")
                    .cloned()
                    .unwrap_or_else(|| std::env::var("PATH").unwrap_or_default())
            );

            cmd.stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .map_err(|e| format!("Failed to spawn agent: {}", e))?
        };

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Failed to get stdin".to_string())?;

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Failed to get stdout".to_string())?;

        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "Failed to get stderr".to_string())?;

        let stdin = Arc::new(RwLock::new(stdin));

        // Spawn a thread to read stdout and emit events
        let agent_id_clone = agent_id.clone();
        let app_handle_clone = app_handle.clone();
        let agents_clone = Arc::clone(&self.agents);

        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                match line {
                    Ok(message) => {
                        let agent_message = AgentMessage {
                            agent_id: agent_id_clone.clone(),
                            message,
                        };
                        let _ = app_handle_clone.emit("agent-message", agent_message);
                    }
                    Err(_) => break,
                }
            }
            // Agent process ended, remove from map
            log::info!("Agent {} closed its stdout; cleaning up", agent_id_clone);
            agents_clone.write().remove(&agent_id_clone);
            let _ = app_handle_clone.emit("agent-closed", agent_id_clone);
        });

        // Spawn a thread to read stderr and emit events (for startup progress)
        let agent_id_clone2 = agent_id.clone();
        let app_handle_clone2 = app_handle.clone();
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                match line {
                    Ok(line_content) => {
                        // Debug level, so this only reaches the file when the
                        // user opted in: agent stderr can echo prompt text and
                        // absolute paths.
                        log::debug!("[{}] {}", agent_id_clone2, line_content);
                        let stderr_msg = AgentStderr {
                            agent_id: agent_id_clone2.clone(),
                            line: line_content,
                        };
                        let _ = app_handle_clone2.emit("agent-stderr", stderr_msg);
                    }
                    Err(_) => break,
                }
            }
        });

        let running_agent = RunningAgent { child, stdin };
        self.agents.write().insert(agent_id.clone(), running_agent);

        Ok(AgentInstance { id: agent_id, name })
    }

    pub fn send_message(&self, agent_id: &str, message: &str) -> Result<(), String> {
        let agents = self.agents.read();
        let agent = agents
            .get(agent_id)
            .ok_or_else(|| format!("Agent not found: {}", agent_id))?;

        let mut stdin = agent.stdin.write();
        writeln!(stdin, "{}", message).map_err(|e| format!("Failed to write to stdin: {}", e))?;
        stdin
            .flush()
            .map_err(|e| format!("Failed to flush stdin: {}", e))?;

        Ok(())
    }

    pub fn kill_agent(&self, agent_id: &str) -> Result<(), String> {
        let mut agents = self.agents.write();
        if let Some(mut agent) = agents.remove(agent_id) {
            agent
                .child
                .kill()
                .map_err(|e| format!("Failed to kill agent: {}", e))?;
        }
        Ok(())
    }

    pub fn list_running_agents(&self) -> Vec<String> {
        self.agents.read().keys().cloned().collect()
    }
}

#[cfg(not(desktop))]
impl AgentManager {
    pub fn new() -> Self {
        Self {
            _phantom: std::marker::PhantomData,
        }
    }

    pub fn spawn_agent(
        &self,
        _name: String,
        _config: &AgentConfig,
        _app_handle: AppHandle,
    ) -> Result<AgentInstance, String> {
        Err("stdio agents are not supported on this platform; configure a websocket or http transport".to_string())
    }

    pub fn send_message(&self, _agent_id: &str, _message: &str) -> Result<(), String> {
        Err("stdio agents are not supported on this platform".to_string())
    }

    pub fn kill_agent(&self, _agent_id: &str) -> Result<(), String> {
        Ok(())
    }

    pub fn list_running_agents(&self) -> Vec<String> {
        Vec::new()
    }
}

impl Default for AgentManager {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(all(test, desktop, target_os = "macos"))]
mod tests {
    use super::build_spawn_path;

    #[test]
    fn appends_homebrew_dirs_to_the_inherited_path() {
        assert_eq!(
            build_spawn_path(None, "/usr/bin:/bin"),
            "/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin"
        );
    }

    #[test]
    fn config_path_is_preserved_in_full_and_keeps_precedence() {
        assert_eq!(
            build_spawn_path(Some("/my/tools:/usr/bin"), "/inherited/only"),
            "/my/tools:/usr/bin:/opt/homebrew/bin:/usr/local/bin"
        );
    }

    #[test]
    fn existing_entries_are_not_duplicated_or_reordered() {
        assert_eq!(
            build_spawn_path(None, "/usr/local/bin:/usr/bin"),
            "/usr/local/bin:/usr/bin:/opt/homebrew/bin"
        );
    }

    #[test]
    fn empty_segments_are_dropped() {
        assert_eq!(
            build_spawn_path(None, ":/usr/bin::"),
            "/usr/bin:/opt/homebrew/bin:/usr/local/bin"
        );
    }

    #[test]
    fn empty_path_yields_only_the_appended_dirs() {
        assert_eq!(
            build_spawn_path(None, ""),
            "/opt/homebrew/bin:/usr/local/bin"
        );
    }
}
