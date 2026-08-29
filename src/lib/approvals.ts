// How tool-call approvals are presented.
//
// The default is `inline`: the request lands as a row in the transcript with
// its buttons under the line, the way agent CLIs do it. That keeps a permanent
// record of what was permitted, but it trades away the one thing a modal
// guarantees — that the request cannot be scrolled past. Anyone who wants the
// hard stop back can have it, so the modal stays available as a preference
// rather than being deleted.

import { ref, readonly } from 'vue';
import { loadKvStore } from './host';

export const APPROVAL_STYLE_KEY = 'approvalStyle';

export type ApprovalStyle = 'inline' | 'modal';

const style = ref<ApprovalStyle>('inline');

/** Current style. Reactive; safe to read before the preference has loaded. */
export const approvalStyle = readonly(style);

function coerce(value: unknown): ApprovalStyle {
  // Anything unrecognised (an older build, a hand-edited file) falls back to
  // the default rather than leaving approvals with no UI at all.
  return value === 'modal' ? 'modal' : 'inline';
}

/** Reads the stored preference. Called once during app startup. */
export async function loadApprovalStyle(): Promise<ApprovalStyle> {
  try {
    const prefs = await loadKvStore('preferences.json');
    style.value = coerce(await prefs.get<string>(APPROVAL_STYLE_KEY));
  } catch (e) {
    console.warn('Failed to read approval style preference:', e);
  }
  return style.value;
}

/** Applies and persists a new style. Takes effect immediately. */
export async function setApprovalStyle(next: ApprovalStyle): Promise<void> {
  style.value = coerce(next);
  const prefs = await loadKvStore('preferences.json');
  await prefs.set(APPROVAL_STYLE_KEY, style.value);
  await prefs.save();
}
