/**
 * Pure ARIA radiogroup keyboard helpers for the Settings ModelTable.
 *
 * Extracted from ProvidersPanel.tsx so the keyboard transition logic can be
 * unit-tested with node:test directly — the .tsx file pulls in React and
 * can't be imported by the desktop main test runner without JSX support.
 * Per @kenji's PR93 follow-up: lock down the a11y behavior so future
 * refactors don't regress to "focus-only, no select".
 *
 * The helpers take only the data needed to compute the transition:
 *   - `currentId` — id of the currently focused/selected radio (or undefined
 *     when no radio is focused yet, e.g. user just tabbed into the group)
 *   - `visibleIds` — radio ids in display order; what the user sees
 *   - `key` — the keyboard event's `event.key`
 *
 * Returns the next radio id, or `null` when the key isn't a radiogroup nav
 * key (caller should not preventDefault — Space/Enter still get the native
 * button click; printable keys still type into the search input).
 */

const NAV_KEYS = new Set(['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End']);

export function isRadioGroupNavKey(key: string): boolean {
  return NAV_KEYS.has(key);
}

/**
 * Resolve the single radio that should stay in the tab order for the current
 * filtered view. ARIA radiogroups need one tabbable item even when the selected
 * value is currently filtered out of the DOM; otherwise keyboard users cannot
 * tab into the visible results to choose a replacement.
 */
export function tabbableRadioId(
  selectedId: string | undefined,
  visibleIds: readonly string[],
): string | null {
  if (visibleIds.length === 0) return null;
  if (selectedId !== undefined && visibleIds.includes(selectedId)) return selectedId;
  return visibleIds[0] ?? null;
}

/**
 * Resolve the next radio id from the radio-group keyboard event. Returns
 * `null` for non-nav keys or empty groups; the caller should bail without
 * intercepting the key in either case.
 */
export function nextRadioId(
  currentId: string | undefined,
  visibleIds: readonly string[],
  key: string,
): string | null {
  if (visibleIds.length === 0) return null;
  if (!isRadioGroupNavKey(key)) return null;
  const currentIndex = currentId === undefined ? -1 : visibleIds.indexOf(currentId);
  const total = visibleIds.length;
  let nextIndex: number;
  switch (key) {
    case 'ArrowDown':
    case 'ArrowRight':
      nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % total;
      break;
    case 'ArrowUp':
    case 'ArrowLeft':
      nextIndex = currentIndex < 0 ? total - 1 : (currentIndex - 1 + total) % total;
      break;
    case 'Home':
      nextIndex = 0;
      break;
    case 'End':
      nextIndex = total - 1;
      break;
    default:
      return null;
  }
  return visibleIds[nextIndex] ?? null;
}
