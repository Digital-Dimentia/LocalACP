// Types for the LocalACP application

import type { JsonSchema } from './schema-form';

/**
 * Transport kinds supported by the frontend.
 *
 * - `stdio`: agent runs as a local subprocess (desktop only).
 * - `websocket`: agent listens on `ws://` / `wss://` and speaks ACP over a WebSocket.
 * - `http`: agent listens on `http://` / `https://` and speaks ACP over Streamable HTTP / SSE.
 */
export type AgentTransportKind = 'stdio' | 'websocket' | 'http';

export interface AgentConfig {
  /**
   * Transport kind. Optional for backward compatibility — when omitted, the
   * config is treated as a stdio agent.
   */
  transport?: AgentTransportKind;

  // ----- stdio fields (optional when transport != 'stdio') -----
  command?: string;
  args?: string[];
  env?: Record<string, string>;

  // ----- remote fields (used when transport != 'stdio') -----
  url?: string;
  headers?: Record<string, string>;
}

export interface AgentsConfig {
  agents: Record<string, AgentConfig>;
  /** Absent in configs written before MCP support existed. */
  mcpServers?: Record<string, McpServerConfig>;
}

/** Returns the effective transport kind for an agent config. */
export function getTransportKind(config: AgentConfig): AgentTransportKind {
  return config.transport ?? 'stdio';
}

/** Type guard: true for legacy / explicit stdio agents. */
export function isStdioConfig(
  config: AgentConfig
): config is AgentConfig & { command: string } {
  return getTransportKind(config) === 'stdio';
}

/** Type guard: true for websocket / http agents with a non-empty URL. */
export function isRemoteConfig(
  config: AgentConfig
): config is AgentConfig & { url: string } {
  const kind = getTransportKind(config);
  return (
    (kind === 'websocket' || kind === 'http') &&
    typeof config.url === 'string' &&
    config.url.length > 0
  );
}


// ---------------------------------------------------------------------------
// MCP servers
// ---------------------------------------------------------------------------

/**
 * Transport kinds for an MCP server.
 *
 * Every ACP agent must support `stdio`; `http` and `sse` are only legal when
 * the agent advertises them in `agentCapabilities.mcpCapabilities` during
 * `initialize`, which is why `toWireMcpServers` takes those capabilities.
 */
export type McpTransportKind = 'stdio' | 'http' | 'sse';

/**
 * How an MCP server is stored in `agents.json`. A superset of the ACP wire
 * shape: `description` and `enabled` are ours and never leave the app.
 */
export interface McpServerConfig {
  /** Optional for backward compatibility; omitted means stdio. */
  transport?: McpTransportKind;

  // ----- stdio fields -----
  command?: string;
  args?: string[];
  env?: Record<string, string>;

  // ----- http / sse fields -----
  url?: string;
  headers?: Record<string, string>;

  /** Free-text note shown in Settings. */
  description?: string;
  /** Parked servers stay configured but are not offered to sessions. */
  enabled?: boolean;
}

/** Agent-advertised MCP support, from `initialize`. */
export interface McpCapabilities {
  http?: boolean;
  sse?: boolean;
}

/** `{name, value}` pair — the shape ACP uses for both env vars and headers. */
interface NameValue {
  name: string;
  value: string;
}

/** An entry as it goes out in `session/new` / `session/load`. */
export type WireMcpServer =
  | { name: string; command: string; args: string[]; env: NameValue[] }
  | { type: 'http' | 'sse'; name: string; url: string; headers: NameValue[] };

/** Returns the effective transport kind for an MCP server config. */
export function getMcpTransportKind(config: McpServerConfig): McpTransportKind {
  return config.transport ?? 'stdio';
}

/** ACP wants `[{name, value}]` where the config stores a plain object. */
function toNameValues(record: Record<string, string> | undefined): NameValue[] {
  return Object.entries(record ?? {}).map(([name, value]) => ({ name, value }));
}

/**
 * Convert stored MCP server configs into ACP wire entries.
 *
 * Drops disabled servers, entries missing the field their transport requires,
 * and http/sse entries the agent has not said it supports — sending one of
 * those is a protocol violation, and agents are entitled to fail the whole
 * `session/new` over it rather than skip the offending entry.
 *
 * Returns the entries plus the names of anything skipped, so the caller can
 * say so out loud instead of leaving the user wondering why their server
 * never showed up.
 */
export function toWireMcpServers(
  servers: Record<string, McpServerConfig>,
  capabilities?: McpCapabilities
): { wire: WireMcpServer[]; skipped: string[] } {
  const wire: WireMcpServer[] = [];
  const skipped: string[] = [];

  for (const [name, config] of Object.entries(servers)) {
    if (config.enabled === false) continue;

    const kind = getMcpTransportKind(config);

    if (kind === 'stdio') {
      if (!config.command) {
        skipped.push(`${name} (no command)`);
        continue;
      }
      wire.push({
        name,
        command: config.command,
        args: config.args ?? [],
        env: toNameValues(config.env),
      });
      continue;
    }

    if (!config.url) {
      skipped.push(`${name} (no url)`);
      continue;
    }
    if (!capabilities?.[kind]) {
      skipped.push(`${name} (agent does not support MCP over ${kind})`);
      continue;
    }
    wire.push({
      type: kind,
      name,
      url: config.url,
      headers: toNameValues(config.headers),
    });
  }

  return { wire, skipped };
}

export interface AgentInstance {
  id: string;
  name: string;
}

export interface AgentMessage {
  agent_id: string;
  message: string;
}

export interface AgentStderr {
  agent_id: string;
  line: string;
}

export interface AgentClosed {
  agent_id: string;
  /** Exit status, or null when the agent was killed deliberately by us. */
  exit_code: number | null;
  /** Last stderr lines before the exit — the diagnosis for a failed spawn. */
  stderr_tail: string[];
}

export interface SavedSession {
  id: string;
  agentName: string;
  sessionId: string;
  title: string;
  lastUpdated: number;
  cwd: string;
  supportsLoadSession?: boolean; // Whether the agent supports session/load
}

export interface ToolCallInfo {
  toolCallId: string;
  title: string;
  kind: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  locations?: { path: string }[];
}

export interface PermissionRequest {
  sessionId: string;
  toolCall: ToolCallInfo;
  options: PermissionOption[];
}

export interface PermissionOption {
  kind: string;
  name: string;
  optionId: string;
}

// Session Modes
export interface SessionMode {
  id: string;
  name: string;
  description?: string;
}

export interface SessionModeState {
  currentModeId: string;
  availableModes: SessionMode[];
}

// Slash Commands
export interface SlashCommand {
  name: string;
  description: string;
  hint?: string;
  /**
   * The tool's own JSON Schema, when the agent carried one across. Turns the
   * invocation row's free-text parameter line into a real form; absent, the
   * row falls back to `hint` and behaves exactly as it always has.
   */
  inputSchema?: JsonSchema;
}

/**
 * Dig a tool's `inputSchema` out of an `AvailableCommand`'s `_meta`.
 *
 * ACP's only argument shape is a single free-text hint, so the schema travels
 * in `_meta` — the protocol's own extensibility point. See
 * docs/agent-integration.md for the convention this reads.
 *
 * Read in two places, namespaced first: an agent that wants to publish schemas
 * without adopting our namespace should not have to. Anything that is not a
 * plain object is treated as absent rather than as an error — this is
 * untrusted input from another process, and a malformed schema must cost the
 * user a form, never the command itself.
 */
export function toolSchemaFromMeta(meta: unknown): JsonSchema | undefined {
  if (!meta || typeof meta !== 'object') return undefined;
  const bag = meta as Record<string, unknown>;

  const namespaced = bag['python-acp/tool'];
  if (namespaced && typeof namespaced === 'object') {
    const schema = (namespaced as Record<string, unknown>).inputSchema;
    if (schema && typeof schema === 'object' && !Array.isArray(schema)) {
      return schema as JsonSchema;
    }
  }

  const bare = bag.inputSchema;
  if (bare && typeof bare === 'object' && !Array.isArray(bare)) {
    return bare as JsonSchema;
  }
  return undefined;
}

// Models
export interface ModelInfo {
  modelId: string;
  name: string;
  description?: string;
}
