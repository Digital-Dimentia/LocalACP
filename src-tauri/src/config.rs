#[cfg(desktop)]
use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher, EventKind};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use indexmap::IndexMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
#[cfg(desktop)]
use tauri::Emitter;
use tauri::AppHandle;
#[cfg(not(desktop))]
use tauri::Manager;

/// Transport kind for an ACP agent.
///
/// `stdio` (default, desktop only) launches a subprocess and exchanges
/// JSON-RPC over stdin/stdout. `websocket` and `http` connect to a remote
/// endpoint advertised by an agent that natively speaks ACP over the wire,
/// and require the corresponding `url`/`headers` fields.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AgentTransport {
    #[default]
    Stdio,
    Websocket,
    Http,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentConfig {
    /// Transport kind. Defaults to `stdio` for backward compatibility with
    /// existing `agents.json` files that only contain `command`/`args`.
    #[serde(default, skip_serializing_if = "is_default_transport")]
    pub transport: AgentTransport,

    // ----- stdio-only fields (optional when transport != stdio) -----
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "std::collections::HashMap::is_empty")]
    pub env: std::collections::HashMap<String, String>,

    // ----- remote-only fields (optional, used when transport != stdio) -----
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headers: Option<std::collections::HashMap<String, String>>,
}

fn is_default_transport(t: &AgentTransport) -> bool {
    *t == AgentTransport::Stdio
}

impl AgentConfig {
    /// Build a stdio-transport agent config (used by defaults and
    /// backward-compatible callers).
    pub fn stdio(
        command: String,
        args: Vec<String>,
        env: std::collections::HashMap<String, String>,
    ) -> Self {
        Self {
            transport: AgentTransport::Stdio,
            command: Some(command),
            args: Some(args),
            env,
            url: None,
            headers: None,
        }
    }
}


/// Transport kind for an MCP server.
///
/// `stdio` is the only one every ACP agent must support; `http` and `sse` are
/// gated on the agent advertising `mcpCapabilities.http` / `.sse` during
/// `initialize`, which the frontend checks before sending them.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum McpTransport {
    #[default]
    Stdio,
    Http,
    Sse,
}

fn is_default_mcp_transport(t: &McpTransport) -> bool {
    *t == McpTransport::Stdio
}

fn default_true() -> bool {
    true
}

fn is_true(b: &bool) -> bool {
    *b
}

/// One MCP server offered to agents at `session/new` / `session/load`.
///
/// Deliberately a superset of the ACP wire shape: `description` and `enabled`
/// are ours and are stripped before sending. `enabled` lets a user park a
/// server without deleting the command line and the env vars that go with it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServerConfig {
    #[serde(default, skip_serializing_if = "is_default_mcp_transport")]
    pub transport: McpTransport,

    // ----- stdio-only -----
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "std::collections::HashMap::is_empty")]
    pub env: std::collections::HashMap<String, String>,

    // ----- http / sse only -----
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headers: Option<std::collections::HashMap<String, String>>,

    /// Free-text note shown in Settings. Never sent to the agent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,

    /// Disabled servers stay in the file but are not offered to sessions.
    /// Defaults to true so a hand-written entry works without the field.
    #[serde(default = "default_true", skip_serializing_if = "is_true")]
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentsConfig {
    pub agents: IndexMap<String, AgentConfig>,

    /// MCP servers offered to every session. Absent from older `agents.json`
    /// files, and omitted again when empty so the default file is unchanged.
    #[serde(
        default,
        rename = "mcpServers",
        skip_serializing_if = "IndexMap::is_empty"
    )]
    pub mcp_servers: IndexMap<String, McpServerConfig>,
}

impl Default for AgentsConfig {
    fn default() -> Self {
        let mut agents = IndexMap::new();
        agents.insert(
            "GitHub Copilot".to_string(),
            AgentConfig::stdio(
                "npx".to_string(),
                vec![
                    "@github/copilot-language-server@latest".to_string(),
                    "--acp".to_string(),
                ],
                std::collections::HashMap::new(),
            ),
        );
        agents.insert(
            "Claude Code".to_string(),
            AgentConfig::stdio(
                "npx".to_string(),
                vec!["@agentclientprotocol/claude-agent-acp@latest".to_string()],
                std::collections::HashMap::new(),
            ),
        );
        agents.insert(
            "Gemini CLI".to_string(),
            AgentConfig::stdio(
                "npx".to_string(),
                vec![
                    "@google/gemini-cli@latest".to_string(),
                    "--experimental-acp".to_string(),
                ],
                std::collections::HashMap::new(),
            ),
        );
        agents.insert(
            "Qwen Code".to_string(),
            AgentConfig::stdio(
                "npx".to_string(),
                vec![
                    "@qwen-code/qwen-code@latest".to_string(),
                    "--acp".to_string(),
                    "--experimental-skills".to_string(),
                ],
                std::collections::HashMap::new(),
            ),
        );
        agents.insert(
            "Auggie CLI".to_string(),
            AgentConfig::stdio(
                "npx".to_string(),
                vec![
                    "@augmentcode/auggie@latest".to_string(),
                    "--acp".to_string(),
                ],
                {
                    let mut env = std::collections::HashMap::new();
                    env.insert("AUGMENT_DISABLE_AUTO_UPDATE".to_string(), "1".to_string());
                    env
                },
            ),
        );
        agents.insert(
            "Qoder CLI".to_string(),
            AgentConfig::stdio(
                "npx".to_string(),
                vec![
                    "@qoder-ai/qodercli@latest".to_string(),
                    "--acp".to_string(),
                ],
                std::collections::HashMap::new(),
            ),
        );
        agents.insert(
            "Codex CLI".to_string(),
            AgentConfig::stdio(
                "npx".to_string(),
                vec!["@zed-industries/codex-acp@latest".to_string()],
                std::collections::HashMap::new(),
            ),
        );
        agents.insert(
            "OpenCode".to_string(),
            AgentConfig::stdio(
                "npx".to_string(),
                vec!["opencode-ai@latest".to_string(), "acp".to_string()],
                std::collections::HashMap::new(),
            ),
        );
        agents.insert(
            "OpenClaw".to_string(),
            AgentConfig::stdio(
                "npx".to_string(),
                vec!["openclaw".to_string(), "acp".to_string()],
                std::collections::HashMap::new(),
            ),
        );
        agents.insert(
            "Kiro CLI".to_string(),
            AgentConfig::stdio(
                "kiro-cli".to_string(),
                vec!["acp".to_string()],
                std::collections::HashMap::new(),
            ),
        );
        agents.insert(
            "Hermes Agent".to_string(),
            AgentConfig::stdio(
                "hermes".to_string(),
                vec!["acp".to_string()],
                std::collections::HashMap::new(),
            ),
        );
        AgentsConfig {
            agents,
            mcp_servers: IndexMap::new(),
        }
    }
}

pub struct ConfigManager {
    config: Arc<RwLock<AgentsConfig>>,
    config_path: PathBuf,
    /// File watcher is desktop-only. Mobile builds rely on explicit
    /// `add_agent` / `update_agent` IPC calls (no external editing path).
    #[cfg(desktop)]
    #[allow(dead_code)]
    watcher: Option<RecommendedWatcher>,
}

impl ConfigManager {
    pub fn new(app: &AppHandle) -> Result<Self, String> {
        let config_path = get_config_path(app)?;

        // Create config directory if it doesn't exist
        if let Some(parent) = config_path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }

        // Load initial config or create default
        let config = if config_path.exists() {
            load_config(&config_path)?
        } else {
            let default_config = AgentsConfig::default();
            save_config(&config_path, &default_config)?;
            default_config
        };

        let config = Arc::new(RwLock::new(config));

        // Set up file watcher (desktop only — `notify` doesn't have a useful
        // backend on iOS/Android, and mobile users can't edit the file
        // outside the app anyway).
        #[cfg(desktop)]
        let watcher = {
            let config_clone = Arc::clone(&config);
            let config_path_clone = config_path.clone();
            let app_handle = app.clone();
            Some(setup_watcher(config_clone, config_path_clone, app_handle)?)
        };
        #[cfg(not(desktop))]
        {
            // Touch `app` so the parameter isn't reported as unused on mobile.
            let _ = app;
        }

        Ok(Self {
            config,
            config_path,
            #[cfg(desktop)]
            watcher,
        })
    }

    pub fn get_config(&self) -> AgentsConfig {
        self.config.read().clone()
    }

    pub fn reload(&self) -> Result<AgentsConfig, String> {
        let new_config = load_config(&self.config_path)?;
        *self.config.write() = new_config.clone();
        Ok(new_config)
    }

    pub fn get_config_path(&self) -> PathBuf {
        self.config_path.clone()
    }

    pub fn save(&self) -> Result<(), String> {
        let config = self.config.read();
        save_config(&self.config_path, &config)
    }

    pub fn add_agent(&self, name: String, config: AgentConfig) -> Result<AgentsConfig, String> {
        {
            let mut agents_config = self.config.write();
            agents_config.agents.insert(name, config);
        }
        self.save()?;
        Ok(self.get_config())
    }

    pub fn remove_agent(&self, name: &str) -> Result<AgentsConfig, String> {
        {
            let mut agents_config = self.config.write();
            agents_config.agents.shift_remove(name);
        }
        self.save()?;
        Ok(self.get_config())
    }

    pub fn add_mcp_server(
        &self,
        name: String,
        config: McpServerConfig,
    ) -> Result<AgentsConfig, String> {
        {
            let mut agents_config = self.config.write();
            agents_config.mcp_servers.insert(name, config);
        }
        self.save()?;
        Ok(self.get_config())
    }

    pub fn remove_mcp_server(&self, name: &str) -> Result<AgentsConfig, String> {
        {
            let mut agents_config = self.config.write();
            agents_config.mcp_servers.shift_remove(name);
        }
        self.save()?;
        Ok(self.get_config())
    }

    /// Replace an MCP server, preserving its position in the file. `insert`
    /// on an existing key already keeps the slot; a rename is expressed by the
    /// caller removing the old name first.
    pub fn update_mcp_server(
        &self,
        name: String,
        config: McpServerConfig,
    ) -> Result<AgentsConfig, String> {
        self.add_mcp_server(name, config)
    }

    pub fn update_agent(&self, name: String, config: AgentConfig) -> Result<AgentsConfig, String> {
        {
            let mut agents_config = self.config.write();
            if agents_config.agents.contains_key(&name) {
                agents_config.agents.insert(name, config);
            } else {
                return Err(format!("Agent '{}' not found", name));
            }
        }
        self.save()?;
        Ok(self.get_config())
    }
}

fn get_config_path(_app: &AppHandle) -> Result<PathBuf, String> {
    // On desktop we keep the historical `~/.config/acp-ui/agents.json`
    // (resp. %APPDATA%\acp-ui, ~/Library/Application Support/acp-ui)
    // so existing installations don't need to migrate.
    #[cfg(desktop)]
    {
        return dirs::config_dir()
            .map(|p| p.join("acp-ui").join("agents.json"))
            .ok_or_else(|| "Could not find config directory".to_string());
    }
    // On mobile, the only writable per-app location is the sandbox config
    // dir exposed by Tauri. `dirs::config_dir()` is unreliable there.
    #[cfg(not(desktop))]
    {
        return _app
            .path()
            .app_config_dir()
            .map_err(|e| format!("Could not resolve app config dir: {}", e))
            .map(|p| p.join("agents.json"));
    }
}

fn load_config(path: &PathBuf) -> Result<AgentsConfig, String> {
    let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&content).map_err(|e| e.to_string())
}

fn save_config(path: &PathBuf, config: &AgentsConfig) -> Result<(), String> {
    let content = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    fs::write(path, content).map_err(|e| e.to_string())
}

#[cfg(desktop)]
fn setup_watcher(
    config: Arc<RwLock<AgentsConfig>>,
    config_path: PathBuf,
    app_handle: AppHandle,
) -> Result<RecommendedWatcher, String> {
    let config_path_for_watcher = config_path.clone();
    
    let mut watcher = RecommendedWatcher::new(
        move |res: Result<notify::Event, notify::Error>| {
            if let Ok(event) = res {
                match event.kind {
                    EventKind::Modify(_) | EventKind::Create(_) => {
                        if event.paths.iter().any(|p| p == &config_path_for_watcher) {
                            if let Ok(new_config) = load_config(&config_path_for_watcher) {
                                *config.write() = new_config.clone();
                                let _ = app_handle.emit("config-changed", new_config);
                            }
                        }
                    }
                    _ => {}
                }
            }
        },
        Config::default(),
    )
    .map_err(|e| e.to_string())?;

    // Watch the config directory
    if let Some(parent) = config_path.parent() {
        watcher
            .watch(parent, RecursiveMode::NonRecursive)
            .map_err(|e| e.to_string())?;
    }

    Ok(watcher)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Old-format `agents.json` files only contain `command/args/env`. The
    /// new struct must still deserialize them as stdio agents so users
    /// don't lose their config on upgrade.
    #[test]
    fn deserializes_legacy_stdio_config() {
        let json = r#"{"agents":{"Legacy":{"command":"npx","args":["x"],"env":{}}}}"#;
        let cfg: AgentsConfig = serde_json::from_str(json).unwrap();
        let a = cfg.agents.get("Legacy").unwrap();
        assert_eq!(a.transport, AgentTransport::Stdio);
        assert_eq!(a.command.as_deref(), Some("npx"));
        assert_eq!(a.url, None);
    }

    /// New-format remote agents must round-trip through serde without losing
    /// the transport / url / headers fields.
    #[test]
    fn roundtrips_remote_websocket_config() {
        let json = r#"{"agents":{"Remote":{"transport":"websocket","url":"wss://x/v1","headers":{"Authorization":"Bearer abc"}}}}"#;
        let cfg: AgentsConfig = serde_json::from_str(json).unwrap();
        let a = cfg.agents.get("Remote").unwrap();
        assert_eq!(a.transport, AgentTransport::Websocket);
        assert_eq!(a.url.as_deref(), Some("wss://x/v1"));
        assert_eq!(a.command, None);
        let serialized = serde_json::to_string(&cfg).unwrap();
        // `transport: "stdio"` is omitted by skip_serializing_if; ensure
        // websocket is present in the round-trip output.
        assert!(serialized.contains("\"transport\":\"websocket\""));
    }

    /// Configs written before MCP support have no `mcpServers` key at all and
    /// must keep loading, with an empty map rather than a deserialize error.
    #[test]
    fn config_without_mcp_servers_still_loads() {
        let json = r#"{"agents":{"A":{"command":"npx","args":[],"env":{}}}}"#;
        let cfg: AgentsConfig = serde_json::from_str(json).unwrap();
        assert!(cfg.mcp_servers.is_empty());
        // And an empty map is not written back out, so upgrading the app does
        // not rewrite everyone's file.
        let out = serde_json::to_string(&cfg).unwrap();
        assert!(!out.contains("mcpServers"));
    }

    #[test]
    fn roundtrips_stdio_mcp_server() {
        let json = r#"{"agents":{},"mcpServers":{"demo":{"command":"python3","args":["s.py"],"env":{"TOKEN":"x"},"description":"fixture"}}}"#;
        let cfg: AgentsConfig = serde_json::from_str(json).unwrap();
        let s = cfg.mcp_servers.get("demo").unwrap();
        assert_eq!(s.transport, McpTransport::Stdio);
        assert_eq!(s.command.as_deref(), Some("python3"));
        assert_eq!(s.env.get("TOKEN").map(String::as_str), Some("x"));
        assert_eq!(s.description.as_deref(), Some("fixture"));

        let out = serde_json::to_string(&cfg).unwrap();
        assert!(out.contains("\"mcpServers\""));
        // stdio and enabled:true are the defaults and stay out of the file.
        assert!(!out.contains("\"transport\":\"stdio\""));
        assert!(!out.contains("\"enabled\""));
    }

    /// A hand-written entry with no `enabled` key is on: the field exists to
    /// park a server, so its absence must not silently disable one.
    #[test]
    fn mcp_server_enabled_defaults_to_true() {
        let json = r#"{"agents":{},"mcpServers":{"demo":{"command":"x"}}}"#;
        let cfg: AgentsConfig = serde_json::from_str(json).unwrap();
        assert!(cfg.mcp_servers.get("demo").unwrap().enabled);
    }

    #[test]
    fn roundtrips_http_mcp_server_and_keeps_disabled_flag() {
        let json = r#"{"agents":{},"mcpServers":{"remote":{"transport":"http","url":"https://mcp.example.com/v1","headers":{"Authorization":"Bearer t"},"enabled":false}}}"#;
        let cfg: AgentsConfig = serde_json::from_str(json).unwrap();
        let s = cfg.mcp_servers.get("remote").unwrap();
        assert_eq!(s.transport, McpTransport::Http);
        assert_eq!(s.url.as_deref(), Some("https://mcp.example.com/v1"));
        assert!(!s.enabled);

        let out = serde_json::to_string(&cfg).unwrap();
        assert!(out.contains("\"transport\":\"http\""));
        assert!(out.contains("\"enabled\":false"));
    }

    #[test]
    fn defaults_keep_all_eleven_stdio_agents() {
        let cfg = AgentsConfig::default();
        assert_eq!(cfg.agents.len(), 11);
        for (_, a) in &cfg.agents {
            assert_eq!(a.transport, AgentTransport::Stdio);
            assert!(a.command.is_some());
        }
    }
}
