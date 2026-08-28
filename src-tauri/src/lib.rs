mod agent;
mod config;
mod logging;

use agent::{AgentInstance, AgentManager};
use config::{
    AgentConfig, AgentTransport, AgentsConfig, ConfigManager, McpServerConfig, McpTransport,
};
use parking_lot::RwLock;
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};

struct AppState {
    config_manager: Arc<RwLock<Option<ConfigManager>>>,
    agent_manager: AgentManager,
}

#[tauri::command]
fn get_config(state: State<AppState>) -> Result<AgentsConfig, String> {
    let config_manager = state.config_manager.read();
    config_manager
        .as_ref()
        .map(|cm| cm.get_config())
        .ok_or_else(|| "Config manager not initialized".to_string())
}

#[tauri::command]
fn reload_config(state: State<AppState>) -> Result<AgentsConfig, String> {
    let config_manager = state.config_manager.read();
    config_manager
        .as_ref()
        .map(|cm| cm.reload())
        .ok_or_else(|| "Config manager not initialized".to_string())?
}

#[tauri::command]
fn get_config_path(state: State<AppState>) -> Result<String, String> {
    let config_manager = state.config_manager.read();
    config_manager
        .as_ref()
        .map(|cm| cm.get_config_path().to_string_lossy().to_string())
        .ok_or_else(|| "Config manager not initialized".to_string())
}

#[tauri::command]
fn spawn_agent(
    name: String,
    state: State<AppState>,
    app_handle: AppHandle,
) -> Result<AgentInstance, String> {
    let config_manager = state.config_manager.read();
    let config = config_manager
        .as_ref()
        .ok_or_else(|| "Config manager not initialized".to_string())?
        .get_config();

    let agent_config = config
        .agents
        .get(&name)
        .ok_or_else(|| format!("Agent '{}' not found in config", name))?;

    state
        .agent_manager
        .spawn_agent(name, agent_config, app_handle)
}

#[tauri::command]
fn send_to_agent(agent_id: String, message: String, state: State<AppState>) -> Result<(), String> {
    state.agent_manager.send_message(&agent_id, &message)
}

#[tauri::command]
fn kill_agent(agent_id: String, state: State<AppState>) -> Result<(), String> {
    state.agent_manager.kill_agent(&agent_id)
}

#[tauri::command]
fn list_running_agents(state: State<AppState>) -> Vec<String> {
    state.agent_manager.list_running_agents()
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn add_agent(
    name: String,
    command: Option<String>,
    args: Option<Vec<String>>,
    env: Option<std::collections::HashMap<String, String>>,
    transport: Option<String>,
    url: Option<String>,
    headers: Option<std::collections::HashMap<String, String>>,
    state: State<AppState>,
) -> Result<AgentsConfig, String> {
    let agent_config = build_agent_config(command, args, env, transport, url, headers)?;
    let config_manager = state.config_manager.read();
    config_manager
        .as_ref()
        .ok_or_else(|| "Config manager not initialized".to_string())?
        .add_agent(name, agent_config)
}

#[tauri::command]
fn remove_agent(name: String, state: State<AppState>) -> Result<AgentsConfig, String> {
    let config_manager = state.config_manager.read();
    config_manager
        .as_ref()
        .ok_or_else(|| "Config manager not initialized".to_string())?
        .remove_agent(&name)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn update_agent(
    name: String,
    command: Option<String>,
    args: Option<Vec<String>>,
    env: Option<std::collections::HashMap<String, String>>,
    transport: Option<String>,
    url: Option<String>,
    headers: Option<std::collections::HashMap<String, String>>,
    state: State<AppState>,
) -> Result<AgentsConfig, String> {
    let agent_config = build_agent_config(command, args, env, transport, url, headers)?;
    let config_manager = state.config_manager.read();
    config_manager
        .as_ref()
        .ok_or_else(|| "Config manager not initialized".to_string())?
        .update_agent(name, agent_config)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn add_mcp_server(
    name: String,
    transport: Option<String>,
    command: Option<String>,
    args: Option<Vec<String>>,
    env: Option<std::collections::HashMap<String, String>>,
    url: Option<String>,
    headers: Option<std::collections::HashMap<String, String>>,
    description: Option<String>,
    enabled: Option<bool>,
    state: State<AppState>,
) -> Result<AgentsConfig, String> {
    let config = build_mcp_server_config(
        transport,
        command,
        args,
        env,
        url,
        headers,
        description,
        enabled,
    )?;
    let config_manager = state.config_manager.read();
    config_manager
        .as_ref()
        .ok_or_else(|| "Config manager not initialized".to_string())?
        .add_mcp_server(name, config)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn update_mcp_server(
    name: String,
    transport: Option<String>,
    command: Option<String>,
    args: Option<Vec<String>>,
    env: Option<std::collections::HashMap<String, String>>,
    url: Option<String>,
    headers: Option<std::collections::HashMap<String, String>>,
    description: Option<String>,
    enabled: Option<bool>,
    state: State<AppState>,
) -> Result<AgentsConfig, String> {
    let config = build_mcp_server_config(
        transport,
        command,
        args,
        env,
        url,
        headers,
        description,
        enabled,
    )?;
    let config_manager = state.config_manager.read();
    config_manager
        .as_ref()
        .ok_or_else(|| "Config manager not initialized".to_string())?
        .update_mcp_server(name, config)
}

#[tauri::command]
fn remove_mcp_server(name: String, state: State<AppState>) -> Result<AgentsConfig, String> {
    let config_manager = state.config_manager.read();
    config_manager
        .as_ref()
        .ok_or_else(|| "Config manager not initialized".to_string())?
        .remove_mcp_server(&name)
}

/// Build an `McpServerConfig` from the loosely-typed Tauri command arguments.
///
/// Mirrors `build_agent_config`: the renderer is not trusted to have validated
/// anything, and a half-formed entry here would be sent to every future
/// session rather than failing once.
#[allow(clippy::too_many_arguments)]
fn build_mcp_server_config(
    transport: Option<String>,
    command: Option<String>,
    args: Option<Vec<String>>,
    env: Option<std::collections::HashMap<String, String>>,
    url: Option<String>,
    headers: Option<std::collections::HashMap<String, String>>,
    description: Option<String>,
    enabled: Option<bool>,
) -> Result<McpServerConfig, String> {
    let transport_kind = match transport.as_deref() {
        None | Some("") | Some("stdio") => McpTransport::Stdio,
        Some("http") => McpTransport::Http,
        Some("sse") => McpTransport::Sse,
        Some(other) => return Err(format!("Unknown MCP transport: {}", other)),
    };

    // An MCP server over stdio is a subprocess the agent launches. Mobile
    // agents are remote and launch it on their own host, so this is not the
    // same platform restriction that applies to stdio *agents* and is
    // deliberately not rejected here.
    let description = description.filter(|d| !d.is_empty());
    let enabled = enabled.unwrap_or(true);

    match transport_kind {
        McpTransport::Stdio => {
            let command = command
                .filter(|s| !s.is_empty())
                .ok_or_else(|| "stdio MCP server requires a command".to_string())?;
            Ok(McpServerConfig {
                transport: McpTransport::Stdio,
                command: Some(command),
                args: Some(args.unwrap_or_default()),
                env: env.unwrap_or_default(),
                url: None,
                headers: None,
                description,
                enabled,
            })
        }
        McpTransport::Http | McpTransport::Sse => {
            let url = url
                .filter(|s| !s.is_empty())
                .ok_or_else(|| "http/sse MCP server requires a url".to_string())?;
            let lower = url.to_ascii_lowercase();
            if !(lower.starts_with("http://") || lower.starts_with("https://")) {
                return Err(format!(
                    "MCP server URL must be http:// or https://, got: {}",
                    url
                ));
            }
            Ok(McpServerConfig {
                transport: transport_kind,
                command: None,
                args: None,
                env: std::collections::HashMap::new(),
                url: Some(url),
                headers: headers.filter(|h| !h.is_empty()),
                description,
                enabled,
            })
        }
    }
}

#[tauri::command]
fn get_debug_logging() -> bool {
    logging::debug_logging_enabled()
}

#[tauri::command]
fn set_debug_logging(enabled: bool, app_handle: AppHandle) -> Result<(), String> {
    logging::set_debug_logging(&app_handle, enabled)
}

#[tauri::command]
fn get_log_path(app_handle: AppHandle) -> Result<String, String> {
    logging::log_file_path(&app_handle).map(|p| p.to_string_lossy().to_string())
}

/// Build an `AgentConfig` from the loosely-typed Tauri command arguments,
/// applying validation rules per transport kind.
fn build_agent_config(
    command: Option<String>,
    args: Option<Vec<String>>,
    env: Option<std::collections::HashMap<String, String>>,
    transport: Option<String>,
    url: Option<String>,
    headers: Option<std::collections::HashMap<String, String>>,
) -> Result<AgentConfig, String> {
    let transport_kind = match transport.as_deref() {
        None | Some("") | Some("stdio") => AgentTransport::Stdio,
        Some("websocket") | Some("ws") | Some("wss") => AgentTransport::Websocket,
        Some("http") | Some("https") => AgentTransport::Http,
        Some(other) => return Err(format!("Unknown transport: {}", other)),
    };

    // Defense in depth: stdio agents can't run on mobile (no subprocess).
    // The frontend already filters them out, but reject here too so a
    // malicious renderer or synced config can't smuggle one through the
    // IPC boundary.
    #[cfg(not(desktop))]
    if matches!(transport_kind, AgentTransport::Stdio) {
        return Err("stdio agents are not supported on this platform".to_string());
    }

    match transport_kind {
        AgentTransport::Stdio => {
            let command = command
                .filter(|s| !s.is_empty())
                .ok_or_else(|| "stdio agent requires a command".to_string())?;
            Ok(AgentConfig {
                transport: AgentTransport::Stdio,
                command: Some(command),
                args: Some(args.unwrap_or_default()),
                env: env.unwrap_or_default(),
                url: None,
                headers: None,
            })
        }
        AgentTransport::Websocket | AgentTransport::Http => {
            let url = url
                .filter(|s| !s.is_empty())
                .ok_or_else(|| "remote agent requires a url".to_string())?;
            // Sanity-check scheme matches transport so users get an early error.
            let lower = url.to_ascii_lowercase();
            let scheme_ok = match transport_kind {
                AgentTransport::Websocket => {
                    lower.starts_with("ws://") || lower.starts_with("wss://")
                }
                AgentTransport::Http => {
                    lower.starts_with("http://") || lower.starts_with("https://")
                }
                _ => true,
            };
            if !scheme_ok {
                return Err(format!(
                    "URL scheme does not match transport '{:?}': {}",
                    transport_kind, url
                ));
            }
            let headers = headers.filter(|h| !h.is_empty());
            Ok(AgentConfig {
                transport: transport_kind,
                command: None,
                args: None,
                env: std::collections::HashMap::new(),
                url: Some(url),
                headers,
            })
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app_state = AppState {
        config_manager: Arc::new(RwLock::new(None)),
        agent_manager: AgentManager::new(),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .manage(app_state)
        .setup(|app| {
            let app_handle = app.handle().clone();
            let state: State<AppState> = app.state();

            // Before anything else in setup: everything below is worth logging.
            logging::init(&app_handle);
            log::info!(
                "{} v{} starting (debug logging {})",
                app.package_info().name,
                app.package_info().version,
                if logging::debug_logging_enabled() { "on" } else { "off" }
            );

            // Initialize config manager
            match ConfigManager::new(&app_handle) {
                Ok(cm) => {
                    *state.config_manager.write() = Some(cm);
                }
                Err(e) => {
                    log::error!("Failed to initialize config manager: {}", e);
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            reload_config,
            get_config_path,
            spawn_agent,
            send_to_agent,
            kill_agent,
            list_running_agents,
            add_agent,
            remove_agent,
            update_agent,
            add_mcp_server,
            update_mcp_server,
            remove_mcp_server,
            get_debug_logging,
            set_debug_logging,
            get_log_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stdio_input(command: Option<&str>) -> Result<McpServerConfig, String> {
        build_mcp_server_config(
            None,
            command.map(str::to_string),
            Some(vec!["server.py".to_string()]),
            None,
            None,
            None,
            None,
            None,
        )
    }

    /// No transport field means stdio, matching how the config deserializes.
    #[test]
    fn mcp_defaults_to_stdio_and_enabled() {
        let c = stdio_input(Some("python3")).unwrap();
        assert_eq!(c.transport, McpTransport::Stdio);
        assert_eq!(c.command.as_deref(), Some("python3"));
        assert!(c.enabled);
    }

    /// An entry with no command would be sent to every future session and
    /// rejected there, so it is refused at the point of entry instead.
    #[test]
    fn mcp_stdio_requires_a_command() {
        assert!(stdio_input(None).is_err());
        assert!(stdio_input(Some("")).is_err());
    }

    #[test]
    fn mcp_http_requires_an_http_url() {
        let ok = build_mcp_server_config(
            Some("http".to_string()),
            None,
            None,
            None,
            Some("https://mcp.example.com/v1".to_string()),
            None,
            None,
            None,
        )
        .unwrap();
        assert_eq!(ok.transport, McpTransport::Http);

        // Missing entirely.
        assert!(build_mcp_server_config(
            Some("sse".to_string()),
            None,
            None,
            None,
            None,
            None,
            None,
            None
        )
        .is_err());

        // Right shape, wrong scheme — ws:// belongs to agent transports, not
        // MCP ones, and is an easy thing to paste in by mistake.
        assert!(build_mcp_server_config(
            Some("http".to_string()),
            None,
            None,
            None,
            Some("wss://mcp.example.com/v1".to_string()),
            None,
            None,
            None
        )
        .is_err());
    }

    #[test]
    fn mcp_rejects_unknown_transport() {
        assert!(build_mcp_server_config(
            Some("carrier-pigeon".to_string()),
            Some("x".to_string()),
            None,
            None,
            None,
            None,
            None,
            None
        )
        .is_err());
    }
}
