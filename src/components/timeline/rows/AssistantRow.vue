<script setup lang="ts">
import { ref } from 'vue';
import { renderMarkdown } from '../../../lib/markdown';
import type { AssistantEntry } from '../../../lib/timeline';

defineProps<{ entry: AssistantEntry }>();

// Expansion is per-row view state and dies with the row, so it lives here
// rather than in a set of ids held by the chat view.
const thoughtExpanded = ref(false);
</script>

<template>
  <div class="tl-row row-assistant">
    <div class="tl-row-header">
      <span class="tl-role">Assistant</span>
    </div>

    <!-- Reasoning comes first: it explains the output below it. -->
    <div v-if="entry.thought" class="thought-section">
      <button class="thought-toggle" @click="thoughtExpanded = !thoughtExpanded">
        <span class="thought-icon">💭</span>
        <span class="thought-label">{{ thoughtExpanded ? 'Hide Thinking' : 'Show Thinking' }}</span>
        <span class="thought-chevron">{{ thoughtExpanded ? '▲' : '▼' }}</span>
      </button>
      <div v-if="thoughtExpanded" class="thought-content">
        <div v-html="renderMarkdown(entry.thought)" />
      </div>
    </div>

    <div v-if="entry.content" class="tl-content" v-html="renderMarkdown(entry.content)" />
  </div>
</template>

<style scoped>
.row-assistant {
  background: var(--bg-assistant, #f5f5f5);
  margin-right: 2rem;
}

.thought-section {
  margin-bottom: 0.75rem;
  border: 1px solid var(--border-color, #e0e0e0);
  border-radius: 8px;
  overflow: hidden;
}

.thought-toggle {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  padding: 0.5rem 0.75rem;
  background: var(--bg-hover, #f5f5f5);
  border: none;
  cursor: pointer;
  font-size: 0.85rem;
  color: var(--text-muted, #666);
  text-align: left;
  transition: background 0.15s ease;
}

.thought-toggle:hover {
  background: var(--bg-user, #e3f2fd);
}

.thought-icon {
  font-size: 1rem;
  flex-shrink: 0;
}

.thought-label {
  flex: 1;
  font-weight: 500;
}

.thought-chevron {
  font-size: 0.7rem;
  color: var(--text-muted, #999);
}

.thought-content {
  padding: 0.75rem 1rem 0.75rem 1.25rem;
  background: var(--bg-main, #fafafa);
  border-top: 1px solid var(--border-color, #e0e0e0);
  font-size: 0.9rem;
  color: var(--text-muted, #666);
  font-style: italic;
  line-height: 1.5;
}

.thought-content :deep(p) {
  margin: 0 0 0.5rem 0;
}

.thought-content :deep(p:last-child) {
  margin-bottom: 0;
}

.thought-content :deep(code) {
  background: var(--bg-hover, #f0f0f0);
  padding: 0.125rem 0.25rem;
  border-radius: 3px;
  font-size: 0.85em;
}
</style>
