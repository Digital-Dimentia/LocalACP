<script setup lang="ts">
import ToolCallLine from '../ToolCallLine.vue';
import type { ToolCallEntry } from '../../../lib/timeline';

defineProps<{ entry: ToolCallEntry }>();
</script>

<template>
  <div class="tool-call-row">
    <ToolCallLine :tool-call="entry.toolCall" />
  </div>
</template>

<style scoped>
/* The row only supplies the transcript's gutter and spacing; the line itself
   is drawn by ToolCallLine so it matches the nested copies exactly. */
.tool-call-row {
  margin: 0 2rem 0.25rem 0;
}
</style>
