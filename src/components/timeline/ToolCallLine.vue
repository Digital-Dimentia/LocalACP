<script setup lang="ts">
// One tool call, drawn as a single line.
//
// Shared by `ToolCallRow` (a call the agent made on its own, standing as its
// own row) and by `ToolInvokeRow` (calls made during a run the user started,
// nested inside that row). They are the same thing in two places and must
// look the same in both, so the markup and its styles live here rather than
// being copied into whichever component happens to need them next.

import { toolKindIcon, toolStatusIcon } from '../../lib/tool-icons';
import type { ToolCallInfo } from '../../lib/types';

defineProps<{ toolCall: ToolCallInfo }>();
</script>

<template>
  <div :class="['tool-call-line', `tool-${toolCall.status}`]">
    <span class="tool-icon">{{ toolKindIcon(toolCall.kind) }}</span>
    <span class="tool-name">{{ toolCall.title }}</span>
    <span v-if="toolCall.locations?.length" class="tl-path tool-location">
      {{ toolCall.locations[0].path }}
    </span>
    <span :class="['tool-status', `status-${toolCall.status}`]">
      {{ toolStatusIcon(toolCall.status) }}
    </span>
  </div>
</template>

<style scoped>
/* Tighter than a prose row: a tool call is a log line, not a message, and a
   run of them should read as a block. */
.tool-call-line {
  display: flex;
  align-items: center;
  gap: 0.5rem;
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
