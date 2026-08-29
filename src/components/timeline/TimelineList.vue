<script setup lang="ts">
import { rowComponents } from './registry';
import type { TimelineEntry } from '../../lib/timeline';

defineProps<{ entries: TimelineEntry[] }>();

// Row-level actions bubble up as domain events. Rows that do not emit them
// (prose, notices) simply never fire — the listeners cost nothing.
const emit = defineEmits<{
  'resolve-permission': [optionId: string];
  'cancel-permission': [];
}>();
</script>

<template>
  <component
    :is="rowComponents[entry.type]"
    v-for="entry in entries"
    :key="entry.id"
    :entry="entry"
    @resolve="emit('resolve-permission', $event)"
    @cancel="emit('cancel-permission')"
  />
</template>

<!-- Unscoped on purpose: these rules are shared by every row component and
     are `tl-` prefixed to stay out of the rest of the app's way. -->
<style>
@import './timeline.css';
</style>
