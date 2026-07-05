/**
 * Global input history, persisted to localStorage.
 *
 * Shares the same dedup + max-entry semantics as
 * `rememberComposerHistoryEntry` from `composer-helpers.ts` (it delegates
 * to that helper rather than reimplementing the trim/dedupe/cap rules),
 * but survives page reloads and is shared across all Composer
 * instances (and any other input surface in the app).
 *
 * The storage key is prefixed with `maka-` to namespace it in
 * localStorage.
 */

import { rememberComposerHistoryEntry } from './composer-helpers.js';

const STORAGE_KEY = 'maka-input-history';

function loadEntries(): string[] | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    // localStorage unavailable (private browsing, SSR, quota lock) — signal
    // failure so the caller keeps its in-memory history instead of
    // clobbering it with empty.
    return null;
  }
  if (raw === null) return []; // nothing stored yet
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null; // unexpected shape — don't clobber memory
    return parsed.filter((e): e is string => typeof e === 'string');
  } catch {
    // Corrupt JSON — don't clobber in-memory history with empty.
    return null;
  }
}

function saveEntries(entries: string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // localStorage full, quota exceeded, or unavailable (SSR, private
    // browsing in some configurations) — silently ignore so the input
    // experience is never degraded by storage failures.
  }
}

/**
 * Read all global input history entries. Newest entry is last.
 *
 * Returns `null` when the storage read fails (localStorage unavailable,
 * corrupt JSON, unexpected shape) so the caller can keep its in-memory
 * history intact instead of treating a failure as "empty". Returns `[]`
 * when nothing is stored yet (a legitimate empty state).
 */
export function readGlobalInputHistory(): string[] | null {
  return loadEntries();
}

/**
 * Persist a sent input text to the global history.
 *
 * Delegates to `rememberComposerHistoryEntry` so the trim / dedup /
 * max-50 cap rules stay defined in exactly one place
 * (`composer-helpers.ts`); this module only adds the localStorage glue.
 */
export function saveGlobalInputHistoryEntry(text: string): void {
  // On storage read failure, seed from empty rather than clobbering —
  // saveEntries will still attempt the write, and the Composer's in-memory
  // history (updated separately via rememberComposerHistoryEntry) stays
  // the source of truth until storage is readable again.
  const next = rememberComposerHistoryEntry(loadEntries() ?? [], text);
  saveEntries(next);
}

/**
 * Remove every entry from the global input history.
 *
 * Provides the deletion story the persisted key needs so sensitive
 * prompts don't linger across refreshes / workspaces / sessions with
 * no way out. Called from Settings · 数据.
 */
export function clearGlobalInputHistory(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // localStorage unavailable (SSR, private browsing) — nothing to clear.
  }
}
