<script setup lang="ts">
import SettingsPreferences from './settings/SettingsPreferences.vue';
import SettingsAgents from './settings/SettingsAgents.vue';
import SettingsMcp from './settings/SettingsMcp.vue';
import '../assets/settings.css';

const props = withDefaults(
  defineProps<{
    /** The agent the main page has selected, used to seed the Agents column. */
    selectedAgent?: string;
  }>(),
  { selectedAgent: '' }
);

const emit = defineEmits<{
  (e: 'close'): void;
}>();
</script>

<template>
  <div class="st-overlay" @click.self="emit('close')">
    <div class="st-panel">
      <div class="st-header">
        <h2>Settings</h2>
        <button class="st-close" @click="emit('close')">✕</button>
      </div>

      <div class="st-columns">
        <SettingsPreferences />
        <SettingsAgents :initial-agent="props.selectedAgent" />
        <SettingsMcp />
      </div>
    </div>
  </div>
</template>
