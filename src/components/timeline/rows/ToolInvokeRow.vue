<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import ToolCallLine from '../ToolCallLine.vue';
import PermissionRow from './PermissionRow.vue';
import { renderMarkdown } from '../../../lib/markdown';
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
  run: [];
  acknowledge: [];
  // Forwarded from a nested approval, so the store answers it by the same
  // path as a free-standing one.
  resolve: [optionId: string];
  cancel: [];
}>();

const input = ref<HTMLInputElement | null>(null);

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

function submit() {
  if (props.canRun === false) return;
  emit('run');
}

onMounted(() => {
  // The row is created mid-keystroke, straight out of the command palette, so
  // typing must continue into the parameter line without reaching for it.
  if (!hasRun.value) input.value?.focus();
});
</script>

<template>
  <div class="invoke-row">
    <div class="invoke-header">
      <span class="wrench">🔧</span>
      <span class="command">/{{ entry.command }}</span>
      <span v-if="entry.description" class="description">{{ entry.description }}</span>
      <span v-if="hasRun" class="run-count" :title="`Run ${entry.runCount} time(s)`">
        ×{{ entry.runCount }}
      </span>
    </div>

    <div class="invoke-body">
      <input
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
      <button class="run-btn" :disabled="canRun === false" @click="submit">
        {{ hasRun ? 'Re-run' : 'Run' }}
      </button>
    </div>

    <!-- What gets sent, spelled out. The row is a line builder, and a builder
         that hides its output is one more thing to second-guess. -->
    <code class="preview">{{ preview }}</code>

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
          v-for="call in calls"
          :key="call.toolCallId"
          :tool-call="call"
          :decision="decisionFor(call.toolCallId)"
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
  font-size: 0.75rem;
  color: var(--text-muted, #666);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.run-count {
  margin-left: auto;
  font-size: 0.75rem;
  color: var(--text-muted, #666);
}

.invoke-body {
  display: flex;
  gap: 0.5rem;
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
