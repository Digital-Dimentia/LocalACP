// The conversation timeline.
//
// A session transcript used to be a flat list of chat messages with tool calls
// bolted onto the assistant message that happened to be open at the time. That
// shape only ever described two kinds of row (a person spoke, the agent spoke)
// and had nowhere to put anything the user must *act* on.
//
// The timeline instead is a list of typed rows discriminated on `type`. Each
// row owns its own data and its own capabilities: an approval row carries the
// options the agent offered and the decision that was made, a tool-call row
// carries execution status, a notice row carries out-of-band events. Adding a
// new kind of row — a diff to review, a form to fill in, a rating to give —
// means adding a variant here and a component to the row registry; nothing in
// the chat view has to learn about it.

import type { PermissionRequest, ToolCallInfo } from './types';

/** Fields every row carries, whatever its type. */
interface TimelineEntryBase {
  id: string;
  timestamp: number;
}

/** Something the person typed (or that the agent replayed back as history). */
export interface UserEntry extends TimelineEntryBase {
  type: 'user';
  content: string;
}

/**
 * A contiguous run of agent output. A turn can produce several of these: any
 * tool call or approval that lands mid-turn closes the current run and the
 * next chunk of text opens a new one, which is what lets the transcript
 * interleave prose and actions in the order they actually happened.
 */
export interface AssistantEntry extends TimelineEntryBase {
  type: 'assistant';
  content: string;
  thought?: string;
}

/**
 * One tool invocation. Holds the same `ToolCallInfo` object the store's
 * lookup map holds, so a `tool_call_update` mutates one object and both views
 * of it are current.
 */
export interface ToolCallEntry extends TimelineEntryBase {
  type: 'tool_call';
  toolCall: ToolCallInfo;
}

/** What happened to an approval request. */
export type PermissionState = 'pending' | 'resolved' | 'cancelled';

/**
 * An approval the agent asked for, and — once answered — the answer.
 *
 * The row is never removed after a decision: it flips to `resolved` and keeps
 * the chosen option, so the transcript is a durable record of what was
 * permitted and how. The old modal vanished without a trace.
 */
export interface PermissionEntry extends TimelineEntryBase {
  type: 'permission';
  /** Links back to the tool call this gates, when the agent supplied one. */
  toolCallId?: string;
  request: PermissionRequest;
  state: PermissionState;
  /** Set once answered; identifies the option the user picked. */
  chosenOptionId?: string;
  /** Human label of the chosen option, kept for display after the fact. */
  chosenName?: string;
  /** ACP option kind of the choice (`allow_once`, `reject_always`, …). */
  chosenKind?: string;
}

/** Out-of-band events worth showing in line: dropped connections, warnings. */
export interface NoticeEntry extends TimelineEntryBase {
  type: 'notice';
  level: 'info' | 'warning' | 'error';
  content: string;
}

export type TimelineEntry =
  | UserEntry
  | AssistantEntry
  | ToolCallEntry
  | PermissionEntry
  | NoticeEntry;

export type TimelineEntryType = TimelineEntry['type'];

/** Narrows an entry to a given variant. */
export function isEntry<T extends TimelineEntryType>(
  entry: TimelineEntry,
  type: T
): entry is Extract<TimelineEntry, { type: T }> {
  return entry.type === type;
}

/**
 * True for approval options that let the agent proceed. ACP option kinds are
 * open-ended strings, so anything unrecognised is treated as *not* an allow —
 * an unknown option must never inherit the styling or the affordances of a
 * blessed one.
 */
export function isAllowOption(kind: string): boolean {
  return kind === 'allow_once' || kind === 'allow_always';
}

/** True for the options that persist a decision beyond this one call. */
export function isAlwaysOption(kind: string): boolean {
  return kind === 'allow_always' || kind === 'reject_always';
}
