/**
 * Composer prompt-history navigation hook (issue #1044).
 *
 * Owns the up/down-arrow recall state that used to live inline in
 * `composer.tsx`: the in-memory mirror of the global input history plus the
 * "mid-navigation" index/savedDraft pair. The pure state machine
 * (`navigateComposerHistory`, `reconcileHistorySync`,
 * `rememberComposerHistoryEntry`) stays in `composer-helpers.ts` and the
 * localStorage seam in `input-history.ts` — both unit-tested there. This
 * hook is the React/DOM seam that applies navigation results to the
 * uncontrolled textarea (value + caret + draft persistence + resize).
 */

import { useRef, type KeyboardEvent, type RefObject } from 'react';
import {
  type ComposerHistoryState,
  navigateComposerHistory,
  reconcileHistorySync,
  rememberComposerHistoryEntry,
} from './composer-helpers.js';
import { readGlobalInputHistory, saveGlobalInputHistoryEntry } from './input-history.js';

export interface ComposerHistoryApi {
  /**
   * Drop back to "not navigating" (index -1, no saved draft). Any real edit,
   * send, or programmatic text set calls this so the next arrow-up starts
   * from the newest entry again.
   */
  resetNavigation(): void;
  /**
   * Record a successfully-sent prompt into both the in-memory list and the
   * persisted global history (shared across input surfaces, survives reloads).
   */
  rememberSentEntry(text: string): void;
  /**
   * PR-GLOBAL-INPUT-HISTORY: up/down arrow navigates the global input
   * history. Bare arrow keys only start navigation when the textarea is
   * empty, or when the user is already mid-navigation (index >= 0); in a
   * multi-line draft the caret keeps moving so editing isn't hijacked.
   * Ctrl/Cmd + ArrowUp/ArrowDown is an explicit shortcut that always
   * navigates history regardless of the current draft.
   *
   * Returns true when the keystroke was consumed (a navigation applied, or
   * deliberately swallowed because history is empty) and the caller must
   * stop further key handling.
   */
  handleArrowKey(event: KeyboardEvent<HTMLTextAreaElement>): boolean;
}

export function useComposerHistory(input: {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  /** Re-measure the textarea after a programmatic value swap. */
  autoResize(): void;
  /** Persist the applied value under the active draft key. */
  saveCurrentDraft(value?: string): void;
}): ComposerHistoryApi {
  const promptHistoryRef = useRef<ComposerHistoryState>({ entries: readGlobalInputHistory() ?? [], index: -1, savedDraft: '' });

  function resetNavigation() {
    promptHistoryRef.current = {
      entries: promptHistoryRef.current.entries,
      index: -1,
      savedDraft: '',
    };
  }

  function rememberSentEntry(text: string) {
    // Save to both local ref and global persistence so the history
    // survives page reloads and is shared across all input surfaces.
    saveGlobalInputHistoryEntry(text);
    promptHistoryRef.current = {
      entries: rememberComposerHistoryEntry(promptHistoryRef.current.entries, text),
      index: -1,
      savedDraft: '',
    };
  }

  function applyValue(el: HTMLTextAreaElement, value: string) {
    el.value = value;
    input.saveCurrentDraft(value);
    input.autoResize();
    const length = el.value.length;
    el.setSelectionRange(length, length);
  }

  function handleArrowKey(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
    const explicit = Boolean(event.ctrlKey || event.metaKey);
    const plainArrow = !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey;
    if (!plainArrow && !explicit) return false;
    const el = input.textareaRef.current;
    const isNavigatingHistory = promptHistoryRef.current.index >= 0;
    const canStartHistory = Boolean(el && !el.value.trim());
    if (!el || !(explicit || isNavigatingHistory || canStartHistory)) return false;
    // Re-read global history from localStorage on every navigation so
    // a clear from Settings (an overlay that keeps the Composer
    // mounted) is picked up immediately, and a transient storage
    // failure does not clobber the in-memory history.
    // reconcileHistorySync restores the saved draft if a clear happened
    // mid-navigation (so the user doesn't lose what they were typing).
    const synced = readGlobalInputHistory();
    const { state, restoreDraft } = reconcileHistorySync(promptHistoryRef.current, synced);
    promptHistoryRef.current = state;
    if (restoreDraft) {
      applyValue(el, state.savedDraft);
    }
    // Nothing to navigate when history was cleared (synced empty) — the
    // keystroke is swallowed so it can't fall through to other handlers.
    // When the storage read failed (synced === null), keep navigating
    // with the in-memory entries.
    if (synced !== null && synced.length === 0) return true;
    const next = navigateComposerHistory(
      promptHistoryRef.current,
      event.key === 'ArrowUp' ? 'previous' : 'next',
      el.value,
    );
    if (!next.changed) return false;
    event.preventDefault();
    promptHistoryRef.current = next.state;
    applyValue(el, next.value);
    return true;
  }

  return { resetNavigation, rememberSentEntry, handleArrowKey };
}
