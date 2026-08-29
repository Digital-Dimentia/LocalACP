<script setup lang="ts">
import { toolKindIcon, toolStatusIcon } from '../../../lib/tool-icons';
import type { ToolCallEntry } from '../../../lib/timeline';

defineProps<{ entry: ToolCallEntry }>();
</script>

<template>
  <div :class="['tool-call-row', `tool-${entry.toolCall.status}`]">
    <span class="tool-icon">{{ toolKindIcon(entry.toolCall.kind) }}</span>
    <span class="tool-name">{{ entry.toolCall.title }}</span>
    <span v-if="entry.toolCall.locations?.length" class="tl-path tool-location">
      {{ entry.toolCall.locations[0].path }}
    </span>
    <span :class="['tool-status', `status-${entry.toolCall.status}`]">
      {{ toolStatusIcon(entry.toolCall.status) }}
    </span>
  </div>
</template>

<style scoped>
/* Tool calls sit tighter than prose rows: they are a log line, not a message,
   and a run of them should read as a block. */
.tool-call-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin: 0 2rem 0.25rem 0;
  padding: 0.375rem 0.625rem;
  border-radius: 4px;
  font-size: 0.8rem;
  background: rgba(0, 0, 0, 0.04);
  border-left: 2px solid var(--border-color);
}

.tool-pending { border-left-color: #f59e0b; }

.tool-in_progress {
  border-left-color: #3b82f6;
  background: rgba(59, 130, 246, 0.08);
}

.tool-completed {
  border-left-color: #10b981;
  background: rgba(16, 185, 129, 0.08);
}

.tool-failed {
  border-left-color: #ef4444;
  background: rgba(239, 68, 68, 0.08);
}

.tool-icon {
  font-size: 0.875rem;
}

.tool-name {
  font-weight: 500;
  color: var(--text-primary);
}

.tool-location {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tool-status {
  font-size: 0.75rem;
  font-weight: 600;
}

.status-pending { color: #f59e0b; }
.status-in_progress { color: #3b82f6; }
.status-completed { color: #10b981; }
.status-failed { color: #ef4444; }
</style>
