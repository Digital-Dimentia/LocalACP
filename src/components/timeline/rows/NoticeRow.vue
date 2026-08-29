<script setup lang="ts">
import type { NoticeEntry } from '../../../lib/timeline';

defineProps<{ entry: NoticeEntry }>();

const icons: Record<NoticeEntry['level'], string> = {
  info: 'ℹ️',
  warning: '⚠️',
  error: '⛔',
};
</script>

<template>
  <div :class="['notice-row', `notice-${entry.level}`]" role="status">
    <span class="notice-icon">{{ icons[entry.level] }}</span>
    <span class="notice-text">{{ entry.content }}</span>
  </div>
</template>

<style scoped>
.notice-row {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  margin: 0 2rem 0.75rem 0;
  padding: 0.5rem 0.75rem;
  border-radius: 4px;
  font-size: 0.8rem;
  border-left: 2px solid var(--border-color);
  background: rgba(0, 0, 0, 0.04);
}

.notice-warning {
  border-left-color: #f59e0b;
  background: rgba(245, 158, 11, 0.08);
}

.notice-error {
  border-left-color: #ef4444;
  background: rgba(239, 68, 68, 0.08);
}

.notice-text {
  overflow-wrap: break-word;
}
</style>
