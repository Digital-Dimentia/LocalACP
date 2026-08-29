<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { toolKindIcon } from '../../../lib/tool-icons';
import { isAllowOption, isAlwaysOption, type PermissionEntry } from '../../../lib/timeline';
import { approvalStyle } from '../../../lib/approvals';

const props = defineProps<{ entry: PermissionEntry }>();

const emit = defineEmits<{
  resolve: [optionId: string];
  cancel: [];
}>();

const root = ref<HTMLElement | null>(null);

const isPending = computed(() => props.entry.state === 'pending');

// When the user has chosen the modal, the row still appears — it is the
// transcript's record — but the buttons live in the dialog. Two live copies of
// the same request could be answered twice.
const isInteractive = computed(() => isPending.value && approvalStyle.value === 'inline');
const toolCall = computed(() => props.entry.request.toolCall);

// What the decision was, phrased for the transcript rather than for a button.
const outcomeLabel = computed(() => {
  if (props.entry.state === 'cancelled') return 'Cancelled';
  return props.entry.chosenName ?? 'Answered';
});

const outcomeAllowed = computed(
  () => props.entry.state === 'resolved' && isAllowOption(props.entry.chosenKind ?? '')
);

onMounted(() => {
  if (!isPending.value) return;
  // Move the viewport and the keyboard to the request. The container takes
  // focus, never a button: nothing should be pre-armed such that a stray
  // Enter grants access the user never read.
  root.value?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  if (isInteractive.value) root.value?.focus({ preventScroll: true });
});
</script>

<template>
  <div
    ref="root"
    :class="['permission-row', isPending ? 'is-pending' : 'is-decided']"
    tabindex="-1"
    role="group"
    :aria-label="isPending ? 'Permission required' : 'Permission decision'"
  >
    <div class="permission-header">
      <span class="lock">{{ isPending ? '🔐' : (outcomeAllowed ? '✅' : '🚫') }}</span>
      <span class="headline">
        {{ isPending ? 'Permission required' : outcomeLabel }}
      </span>
      <span class="tool-kind">{{ toolKindIcon(toolCall.kind) }} {{ toolCall.kind }}</span>
    </div>

    <div class="permission-body">
      <div class="tool-title">{{ toolCall.title }}</div>
      <div
        v-for="(loc, index) in toolCall.locations ?? []"
        :key="index"
        class="tl-path location"
      >
        📁 {{ loc.path }}
      </div>
    </div>

    <div v-if="isInteractive" class="permission-actions">
      <button
        v-for="option in entry.request.options"
        :key="option.optionId"
        :class="[
          'option-btn',
          isAllowOption(option.kind) ? 'option-allow' : 'option-deny',
          { 'option-always': isAlwaysOption(option.kind) },
        ]"
        :title="isAlwaysOption(option.kind) ? 'Applies to every future request of this kind in this session' : undefined"
        @click="emit('resolve', option.optionId)"
      >
        {{ option.name }}
        <span v-if="isAlwaysOption(option.kind)" class="always-marker" aria-hidden="true">∞</span>
      </button>
      <button class="option-btn option-cancel" @click="emit('cancel')">Cancel</button>
    </div>

    <div v-else-if="isPending" class="awaiting-dialog">
      Waiting for your answer in the permission dialog…
    </div>
  </div>
</template>

<style scoped>
.permission-row {
  margin: 0 2rem 1rem 0;
  padding: 0.75rem;
  border-radius: 8px;
  border: 1px solid var(--border-color, #e0e0e0);
  background: var(--bg-assistant, #f5f5f5);
}

/* A pending request has to read as a stop, not as another log line — it is
   the one row in the transcript that is waiting on the user. */
.permission-row.is-pending {
  border-color: #f59e0b;
  border-left-width: 4px;
  background: rgba(245, 158, 11, 0.08);
}

.permission-row.is-pending:focus {
  outline: 2px solid #f59e0b;
  outline-offset: 2px;
}

.permission-row.is-decided {
  opacity: 0.85;
  font-size: 0.9em;
}

.permission-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
}

.headline {
  font-weight: 600;
  font-size: 0.9rem;
}

.tool-kind {
  margin-left: auto;
  font-size: 0.75rem;
  color: var(--text-muted, #666);
  text-transform: capitalize;
}

.permission-body {
  margin-bottom: 0.75rem;
}

.tool-title {
  font-weight: 500;
  overflow-wrap: break-word;
}

.location {
  padding: 0.125rem 0;
}

.is-decided .permission-actions {
  display: none;
}

.awaiting-dialog {
  font-size: 0.8rem;
  color: var(--text-muted, #666);
  font-style: italic;
}

.permission-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.option-btn {
  flex: 1;
  min-width: 120px;
  min-height: 36px;
  padding: 0.5rem 0.875rem;
  border: none;
  border-radius: 4px;
  font-size: 0.875rem;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.15s;
}

.option-allow {
  background: var(--bg-success, #28a745);
  color: white;
}

.option-allow:hover {
  background: var(--bg-success-hover, #218838);
}

/* Deny is the default-safe answer, so it must never be the quiet option. */
.option-deny {
  background: var(--bg-danger, #dc3545);
  color: white;
}

.option-deny:hover {
  background: var(--bg-danger-hover, #c82333);
}

/* Choices that outlive this single call are marked so a persistent grant is
   never made by accident. */
.option-always {
  border: 2px dashed rgba(255, 255, 255, 0.6);
}

.always-marker {
  margin-left: 0.25rem;
  font-weight: 700;
}

.option-cancel {
  flex: 0 0 auto;
  min-width: 88px;
  border: 1px solid var(--border-color, #ccc);
  background: var(--bg-button, #fff);
  color: var(--text-primary, #333);
  font-weight: 400;
}

.option-cancel:hover {
  background: var(--bg-hover, #f0f0f0);
}

@media (max-width: 800px) {
  .permission-row {
    margin-right: 0;
  }

  .option-btn {
    min-height: 44px;
  }
}
</style>
