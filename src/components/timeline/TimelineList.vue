<script setup lang="ts">
import { rowComponents } from './registry';
import type { TimelineEntry } from '../../lib/timeline';

const props = defineProps<{
  entries: TimelineEntry[];
  /** False while a turn is in flight or an approval is outstanding. */
  canRun?: boolean;
}>();

// Bound per row rather than spread across all of them: a row that does not
// declare `canRun` would otherwise inherit it as a stray `can-run` attribute
// on its root element.
function rowProps(entry: TimelineEntry) {
  return entry.type === 'tool_invoke'
    ? { entry, canRun: props.canRun }
    : { entry };
}

// Row-level actions bubble up as domain events. Rows that do not emit them
// (prose, notices) simply never fire — the listeners cost nothing.
const emit = defineEmits<{
  'resolve-permission': [optionId: string];
  'cancel-permission': [];
  'update-invoke-params': [id: string, params: string];
  'run-invoke': [id: string];
}>();
</script>

<template>
  <component
    :is="rowComponents[entry.type]"
    v-for="entry in entries"
    :key="entry.id"
    v-bind="rowProps(entry)"
    @resolve="emit('resolve-permission', $event)"
    @cancel="emit('cancel-permission')"
    @update-params="emit('update-invoke-params', entry.id, $event)"
    @run="emit('run-invoke', entry.id)"
  />
</template>

<!-- Unscoped on purpose: these rules are shared by every row component and
     are `tl-` prefixed to stay out of the rest of the app's way. -->
<style>
@import './timeline.css';
</style>
