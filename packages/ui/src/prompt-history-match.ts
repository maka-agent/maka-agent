/**
 * Prompt-history matching — the decision behind the composer's inline
 * completion.
 *
 * This retrieves text the user has already sent. It does not generate one, and
 * it is deliberately not a "suggestion" abstraction: a future model completion
 * would be asynchronous, cancellable and metered, and a prompt recommendation
 * need not extend a typed prefix at all. Those are different decision
 * contracts and belong in their own modules; only the visual seam
 * (`ChatComposerInput`'s `inlineCompletion`) is worth sharing.
 *
 * Pure, and pure of the DOM too: the caret, the selection, wrapping and
 * whether anything else already owns Tab are the editor's business, and it
 * answers all of them itself. What is left here is the one question the
 * composer can answer — given this draft and this history, what would finish
 * it — plus the two guards that keep the answer honest:
 *
 *   - a match must be a true prefix extension, so what is offered is exactly
 *     what appending it produces;
 *   - a draft too short to distinguish prompts is not matched, because at one
 *     or two characters nearly every entry qualifies and the offer would
 *     flicker through unrelated old prompts.
 */

/**
 * Shortest draft that earns a match. One character matches nearly every
 * history entry.
 */
export const PROMPT_HISTORY_MATCH_MIN_DRAFT = 2;

/**
 * The remainder of the newest history entry that `draft` is a prefix of, or
 * null when nothing matches.
 *
 * Returns the remainder rather than the entry so the caller appends instead of
 * replacing: whatever the user typed is never rewritten, which matters for the
 * case-insensitive pass below — typing `fix ` must not be recased to a stored
 * `Fix `.
 */
export function matchPromptHistory(draft: string, entries: readonly string[]): string | null {
  if (draft.trim().length < PROMPT_HISTORY_MATCH_MIN_DRAFT) return null;

  // Newest first: the most recent matching prompt is the one the user is most
  // likely retyping.
  const exact = newestMatch((entry) => entry.startsWith(draft));
  if (exact !== null) return exact.slice(draft.length);
  // Second pass ignores case, so a draft that starts lowercase still finds the
  // capitalized prompt it is a prefix of.
  const lowered = draft.toLowerCase();
  const insensitive = newestMatch((entry) => entry.toLowerCase().startsWith(lowered));
  return insensitive === null ? null : insensitive.slice(draft.length);

  function newestMatch(matches: (entry: string) => boolean): string | null {
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index];
      // Equal length means the draft already *is* that entry — nothing is left
      // to complete.
      if (entry === undefined || entry.length <= draft.length) continue;
      if (matches(entry)) return entry;
    }
    return null;
  }
}
