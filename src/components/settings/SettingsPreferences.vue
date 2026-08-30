<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useConfigStore } from '../../stores/config';
import {
  loadKvStore,
  hasLogFile,
  getDebugLogging,
  setDebugLogging,
  getLogPath,
  revealLogFile,
} from '../../lib/host';
import { setDebugForwarding } from '../../lib/logger';
import { setTelemetryEnabled, TELEMETRY_ENABLED_KEY } from '../../lib/telemetry';
import { approvalStyle, setApprovalStyle, type ApprovalStyle } from '../../lib/approvals';
import {
  loadThemePreference,
  setThemePreference,
  type ThemePreference,
} from '../../lib/theme';
import InfoPopover from './InfoPopover.vue';

const configStore = useConfigStore();

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
// Approvals
// ---------------------------------------------------------------------------

const APPROVAL_OPTIONS: { value: ApprovalStyle; label: string }[] = [
  { value: 'inline', label: 'In the conversation' },
  { value: 'modal', label: 'Blocking dialog' },
];

// Seeded from the module's live value, which App.vue loads at startup.
const approvals = ref<ApprovalStyle>(approvalStyle.value);

async function handleApprovalStyleChange(): Promise<void> {
  try {
    await setApprovalStyle(approvals.value);
  } catch (e) {
    console.error('Failed to update approval style preference:', e);
    // Snap back so the control never claims a setting that was not stored.
    approvals.value = approvalStyle.value;
  }
}

// ---------------------------------------------------------------------------
// Privacy / telemetry
// ---------------------------------------------------------------------------

// Mirrors the stored preference. Telemetry is opt-in, so the checkbox starts
// unchecked for anyone who has never turned it on.
const telemetryOn = ref(false);

async function handleTelemetryToggle(): Promise<void> {
  // setTelemetryEnabled persists the choice and starts or tears down the SDK,
  // so the change takes effect now rather than at next launch.
  try {
    await setTelemetryEnabled(telemetryOn.value);
  } catch (e) {
    console.error('Failed to update telemetry preference:', e);
  }
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
</script>

<template>
  <div class="st-column">
    <div class="st-column-header">
      <h3>Preferences</h3>
    </div>

    <section class="st-pref">
      <h4 class="st-pref-title">
        Appearance
        <InfoPopover label="Appearance">
          System follows your operating system's appearance setting. Light and
          Dark override it for this app only, on this device.
        </InfoPopover>
      </h4>
      <div class="st-radios st-radios-inline" role="radiogroup" aria-label="Theme">
        <label v-for="option in THEME_OPTIONS" :key="option.value" class="st-radio">
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
    </section>

    <section class="st-pref">
      <h4 class="st-pref-title">
        Approvals
        <InfoPopover label="Approvals">
          Where an agent's request to run a tool appears. In the conversation
          puts the request and its buttons in line with the transcript, and
          leaves a record of what you allowed; the composer is blocked and a
          banner points back at the request until you answer. The blocking
          dialog covers the window instead, which is harder to overlook but
          leaves nothing behind once dismissed.
        </InfoPopover>
      </h4>
      <div class="st-radios" role="radiogroup" aria-label="Approval style">
        <label v-for="option in APPROVAL_OPTIONS" :key="option.value" class="st-radio">
          <input
            type="radio"
            name="approval-style"
            :value="option.value"
            v-model="approvals"
            @change="handleApprovalStyleChange"
          />
          <span>{{ option.label }}</span>
        </label>
      </div>
    </section>

    <section class="st-pref">
      <h4 class="st-pref-title">
        Privacy
        <InfoPopover label="Privacy">
          Off by default. When on, ACP UI reports app launches, agent names, and
          session events (created, resumed, prompt sent, disconnected) plus
          error reports to Azure Application Insights, tagged with a random
          install ID. Prompt text, agent output, and file contents are never
          sent. Turning this off stops collection immediately; anything already
          queued is sent as the reporter shuts down.
        </InfoPopover>
      </h4>
      <label class="st-check">
        <input type="checkbox" v-model="telemetryOn" @change="handleTelemetryToggle" />
        <span>Send anonymous usage data</span>
      </label>
    </section>

    <section v-if="logsAvailable" class="st-pref">
      <h4 class="st-pref-title">
        Diagnostics
        <InfoPopover label="Diagnostics">
          App events, agent launches and errors are always written to the log
          file. Debug logging adds verbose detail, including the output agents
          print on stderr — which can contain prompt text and file paths, so it
          stays off until you turn it on. The change applies immediately; the
          file is kept on this device and never uploaded.
        </InfoPopover>
      </h4>
      <label class="st-check">
        <input type="checkbox" v-model="debugLogging" @change="handleDebugLoggingToggle" />
        <span>Enable debug logging</span>
      </label>
      <p v-if="logPath" class="st-path">{{ logPath }}</p>
      <p v-if="logError" class="st-error">{{ logError }}</p>
      <button class="st-btn" @click="handleRevealLog">Show Log File</button>
    </section>

    <section class="st-pref">
      <h4 class="st-pref-title">
        Config File
        <InfoPopover label="Config File">
          Agents and MCP servers are stored here. Changes to this file are
          automatically reloaded.
        </InfoPopover>
      </h4>
      <p class="st-path">{{ configStore.configPath }}</p>
    </section>
  </div>
</template>
