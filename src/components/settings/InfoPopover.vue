<script setup lang="ts">
import { ref, onBeforeUnmount, watch, nextTick } from 'vue';

const props = defineProps<{
  /** Names what the copy is about, for screen readers: "About Privacy". */
  label: string;
}>();

const open = ref(false);
const root = ref<HTMLElement | null>(null);
const trigger = ref<HTMLButtonElement | null>(null);

// The left settings column is narrow on purpose, so the explanatory copy that
// used to sit inline lives behind this affordance. It opens on click rather
// than hover: a native `title` tooltip is unreachable by touch and awkward by
// keyboard, and some of this copy is security-relevant (what telemetry sends,
// that debug logs can contain prompt text).
function toggle() {
  open.value = !open.value;
}

function close(refocus = false) {
  if (!open.value) return;
  open.value = false;
  if (refocus) trigger.value?.focus();
}

function onDocumentPointerDown(e: PointerEvent) {
  if (!root.value?.contains(e.target as Node)) close();
}

function onDocumentKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') close(true);
}

watch(open, async (isOpen) => {
  if (isOpen) {
    // Registered on the next tick so the click that opened the popover does
    // not immediately close it again.
    await nextTick();
    document.addEventListener('pointerdown', onDocumentPointerDown);
    document.addEventListener('keydown', onDocumentKeydown);
  } else {
    document.removeEventListener('pointerdown', onDocumentPointerDown);
    document.removeEventListener('keydown', onDocumentKeydown);
  }
});

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown);
  document.removeEventListener('keydown', onDocumentKeydown);
});
</script>

<template>
  <span ref="root" class="info-popover">
    <button
      ref="trigger"
      type="button"
      class="info-trigger"
      :aria-label="`About ${props.label}`"
      :aria-expanded="open"
      @click="toggle"
    >
      i
    </button>
    <span v-if="open" class="info-bubble" role="note">
      <slot />
    </span>
  </span>
</template>

<style scoped>
.info-popover {
  position: relative;
  display: inline-block;
  vertical-align: middle;
}

.info-trigger {
  width: 1.1rem;
  height: 1.1rem;
  padding: 0;
  border-radius: 999px;
  border: 1px solid var(--border-color);
  background: transparent;
  color: var(--text-muted);
  font-size: 0.7rem;
  font-style: italic;
  font-weight: 700;
  line-height: 1;
  cursor: pointer;
}

.info-trigger:hover,
.info-trigger[aria-expanded='true'] {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.info-bubble {
  position: absolute;
  top: calc(100% + 0.35rem);
  left: 0;
  z-index: 10;
  display: block;
  width: max-content;
  max-width: 22rem;
  padding: 0.6rem 0.7rem;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--bg-main);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.25);
  font-size: 0.75rem;
  font-weight: 400;
  line-height: 1.45;
  color: var(--text-secondary);
  white-space: normal;
}

.info-bubble :deep(code) {
  background: var(--bg-sidebar);
  padding: 0.05rem 0.25rem;
  border-radius: 3px;
}
</style>
