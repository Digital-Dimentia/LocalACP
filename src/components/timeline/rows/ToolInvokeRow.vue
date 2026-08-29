<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import ToolCallLine from '../ToolCallLine.vue';
import ToolParamForm from '../ToolParamForm.vue';
import PermissionRow from './PermissionRow.vue';
import { renderMarkdown } from '../../../lib/markdown';
import {
  requiredKeys,
  toInvocationLine,
  validate,
  type FormValues,
} from '../../../lib/schema-form';
import {
  invocationLine,
  permissionOutcomeLabel,
  type PermissionEntry,
  type ToolInvokeEntry,
} from '../../../lib/timeline';

const props = defineProps<{
  entry: ToolInvokeEntry;
  /** False while a turn is in flight or an approval is outstanding. */
  canRun?: boolean;
}>();

const emit = defineEmits<{
  'update-params': [params: string];
  'update-values': [values: FormValues];
  'update-mode': [mode: 'form' | 'raw'];
  run: [];
  acknowledge: [];
  // Forwarded from a nested approval, so the store answers it by the same
  // path as a free-standing one.
  resolve: [optionId: string];
  cancel: [];
}>();

const input = ref<HTMLInputElement | null>(null);

// A schema with fields is the only thing that earns a form. One that parsed to
// nothing but a list of conditional keywords still matters — it is why this
// row is showing a text box — but it has nothing to render.
const hasForm = computed(() => (props.entry.form?.fields.length ?? 0) > 0);
const showForm = computed(() => hasForm.value && props.entry.mode === 'form');

// Named so the row can say which keyword defeated it rather than shrugging.
const unsupported = computed(() => props.entry.form?.unsupported ?? []);

const required = computed(() =>
  props.entry.form ? requiredKeys(props.entry.form, props.entry.values) : new Set<string>()
);

// Validation is a courtesy to the user, not a gate the agent relies on: the
// same call typed by hand into the raw box goes straight through, and the
// agent checks it on arrival either way.
const errors = computed(() =>
  showForm.value && props.entry.form ? validate(props.entry.form, props.entry.values) : {}
);
const errorCount = computed(() => Object.keys(errors.value).length);

const hasRun = computed(() => props.entry.runCount > 0);
const isRunning = computed(() => props.entry.state === 'running');
const hasResult = computed(() => (props.entry.result ?? '').length > 0);

const calls = computed(() => props.entry.toolCalls);

// An unanswered request is never folded into the collapsible list and never
// abbreviated: it is the one thing in this row that is waiting on a person.
const pendingPermissions = computed(() =>
  props.entry.permissions.filter((p) => p.state === 'pending')
);

// Answered ones collapse onto the call they gated, keyed by the id both carry.
const decisions = computed(() => {
  const byToolCall = new Map<string, string>();
  for (const permission of props.entry.permissions) {
    if (permission.state === 'pending' || !permission.toolCallId) continue;
    byToolCall.set(permission.toolCallId, permissionOutcomeLabel(permission));
  }
  return byToolCall;
});

// An approval whose call never appeared in this run has nothing to collapse
// onto, so it keeps a line of its own rather than vanishing.
const orphanDecisions = computed(() =>
  props.entry.permissions.filter(
    (p) =>
      p.state !== 'pending' &&
      !calls.value.some((c) => c.toolCallId === p.toolCallId)
  )
);

/**
 * The run's approval outcome, shown in the header where it cannot be folded.
 *
 * The per-line badges live inside the collapsible list, which closes itself as
 * soon as the run is answered — so on their own they hid the decision exactly
 * when there was one to read. This is the copy that is always visible.
 */
const decisionSummary = computed(() => {
  const answered = props.entry.permissions.filter((p) => p.state !== 'pending');
  if (answered.length === 0) return undefined;
  const labels = answered.map(permissionOutcomeLabel);
  // A refusal is never averaged away by whatever else was allowed.
  if (labels.includes('Rejected')) return 'Rejected';
  return new Set(labels).size === 1 ? labels[0] : 'Mixed';
});

function decisionFor(toolCallId: string): string | undefined {
  return decisions.value.get(toolCallId);
}

function orphanLabel(permission: PermissionEntry): string {
  return `${permissionOutcomeLabel(permission)} · ${permission.request.toolCall.title}`;
}
const failedCount = computed(
  () => calls.value.filter((c) => c.status === 'failed').length
);

// Expanded while the run is in flight so progress is visible, then folded away
// once the answer is in — the actions were the means, the result is the point.
// Anything that failed stays open: a folded failure is a silent one.
const callsExpanded = ref(false);
watch(
  () => props.entry.state,
  (state) => {
    if (state === 'running') callsExpanded.value = true;
    else if (state === 'answered' && failedCount.value === 0) callsExpanded.value = false;
  }
);

const callsSummary = computed(() => {
  const total = calls.value.length;
  const noun = total === 1 ? 'tool call' : 'tool calls';
  return failedCount.value > 0
    ? `${total} ${noun}, ${failedCount.value} failed`
    : `${total} ${noun}`;
});
// Exactly what Run will send, assembled by the same function the store uses.
const preview = computed(() => invocationLine(props.entry));

// Once a run has produced calls the line rides along on the first of them, so
// the standalone copy is redundant — until the parameters are edited, at which
// point what the row would send differs from what it ran, and that is exactly
// when the assembled line is worth seeing again.
const showPreview = computed(
  () => calls.value.length === 0 || preview.value !== props.entry.lastRunLine
);

const blocked = computed(() => props.canRun === false || errorCount.value > 0);

function submit() {
  if (blocked.value) return;
  emit('run');
}

/**
 * Leaving the form for the raw line is free; coming back is not.
 *
 * The form's values are the truth on the way out and the line is regenerated
 * from them, so a line edited by hand has nowhere to go. Reparsing it would be
 * guesswork on a format built for a parser in another language — asking is the
 * honest option, and losing a hand-written line silently is the one outcome
 * worth preventing.
 */
function setMode(mode: 'form' | 'raw') {
  if (mode === props.entry.mode) return;
  if (mode === 'form' && props.entry.params !== generatedLine.value) {
    const ok = window.confirm(
      'The parameters were edited by hand. Switching back to the form will replace them with what the form holds. Continue?'
    );
    if (!ok) return;
  }
  emit('update-mode', mode);
  if (mode === 'form') emit('update-values', { ...props.entry.values });
}

onMounted(() => {
  // The row is created mid-keystroke, straight out of the command palette, so
  // typing must continue into the parameter line without reaching for it.
  if (!hasRun.value) input.value?.focus();
});

// The parameters the form's own values assemble to. Compared against
// `entry.params` this is the only way to know whether the line still came from
// the form or was since typed over by hand.
const generatedLine = computed(() => {
  if (!props.entry.form) return props.entry.params;
  const line = toInvocationLine(props.entry.command, props.entry.form, props.entry.values);
  const space = line.indexOf(' ');
  return space === -1 ? '' : line.slice(space + 1);
});
</script>

<template>
  <div class="invoke-row">
    <div class="invoke-header">
      <span class="wrench">🔧</span>
      <span class="command">/{{ entry.command }}</span>
      <span v-if="entry.description" class="description">{{ entry.description }}</span>
      <span class="header-right">
        <!-- The escape hatch is always visible, not tucked behind a failure:
             a schema can describe a call the form cannot express, and finding
             that out should not mean hunting for the text box. -->
        <span v-if="hasForm" class="mode-toggle" role="group" aria-label="Parameter editor">
          <button
            type="button"
            :class="['mode-btn', { active: entry.mode === 'form' }]"
            :aria-pressed="entry.mode === 'form'"
            @click="setMode('form')"
          >
            Form
          </button>
          <button
            type="button"
            :class="['mode-btn', { active: entry.mode === 'raw' }]"
            :aria-pressed="entry.mode === 'raw'"
            @click="setMode('raw')"
          >
            Raw
          </button>
        </span>
        <span
          v-if="decisionSummary"
          :class="['tl-badge', `tl-badge-${decisionSummary.toLowerCase()}`]"
        >
          {{ decisionSummary }}
        </span>
        <span v-if="hasRun" class="run-count" :title="`Run ${entry.runCount} time(s)`">
          ×{{ entry.runCount }}
        </span>
      </span>
    </div>

    <!-- Named rather than merely absent. A form that quietly did not appear
         is indistinguishable from one that was never built. -->
    <p v-if="unsupported.length" class="unsupported">
      This tool's schema is conditional ({{ unsupported.join(', ') }}), so its parameters
      cannot be shown as a form. The line below goes to the agent as typed.
    </p>

    <div v-if="showForm" class="invoke-form">
      <ToolParamForm
        :form="entry.form!"
        :values="entry.values"
        :required="required"
        :errors="errors"
        :disabled="canRun === false"
        :autofocus="!hasRun"
        @update:values="emit('update-values', $event)"
      />
    </div>

    <div class="invoke-body">
      <input
        v-if="!showForm"
        ref="input"
        class="params"
        type="text"
        :value="entry.params"
        :placeholder="entry.hint || 'parameters'"
        spellcheck="false"
        autocapitalize="off"
        autocomplete="off"
        :aria-label="`Parameters for /${entry.command}`"
        @input="emit('update-params', ($event.target as HTMLInputElement).value)"
        @keydown.enter.prevent="submit"
      />
      <span v-else class="form-status">
        {{ errorCount > 0 ? `${errorCount} field(s) need attention` : 'Ready' }}
      </span>
      <button class="run-btn" :disabled="blocked" @click="submit">
        {{ hasRun ? 'Re-run' : 'Run' }}
      </button>
    </div>

    <!-- What gets sent, spelled out: a line builder that hides its output is
         one more thing to second-guess. Once the run has produced calls the
         line rides along on the first of them instead, which is where you are
         already looking and costs no row of its own. -->
    <code v-if="showForm || showPreview" class="preview">{{ preview }}</code>

    <!-- What the run did, kept with the run that did it. -->
    <div v-if="calls.length" class="calls">
      <button
        class="calls-toggle"
        :aria-expanded="callsExpanded"
        @click="callsExpanded = !callsExpanded"
      >
        <span class="calls-chevron">{{ callsExpanded ? '▾' : '▸' }}</span>
        <span :class="['calls-summary', { 'has-failure': failedCount > 0 }]">
          {{ callsSummary }}
        </span>
      </button>
      <div v-if="callsExpanded" class="calls-list">
        <ToolCallLine
          v-for="(call, index) in calls"
          :key="call.toolCallId"
          :tool-call="call"
          :decision="decisionFor(call.toolCallId)"
          :detail="index === 0 ? preview : undefined"
        />
        <div
          v-for="permission in orphanDecisions"
          :key="permission.id"
          class="orphan-decision"
        >
          🔐 {{ orphanLabel(permission) }}
        </div>
      </div>
    </div>

    <!-- Outside the collapsible list on purpose: an unanswered approval must
         not be foldable, and it gates the composer until it is answered. -->
    <PermissionRow
      v-for="permission in pendingPermissions"
      :key="permission.id"
      :entry="permission"
      @resolve="emit('resolve', $event)"
      @cancel="emit('cancel')"
    />

    <!-- The answer belongs to the call that asked for it. Clicking the result
         marks it seen; by the time it lands the row may be well above the
         fold, so until then it says so. -->
    <div
      v-if="isRunning || hasResult"
      :class="['result', { 'is-unread': entry.unread }]"
      @click="entry.unread && emit('acknowledge')"
    >
      <div class="result-header">
        <span v-if="entry.unread" class="unread-dot" aria-hidden="true">●</span>
        <span class="result-label">{{ isRunning ? 'Running…' : 'Result' }}</span>
        <span v-if="entry.unread" class="unread-hint">new — click to dismiss</span>
      </div>
      <div v-if="hasResult" class="tl-content result-body" v-html="renderMarkdown(entry.result ?? '')" />
    </div>
  </div>
</template>

<style scoped>
.invoke-row {
  margin: 0 2rem var(--tl-row-gap) 0;
  padding: var(--tl-card-pad-y) var(--tl-card-pad-x);
  border-radius: 8px;
  border: 1px solid var(--border-color, #e0e0e0);
  border-left: 4px solid var(--text-accent, #0066cc);
  background: var(--bg-assistant, #f5f5f5);
}

.invoke-header {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  margin-bottom: var(--tl-header-gap);
}

.command {
  font-family: 'Consolas', 'Monaco', monospace;
  font-weight: 600;
  font-size: 0.9rem;
}

.description {
  flex: 1;
  min-width: 0;
  font-size: 0.75rem;
  color: var(--text-muted, #666);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* One group so the trailing items stay right-aligned whether or not the
   command has a description to absorb the slack. */
.header-right {
  display: flex;
  align-items: baseline;
  gap: 0.375rem;
  margin-left: auto;
}

.run-count {
  font-size: 0.75rem;
  color: var(--text-muted, #666);
}

.invoke-body {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.invoke-form {
  margin-bottom: 0.5rem;
}

.form-status {
  flex: 1;
  min-width: 0;
  font-size: 0.75rem;
  color: var(--text-muted, #666);
}

.mode-toggle {
  display: inline-flex;
  border: 1px solid var(--border-color, #ccc);
  border-radius: 4px;
  overflow: hidden;
}

.mode-btn {
  padding: 0.0625rem 0.4375rem;
  border: none;
  background: transparent;
  color: var(--text-muted, #666);
  font-family: inherit;
  font-size: 0.7rem;
  cursor: pointer;
}

.mode-btn.active {
  background: var(--bg-primary, #0066cc);
  color: #fff;
}

.unsupported {
  margin: 0 0 0.375rem;
  font-size: 0.75rem;
  color: var(--text-muted, #666);
}

.params {
  flex: 1;
  min-width: 0;
  padding: 0.25rem 0.5rem;
  border: 1px solid var(--border-color, #ccc);
  border-radius: 4px;
  background: var(--bg-main, #fff);
  color: var(--text-primary, #333);
  font-family: 'Consolas', 'Monaco', monospace;
  font-size: 0.85rem;
}

.params:focus {
  outline: none;
  border-color: var(--text-accent, #0066cc);
}

.run-btn {
  min-width: 88px;
  min-height: var(--tl-control-h);
  padding: var(--tl-control-pad);
  border: none;
  border-radius: 4px;
  background: var(--bg-primary, #0066cc);
  color: #fff;
  font-size: 0.8125rem;
  font-weight: 500;
  cursor: pointer;
}

.run-btn:hover:not(:disabled) {
  background: var(--bg-primary-hover, #0052a3);
}

.run-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.calls {
  margin-top: 0.375rem;
}

.calls-toggle {
  display: flex;
  align-items: baseline;
  gap: 0.375rem;
  width: 100%;
  padding: 0.25rem 0;
  border: none;
  background: transparent;
  color: var(--text-muted, #666);
  font-family: inherit;
  font-size: 0.75rem;
  text-align: left;
  cursor: pointer;
}

.calls-chevron {
  font-size: 0.65rem;
}

.calls-summary {
  font-weight: 500;
}

.calls-summary.has-failure {
  color: #ef4444;
}

.calls-list {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  padding-top: 0.25rem;
}

/* The nested approval keeps its own card, but not the transcript gutter it
   would use standing on its own. */
.invoke-row :deep(.permission-row) {
  margin: 0.4375rem 0 0 0;
}

.orphan-decision {
  padding: 0.375rem 0.625rem;
  border-radius: 4px;
  border-left: 2px solid var(--border-color);
  background: rgba(0, 0, 0, 0.04);
  font-size: 0.8rem;
  color: var(--text-muted, #666);
}

.result {
  margin-top: 0.4375rem;
  padding-top: 0.375rem;
  border-top: 1px solid var(--border-color, #e0e0e0);
}

.result.is-unread {
  cursor: pointer;
}

.result-header {
  display: flex;
  align-items: baseline;
  gap: 0.375rem;
  margin-bottom: 0.25rem;
}

.result-label {
  font-size: 0.7rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-muted, #666);
}

.is-unread .result-label {
  color: var(--text-accent, #0066cc);
}

.unread-dot {
  font-size: 0.6rem;
  color: var(--text-accent, #0066cc);
}

.unread-hint {
  font-size: 0.7rem;
  font-style: italic;
  color: var(--text-muted, #999);
}

.result-body {
  font-size: 0.9rem;
}

.preview {
  display: block;
  margin-top: 0.25rem;
  font-family: 'Consolas', 'Monaco', monospace;
  font-size: 0.75rem;
  color: var(--text-muted, #666);
  word-break: break-all;
}

@media (max-width: 800px) {
  .invoke-row {
    margin-right: 0;
  }

  .params {
    /* Avoid iOS auto-zoom on focus when font-size < 16px. */
    font-size: 16px;
  }
}
</style>
