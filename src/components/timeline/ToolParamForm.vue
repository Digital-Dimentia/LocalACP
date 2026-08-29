<script setup lang="ts">
// A tool's parameters, rendered from its JSON Schema.
//
// This component knows nothing about ACP or about sending anything. It renders
// what `parseSchema` described and hands values back up; the row above turns
// those into the command line. Keeping the assembly out of here is what lets
// the preview stay literally what gets sent.

import { onMounted, ref } from 'vue';
import type { FormField, FormValue, FormValues, SchemaForm } from '../../lib/schema-form';

const props = defineProps<{
  form: SchemaForm;
  values: FormValues;
  /** Which keys are mandatory right now — `dependentRequired` moves this. */
  required: Set<string>;
  errors: Record<string, string>;
  disabled?: boolean;
  /** The row opens mid-keystroke out of the palette; typing must continue. */
  autofocus?: boolean;
}>();

const root = ref<HTMLDivElement | null>(null);

onMounted(() => {
  if (!props.autofocus) return;
  // Whichever control the first field turned out to need — the form is
  // generated, so the row above cannot know which element to reach for.
  root.value?.querySelector<HTMLElement>('.control')?.focus();
});

const emit = defineEmits<{ 'update:values': [values: FormValues] }>();

/** Every edit replaces the whole map, so the store writes values and line together. */
function set(key: string, value: FormValue) {
  emit('update:values', { ...props.values, [key]: value });
}

function text(key: string): string {
  const value = props.values[key];
  return typeof value === 'string' ? value : '';
}

function checked(key: string): boolean {
  return props.values[key] === true;
}

/** A checkbox nobody has touched is unset, which is not the same as `false`. */
function isUnset(key: string): boolean {
  return props.values[key] === undefined;
}

function rows(key: string): string[] {
  const value = props.values[key];
  return Array.isArray(value) ? value : [];
}

function setRow(key: string, index: number, value: string) {
  const next = [...rows(key)];
  next[index] = value;
  set(key, next);
}

function addRow(key: string) {
  set(key, [...rows(key), '']);
}

function removeRow(key: string, index: number) {
  const next = [...rows(key)];
  next.splice(index, 1);
  set(key, next);
}

/** The item control of a list, with a usable fallback for a bare list. */
function itemOf(field: FormField): FormField {
  return field.item ?? { key: field.key, label: field.label, control: 'text', required: false };
}

function placeholderFor(field: FormField): string {
  if (field.control === 'json') {
    return field.type === 'array' ? '["one", "two"]' : '{"a": 1}';
  }
  return field.type ?? '';
}
</script>

<template>
  <div ref="root" class="param-form">
    <div v-for="field in form.fields" :key="field.key" class="field">
      <label class="field-label" :for="`f-${field.key}`">
        <span class="field-name">{{ field.label }}</span>
        <span v-if="required.has(field.key)" class="req" aria-label="required">*</span>
        <span v-if="field.type" class="field-type">{{ field.type }}</span>
      </label>

      <!-- Enums are the reason this component exists: the legal values are in
           the schema, so the user picks one instead of spelling it. -->
      <select
        v-if="field.control === 'select'"
        :id="`f-${field.key}`"
        class="control"
        :value="text(field.key)"
        :disabled="disabled"
        @change="set(field.key, ($event.target as HTMLSelectElement).value)"
      >
        <option v-if="!required.has(field.key)" value="">— not sent —</option>
        <option v-for="option in field.options" :key="option.value" :value="option.value">
          {{ option.label }}
        </option>
      </select>

      <div v-else-if="field.control === 'checkbox'" class="check-row">
        <input
          :id="`f-${field.key}`"
          type="checkbox"
          :checked="checked(field.key)"
          :disabled="disabled"
          @change="set(field.key, ($event.target as HTMLInputElement).checked)"
        />
        <span class="check-state">
          {{ isUnset(field.key) ? 'not sent' : String(checked(field.key)) }}
        </span>
        <button
          v-if="!isUnset(field.key) && !required.has(field.key)"
          type="button"
          class="ghost-btn"
          :disabled="disabled"
          @click="set(field.key, undefined)"
        >
          clear
        </button>
      </div>

      <!-- A repeated flag is how the far end spells an array, so a list is a
           stack of ordinary rows rather than a comma-separated string the
           user has to escape by hand. -->
      <div v-else-if="field.control === 'list'" class="list">
        <div v-for="(row, index) in rows(field.key)" :key="index" class="list-row">
          <select
            v-if="itemOf(field).options"
            class="control"
            :value="row"
            :disabled="disabled"
            @change="setRow(field.key, index, ($event.target as HTMLSelectElement).value)"
          >
            <option
              v-for="option in itemOf(field).options"
              :key="option.value"
              :value="option.value"
            >
              {{ option.label }}
            </option>
          </select>
          <input
            v-else
            class="control"
            :type="itemOf(field).control === 'number' ? 'number' : 'text'"
            :value="row"
            :disabled="disabled"
            spellcheck="false"
            @input="setRow(field.key, index, ($event.target as HTMLInputElement).value)"
          />
          <button
            type="button"
            class="ghost-btn"
            :disabled="disabled"
            :aria-label="`Remove ${field.label} entry ${index + 1}`"
            @click="removeRow(field.key, index)"
          >
            ✕
          </button>
        </div>
        <button type="button" class="ghost-btn add" :disabled="disabled" @click="addRow(field.key)">
          + add {{ field.label }}
        </button>
      </div>

      <textarea
        v-else-if="field.control === 'textarea' || field.control === 'json'"
        :id="`f-${field.key}`"
        :class="['control', { mono: field.control === 'json' }]"
        rows="3"
        :value="text(field.key)"
        :placeholder="placeholderFor(field)"
        :disabled="disabled"
        spellcheck="false"
        @input="set(field.key, ($event.target as HTMLTextAreaElement).value)"
      ></textarea>

      <input
        v-else
        :id="`f-${field.key}`"
        class="control"
        :type="field.control === 'number' ? 'number' : (field.inputType ?? 'text')"
        :value="text(field.key)"
        :placeholder="field.description ? '' : placeholderFor(field)"
        :min="field.min"
        :max="field.max"
        :step="field.step"
        :disabled="disabled"
        spellcheck="false"
        autocapitalize="off"
        autocomplete="off"
        @input="set(field.key, ($event.target as HTMLInputElement).value)"
      />

      <p v-if="errors[field.key]" class="field-error">{{ errors[field.key] }}</p>
      <p v-else-if="field.description" class="field-help">{{ field.description }}</p>
    </div>
  </div>
</template>

<style scoped>
.param-form {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 0.1875rem;
}

.field-label {
  display: flex;
  align-items: baseline;
  gap: 0.375rem;
}

.field-name {
  font-family: 'Consolas', 'Monaco', monospace;
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--text-primary, #333);
}

.req {
  font-size: 0.78rem;
  color: #ef4444;
}

.field-type {
  font-size: 0.68rem;
  color: var(--text-muted, #888);
}

.control {
  width: 100%;
  padding: 0.25rem 0.5rem;
  border: 1px solid var(--border-color, #ccc);
  border-radius: 4px;
  background: var(--bg-main, #fff);
  color: var(--text-primary, #333);
  font-family: inherit;
  font-size: 0.85rem;
}

textarea.control {
  resize: vertical;
}

.control.mono {
  font-family: 'Consolas', 'Monaco', monospace;
  font-size: 0.8rem;
}

.control:focus {
  outline: none;
  border-color: var(--text-accent, #0066cc);
}

.control:disabled {
  opacity: 0.6;
}

.check-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.check-state {
  font-family: 'Consolas', 'Monaco', monospace;
  font-size: 0.78rem;
  color: var(--text-muted, #666);
}

.list {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.list-row {
  display: flex;
  gap: 0.25rem;
}

.ghost-btn {
  padding: 0.125rem 0.5rem;
  border: 1px solid var(--border-color, #ccc);
  border-radius: 4px;
  background: transparent;
  color: var(--text-muted, #666);
  font-family: inherit;
  font-size: 0.75rem;
  cursor: pointer;
}

.ghost-btn:hover:not(:disabled) {
  border-color: var(--text-accent, #0066cc);
  color: var(--text-accent, #0066cc);
}

.ghost-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.add {
  align-self: flex-start;
}

.field-error {
  margin: 0;
  font-size: 0.72rem;
  color: #ef4444;
}

.field-help {
  margin: 0;
  font-size: 0.72rem;
  color: var(--text-muted, #888);
}

@media (max-width: 800px) {
  /* Avoid iOS auto-zoom on focus when font-size < 16px. */
  .control {
    font-size: 16px;
  }
}
</style>
