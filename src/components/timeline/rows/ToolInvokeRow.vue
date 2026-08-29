<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { renderMarkdown } from '../../../lib/markdown';
import { invocationLine, type ToolInvokeEntry } from '../../../lib/timeline';

const props = defineProps<{
  entry: ToolInvokeEntry;
  /** False while a turn is in flight or an approval is outstanding. */
  canRun?: boolean;
}>();

const emit = defineEmits<{
  'update-params': [params: string];
  run: [];
  acknowledge: [];
}>();

const input = ref<HTMLInputElement | null>(null);

const hasRun = computed(() => props.entry.runCount > 0);
const isRunning = computed(() => props.entry.state === 'running');
const hasResult = computed(() => (props.entry.result ?? '').length > 0);
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
  margin: 0 2rem 1rem 0;
  padding: 0.75rem;
  border-radius: 8px;
  border: 1px solid var(--border-color, #e0e0e0);
  border-left: 4px solid var(--text-accent, #0066cc);
  background: var(--bg-assistant, #f5f5f5);
}

.invoke-header {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
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
  padding: 0.5rem 0.625rem;
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
  min-height: 36px;
  padding: 0.5rem 1rem;
  border: none;
  border-radius: 4px;
  background: var(--bg-primary, #0066cc);
  color: #fff;
  font-size: 0.875rem;
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

.result {
  margin-top: 0.625rem;
  padding-top: 0.5rem;
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
  margin-top: 0.5rem;
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

  .run-btn {
    min-height: 44px;
  }
}
</style>
