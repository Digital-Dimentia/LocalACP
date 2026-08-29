// Session store for managing ACP sessions and persistence
import { defineStore } from 'pinia';
import { ref, computed, watch } from 'vue';
import { loadKvStore, type KVStore } from '../lib/host/storage';
import { getAppVersion } from '../lib/host';
import { trackEvent, trackError } from '../lib/telemetry';
import type { SavedSession, ToolCallInfo, PermissionRequest, SessionMode, SlashCommand, ModelInfo, AgentConfig } from '../lib/types';
import type {
  AssistantEntry,
  NoticeEntry,
  PermissionEntry,
  TimelineEntry,
} from '../lib/timeline';
import { getTransportKind, toWireMcpServers } from '../lib/types';
import type { McpCapabilities, WireMcpServer } from '../lib/types';
import { AcpClientBridge, createAcpClient } from '../lib/acp-bridge';
import { beginEcho, consumeEcho, type PendingEcho } from '../lib/prompt-echo';
import { onAgentStderr, spawnAgent, killAgent } from '../lib/host';
import { isDesktop } from '../lib/platform';
import { useConfigStore } from './config';
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import type { SessionNotification, AuthMethod } from '@agentclientprotocol/sdk';

const STORE_PATH = 'sessions.json';

/**
 * Assemble the MCP servers to offer a session.
 *
 * The list is global to the app rather than per-agent: an MCP server is a
 * capability of the workspace, not of whichever agent happens to be answering.
 * Entries the agent cannot accept are dropped rather than sent — an agent is
 * within its rights to fail the whole `session/new` over one unsupported
 * transport — and what was dropped is logged, since a silently missing tool
 * server is exactly the kind of thing that reads as "MCP is broken".
 */
function collectMcpServers(
  mcpCapabilities: McpCapabilities | undefined,
  agentName: string
): WireMcpServer[] {
  const configStore = useConfigStore();
  const { wire, skipped } = toWireMcpServers(configStore.mcpServers, mcpCapabilities);

  if (skipped.length > 0) {
    console.warn(
      `Not offering ${skipped.length} MCP server(s) to '${agentName}': ${skipped.join(', ')}`
    );
  }
  console.log(
    `Offering ${wire.length} MCP server(s) to '${agentName}':`,
    wire.map((s) => s.name)
  );
  return wire;
}

/**
 * Enforce the version the agent negotiated in its `initialize` reply.
 *
 * ACP lets the agent answer with a different version than the client asked
 * for — the client's version if it's supported, otherwise the newest the
 * agent speaks — and requires the client to disconnect when it can't speak
 * the result. acp-ui implements exactly {@link PROTOCOL_VERSION}, so any
 * other number is an incompatibility.
 *
 * Failing here, at the handshake, is the whole point: without this the
 * mismatch surfaces later as an arbitrary unsupported method and an error
 * that never names the real cause. A non-conforming agent that omits the
 * field is warned about rather than rejected — it isn't evidence of a
 * mismatch, and rejecting would break agents that work today.
 */
function assertNegotiatedProtocolVersion(negotiated: number | undefined, agentName: string): void {
  if (negotiated === undefined) {
    console.warn(
      `Agent '${agentName}' omitted protocolVersion from its initialize response; assuming ACP v${PROTOCOL_VERSION}.`
    );
    return;
  }
  if (negotiated !== PROTOCOL_VERSION) {
    throw new Error(
      `Agent '${agentName}' negotiated ACP protocol v${negotiated}, but acp-ui speaks v${PROTOCOL_VERSION}. ` +
        `Update acp-ui if the agent is newer, or the agent if it is older.`
    );
  }
}

// App version (loaded once at startup)
let appVersion = '0.1.0';

// Startup phase detection patterns
function detectPhase(line: string): string | null {
  const lower = line.toLowerCase();
  if (lower.includes('download') || lower.includes('fetch') || lower.includes('get ')) {
    return 'downloading';
  }
  if (lower.includes('install') || lower.includes('added') || lower.includes('packages')) {
    return 'installing';
  }
  if (lower.includes('build') || lower.includes('compil')) {
    return 'building';
  }
  if (lower.includes('start') || lower.includes('spawn')) {
    return 'starting';
  }
  return null;
}

export const useSessionStore = defineStore('session', () => {
  // State
  const savedSessions = ref<SavedSession[]>([]);
  const currentSession = ref<SavedSession | null>(null);
  // The conversation as a list of typed rows. See lib/timeline.ts for why
  // this is not a list of chat messages with things hung off them.
  const timeline = ref<TimelineEntry[]>([]);
  const toolCalls = ref<Map<string, ToolCallInfo>>(new Map());

  // The prompt this client has already rendered and is waiting for the agent
  // to echo back. Deliberately not reactive: nothing renders it, and making it
  // a ref would just add a dependency to every chunk that arrives.
  let pendingEcho: PendingEcho | null = null;
  const isConnected = ref(false);
  const isLoading = ref(false);
  const isConnecting = ref(false);
  // True while a foreground reconnect attempt is in flight. Distinct from
  // `isConnecting` (which is the multi-phase initial spawn/connect path):
  // reconnects skip the spawn/stderr-progress UI and just need a small
  // "Reconnecting…" indicator.
  const isReconnecting = ref(false);
  const error = ref<string | null>(null);
  const pendingPermission = ref<PermissionRequest | null>(null);
  
  // Authentication state
  const pendingAuthMethods = ref<AuthMethod[]>([]);
  const pendingAuthAgentName = ref<string>('');
  let authMethodResolver: ((methodId: string | null) => void) | null = null;
  
  // Session modes
  const availableModes = ref<SessionMode[]>([]);
  const currentModeId = ref<string>('');
  
  // Slash commands
  const availableCommands = ref<SlashCommand[]>([]);
  
  // Session models
  const availableModels = ref<ModelInfo[]>([]);
  const currentModelId = ref<string>('');
  
  // Connection cancellation
  let connectionAborted = false;
  
  // Startup progress tracking
  const startupPhase = ref<string>('starting');
  const startupLogs = ref<string[]>([]);
  const startupElapsed = ref<number>(0);
  let startupTimer: ReturnType<typeof setInterval> | null = null;
  let stderrUnlisten: (() => void) | null = null;
  
  // Current ACP client
  let acpClient: AcpClientBridge | null = null;
  let store: KVStore | null = null;

  // Computed
  const hasActiveSession = computed(() => currentSession.value !== null);
  const timelineEntries = computed(() => timeline.value);
  /**
   * The approval the user is being asked for right now, if any. Derived from
   * the timeline rather than tracked separately so the row and the gate can
   * never disagree about whether something is outstanding.
   */
  const pendingPermissionEntry = computed(
    () => timeline.value.find(
      (e): e is PermissionEntry => e.type === 'permission' && e.state === 'pending'
    ) ?? null
  );
  const toolCallList = computed(() => Array.from(toolCalls.value.values()));
  // Only sessions that support resuming (loadSession capability)
  const resumableSessions = computed(() => 
    savedSessions.value.filter(s => s.supportsLoadSession === true)
  );

  // Initialize store
  async function initStore() {
    store = await loadKvStore(STORE_PATH);
    const saved = await store.get<SavedSession[]>('sessions');
    if (saved) {
      savedSessions.value = saved;
    }
    
    // Load app version (Tauri API on desktop/mobile, build-time inject on web)
    try {
      appVersion = await getAppVersion();
    } catch (e) {
      console.warn('Failed to get app version:', e);
    }
  }

  async function saveSessionsToStore() {
    if (store) {
      await store.set('sessions', savedSessions.value);
      await store.save();
    }
  }

  // Handle an unexpected transport close (e.g. WebSocket dropped while idle,
  // local agent process exited). The bridge has already rejected any
  // in-flight requests; we just need to tear down UI state so the user gets
  // a clear "disconnected" signal instead of a stale "connected" view.
  function handleUnexpectedClose(reason?: string): void {
    // If `acpClient` is already null, this fired during a voluntary
    // disconnect that's tearing down anyway — nothing to do.
    if (!acpClient) return;
    acpClient = null;
    isConnected.value = false;
    isLoading.value = false;
    pendingPermission.value = null;
    // Nobody is left to answer an outstanding request, and a stuck approval
    // row would gate the composer forever.
    abandonPendingPermissions();
    const message = `Connection lost: ${reason ?? 'transport closed'}`;
    error.value = message;
    pushNotice('error', message);
  }

  /** Appends a row and hands it back already reactive. */
  function pushEntry<T extends TimelineEntry>(entry: T): T {
    timeline.value.push(entry);
    return timeline.value[timeline.value.length - 1] as T;
  }

  /** Records an out-of-band event in the transcript. */
  function pushNotice(level: NoticeEntry['level'], content: string): NoticeEntry {
    return pushEntry<NoticeEntry>({
      type: 'notice',
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      level,
      content,
    });
  }

  /** Marks every still-open approval as cancelled (transport gone, reset). */
  function abandonPendingPermissions(): void {
    for (const entry of timeline.value) {
      if (entry.type === 'permission' && entry.state === 'pending') {
        entry.state = 'cancelled';
      }
    }
  }

  /** Drops the whole transcript. Used when a session starts or is replaced. */
  function resetTimeline(): void {
    timeline.value = [];
    toolCalls.value.clear();
    pendingPermission.value = null;
    // A fresh transcript has nothing outstanding to match an echo against.
    pendingEcho = null;
  }

  // Returns the run of assistant prose currently open, starting one if the tail
  // of the timeline is anything else. Only text and thought accumulate here;
  // tool calls and approvals are rows of their own.
  function currentAssistantMessage(): AssistantEntry {
    const last = timeline.value[timeline.value.length - 1];
    if (last && last.type === 'assistant') {
      return last;
    }
    // Anything else at the tail — a tool call, an approval — has closed the
    // previous run of prose. Opening a new row here is what makes the
    // transcript interleave in the order events actually happened.
    return pushEntry<AssistantEntry>({
      type: 'assistant',
      id: crypto.randomUUID(),
      content: '',
      timestamp: Date.now(),
    });
  }

  // Appends a tool call as its own row and registers it in the lookup map.
  // Both hold the same object, so a later `tool_call_update` needs no
  // write-through to keep the row current.
  function attachToolCall(toolCall: ToolCallInfo): void {
    const entry = pushEntry({
      type: 'tool_call' as const,
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      toolCall,
    });
    toolCalls.value.set(toolCall.toolCallId, entry.toolCall);
  }

  // Session update handler
  function handleSessionUpdate(notification: SessionNotification) {
    const update = notification.update;
    
    switch (update.sessionUpdate) {
      case 'user_message_chunk': {
        // Agents echo the prompt back, and `session/load` replays history the
        // same way. Anything this client already rendered itself is consumed
        // here rather than appended a second time; see lib/prompt-echo.ts.
        const chunk = update.content.type === 'text' ? update.content.text : '';
        const { render, pending } = consumeEcho(pendingEcho, chunk);
        pendingEcho = pending;
        if (!render) break;

        // Append to the open user row, or start one (replayed history).
        const last = timeline.value[timeline.value.length - 1];
        if (last && last.type === 'user') {
          last.content += render;
        } else {
          pushEntry({
            type: 'user' as const,
            id: crypto.randomUUID(),
            content: render,
            timestamp: Date.now(),
          });
        }
        break;
      }

      case 'agent_message_chunk': {
        const msg = currentAssistantMessage();
        if (update.content.type === 'text') {
          msg.content += update.content.text;
        }
        break;
      }

      case 'agent_thought_chunk': {
        const msg = currentAssistantMessage();
        if (update.content.type === 'text') {
          msg.thought = (msg.thought || '') + update.content.text;
        }
        break;
      }

      case 'tool_call': {
        // A tool call is a valid update on its own and may arrive before any
        // assistant chunk, so the container is created on demand rather than
        // required to already exist.
        attachToolCall({
          toolCallId: update.toolCallId,
          title: update.title,
          kind: update.kind || 'other',
          status: update.status || 'pending',
          locations: update.locations,
        });
        break;
      }

      case 'tool_call_update': {
        const existing = toolCalls.value.get(update.toolCallId);
        if (!existing) {
          // The tool_call that opened this entry may never have arrived (an agent
          // that only reports terminal state, or a mid-stream reconnect). Create
          // it from the update rather than dropping the call.
          attachToolCall({
            toolCallId: update.toolCallId,
            title: update.title || update.toolCallId,
            kind: update.kind || 'other',
            status: update.status || 'pending',
            locations: update.locations ?? undefined,
          });
          break;
        }
        // The message array holds this same object, so one mutation updates both.
        if (update.status) existing.status = update.status;
        if (update.title) existing.title = update.title;
        if (update.kind) existing.kind = update.kind;
        if (update.locations) existing.locations = update.locations;
        break;
      }

      case 'current_mode_update':
        // Agent changed the mode
        if ('modeId' in update && update.modeId) {
          currentModeId.value = update.modeId as string;
        }
        break;

      case 'available_commands_update':
        // Agent advertised slash commands
        if ('availableCommands' in update && Array.isArray(update.availableCommands)) {
          availableCommands.value = update.availableCommands.map((cmd) => ({
            name: cmd.name,
            description: cmd.description,
            hint: cmd.input?.hint ?? undefined,
          }));
        }
        break;

      default:
        console.log('Unhandled session update:', update);
    }
  }

  // Prompt user to select auth method
  async function promptForAuthMethod(authMethods: AuthMethod[], agentName: string): Promise<string | null> {
    return new Promise((resolve) => {
      pendingAuthMethods.value = authMethods;
      pendingAuthAgentName.value = agentName;
      authMethodResolver = resolve;
    });
  }

  // User selected an auth method
  function selectAuthMethod(methodId: string): void {
    if (authMethodResolver) {
      authMethodResolver(methodId);
      authMethodResolver = null;
      pendingAuthMethods.value = [];
      pendingAuthAgentName.value = '';
    }
  }

  // User cancelled auth selection
  function cancelAuthSelection(): void {
    if (authMethodResolver) {
      authMethodResolver(null);
      authMethodResolver = null;
      pendingAuthMethods.value = [];
      pendingAuthAgentName.value = '';
    }
  }

  // Create new session
  async function createSession(agentName: string, cwd: string): Promise<void> {
    isLoading.value = true;
    isConnecting.value = true;
    connectionAborted = false;
    error.value = null;

    // Look up the agent's transport kind so we know whether to do the
    // stdio-only startup choreography (spawn → stderr progress) or the
    // streamlined remote path (just open a network transport).
    const configStore = useConfigStore();
    const agentConfig: AgentConfig | undefined = configStore.getAgent(agentName);
    const transportKind = agentConfig
      ? getTransportKind(agentConfig)
      : 'stdio';
    const isRemote = transportKind !== 'stdio';

    // Reset and start progress tracking
    startupPhase.value = 'starting';
    startupLogs.value = [];
    startupElapsed.value = 0;
    startupTimer = setInterval(() => {
      startupElapsed.value++;
    }, 1000);

    // Track the spawned stdio instance separately so we can `killAgent` it
    // if cancellation/abort happens before we've wrapped it in a bridge.
    // Once `acpClient` is set, ownership transfers to the bridge and
    // `acpClient.disconnect()` becomes the only correct cleanup path.
    let spawnedInstance: { id: string } | null = null;

    try {
      if (!agentConfig) {
        throw new Error(`Agent '${agentName}' not found in config`);
      }

      if (!isRemote) {
        // For stdio agents we need the spawned process's id up front so the
        // stderr listener can filter on it (multiple agents may be running
        // concurrently). We spawn here, hand the resulting AgentInstance to
        // a StdioTransport, then build the bridge from that transport.
        startupPhase.value = 'starting';
        const agentInstance = await spawnAgent(agentName);
        spawnedInstance = agentInstance;

        stderrUnlisten = await onAgentStderr((stderr) => {
          if (stderr.agent_id !== agentInstance.id) return;
          startupLogs.value.push(stderr.line);
          // Detect phase from output
          const detectedPhase = detectPhase(stderr.line);
          if (detectedPhase) {
            startupPhase.value = detectedPhase;
          }
        }) as unknown as () => void;

        if (connectionAborted) {
          // Process was spawned but no bridge exists yet — kill the orphan
          // before throwing so the local agent doesn't keep running.
          await killAgent(agentInstance.id).catch((err) =>
            console.warn('killAgent during abort failed:', err)
          );
          spawnedInstance = null;
          throw new Error('Connection cancelled');
        }

        startupPhase.value = 'initializing';

        // Wrap the just-spawned instance in a StdioTransport. Using the
        // legacy single-arg form keeps backward compatibility and avoids a
        // double-spawn (StdioTransport.spawn would call spawnAgent again).
        acpClient = await createAcpClient(agentInstance);
        // Ownership of the child process now belongs to the bridge — clear
        // our local reference so the catch block doesn't double-kill it.
        spawnedInstance = null;
      } else {
        // Remote agents have no stderr stream; show a minimal "connecting"
        // state instead of the multi-phase progress UI.
        startupPhase.value = 'connecting';

        if (connectionAborted) {
          throw new Error('Connection cancelled');
        }

        // The factory opens a WebSocket / HTTP connection based on
        // agentConfig.transport.
        acpClient = await createAcpClient({ name: agentName, config: agentConfig });
      }

      acpClient.onSessionUpdate = handleSessionUpdate;
      // Surface unexpected transport closes (e.g. WebSocket drop while idle)
      // to the UI so users don't sit on a stale "connected" state forever.
      acpClient.onTransportClose = (reason) => {
        handleUnexpectedClose(reason);
      };
      
      // Mirror the bridge's outstanding request into the store, and give it a
      // row in the transcript so it can be answered in line.
      watch(
        () => acpClient?.pendingPermissionRequest.value,
        (newValue) => {
          pendingPermission.value = newValue ?? null;
          if (newValue) appendPermissionRequest(newValue);
        },
        { immediate: true }
      );

      if (connectionAborted) {
        await acpClient.disconnect();
        throw new Error('Connection cancelled');
      }

      startupPhase.value = 'connecting';

      // Initialize connection
      // Only Tauri desktop has real filesystem access; mobile and web
      // cannot fulfil readTextFile / writeTextFile RPCs.
      const canAccessFs = isDesktop();

      const initResponse = await acpClient.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          fs: {
            readTextFile: canAccessFs,
            writeTextFile: canAccessFs,
          },
        },
        clientInfo: {
          name: 'acp-ui',
          title: 'ACP UI',
          version: appVersion,
        },
      });

      console.log('Agent initialized:', initResponse);

      assertNegotiatedProtocolVersion(initResponse.protocolVersion, agentName);

      // Check if agent supports session loading
      const supportsLoadSession = initResponse.agentCapabilities?.loadSession ?? false;

      // Resolved once from the handshake and reused for the post-auth retry:
      // the agent's answer cannot change between the two attempts.
      const mcpServers = collectMcpServers(
        initResponse.agentCapabilities?.mcpCapabilities as McpCapabilities | undefined,
        agentName
      );

      if (connectionAborted) {
        await acpClient.disconnect();
        throw new Error('Connection cancelled');
      }

      // Store available auth methods for potential retry
      const availableAuthMethods = initResponse.authMethods || [];

      if (connectionAborted) {
        await acpClient.disconnect();
        throw new Error('Connection cancelled');
      }

      // Try to create session - may fail with auth_required
      let sessionResponse;
      try {
        sessionResponse = await acpClient.newSession({
          cwd,
          mcpServers,
        });
      } catch (sessionError: unknown) {
        // Check if auth is required (error code -32000)
        const errorMessage = sessionError instanceof Error ? sessionError.message : String(sessionError);
        const isAuthRequired = errorMessage.toLowerCase().includes('authentication required') ||
                               errorMessage.includes('-32000');
        
        if (isAuthRequired && availableAuthMethods.length > 0) {
          console.log('Authentication required, available methods:', availableAuthMethods);
          
          // Prompt user to select auth method
          const selectedMethodId = await promptForAuthMethod(availableAuthMethods, agentName);
          
          if (!selectedMethodId || connectionAborted) {
            await acpClient.disconnect();
            throw new Error('Authentication cancelled by user');
          }
          
          console.log('Authenticating with method:', selectedMethodId);
          const authResponse = await acpClient.authenticate({
            methodId: selectedMethodId,
          });
          console.log('Authentication successful:', authResponse);

          if (connectionAborted) {
            await acpClient.disconnect();
            throw new Error('Connection cancelled');
          }

          // Retry session creation after auth
          sessionResponse = await acpClient.newSession({
            cwd,
            mcpServers,
          });
        } else {
          throw sessionError;
        }
      }

      // Save session
      const session: SavedSession = {
        id: crypto.randomUUID(),
        agentName,
        sessionId: sessionResponse.sessionId,
        title: `Session ${new Date().toLocaleString()}`,
        lastUpdated: Date.now(),
        cwd,
        supportsLoadSession,
      };

      currentSession.value = session;
      savedSessions.value.push(session);
      await saveSessionsToStore();
      
      isConnected.value = true;
      resetTimeline();
      
      // Track successful session creation
      trackEvent('SessionCreated', { agentName, success: 'true' });
      
      // Set up session modes if available
      if (sessionResponse.modes) {
        availableModes.value = (sessionResponse.modes.availableModes || []).map(m => ({
          id: m.id,
          name: m.name,
          description: m.description ?? undefined,
        }));
        currentModeId.value = sessionResponse.modes.currentModeId || '';
      } else {
        availableModes.value = [];
        currentModeId.value = '';
      }

      // Set up session models if available
      if (sessionResponse.models) {
        availableModels.value = (sessionResponse.models.availableModels || []).map(m => ({
          modelId: m.modelId,
          name: m.name,
          description: m.description ?? undefined,
        }));
        currentModelId.value = sessionResponse.models.currentModelId || '';
      } else {
        availableModels.value = [];
        currentModelId.value = '';
      }

    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
      // Tear down whichever side of the connection is live. The bridge owns
      // the spawned process once it exists, so prefer disconnecting it.
      // Otherwise (e.g. abort right after spawn but before bridge creation)
      // kill the orphaned local agent directly.
      if (acpClient) {
        try {
          await acpClient.disconnect();
        } catch (cleanupErr) {
          console.warn('disconnect during createSession cleanup failed:', cleanupErr);
        }
      } else if (spawnedInstance) {
        try {
          await killAgent(spawnedInstance.id);
        } catch (cleanupErr) {
          console.warn('killAgent during createSession cleanup failed:', cleanupErr);
        }
      }
      acpClient = null;
      // Track session creation failure
      trackEvent('SessionCreated', { agentName, success: 'false' });
      trackError(e instanceof Error ? e : new Error(String(e)));
      throw e;
    } finally {
      isLoading.value = false;
      isConnecting.value = false;
      // Clean up startup progress tracking
      if (startupTimer) {
        clearInterval(startupTimer);
        startupTimer = null;
      }
      if (stderrUnlisten) {
        stderrUnlisten();
        stderrUnlisten = null;
      }
    }
  }

  // Resume existing session
  async function resumeSession(savedSession: SavedSession): Promise<void> {
    isLoading.value = true;
    error.value = null;

    try {
      const configStore = useConfigStore();
      const agentConfig: AgentConfig | undefined = configStore.getAgent(savedSession.agentName);
      if (!agentConfig) {
        throw new Error(`Agent '${savedSession.agentName}' not found in config`);
      }

      // Create ACP client bridge (transport selected based on agent config).
      acpClient = await createAcpClient({
        name: savedSession.agentName,
        config: agentConfig,
      });
      acpClient.onSessionUpdate = handleSessionUpdate;
      // Surface unexpected transport closes (e.g. WebSocket dropped while idle,
      // local agent process crashed) so the UI doesn't sit on a stale
      // "connected" view forever.
      acpClient.onTransportClose = (reason) => {
        handleUnexpectedClose(reason);
      };

      // Mirror the bridge's outstanding request into the store, and give it a
      // row in the transcript so it can be answered in line.
      watch(
        () => acpClient?.pendingPermissionRequest.value,
        (newValue) => {
          pendingPermission.value = newValue ?? null;
          if (newValue) appendPermissionRequest(newValue);
        },
        { immediate: true }
      );

      // Only Tauri desktop has real filesystem access; mobile and web
      // cannot fulfil readTextFile / writeTextFile RPCs.
      const canAccessFs = isDesktop();

      // Initialize connection
      const initResponse = await acpClient.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          fs: {
            readTextFile: canAccessFs,
            writeTextFile: canAccessFs,
          },
        },
        clientInfo: {
          name: 'acp-ui',
          title: 'ACP UI',
          version: appVersion,
        },
      });

      assertNegotiatedProtocolVersion(initResponse.protocolVersion, savedSession.agentName);

      const mcpServers = collectMcpServers(
        initResponse.agentCapabilities?.mcpCapabilities as McpCapabilities | undefined,
        savedSession.agentName
      );

      // Store available auth methods for potential retry
      const availableAuthMethods = initResponse.authMethods || [];

      // Clear the transcript BEFORE loadSession — the agent replays history
      // through the same notifications a live turn uses.
      resetTimeline();

      // Try to load existing session - may fail with auth_required
      try {
        await acpClient.loadSession({
          sessionId: savedSession.sessionId,
          cwd: savedSession.cwd,
          mcpServers,
        });
      } catch (sessionError: unknown) {
        // Check if auth is required (error code -32000)
        const errorMessage = sessionError instanceof Error ? sessionError.message : String(sessionError);
        const isAuthRequired = errorMessage.toLowerCase().includes('authentication required') ||
                               errorMessage.includes('-32000');
        
        if (isAuthRequired && availableAuthMethods.length > 0) {
          console.log('Authentication required, available methods:', availableAuthMethods);
          
          // Prompt user to select auth method
          const selectedMethodId = await promptForAuthMethod(availableAuthMethods, savedSession.agentName);
          
          if (!selectedMethodId) {
            await acpClient.disconnect();
            throw new Error('Authentication cancelled by user');
          }
          
          console.log('Authenticating with method:', selectedMethodId);
          const authResponse = await acpClient.authenticate({
            methodId: selectedMethodId,
          });
          console.log('Authentication successful:', authResponse);

          // Retry loading session after auth
          await acpClient.loadSession({
            sessionId: savedSession.sessionId,
            cwd: savedSession.cwd,
            mcpServers,
          });
        } else {
          throw sessionError;
        }
      }

      currentSession.value = savedSession;
      isConnected.value = true;
      // Messages already populated by session/update notifications during loadSession

      // Track successful session resume
      trackEvent('SessionResumed', { agentName: savedSession.agentName, success: 'true' });

      // Update last accessed time
      savedSession.lastUpdated = Date.now();
      await saveSessionsToStore();

    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
      // Disconnect the bridge if it was created — otherwise we leak the
      // spawned stdio process or open WebSocket on initialize/loadSession
      // failure.
      if (acpClient) {
        try {
          await acpClient.disconnect();
        } catch (cleanupErr) {
          console.warn('disconnect during resumeSession cleanup failed:', cleanupErr);
        }
        acpClient = null;
      }
      // Track session resume failure
      trackEvent('SessionResumed', { agentName: savedSession.agentName, success: 'false' });
      trackError(e instanceof Error ? e : new Error(String(e)));
      throw e;
    } finally {
      isLoading.value = false;
    }
  }

  // Send prompt
  async function sendPrompt(text: string): Promise<void> {
    if (!acpClient || !currentSession.value) {
      throw new Error('No active session');
    }

    // The session title is taken from the opening prompt, so note whether
    // this is it before the row is appended.
    const isFirstPrompt = !timeline.value.some((e) => e.type === 'user');

    pushEntry({
      type: 'user' as const,
      id: crypto.randomUUID(),
      content: text,
      timestamp: Date.now(),
    });

    // The agent will echo this back as user_message_chunk notifications during
    // the turn; they arrive before `prompt` resolves.
    pendingEcho = beginEcho(text);

    isLoading.value = true;
    try {
      const response = await acpClient.prompt({
        sessionId: currentSession.value.sessionId,
        prompt: [
          {
            type: 'text',
            text,
          },
        ],
      });

      console.log('Prompt completed:', response.stopReason);

      // Track prompt sent
      trackEvent('PromptSent', { 
        messageLength: String(text.length),
        stopReason: response.stopReason || 'unknown',
      });

      // Name the session after the prompt that opened it.
      if (isFirstPrompt && currentSession.value) {
        currentSession.value.title = text.slice(0, 50) + (text.length > 50 ? '...' : '');
        currentSession.value.lastUpdated = Date.now();
        await saveSessionsToStore();
      }
    } finally {
      isLoading.value = false;
      // The turn is over — including when it failed or was cancelled — so any
      // echo that was coming has arrived. Dropping it here bounds the window:
      // a later identical chunk is the user typing again, not an echo, and
      // must render.
      pendingEcho = null;
    }
  }

  // Cancel current operation
  async function cancelOperation(): Promise<void> {
    if (!acpClient || !currentSession.value) return;
    
    await acpClient.cancel({
      sessionId: currentSession.value.sessionId,
    });
  }

  // Cancel ongoing connection attempt
  async function cancelConnection(): Promise<void> {
    connectionAborted = true;
    
    // Cancel auth selection if pending
    if (authMethodResolver) {
      authMethodResolver(null);
      authMethodResolver = null;
      pendingAuthMethods.value = [];
      pendingAuthAgentName.value = '';
    }
    
    // Disconnect if client exists
    if (acpClient) {
      try {
        await acpClient.disconnect();
      } catch (e) {
        console.error('Error disconnecting:', e);
      }
      acpClient = null;
    }
    
    isLoading.value = false;
    isConnecting.value = false;
    error.value = null;
  }

  /**
   * Gives the agent's request a row in the transcript. Requests are ignored if
   * one is already open for the same tool call: agents may re-ask after a
   * reconnect, and a second row would let one prompt be answered twice.
   */
  function appendPermissionRequest(request: PermissionRequest): void {
    const toolCallId = request.toolCall.toolCallId;
    const duplicate = timeline.value.some(
      (e) => e.type === 'permission' && e.state === 'pending' && e.toolCallId === toolCallId
    );
    if (duplicate) return;

    pushEntry<PermissionEntry>({
      type: 'permission',
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      toolCallId,
      request,
      state: 'pending',
    });
  }

  // Handle permission response
  function resolvePermission(optionId: string): void {
    const entry = pendingPermissionEntry.value;
    if (entry) {
      const option = entry.request.options.find((o) => o.optionId === optionId);
      // The row is kept, not removed: the transcript is the record of what was
      // permitted and how, which the modal it replaces never left behind.
      entry.state = 'resolved';
      entry.chosenOptionId = optionId;
      entry.chosenName = option?.name;
      entry.chosenKind = option?.kind;
    }
    if (acpClient) {
      acpClient.resolvePermission(optionId);
    }
  }

  function cancelPermission(): void {
    const entry = pendingPermissionEntry.value;
    if (entry) entry.state = 'cancelled';
    if (acpClient) {
      acpClient.cancelPermission();
    }
  }

  // Disconnect current session
  async function disconnect(): Promise<void> {
    const agentName = currentSession.value?.agentName || 'unknown';
    const sessionStart = currentSession.value?.lastUpdated || Date.now();
    const sessionDuration = Math.round((Date.now() - sessionStart) / 1000);
    
    if (acpClient) {
      await acpClient.disconnect();
      acpClient = null;
    }
    
    // Track session disconnect
    trackEvent('SessionDisconnected', { 
      agentName,
      sessionDurationSeconds: String(sessionDuration),
      messageCount: String(timeline.value.length),
    });
    
    currentSession.value = null;
    isConnected.value = false;
    resetTimeline();
    availableModes.value = [];
    currentModeId.value = '';
    availableCommands.value = [];
    availableModels.value = [];
    currentModelId.value = '';
  }

  // Delete saved session
  async function deleteSession(sessionId: string): Promise<void> {
    savedSessions.value = savedSessions.value.filter(s => s.id !== sessionId);
    await saveSessionsToStore();
  }

  // Set session mode
  async function setMode(modeId: string): Promise<void> {
    if (!acpClient || !currentSession.value) {
      throw new Error('No active session');
    }
    
    await acpClient.setMode({
      sessionId: currentSession.value.sessionId,
      modeId,
    });
    
    // Optimistically update the current mode
    currentModeId.value = modeId;
  }

  // Set session model
  async function setModel(modelId: string): Promise<void> {
    if (!acpClient || !currentSession.value) {
      throw new Error('No active session');
    }
    
    await acpClient.unstable_setSessionModel({
      sessionId: currentSession.value.sessionId,
      modelId,
    });
    
    // Optimistically update the current model
    currentModelId.value = modelId;
  }

  function clearError() {
    error.value = null;
  }

  /**
   * Foreground reconnect: when the user returns to the app and we're
   * disconnected (because the OS froze the WebView, the NAT killed the TCP
   * connection, or the network changed), silently re-attach to the saved
   * session if possible.
   *
   * Returns `true` if a reconnect was attempted, `false` if there was
   * nothing to do (no saved session, already connected/connecting, agent
   * doesn't advertise session-load support, etc.).
   *
   * Errors are surfaced via `error.value` exactly like a manual resume
   * would; the caller doesn't need to handle them.
   */
  async function tryReconnect(): Promise<boolean> {
    // Already connected or already trying — leave it alone.
    if (isConnected.value || isConnecting.value || isLoading.value) {
      return false;
    }
    // No prior session to reconnect to.
    const session = currentSession.value;
    if (!session) {
      return false;
    }
    // Bridge already exists (race with another reconnect in flight).
    if (acpClient) {
      return false;
    }
    // Agent must support `session/load` for resume to be meaningful;
    // otherwise we'd just create a fresh session, which is a strictly
    // user-initiated action.
    if (!session.supportsLoadSession) {
      return false;
    }

    // Clear the stale "Connection lost" banner up-front so the UI shows
    // an honest "Reconnecting…" state instead of a contradictory red
    // banner during the attempt. If the reconnect ultimately fails, the
    // catch below restores a real error message.
    error.value = null;
    isReconnecting.value = true;
    try {
      await resumeSession(session);
      return true;
    } catch (e) {
      // `resumeSession`'s own catch already wrote `error.value`; nothing
      // more to do here. Returning true so the caller knows we tried.
      console.warn('Foreground reconnect failed:', e);
      return true;
    } finally {
      isReconnecting.value = false;
    }
  }

  return {
    // State
    savedSessions,
    currentSession,
    timeline,
    isConnected,
    isLoading,
    isConnecting,
    isReconnecting,
    error,
    pendingPermission,
    pendingAuthMethods,
    pendingAuthAgentName,
    availableModes,
    currentModeId,
    availableCommands,
    availableModels,
    currentModelId,
    startupPhase,
    startupLogs,
    startupElapsed,
    
    // Computed
    hasActiveSession,
    timelineEntries,
    pendingPermissionEntry,
    toolCallList,
    resumableSessions,
    
    // Actions
    initStore,
    createSession,
    resumeSession,
    sendPrompt,
    cancelOperation,
    cancelConnection,
    resolvePermission,
    cancelPermission,
    selectAuthMethod,
    cancelAuthSelection,
    disconnect,
    deleteSession,
    setMode,
    setModel,
    clearError,
    tryReconnect,
    pushNotice,
    
    // Expose client for permission handling
    get acpClient() { return acpClient; },
  };
});
