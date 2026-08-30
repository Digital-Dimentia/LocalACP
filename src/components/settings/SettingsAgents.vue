<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useConfigStore } from '../../stores/config';
import { addAgent, removeAgent, updateAgent } from '../../lib/host';
import { getTransportKind, type AgentTransportKind } from '../../lib/types';
import { restrictedTransports } from '../../lib/platform';
import { parseArgs } from '../../lib/parse-args';
import EnvVarEditor from '../EnvVarEditor.vue';
import InfoPopover from './InfoPopover.vue';

const props = defineProps<{
  /**
   * The agent the main page currently has selected, used only to seed this
   * column's dropdown. Deliberately not a v-model: browsing configs here must
   * not change which agent the next session starts with.
   */
  initialAgent: string;
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
  /** True for a stdio agent on a host that cannot spawn subprocesses. */
  unavailable: boolean;
}

// True on iOS / Android / web, where there is no subprocess to spawn. Stdio
// agents are still listed here — hiding them would strand an agent created on
// desktop with no way to inspect or delete it from a phone — but they are
// flagged as unavailable so it is clear why they do not appear on the main
// page's agent picker.
const restricted = restrictedTransports();

const agents = computed<AgentRow[]>(() =>
  Object.entries(configStore.config.agents).map(([name, config]) => {
    const transport = getTransportKind(config);
    return {
      name,
      transport,
      command: config.command ?? '',
      args: (config.args ?? []).join(' '),
      env: config.env ?? {},
      url: config.url ?? '',
      headers: config.headers ?? {},
      unavailable: restricted && transport === 'stdio',
    };
  })
);

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

const selectedName = ref(props.initialAgent);

const selected = computed<AgentRow | null>(
  () => agents.value.find((a) => a.name === selectedName.value) ?? null
);

// Keep the dropdown pointing at something real: the config file is hot
// reloaded, so an agent can vanish while this panel is open.
watch(
  agents,
  (rows) => {
    if (rows.length === 0) {
      selectedName.value = '';
    } else if (!rows.some((a) => a.name === selectedName.value)) {
      selectedName.value = rows[0].name;
    }
  },
  { immediate: true }
);

// ---------------------------------------------------------------------------
// Form
// ---------------------------------------------------------------------------

/** null when showing the read-only view, 'add' or 'edit' while the form is up. */
const mode = ref<'view' | 'add' | 'edit'>('view');

const formName = ref('');
const formTransport = ref<AgentTransportKind>(restricted ? 'websocket' : 'stdio');
const formCommand = ref('');
const formArgs = ref('');
const formEnv = ref<Record<string, string>>({});
const formUrl = ref('');
const formHeaders = ref<Record<string, string>>({});
const formError = ref('');
const isSubmitting = ref(false);

function cancel() {
  mode.value = 'view';
  formError.value = '';
}

function startAdd() {
  mode.value = 'add';
  formName.value = '';
  formTransport.value = restricted ? 'websocket' : 'stdio';
  formCommand.value = '';
  formArgs.value = '';
  formEnv.value = {};
  formUrl.value = '';
  formHeaders.value = {};
  formError.value = '';
}

function startEdit() {
  const agent = selected.value;
  if (!agent) return;
  mode.value = 'edit';
  formName.value = agent.name;
  formTransport.value = agent.transport;
  formCommand.value = agent.command;
  formArgs.value = agent.args;
  formEnv.value = { ...agent.env };
  formUrl.value = agent.url;
  formHeaders.value = { ...agent.headers };
  formError.value = '';
}

// Switching agents while the form is open would silently discard the edit, so
// drop back to the read-only view instead.
watch(selectedName, () => {
  if (mode.value === 'edit') cancel();
});

async function handleSubmit() {
  formError.value = '';

  const name = formName.value.trim();
  if (!name) {
    formError.value = 'Name is required';
    return;
  }

  // Validate agent name is not purely numeric (JavaScript object key ordering issue)
  if (/^\d+$/.test(name)) {
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

  if (mode.value === 'add' && configStore.config.agents[name]) {
    formError.value = 'An agent with this name already exists';
    return;
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

    const newConfig =
      mode.value === 'edit'
        ? await updateAgent(name, command, args, env, remoteOpts)
        : await addAgent(name, command, args, env, remoteOpts);
    configStore.updateFromEvent(newConfig);
    // Land on whatever was just written, so an added agent is shown rather
    // than leaving the dropdown on the previous one.
    selectedName.value = name;
    mode.value = 'view';
  } catch (e) {
    formError.value = e instanceof Error ? e.message : String(e);
  } finally {
    isSubmitting.value = false;
  }
}

async function handleDelete() {
  const agent = selected.value;
  if (!agent) return;
  if (!confirm(`Delete agent "${agent.name}"?`)) return;

  try {
    const newConfig = await removeAgent(agent.name);
    configStore.updateFromEvent(newConfig);
  } catch (e) {
    console.error('Failed to delete agent:', e);
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
      <h3>Agents</h3>
      <button class="st-btn" @click="startAdd" :disabled="mode === 'add'">+ Add</button>
    </div>

    <div class="st-field">
      <label for="settings-agent-select">Agent</label>
      <select
        id="settings-agent-select"
        class="st-select"
        v-model="selectedName"
        :disabled="mode === 'add' || agents.length === 0"
      >
        <option v-for="agent in agents" :key="agent.name" :value="agent.name">
          {{ agent.name }}{{ agent.unavailable ? ' — unavailable here' : '' }}
        </option>
      </select>
    </div>

    <!-- Add / edit form -->
    <div v-if="mode !== 'view'">
      <div class="st-field">
        <label>Name</label>
        <input
          v-model="formName"
          type="text"
          placeholder="My Agent"
          :disabled="mode === 'edit'"
        />
      </div>

      <div class="st-field">
        <label>Transport</label>
        <select v-model="formTransport">
          <option v-if="!restricted" value="stdio">stdio (local subprocess)</option>
          <option value="websocket">websocket (remote)</option>
          <option value="http">http (remote)</option>
        </select>
        <small v-if="restricted" class="st-hint">
          stdio is not available on this platform.
        </small>
      </div>

      <template v-if="formTransport === 'stdio'">
        <div class="st-field">
          <label>Command</label>
          <input v-model="formCommand" type="text" placeholder="npx" />
        </div>

        <div class="st-field">
          <label>Arguments</label>
          <input v-model="formArgs" type="text" placeholder="-y @example/agent" />
          <small class="st-hint">Space-separated. Use quotes for args with spaces.</small>
        </div>

        <div class="st-field">
          <EnvVarEditor v-model="formEnv" mask-values />
        </div>
      </template>

      <template v-else>
        <div class="st-field">
          <label>URL</label>
          <input
            v-model="formUrl"
            type="text"
            :placeholder="
              formTransport === 'websocket'
                ? 'wss://acp.example.com/v1'
                : 'https://acp.example.com/v1'
            "
          />
          <small class="st-hint">
            {{
              formTransport === 'websocket'
                ? 'WebSocket endpoint (ws:// or wss://)'
                : 'Streamable HTTP endpoint (http:// or https://)'
            }}
          </small>
        </div>

        <div class="st-field">
          <label>
            Headers
            <InfoPopover label="agent headers">
              Authorization headers are sent over the connection. Browser
              WebSocket APIs cannot attach arbitrary HTTP headers; an
              <code>Authorization: Bearer &lt;token&gt;</code> header is
              forwarded as a <code>bearer.&lt;token&gt;</code> WebSocket
              subprotocol. <strong>That subprotocol travels in
              <code>Sec-WebSocket-Protocol</code>, which proxies and tunnels log
              far more often than they log <code>Authorization</code></strong>
              — avoid pointing a tokened agent at a tunnel whose access logs you
              do not control. Tokens are stored unencrypted in the agents config
              file, so treat that file as a secret.
            </InfoPopover>
          </label>
          <EnvVarEditor
            v-model="formHeaders"
            mask-values
            label="Headers"
            empty-text="No headers configured."
          />
        </div>
      </template>

      <div v-if="formError" class="st-error">{{ formError }}</div>

      <div class="st-actions">
        <button class="st-btn-primary" @click="handleSubmit" :disabled="isSubmitting">
          {{ isSubmitting ? 'Saving…' : 'Save' }}
        </button>
        <button class="st-btn" @click="cancel">Cancel</button>
      </div>
    </div>

    <!-- Read-only view -->
    <template v-else-if="selected">
      <dl class="st-readonly">
        <dt>Transport</dt>
        <dd>
          <span class="st-badge" :data-kind="selected.transport">{{ selected.transport }}</span>
          <span v-if="selected.unavailable" class="st-badge" data-kind="off">unavailable</span>
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
      </dl>

      <p v-if="selected.unavailable" class="st-hint">
        This agent runs as a local subprocess, which this platform cannot do, so
        it is not offered on the main page. It is shown here so you can still
        inspect or remove it.
      </p>

      <div class="st-actions">
        <button class="st-btn" @click="startEdit">Edit</button>
        <button class="st-btn-danger" @click="handleDelete">Delete</button>
      </div>
    </template>

    <div v-else class="st-empty">No agents configured. Add one to get started!</div>
  </div>
</template>
