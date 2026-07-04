/**
 * Global input history, persisted to localStorage.
 *
 * Shares the same dedup + max-entry semantics as
 * `rememberComposerHistoryEntry` from `composer-helpers.ts`, but
 * survives page reloads and is shared across all Composer
 * instances (and any other input surface in the app).
 *
 * The storage key is prefixed with `maka-` to namespace it in
 * localStorage.
 */

const STORAGE_KEY = 'maka-input-history';
const MAX_ENTRIES = 50;

function loadEntries(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e): e is string => typeof e === 'string');
  } catch {
    return [];
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
 */
export function readGlobalInputHistory(): string[] {
  return loadEntries();
}

/**
 * Persist a sent input text to the global history.
 *
 * Deduplicates: if the exact text already exists, it is moved to
 * the end (newest position). The total number of entries is capped
 * at `MAX_ENTRIES` (oldest entries are dropped first).
 */
export function saveGlobalInputHistoryEntry(text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  const entries = loadEntries();
  const filtered = entries.filter((entry) => entry !== trimmed);
  filtered.push(trimmed);
  if (filtered.length > MAX_ENTRIES) {
    // Drop oldest entries, keeping the newest MAX_ENTRIES
    filtered.splice(0, filtered.length - MAX_ENTRIES);
  }
  saveEntries(filtered);
}
