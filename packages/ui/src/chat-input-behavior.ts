export interface ChatInputCompositionEvent {
  key?: string;
  nativeEvent: object;
}

export function isChatInputComposing(
  event: ChatInputCompositionEvent,
  trackedComposition = false,
): boolean {
  return trackedComposition || event.key === 'Process'
    || ('isComposing' in event.nativeEvent && event.nativeEvent.isComposing === true);
}

export function fileTransferContainsFiles(types: Iterable<string>, fileCount: number): boolean {
  return fileCount > 0 || Array.from(types).includes('Files');
}

export interface TextInputSelectionTarget {
  value: string;
  focus(): void;
  setSelectionRange(start: number, end: number): void;
}

export function focusTextInputAtEnd(input: TextInputSelectionTarget): void {
  input.focus();
  const end = input.value.length;
  input.setSelectionRange(end, end);
}

/**
 * Composer `@` / `/` mention trigger detection.
 *
 * Decompiled from the QoderWork/WorkBuddy composer bundles and adapted to our
 * plain-text v1 (see docs/archive/composer-mentions-spec-2026-07-14.md). Pure so it
 * can be unit-pinned without a DOM: given the current textarea value + caret
 * offset it reports the active trigger, the query typed after it, and the
 * trigger char's index (so the caller can splice `[start, caret)` on select).
 *
 * `@` references a workspace file (query may contain single spaces — filenames
 * do); `/` references a skill (single-token — any space kills it).
 */
export type MentionTriggerChar = '@' | '/';

export interface MentionTrigger {
  trigger: MentionTriggerChar;
  query: string;
  /** Index of the trigger char itself in `value` (the `@` or `/`). */
  start: number;
}

export function detectMentionTrigger(value: string, caret: number): MentionTrigger | null {
  // Clamp the caret into the value so a stale/oversized offset can't slice
  // out of bounds (selectionStart can momentarily lead the value on paste).
  const pos = Math.max(0, Math.min(caret, value.length));
  // The word boundary defines what counts as a trigger at all: an `@`/`/` is a
  // trigger only when the char before it is start-of-input or whitespace. A
  // `/` inside a path (`@src/app`) or an `@` inside an email (`user@host`) is
  // NOT a trigger — it's just part of a query. So we scan left from the caret
  // for the NEAREST boundary-anchored `@`/`/` (the "consider the nearer one"
  // rule, applied to real triggers) and ignore the non-boundary ones.
  let start = -1;
  let trigger: MentionTriggerChar | null = null;
  for (let i = pos - 1; i >= 0; i--) {
    const ch = value[i];
    if (ch !== '@' && ch !== '/') continue;
    if (i === 0 || /\s/.test(value[i - 1]!)) {
      start = i;
      trigger = ch;
      break;
    }
    // A non-boundary `@`/`/` is part of the query text — keep scanning.
  }
  if (start < 0 || trigger === null) return null;
  const query = value.slice(start + 1, pos);
  if (trigger === '@') {
    // Filenames can contain single spaces and slashes, so only a double space
    // or a newline (never part of one path token) invalidates the `@` query.
    if (query.includes('\n') || query.includes('  ')) return null;
  } else if (/\s/.test(query)) {
    // Skills are a single token — any whitespace (incl. newline) ends it.
    return null;
  }
  return { trigger, query, start };
}

/**
 * Case-insensitive AND-of-substring matcher shared by the file re-filter and
 * the skill filter: every whitespace-separated token in `query` must appear
 * somewhere in `text`. An empty query matches everything (shows the full list).
 */
export function mentionQueryMatches(query: string, text: string): boolean {
  const haystack = text.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .every((token) => haystack.includes(token));
}

/** Normalize `/skill:<query>` and bare `/<query>` into the same Skill search query. */
export function skillMentionQuery(query: string): string {
  return query.toLowerCase().startsWith('skill:') ? query.slice('skill:'.length) : query;
}

export interface ChatInputActionOwner<ActionId> {
  readonly pending: ActionId | null;
  run<Result>(actionId: ActionId, action: () => Promise<Result>): Promise<Result | undefined>;
  reset(): void;
}

export function createChatInputActionOwner<ActionId>(
  onPendingChange: (action: ActionId | null) => void,
): ChatInputActionOwner<ActionId> {
  let pending: ActionId | null = null;
  let generation = 0;
  return {
    get pending() {
      return pending;
    },
    async run<Result>(actionId: ActionId, action: () => Promise<Result>): Promise<Result | undefined> {
      if (pending !== null) return undefined;
      const ownedGeneration = ++generation;
      pending = actionId;
      onPendingChange(actionId);
      try {
        return await action();
      } finally {
        if (generation === ownedGeneration && pending === actionId) {
          pending = null;
          onPendingChange(null);
        }
      }
    },
    reset() {
      generation += 1;
      pending = null;
    },
  };
}
