<script setup lang="ts">
import { renderMarkdown } from '../../../lib/markdown';
import type { UserEntry } from '../../../lib/timeline';

defineProps<{ entry: UserEntry }>();
</script>

<template>
  <div class="tl-row row-user">
    <div class="tl-row-header">
      <span class="tl-role">You</span>
    </div>
    <div class="tl-content" v-html="renderMarkdown(entry.content)" />
  </div>
</template>

<style scoped>
.row-user {
  background: var(--bg-user, #e3f2fd);
  margin-left: 2rem;
}
</style>
