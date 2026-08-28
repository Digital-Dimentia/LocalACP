<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useConfigStore } from '../stores/config';
import {
  addAgent,
  removeAgent,
  updateAgent,
  loadKvStore,
  hasLogFile,
  getDebugLogging,
  setDebugLogging,
  getLogPath,
  revealLogFile,
  addMcpServer,
  updateMcpServer,
  removeMcpServer,
} from '../lib/host';
import { setDebugForwarding } from '../lib/logger';
import { setTelemetryEnabled, TELEMETRY_ENABLED_KEY } from '../lib/telemetry';
import {
  loadThemePreference,
  setThemePreference,
  type ThemePreference,
} from '../lib/theme';
import {
  getTransportKind,
  getMcpTransportKind,
  type AgentTransportKind,
  type McpTransportKind,
} from '../lib/types';
import { restrictedTransports } from '../lib/platform';
import EnvVarEditor from './EnvVarEditor.vue';

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const configStore = useConfigStore();

interface AgentRow {
  name: string;
  transport: AgentTransportKind;
  command: string;
  args: string;
  env: Record<string, string>;
  url: string;
  headers: Record<string, string>;
}

// True on iOS / Android / web: hide the stdio option in the form, and
// filter stdio agents out of the list entirely (they can't run there
// anyway).
const restricted = restrictedTransports();

const agents = computed<AgentRow[]>(() => {
  const entries = Object.entries(configStore.config.agents);
  // On restricted hosts (mobile / web), hide stdio agents entirely. They
  // can't run there (no subprocess), and showing them with a disabled
  // Edit button just creates confusion. The raw entries remain in the
  // config so a desktop sync round-trips them losslessly.
  const filtered = restricted
    ? entries.filter(([, c]) => getTransportKind(c) !== 'stdio')
    : entries;
  return filtered.map(([name, config]) => ({
    name,
    transport: getTransportKind(config),
    command: config.command ?? '',
    args: (config.args ?? []).join(' '),
    env: config.env ?? {},
    url: config.url ?? '',
    headers: config.headers ?? {},
  }));
});

// Form state
const showAddForm = ref(false);
const editingAgent = ref<string | null>(null);
const formName = ref('');
const formTransport = ref<AgentTransportKind>(restricted ? 'websocket' : 'stdio');
const formCommand = ref('');
const formArgs = ref('');
const formEnv = ref<Record<string, string>>({});
const formUrl = ref('');
const formHeaders = ref<Record<string, string>>({});
const formError = ref('');
const isSubmitting = ref(false);

function resetForm() {
  formName.value = '';
  formTransport.value = restricted ? 'websocket' : 'stdio';
  formCommand.value = '';
  formArgs.value = '';
  formEnv.value = {};
  formUrl.value = '';
  formHeaders.value = {};
  formError.value = '';
  showAddForm.value = false;
  editingAgent.value = null;
}

function startAdd() {
  resetForm();
  showAddForm.value = true;
}

function startEdit(agent: AgentRow) {
  resetForm();
  editingAgent.value = agent.name;
  formName.value = agent.name;
  formTransport.value = agent.transport;
  formCommand.value = agent.command;
  formArgs.value = agent.args;
  formEnv.value = { ...agent.env };
  formUrl.value = agent.url;
  formHeaders.value = { ...agent.headers };
}

function parseArgs(argsString: string): string[] {
  // Simple arg parsing - split on spaces but respect quotes
  const args: string[] = [];
  let current = '';
  let inQuotes = false;
  let quoteChar = '';

  for (const char of argsString) {
    if ((char === '"' || char === "'") && !inQuotes) {
      inQuotes = true;
      quoteChar = char;
    } else if (char === quoteChar && inQuotes) {
      inQuotes = false;
      quoteChar = '';
    } else if (char === ' ' && !inQuotes) {
      if (current.trim()) {
        args.push(current.trim());
      }
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim()) {
    args.push(current.trim());
  }
  return args;
}

async function handleSubmit() {
  formError.value = '';

  if (!formName.value.trim()) {
    formError.value = 'Name is required';
    return;
  }

  // Validate agent name is not purely numeric (JavaScript object key ordering issue)
  if (/^\d+$/.test(formName.value)) {
    formError.value = 'Agent name cannot be purely numeric';
    return;
  }

  const transport = formTransport.value;
  const isRemote = transport !== 'stdio';

  if (isRemote) {
    if (!formUrl.value.trim()) {
      formError.value = 'URL is required for remote agents';
      return;
    }
    const lower = formUrl.value.trim().toLowerCase();
    if (transport === 'websocket' && !(lower.startsWith('ws://') || lower.startsWith('wss://'))) {
      formError.value = 'WebSocket URL must start with ws:// or wss://';
      return;
    }
    if (transport === 'http' && !(lower.startsWith('http://') || lower.startsWith('https://'))) {
      formError.value = 'HTTP URL must start with http:// or https://';
      return;
    }
  } else {
    if (!formCommand.value.trim()) {
      formError.value = 'Command is required';
      return;
    }
  }

  const args = isRemote ? [] : parseArgs(formArgs.value);
  isSubmitting.value = true;

  try {
    const remoteOpts = isRemote
      ? {
          transport: transport as 'websocket' | 'http',
          url: formUrl.value.trim(),
          headers: Object.keys(formHeaders.value).length > 0 ? formHeaders.value : undefined,
        }
      : {};
    const command = isRemote ? null : formCommand.value;
    const env = isRemote ? {} : formEnv.value;

    if (editingAgent.value) {
      const newConfig = await updateAgent(formName.value, command, args, env, remoteOpts);
      configStore.updateFromEvent(newConfig);
    } else {
      // Check for duplicates
      if (configStore.config.agents[formName.value]) {
        formError.value = 'An agent with this name already exists';
        isSubmitting.value = false;
        return;
      }
      const newConfig = await addAgent(formName.value, command, args, env, remoteOpts);
      configStore.updateFromEvent(newConfig);
    }
    resetForm();
  } catch (e) {
    formError.value = e instanceof Error ? e.message : String(e);
  } finally {
    isSubmitting.value = false;
  }
}

async function handleDelete(name: string) {
  if (!confirm(`Delete agent "${name}"?`)) return;

  try {
    const newConfig = await removeAgent(name);
    configStore.updateFromEvent(newConfig);
  } catch (e) {
    console.error('Failed to delete agent:', e);
  }
}

// ---------------------------------------------------------------------------
// MCP servers
// ---------------------------------------------------------------------------

interface McpRow {
  name: string;
  transport: McpTransportKind;
  command: string;
  args: string;
  env: Record<string, string>;
  url: string;
  headers: Record<string, string>;
  description: string;
  enabled: boolean;
}

const mcpServers = computed<McpRow[]>(() =>
  Object.entries(configStore.mcpServers).map(([name, config]) => ({
    name,
    transport: getMcpTransportKind(config),
    command: config.command ?? '',
    args: (config.args ?? []).join(' '),
    env: config.env ?? {},
    url: config.url ?? '',
    headers: config.headers ?? {},
    description: config.description ?? '',
    // Absent means enabled: a hand-written entry should work without the field.
    enabled: config.enabled !== false,
  }))
);

const showMcpForm = ref(false);
const editingMcp = ref<string | null>(null);
const mcpName = ref('');
const mcpTransport = ref<McpTransportKind>('stdio');
const mcpCommand = ref('');
const mcpArgs = ref('');
const mcpEnv = ref<Record<string, string>>({});
const mcpUrl = ref('');
const mcpHeaders = ref<Record<string, string>>({});
const mcpDescription = ref('');
const mcpEnabled = ref(true);
const mcpError = ref('');
const mcpSubmitting = ref(false);

function resetMcpForm() {
  mcpName.value = '';
  mcpTransport.value = 'stdio';
  mcpCommand.value = '';
  mcpArgs.value = '';
  mcpEnv.value = {};
  mcpUrl.value = '';
  mcpHeaders.value = {};
  mcpDescription.value = '';
  mcpEnabled.value = true;
  mcpError.value = '';
  showMcpForm.value = false;
  editingMcp.value = null;
}

function startAddMcp() {
  resetMcpForm();
  showMcpForm.value = true;
}

function startEditMcp(server: McpRow) {
  resetMcpForm();
  editingMcp.value = server.name;
  mcpName.value = server.name;
  mcpTransport.value = server.transport;
  mcpCommand.value = server.command;
  mcpArgs.value = server.args;
  mcpEnv.value = { ...server.env };
  mcpUrl.value = server.url;
  mcpHeaders.value = { ...server.headers };
  mcpDescription.value = server.description;
  mcpEnabled.value = server.enabled;
}

/** Collect the form into the shape `addMcpServer` / `updateMcpServer` take. */
function mcpFormInput() {
  const isRemote = mcpTransport.value !== 'stdio';
  return {
    transport: mcpTransport.value,
    command: isRemote ? undefined : mcpCommand.value.trim(),
    args: isRemote ? [] : parseArgs(mcpArgs.value),
    env: isRemote ? {} : mcpEnv.value,
    url: isRemote ? mcpUrl.value.trim() : undefined,
    headers: isRemote ? mcpHeaders.value : undefined,
    description: mcpDescription.value.trim(),
    enabled: mcpEnabled.value,
  };
}

async function handleMcpSubmit() {
  mcpError.value = '';

  const name = mcpName.value.trim();
  if (!name) {
    mcpError.value = 'Name is required';
    return;
  }
  // The name is what the agent matches tool invocations against, so it has to
  // survive a JSON object round-trip intact — numeric-looking keys get
  // reordered by JS object semantics.
  if (/^\d+$/.test(name)) {
    mcpError.value = 'Server name cannot be purely numeric';
    return;
  }

  if (mcpTransport.value === 'stdio') {
    if (!mcpCommand.value.trim()) {
      mcpError.value = 'Command is required for stdio servers';
      return;
    }
  } else {
    const lower = mcpUrl.value.trim().toLowerCase();
    if (!lower) {
      mcpError.value = 'URL is required for http/sse servers';
      return;
    }
    if (!lower.startsWith('http://') && !lower.startsWith('https://')) {
      mcpError.value = 'MCP server URL must start with http:// or https://';
      return;
    }
  }

  if (!editingMcp.value && configStore.mcpServers[name]) {
    mcpError.value = 'An MCP server with this name already exists';
    return;
  }

  mcpSubmitting.value = true;
  try {
    const newConfig = editingMcp.value
      ? await updateMcpServer(name, mcpFormInput())
      : await addMcpServer(name, mcpFormInput());
    configStore.updateFromEvent(newConfig);
    resetMcpForm();
  } catch (e) {
    mcpError.value = e instanceof Error ? e.message : String(e);
  } finally {
    mcpSubmitting.value = false;
  }
}

/** Flip `enabled` straight from the list — the common case is parking a
 * server for one session, not editing its command line. */
async function toggleMcpEnabled(server: McpRow) {
  try {
    const config = configStore.mcpServers[server.name];
    if (!config) return;
    const newConfig = await updateMcpServer(server.name, {
      transport: server.transport,
      command: config.command,
      args: config.args,
      env: config.env,
      url: config.url,
      headers: config.headers,
      description: config.description,
      enabled: !server.enabled,
    });
    configStore.updateFromEvent(newConfig);
  } catch (e) {
    console.error('Failed to toggle MCP server:', e);
  }
}

async function handleMcpDelete(name: string) {
  if (!confirm(`Delete MCP server "${name}"?`)) return;
  try {
    const newConfig = await removeMcpServer(name);
    configStore.updateFromEvent(newConfig);
  } catch (e) {
    console.error('Failed to delete MCP server:', e);
  }
}

// ---------------------------------------------------------------------------
// Appearance
// ---------------------------------------------------------------------------

// Read synchronously: unlike the telemetry preference this one lives in
// localStorage precisely so it can be applied before first paint, so there is
// nothing to await here (see src/lib/theme.ts).
const theme = ref<ThemePreference>(loadThemePreference());

const THEME_OPTIONS: ReadonlyArray<{ value: ThemePreference; label: string }> = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

function handleThemeChange(): void {
  // Applies to the live document and persists in one step, so the change is
  // visible behind the Settings dialog immediately.
  setThemePreference(theme.value);
}

// ---------------------------------------------------------------------------
// Diagnostics / logging
// ---------------------------------------------------------------------------

// Hidden entirely on hosts with no log file (the browser build).
const logsAvailable = hasLogFile();

const debugLogging = ref(false);
const logPath = ref<string | null>(null);
const logError = ref<string | null>(null);

async function handleDebugLoggingToggle(): Promise<void> {
  try {
    await setDebugLogging(debugLogging.value);
    // Keep the console forwarder in step, otherwise the frontend half of the
    // pipeline would keep dropping debug records until the next launch.
    setDebugForwarding(debugLogging.value);
    logError.value = null;
  } catch (e) {
    // Put the checkbox back where it was: the preference did not stick.
    debugLogging.value = !debugLogging.value;
    logError.value = e instanceof Error ? e.message : String(e);
  }
}

async function handleRevealLog(): Promise<void> {
  try {
    await revealLogFile();
    logError.value = null;
  } catch (e) {
    // Most often the file does not exist yet because nothing has been logged.
    logError.value = e instanceof Error ? e.message : String(e);
  }
}

// ---------------------------------------------------------------------------
// Privacy / telemetry
// ---------------------------------------------------------------------------

// Mirrors the stored preference. Telemetry is opt-in, so the checkbox starts
// unchecked for anyone who has never turned it on.
const telemetryOn = ref(false);

onMounted(async () => {
  try {
    const prefs = await loadKvStore('preferences.json');
    telemetryOn.value = (await prefs.get<boolean>(TELEMETRY_ENABLED_KEY)) ?? false;
  } catch (e) {
    console.warn('Failed to read telemetry preference:', e);
  }

  if (!logsAvailable) return;
  try {
    debugLogging.value = await getDebugLogging();
    logPath.value = await getLogPath();
  } catch (e) {
    console.warn('Failed to read logging state:', e);
  }
});

async function handleTelemetryToggle(): Promise<void> {
  // setTelemetryEnabled persists the choice and starts or tears down the SDK,
  // so the change takes effect now rather than at next launch.
  try {
    await setTelemetryEnabled(telemetryOn.value);
  } catch (e) {
    console.error('Failed to update telemetry preference:', e);
  }
}
</script>

<template>
  <div class="settings-overlay" @click.self="emit('close')">
    <div class="settings-panel">
      <div class="settings-header">
        <h2>Settings</h2>
        <button class="close-btn" @click="emit('close')">✕</button>
      </div>

      <div class="settings-content">
        <section class="agents-section">
          <div class="section-header">
            <h3>Agents</h3>
            <button class="add-btn" @click="startAdd" :disabled="showAddForm">
              + Add Agent
            </button>
          </div>

          <!-- Add/Edit Form -->
          <div v-if="showAddForm || editingAgent" class="agent-form">
            <h4>{{ editingAgent ? 'Edit Agent' : 'Add New Agent' }}</h4>

            <div class="form-group">
              <label>Name</label>
              <input
                v-model="formName"
                type="text"
                placeholder="My Agent"
                :disabled="!!editingAgent"
              />
            </div>

            <div class="form-group">
              <label>Transport</label>
              <select v-model="formTransport">
                <option v-if="!restricted" value="stdio">stdio (local subprocess)</option>
                <option value="websocket">websocket (remote)</option>
                <option value="http">http (remote)</option>
              </select>
              <small v-if="restricted">stdio is not available on this platform.</small>
            </div>

            <template v-if="formTransport === 'stdio'">
              <div class="form-group">
                <label>Command</label>
                <input
                  v-model="formCommand"
                  type="text"
                  placeholder="npx"
                />
              </div>

              <div class="form-group">
                <label>Arguments</label>
                <input
                  v-model="formArgs"
                  type="text"
                  placeholder="-y @example/agent"
                />
                <small>Space-separated. Use quotes for args with spaces.</small>
              </div>

              <div class="form-group">
                <EnvVarEditor v-model="formEnv" mask-values />
              </div>
            </template>

            <template v-else>
              <div class="form-group">
                <label>URL</label>
                <input
                  v-model="formUrl"
                  type="text"
                  :placeholder="formTransport === 'websocket' ? 'wss://acp.example.com/v1' : 'https://acp.example.com/v1'"
                />
                <small>
                  {{ formTransport === 'websocket' ? 'WebSocket endpoint (ws:// or wss://)' : 'Streamable HTTP endpoint (http:// or https://)' }}
                </small>
              </div>

              <div class="form-group">
                <label>Headers</label>
                <EnvVarEditor
                  v-model="formHeaders"
                  mask-values
                  label="Headers"
                  empty-text="No headers configured."
                />
                <small>
                  Authorization headers are sent over the connection. Browser WebSocket APIs
                  cannot attach arbitrary HTTP headers; an <code>Authorization: Bearer &lt;token&gt;</code>
                  header is forwarded as a <code>bearer.&lt;token&gt;</code> WebSocket subprotocol.
                  <strong>That subprotocol travels in <code>Sec-WebSocket-Protocol</code>, which
                  proxies and tunnels log far more often than they log
                  <code>Authorization</code></strong> &mdash; avoid pointing a tokened agent at a
                  tunnel whose access logs you do not control. Tokens are stored unencrypted in
                  the agents config file, so treat that file as a secret.
                </small>
              </div>
            </template>

            <div v-if="formError" class="form-error">
              {{ formError }}
            </div>

            <div class="form-actions">
              <button
                class="save-btn"
                @click="handleSubmit"
                :disabled="isSubmitting"
              >
                {{ isSubmitting ? 'Saving...' : 'Save' }}
              </button>
              <button class="cancel-btn" @click="resetForm">
                Cancel
              </button>
            </div>
          </div>

          <!-- Agent List -->
          <div class="agents-list">
            <div
              v-for="agent in agents"
              :key="agent.name"
              class="agent-item"
            >
              <div class="agent-info">
                <div class="agent-name">
                  {{ agent.name }}
                  <span class="agent-transport-badge" :data-kind="agent.transport">{{ agent.transport }}</span>
                </div>
                <div class="agent-command">
                  <code v-if="agent.transport === 'stdio'">{{ agent.command }} {{ agent.args }}</code>
                  <code v-else>{{ agent.url }}</code>
                </div>
              </div>
              <div class="agent-actions">
                <button class="edit-btn" @click="startEdit(agent)">
                  Edit
                </button>
                <button class="delete-btn" @click="handleDelete(agent.name)">
                  Delete
                </button>
              </div>
            </div>

            <div v-if="agents.length === 0" class="no-agents">
              No agents configured. Add one to get started!
            </div>
          </div>
        </section>

        <section class="agents-section">
          <div class="section-header">
            <h3>MCP Servers</h3>
            <button class="add-btn" @click="startAddMcp" :disabled="showMcpForm">
              + Add MCP Server
            </button>
          </div>

          <p class="section-note">
            Offered to every session this app starts, so the agent can call
            their tools. Enabled servers are sent with <code>session/new</code>
            and <code>session/load</code>; the agent launches stdio servers
            itself. These are separate from any MCP servers the agent loads
            from its own config.
          </p>

          <div v-if="showMcpForm || editingMcp" class="agent-form">
            <h4>{{ editingMcp ? 'Edit MCP Server' : 'Add MCP Server' }}</h4>

            <div class="form-group">
              <label>Name</label>
              <input
                v-model="mcpName"
                type="text"
                placeholder="demo"
                :disabled="!!editingMcp"
              />
              <small>The agent identifies the server by this name.</small>
            </div>

            <div class="form-group">
              <label>Transport</label>
              <select v-model="mcpTransport">
                <option value="stdio">stdio (agent launches it)</option>
                <option value="http">http (remote)</option>
                <option value="sse">sse (remote)</option>
              </select>
              <small>
                Every agent supports stdio. http and sse are only sent to
                agents that advertise support for them, and skipped with a
                warning otherwise.
              </small>
            </div>

            <template v-if="mcpTransport === 'stdio'">
              <div class="form-group">
                <label>Command</label>
                <input v-model="mcpCommand" type="text" placeholder="/usr/bin/python3" />
              </div>

              <div class="form-group">
                <label>Arguments</label>
                <input v-model="mcpArgs" type="text" placeholder="/path/to/server.py" />
                <small>Space-separated. Use quotes for args with spaces.</small>
              </div>

              <div class="form-group">
                <EnvVarEditor v-model="mcpEnv" mask-values />
              </div>
            </template>

            <template v-else>
              <div class="form-group">
                <label>URL</label>
                <input v-model="mcpUrl" type="text" placeholder="https://mcp.example.com/v1" />
              </div>

              <div class="form-group">
                <EnvVarEditor
                  v-model="mcpHeaders"
                  mask-values
                  label="Headers"
                  empty-text="No headers configured."
                />
              </div>
            </template>

            <div class="form-group">
              <label>Description</label>
              <input v-model="mcpDescription" type="text" placeholder="What this server provides" />
              <small>Shown here only; never sent to the agent.</small>
            </div>

            <label class="telemetry-toggle">
              <input type="checkbox" v-model="mcpEnabled" />
              <span>Enabled</span>
            </label>

            <small>
              Commands, arguments and environment variables are handed to the
              agent, which launches the server on its own host — so point this
              at servers you trust. They are stored unencrypted in the agents
              config file, so treat that file as a secret when a server needs
              an API token.
            </small>

            <div v-if="mcpError" class="form-error">{{ mcpError }}</div>

            <div class="form-actions">
              <button class="save-btn" @click="handleMcpSubmit" :disabled="mcpSubmitting">
                {{ mcpSubmitting ? 'Saving...' : 'Save' }}
              </button>
              <button class="cancel-btn" @click="resetMcpForm">Cancel</button>
            </div>
          </div>

          <div class="agents-list">
            <div
              v-for="server in mcpServers"
              :key="server.name"
              class="agent-item"
              :class="{ disabled: !server.enabled }"
            >
              <div class="agent-info">
                <div class="agent-name">
                  {{ server.name }}
                  <span class="agent-transport-badge" :data-kind="server.transport">
                    {{ server.transport }}
                  </span>
                  <span v-if="!server.enabled" class="agent-transport-badge">disabled</span>
                </div>
                <div class="agent-command">
                  <code v-if="server.transport === 'stdio'">{{ server.command }} {{ server.args }}</code>
                  <code v-else>{{ server.url }}</code>
                </div>
                <div v-if="server.description" class="agent-command">{{ server.description }}</div>
              </div>
              <div class="agent-actions">
                <button class="edit-btn" @click="toggleMcpEnabled(server)">
                  {{ server.enabled ? 'Disable' : 'Enable' }}
                </button>
                <button class="edit-btn" @click="startEditMcp(server)">Edit</button>
                <button class="delete-btn" @click="handleMcpDelete(server.name)">Delete</button>
              </div>
            </div>

            <div v-if="mcpServers.length === 0" class="no-agents">
              No MCP servers configured. Sessions start with none.
            </div>
          </div>
        </section>

        <section class="config-section">
          <h3>Appearance</h3>
          <div class="theme-options" role="radiogroup" aria-label="Theme">
            <label
              v-for="option in THEME_OPTIONS"
              :key="option.value"
              class="theme-option"
            >
              <input
                type="radio"
                name="theme"
                :value="option.value"
                v-model="theme"
                @change="handleThemeChange"
              />
              <span>{{ option.label }}</span>
            </label>
          </div>
          <small>
            System follows your operating system's appearance setting. Light
            and Dark override it for this app only, on this device.
          </small>
        </section>

        <section class="config-section">
          <h3>Privacy</h3>
          <label class="telemetry-toggle">
            <input
              type="checkbox"
              v-model="telemetryOn"
              @change="handleTelemetryToggle"
            />
            <span>Send anonymous usage data</span>
          </label>
          <small>
            Off by default. When on, ACP UI reports app launches, agent names,
            and session events (created, resumed, prompt sent, disconnected)
            plus error reports to Azure Application Insights, tagged with a
            random install ID. Prompt text, agent output, and file contents are
            never sent. Turning this off stops collection immediately; anything
            already queued is sent as the reporter shuts down.
          </small>
        </section>

        <section v-if="logsAvailable" class="config-section">
          <h3>Diagnostics</h3>
          <label class="telemetry-toggle">
            <input
              type="checkbox"
              v-model="debugLogging"
              @change="handleDebugLoggingToggle"
            />
            <span>Enable debug logging</span>
          </label>
          <small>
            App events, agent launches and errors are always written to the log
            file below. Debug logging adds verbose detail, including the output
            agents print on stderr — which can contain prompt text and file
            paths, so it stays off until you turn it on. The change applies
            immediately; the file is kept on this device and never uploaded.
          </small>
          <p v-if="logPath" class="config-path">{{ logPath }}</p>
          <p v-if="logError" class="log-error">{{ logError }}</p>
          <button class="edit-btn" @click="handleRevealLog">
            Show Log File
          </button>
        </section>

        <section class="config-section">
          <h3>Config File</h3>
          <p class="config-path">{{ configStore.configPath }}</p>
          <small>Changes to this file are automatically reloaded.</small>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.settings-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.agent-transport-badge {
  display: inline-block;
  margin-left: 0.5rem;
  padding: 0.1rem 0.5rem;
  border-radius: 999px;
  font-size: 0.7rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  vertical-align: middle;
  border: 1px solid transparent;
  /* Default (stdio) — emerald to convey "local process". */
  background: #ecfdf5;
  color: #047857;
  border-color: #a7f3d0;
}
.agent-transport-badge[data-kind='websocket'],
.agent-transport-badge[data-kind='http'] {
  background: #e0f2fe;
  color: #0369a1;
  border-color: #bae6fd;
}

.settings-panel {
  background: var(--bg-main);
  border-radius: 8px;
  width: 90%;
  max-width: 600px;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
}

.settings-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1rem 1.25rem;
  border-bottom: 1px solid var(--border-color);
}

.settings-header h2 {
  margin: 0;
  font-size: 1.25rem;
}

.close-btn {
  border: none;
  background: transparent;
  font-size: 1.25rem;
  cursor: pointer;
  color: var(--text-secondary);
  padding: 0.25rem;
}

.close-btn:hover {
  color: var(--text-primary);
}

.settings-content {
  padding: 1.25rem;
  overflow-y: auto;
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 1rem;
}

.section-header h3 {
  margin: 0;
}

.add-btn {
  padding: 0.375rem 0.75rem;
  border: 1px solid var(--bg-primary);
  background: transparent;
  color: var(--bg-primary);
  border-radius: 4px;
  cursor: pointer;
  font-size: 0.875rem;
}

.add-btn:hover:not(:disabled) {
  background: var(--bg-primary);
  color: white;
}

.add-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.agent-form {
  background: var(--bg-sidebar);
  padding: 1rem;
  border-radius: 6px;
  margin-bottom: 1rem;
}

.agent-form h4 {
  margin: 0 0 1rem 0;
  font-size: 1rem;
}

.form-group {
  margin-bottom: 0.75rem;
}

.form-group label {
  display: block;
  font-size: 0.875rem;
  font-weight: 500;
  margin-bottom: 0.25rem;
}

.form-group input {
  width: 100%;
  padding: 0.5rem;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  font-size: 0.9rem;
  background: var(--bg-main);
  color: var(--text-primary);
}

.form-group input:focus {
  outline: none;
  border-color: var(--bg-primary);
}

.form-group small {
  display: block;
  margin-top: 0.25rem;
  font-size: 0.75rem;
  color: var(--text-muted);
}

.form-error {
  color: var(--bg-danger);
  font-size: 0.875rem;
  margin-bottom: 0.75rem;
}

.form-actions {
  display: flex;
  gap: 0.5rem;
}

.save-btn {
  padding: 0.5rem 1rem;
  background: var(--bg-primary);
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
}

.save-btn:hover:not(:disabled) {
  background: var(--bg-primary-hover);
}

.save-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.cancel-btn {
  padding: 0.5rem 1rem;
  background: transparent;
  color: var(--text-secondary);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  cursor: pointer;
}

.cancel-btn:hover {
  background: var(--bg-hover);
}

.agents-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.agent-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem;
  background: var(--bg-sidebar);
  border-radius: 6px;
}

.agent-info {
  flex: 1;
  min-width: 0;
}

.agent-name {
  font-weight: 500;
  margin-bottom: 0.25rem;
}

.agent-command {
  font-size: 0.8rem;
  color: var(--text-muted);
}

.agent-command code {
  background: var(--bg-main);
  padding: 0.125rem 0.375rem;
  border-radius: 3px;
  word-break: break-all;
}

.agent-actions {
  display: flex;
  gap: 0.5rem;
  margin-left: 1rem;
}

.edit-btn,
.delete-btn {
  padding: 0.25rem 0.5rem;
  border-radius: 4px;
  font-size: 0.8rem;
  cursor: pointer;
}

.edit-btn {
  background: transparent;
  border: 1px solid var(--border-color);
  color: var(--text-secondary);
}

.edit-btn:hover {
  background: var(--bg-hover);
}

.delete-btn {
  background: transparent;
  border: 1px solid var(--bg-danger);
  color: var(--bg-danger);
}

.delete-btn:hover {
  background: var(--bg-danger);
  color: white;
}

.no-agents {
  text-align: center;
  padding: 2rem;
  color: var(--text-muted);
}

.config-section {
  margin-top: 1.5rem;
  padding-top: 1.5rem;
  border-top: 1px solid var(--border-color);
}

.config-section h3 {
  margin: 0 0 0.5rem 0;
}

.config-path {
  font-family: monospace;
  font-size: 0.8rem;
  color: var(--text-secondary);
  background: var(--bg-sidebar);
  padding: 0.5rem;
  border-radius: 4px;
  word-break: break-all;
  margin-bottom: 0.25rem;
}

.section-note {
  margin: 0 0 0.75rem;
  font-size: 0.85rem;
  color: var(--text-secondary);
}

.agent-item.disabled .agent-info {
  opacity: 0.55;
}

.log-error {
  margin: 0.5rem 0;
  color: var(--bg-danger);
  font-size: 0.85rem;
}

.theme-options {
  display: flex;
  gap: 1rem;
  margin: 0.25rem 0 0.5rem;
  flex-wrap: wrap;
}
.theme-option {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  cursor: pointer;
  font-size: 0.9rem;
}
.theme-option input {
  cursor: pointer;
}

.telemetry-toggle {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin: 0.25rem 0 0.5rem;
  cursor: pointer;
  font-size: 0.9rem;
}
.telemetry-toggle input {
  cursor: pointer;
}
.config-section small {
  font-size: 0.75rem;
  color: var(--text-muted);
}
</style>
