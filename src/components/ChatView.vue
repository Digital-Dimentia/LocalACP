<script setup lang="ts">
import { ref, computed, nextTick, watch } from 'vue';
import { useSessionStore } from '../stores/session';
import { isMobile } from '../lib/platform';
import ModePicker from './ModePicker.vue';
import ModelPicker from './ModelPicker.vue';
import CommandPalette from './CommandPalette.vue';
import TimelineList from './timeline/TimelineList.vue';
import { approvalStyle } from '../lib/approvals';
import type { SlashCommand } from '../lib/types';

const sessionStore = useSessionStore();
const inputText = ref('');
const messagesContainer = ref<HTMLElement | null>(null);
const commandPaletteRef = ref<InstanceType<typeof CommandPalette> | null>(null);

// On mobile (iOS/Android) the soft-keyboard's Return key should insert a
// newline like every other native chat app; submitting is the dedicated
// Send button. On desktop, Enter still submits and Shift+Enter newlines.
const submitOnEnter = !isMobile();

const entries = computed(() => sessionStore.timelineEntries);
const isLoading = computed(() => sessionStore.isLoading);
const isReconnecting = computed(() => sessionStore.isReconnecting);
const currentSession = computed(() => sessionStore.currentSession);
const availableModes = computed(() => sessionStore.availableModes);
const currentModeId = computed(() => sessionStore.currentModeId);
const availableModels = computed(() => sessionStore.availableModels);
const currentModelId = computed(() => sessionStore.currentModelId);
const availableCommands = computed(() => sessionStore.availableCommands);

// An approval the user has not answered. While one is outstanding the composer
// is gated: an inline button, unlike the modal it replaces, can be scrolled
// past, and nothing should let a prompt be queued behind an unanswered grant.
const pendingApproval = computed(() => sessionStore.pendingPermissionEntry);
const awaitingApproval = computed(
  () => pendingApproval.value !== null && approvalStyle.value === 'inline'
);

function scrollToApproval() {
  if (!pendingApproval.value || !messagesContainer.value) return;
  const el = messagesContainer.value.querySelector('.permission-row.is-pending');
  (el as HTMLElement | null)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  (el as HTMLElement | null)?.focus({ preventScroll: true });
}

function handleResolvePermission(optionId: string) {
  sessionStore.resolvePermission(optionId);
}

function handleCancelPermission() {
  sessionStore.cancelPermission();
}

// Slash command state
const showCommandPalette = computed(() => {
  if (availableCommands.value.length === 0) return false;
  const text = inputText.value;
  // Show palette when input starts with "/" and cursor is after it
  if (!text.startsWith('/')) return false;
  // Don't show if there's a space (command already entered)
  const spaceIndex = text.indexOf(' ');
  return spaceIndex === -1;
});

const commandFilter = computed(() => {
  if (!inputText.value.startsWith('/')) return '';
  return inputText.value.slice(1); // Remove the leading "/"
});

// Auto-scroll to bottom when the transcript grows
watch(entries, async () => {
  await nextTick();
  if (messagesContainer.value) {
    messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight;
  }
}, { deep: true });

async function handleSend() {
  const text = inputText.value.trim();
  if (!text || isLoading.value || awaitingApproval.value) return;
  
  inputText.value = '';
  try {
    await sessionStore.sendPrompt(text);
  } catch (e) {
    console.error('Failed to send prompt:', e);
  }
}

function handleKeyDown(event: KeyboardEvent) {
  // Let CommandPalette handle navigation keys when visible
  if (showCommandPalette.value && commandPaletteRef.value) {
    if (['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key)) {
      commandPaletteRef.value.handleKeyDown(event);
      return;
    }
  }

  // Enter-to-send is desktop only. On mobile we let the textarea insert a
  // newline like every other native chat app and require an explicit tap
  // on the Send button.
  if (submitOnEnter && event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    handleSend();
  }
}

function handleCommandSelect(command: SlashCommand) {
  // Replace current input with the command
  if (command.hint) {
    inputText.value = `/${command.name} `;
  } else {
    inputText.value = `/${command.name} `;
  }
}

function handleCommandClose() {
  // Just dismiss, keep the text
}

function handleCancel() {
  sessionStore.cancelOperation();
}

async function handleModeChange(modeId: string) {
  try {
    await sessionStore.setMode(modeId);
  } catch (e) {
    console.error('Failed to change mode:', e);
  }
}

async function handleModelChange(modelId: string) {
  try {
    await sessionStore.setModel(modelId);
  } catch (e) {
    console.error('Failed to change model:', e);
  }
}

</script>

<template>
  <div class="chat-view">
    <div class="chat-header">
      <h2>{{ currentSession?.title || 'Chat' }}</h2>
      <div class="header-right">
        <ModelPicker 
          v-if="availableModels.length > 0"
          :models="availableModels"
          :current-model-id="currentModelId"
          :disabled="isLoading"
          @change="handleModelChange"
        />
        <ModePicker 
          v-if="availableModes.length > 0"
          :modes="availableModes"
          :current-mode-id="currentModeId"
          :disabled="isLoading"
          @change="handleModeChange"
        />
        <span class="agent-name">{{ currentSession?.agentName }}</span>
      </div>
    </div>
    
    <div ref="messagesContainer" class="messages-container">
      <TimelineList
        :entries="entries"
        @resolve-permission="handleResolvePermission"
        @cancel-permission="handleCancelPermission"
      />

      <!-- Loading indicator -->
      <div v-if="isLoading" class="loading-indicator">
        <span class="spinner"></span>
        <span>Thinking...</span>
        <button class="cancel-btn" @click="handleCancel">Cancel</button>
      </div>
    </div>
    
    <!-- The one affordance that keeps an inline approval from being missed:
         it stays put while the transcript scrolls, and takes you back. -->
    <button v-if="awaitingApproval" class="approval-bar" @click="scrollToApproval">
      <span class="approval-bar-icon">🔐</span>
      <span class="approval-bar-text">
        Approval required: {{ pendingApproval?.request.toolCall.title }}
      </span>
      <span class="approval-bar-action">Review →</span>
    </button>

    <div class="input-container">
      <CommandPalette
        ref="commandPaletteRef"
        :commands="availableCommands"
        :filter="commandFilter"
        :visible="showCommandPalette"
        @select="handleCommandSelect"
        @close="handleCommandClose"
      />
      <textarea
        v-model="inputText"
        :placeholder="
          awaitingApproval
            ? 'Answer the pending approval to continue…'
            : (isReconnecting
                ? 'Reconnecting…'
                : (availableCommands.length > 0
                    ? 'Type your message... (/ for commands)'
                    : 'Type your message...'))
        "
        :disabled="isLoading || isReconnecting || awaitingApproval"
        @keydown="handleKeyDown"
        rows="3"
      />
      <button 
        class="send-btn"
        :disabled="!inputText.trim() || isLoading || isReconnecting || awaitingApproval"
        @click="handleSend"
      >
        Send
      </button>
    </div>
  </div>
</template>

<style scoped>
.chat-view {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.chat-header {
  padding: 1rem;
  border-bottom: 1px solid var(--border-color, #e0e0e0);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}

.chat-header h2 {
  margin: 0;
  font-size: 1.1rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.agent-name {
  font-size: 0.875rem;
  color: var(--text-accent, #0066cc);
}

.messages-container {
  flex: 1;
  overflow-y: auto;
  padding: 1rem;
}

.loading-indicator {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.75rem;
  color: var(--text-muted, #666);
}

.spinner {
  width: 16px;
  height: 16px;
  border: 2px solid var(--border-color, #ccc);
  border-top-color: var(--text-accent, #0066cc);
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.cancel-btn {
  margin-left: auto;
  padding: 0.25rem 0.5rem;
  border: 1px solid var(--border-color, #ccc);
  border-radius: 4px;
  background: transparent;
  font-size: 0.8rem;
  cursor: pointer;
}

/* Sticky, full-width and unmissable: the composer's own gate. */
.approval-bar {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  padding: 0.5rem 1rem;
  border: none;
  border-top: 1px solid #f59e0b;
  background: rgba(245, 158, 11, 0.15);
  color: var(--text-primary, #333);
  font-size: 0.85rem;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
}

.approval-bar:hover {
  background: rgba(245, 158, 11, 0.25);
}

.approval-bar-text {
  flex: 1;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.approval-bar-action {
  color: var(--text-accent, #0066cc);
  font-weight: 600;
  white-space: nowrap;
}

.input-container {
  position: relative;
  display: flex;
  gap: 0.5rem;
  padding: 1rem;
  border-top: 1px solid var(--border-color, #e0e0e0);
}

textarea {
  flex: 1;
  padding: 0.75rem;
  border: 1px solid var(--border-color, #ccc);
  border-radius: 6px;
  font-size: 1rem;
  font-family: inherit;
  resize: none;
}

textarea:focus {
  outline: none;
  border-color: var(--text-accent, #0066cc);
}

.send-btn {
  padding: 0.75rem 1.5rem;
  background: var(--bg-primary, #0066cc);
  color: white;
  border: none;
  border-radius: 6px;
  font-size: 1rem;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.15s;
}

.send-btn:hover:not(:disabled) {
  background: var(--bg-primary-hover, #0052a3);
}

.send-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* ---------- Mobile / narrow-viewport tweaks ---------- */

@media (max-width: 800px) {
  /* Reserve space for the floating mobile hamburger (44px wide, fixed in
     App.vue) so the mode/model pickers don't sit underneath it. Also push
     the header below the camera notch / status bar so picker buttons aren't
     clipped on phones with a hole-punch or notch. */
  .chat-header {
    padding-top: calc(1rem + env(safe-area-inset-top, 0px));
    padding-left: calc(44px + 1rem);
  }

  /* Agent identity is already shown in the sidebar drawer; on a phone the
     chat header should belong to mode/model/actions. Hiding the long name
     also avoids awkward 4-line wraps for names like "Copilot CLI dev tunnel". */
  .agent-name {
    display: none;
  }

  /* Session title is also redundant on mobile (visible in the sidebar
     SessionList) and otherwise gets crushed to a single character by the
     mode/model pickers. Reclaim the horizontal space. */
  .chat-header h2 {
    display: none;
  }

  .input-container {
    /* iOS home-indicator: keep Send button reachable above the gesture area. */
    padding-bottom: calc(1rem + env(safe-area-inset-bottom, 0px));
    gap: 0.5rem;
  }

  textarea {
    /* Avoid iOS auto-zoom on focus when font-size < 16px. */
    font-size: 16px;
    min-height: 44px;
  }

  .send-btn {
    min-width: 64px;
    min-height: 44px;
    padding: 0.5rem 1rem;
  }
}

</style>
