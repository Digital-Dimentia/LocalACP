<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useConfigStore } from '../../stores/config';
import { addMcpServer, updateMcpServer, removeMcpServer } from '../../lib/host';
import { getMcpTransportKind, type McpTransportKind } from '../../lib/types';
import { parseArgs } from '../../lib/parse-args';
import EnvVarEditor from '../EnvVarEditor.vue';
import InfoPopover from './InfoPopover.vue';

const configStore = useConfigStore();

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

const servers = computed<McpRow[]>(() =>
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

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

const selectedName = ref('');

const selected = computed<McpRow | null>(
  () => servers.value.find((s) => s.name === selectedName.value) ?? null
);

// The config file is hot reloaded, so a server can vanish while this panel is
// open. Unlike agents there is no sensible default here — nothing is selected
// until a row is clicked.
watch(servers, (rows) => {
  if (selectedName.value && !rows.some((s) => s.name === selectedName.value)) {
    selectedName.value = '';
  }
});

// ---------------------------------------------------------------------------
// Form
// ---------------------------------------------------------------------------

const mode = ref<'view' | 'add' | 'edit'>('view');

const formName = ref('');
const formTransport = ref<McpTransportKind>('stdio');
const formCommand = ref('');
const formArgs = ref('');
const formEnv = ref<Record<string, string>>({});
const formUrl = ref('');
const formHeaders = ref<Record<string, string>>({});
const formDescription = ref('');
const formEnabled = ref(true);
const formError = ref('');
const isSubmitting = ref(false);

function cancel() {
  mode.value = 'view';
  formError.value = '';
}

function startAdd() {
  mode.value = 'add';
  formName.value = '';
  formTransport.value = 'stdio';
  formCommand.value = '';
  formArgs.value = '';
  formEnv.value = {};
  formUrl.value = '';
  formHeaders.value = {};
  formDescription.value = '';
  formEnabled.value = true;
  formError.value = '';
}

function startEdit() {
  const server = selected.value;
  if (!server) return;
  mode.value = 'edit';
  formName.value = server.name;
  formTransport.value = server.transport;
  formCommand.value = server.command;
  formArgs.value = server.args;
  formEnv.value = { ...server.env };
  formUrl.value = server.url;
  formHeaders.value = { ...server.headers };
  formDescription.value = server.description;
  formEnabled.value = server.enabled;
  formError.value = '';
}

/** Selecting a row is the list's job; it must not throw away an open edit. */
function selectRow(name: string) {
  if (mode.value !== 'view') cancel();
  selectedName.value = selectedName.value === name ? '' : name;
}

/** Collect the form into the shape `addMcpServer` / `updateMcpServer` take. */
function formInput() {
  const isRemote = formTransport.value !== 'stdio';
  return {
    transport: formTransport.value,
    command: isRemote ? undefined : formCommand.value.trim(),
    args: isRemote ? [] : parseArgs(formArgs.value),
    env: isRemote ? {} : formEnv.value,
    url: isRemote ? formUrl.value.trim() : undefined,
    headers: isRemote ? formHeaders.value : undefined,
    description: formDescription.value.trim(),
    enabled: formEnabled.value,
  };
}

async function handleSubmit() {
  formError.value = '';

  const name = formName.value.trim();
  if (!name) {
    formError.value = 'Name is required';
    return;
  }
  // The name is what the agent matches tool invocations against, so it has to
  // survive a JSON object round-trip intact — numeric-looking keys get
  // reordered by JS object semantics.
  if (/^\d+$/.test(name)) {
    formError.value = 'Server name cannot be purely numeric';
    return;
  }

  if (formTransport.value === 'stdio') {
    if (!formCommand.value.trim()) {
      formError.value = 'Command is required for stdio servers';
      return;
    }
  } else {
    const lower = formUrl.value.trim().toLowerCase();
    if (!lower) {
      formError.value = 'URL is required for http/sse servers';
      return;
    }
    if (!lower.startsWith('http://') && !lower.startsWith('https://')) {
      formError.value = 'MCP server URL must start with http:// or https://';
      return;
    }
  }

  if (mode.value === 'add' && configStore.mcpServers[name]) {
    formError.value = 'An MCP server with this name already exists';
    return;
  }

  isSubmitting.value = true;
  try {
    const newConfig =
      mode.value === 'edit'
        ? await updateMcpServer(name, formInput())
        : await addMcpServer(name, formInput());
    configStore.updateFromEvent(newConfig);
    selectedName.value = name;
    mode.value = 'view';
  } catch (e) {
    formError.value = e instanceof Error ? e.message : String(e);
  } finally {
    isSubmitting.value = false;
  }
}

/** Flip `enabled` straight from the list — the common case is parking a
 * server for one session, not editing its command line. */
async function toggleEnabled(server: McpRow) {
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

async function handleDelete() {
  const server = selected.value;
  if (!server) return;
  if (!confirm(`Delete MCP server "${server.name}"?`)) return;
  try {
    const newConfig = await removeMcpServer(server.name);
    configStore.updateFromEvent(newConfig);
  } catch (e) {
    console.error('Failed to delete MCP server:', e);
  }
}

/** Masked stand-in for a secret map, so a read-only view never leaks a token. */
function summarizeSecrets(map: Record<string, string>): string {
  const keys = Object.keys(map);
  if (keys.length === 0) return 'none';
  return `${keys.length} set — ${keys.join(', ')}`;
}
</script>

<template>
  <div class="st-column">
    <div class="st-column-header">
      <h3>
        MCP Servers
        <InfoPopover label="MCP servers">
          Offered to every session this app starts, so the agent can call their
          tools. Enabled servers are sent with <code>session/new</code> and
          <code>session/load</code>; the agent launches stdio servers itself.
          These are separate from any MCP servers the agent loads from its own
          config. Commands, arguments and environment variables are handed to
          the agent, which launches the server on its own host — so point this
          at servers you trust. They are stored unencrypted in the agents config
          file, so treat that file as a secret when a server needs an API token.
        </InfoPopover>
      </h3>
      <button class="st-btn" @click="startAdd" :disabled="mode === 'add'">+ Add</button>
    </div>

    <!-- Name list. The toggle flips enabled in place; the row body selects. -->
    <ul class="mcp-list">
      <li v-for="server in servers" :key="server.name" class="mcp-row">
        <button
          type="button"
          class="mcp-row-name"
          :class="{ selected: server.name === selectedName, off: !server.enabled }"
          :aria-pressed="server.name === selectedName"
          @click="selectRow(server.name)"
        >
          {{ server.name }}
        </button>
        <label class="mcp-toggle" :title="server.enabled ? 'Enabled' : 'Disabled'">
          <input
            type="checkbox"
            :checked="server.enabled"
            :aria-label="`Enable ${server.name}`"
            @change="toggleEnabled(server)"
          />
        </label>
      </li>
      <li v-if="servers.length === 0" class="st-empty">
        No MCP servers configured. Sessions start with none.
      </li>
    </ul>

    <!-- Add / edit form -->
    <div v-if="mode !== 'view'" class="mcp-detail">
      <div class="st-field">
        <label>Name</label>
        <input v-model="formName" type="text" placeholder="demo" :disabled="mode === 'edit'" />
        <small class="st-hint">The agent identifies the server by this name.</small>
      </div>

      <div class="st-field">
        <label>Transport</label>
        <select v-model="formTransport">
          <option value="stdio">stdio (agent launches it)</option>
          <option value="http">http (remote)</option>
          <option value="sse">sse (remote)</option>
        </select>
        <small class="st-hint">
          Every agent supports stdio. http and sse are only sent to agents that
          advertise support for them, and skipped with a warning otherwise.
        </small>
      </div>

      <template v-if="formTransport === 'stdio'">
        <div class="st-field">
          <label>Command</label>
          <input v-model="formCommand" type="text" placeholder="/usr/bin/python3" />
        </div>

        <div class="st-field">
          <label>Arguments</label>
          <input v-model="formArgs" type="text" placeholder="/path/to/server.py" />
          <small class="st-hint">Space-separated. Use quotes for args with spaces.</small>
        </div>

        <div class="st-field">
          <EnvVarEditor v-model="formEnv" mask-values />
        </div>
      </template>

      <template v-else>
        <div class="st-field">
          <label>URL</label>
          <input v-model="formUrl" type="text" placeholder="https://mcp.example.com/v1" />
        </div>

        <div class="st-field">
          <EnvVarEditor
            v-model="formHeaders"
            mask-values
            label="Headers"
            empty-text="No headers configured."
          />
        </div>
      </template>

      <div class="st-field">
        <label>Description</label>
        <input v-model="formDescription" type="text" placeholder="What this server provides" />
        <small class="st-hint">Shown here only; never sent to the agent.</small>
      </div>

      <label class="st-check">
        <input type="checkbox" v-model="formEnabled" />
        <span>Enabled</span>
      </label>

      <div v-if="formError" class="st-error">{{ formError }}</div>

      <div class="st-actions">
        <button class="st-btn-primary" @click="handleSubmit" :disabled="isSubmitting">
          {{ isSubmitting ? 'Saving…' : 'Save' }}
        </button>
        <button class="st-btn" @click="cancel">Cancel</button>
      </div>
    </div>

    <!-- Read-only view -->
    <div v-else-if="selected" class="mcp-detail">
      <dl class="st-readonly">
        <dt>Transport</dt>
        <dd>
          <span class="st-badge" :data-kind="selected.transport">{{ selected.transport }}</span>
          <span v-if="!selected.enabled" class="st-badge" data-kind="off">disabled</span>
        </dd>

        <template v-if="selected.transport === 'stdio'">
          <dt>Command</dt>
          <dd><code>{{ selected.command }}</code></dd>
          <dt>Arguments</dt>
          <dd>
            <code v-if="selected.args">{{ selected.args }}</code>
            <span v-else>none</span>
          </dd>
          <dt>Environment</dt>
          <dd>{{ summarizeSecrets(selected.env) }}</dd>
        </template>

        <template v-else>
          <dt>URL</dt>
          <dd><code>{{ selected.url }}</code></dd>
          <dt>Headers</dt>
          <dd>{{ summarizeSecrets(selected.headers) }}</dd>
        </template>

        <dt>Description</dt>
        <dd>{{ selected.description || 'none' }}</dd>
      </dl>

      <div class="st-actions">
        <button class="st-btn" @click="startEdit">Edit</button>
        <button class="st-btn-danger" @click="handleDelete">Delete</button>
      </div>
    </div>

    <p v-else-if="servers.length > 0" class="st-hint">
      Select a server to see its configuration.
    </p>
  </div>
</template>

<style scoped>
.mcp-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}

.mcp-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.mcp-row-name {
  flex: 1;
  min-width: 0;
  text-align: left;
  padding: 0.35rem 0.5rem;
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
  color: var(--text-primary);
  font-size: 0.85rem;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mcp-row-name:hover {
  background: var(--bg-hover);
}

.mcp-row-name.selected {
  background: var(--bg-sidebar);
  border-color: var(--border-color);
  font-weight: 600;
}

/* A disabled server still needs to be readable — dim it rather than hide it. */
.mcp-row-name.off {
  color: var(--text-muted);
}

.mcp-toggle {
  display: flex;
  align-items: center;
  cursor: pointer;
}

.mcp-toggle input {
  cursor: pointer;
  margin: 0;
}

.mcp-detail {
  margin-top: 0.85rem;
  padding-top: 0.85rem;
  border-top: 1px solid var(--border-color);
}
</style>
