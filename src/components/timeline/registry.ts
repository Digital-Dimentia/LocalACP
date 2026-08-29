// Row registry: the single place that maps a timeline entry type to the
// component that draws it.
//
// The chat view never switches on `entry.type`. Teaching the transcript a new
// kind of row — a diff to review, a form, a rating — is a variant in
// `lib/timeline.ts`, a component under `rows/`, and one line here.

import type { Component } from 'vue';
import type { TimelineEntryType } from '../../lib/timeline';
import UserRow from './rows/UserRow.vue';
import AssistantRow from './rows/AssistantRow.vue';
import ToolCallRow from './rows/ToolCallRow.vue';
import PermissionRow from './rows/PermissionRow.vue';
import NoticeRow from './rows/NoticeRow.vue';

/**
 * Every entry type must appear here: `Record` over the union means adding a
 * variant without a component is a compile error, not a blank row at runtime.
 */
export const rowComponents: Record<TimelineEntryType, Component> = {
  user: UserRow,
  assistant: AssistantRow,
  tool_call: ToolCallRow,
  permission: PermissionRow,
  notice: NoticeRow,
};
