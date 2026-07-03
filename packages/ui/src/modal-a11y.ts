import { useEffect, type RefObject } from 'react';

/**
 * Hook for accessible modal dialogs.
 *
 * - Saves the element that had focus before the modal opened.
 * - Moves focus to the first focusable element inside the modal on mount
 *   (or the container itself if no focusable child exists).
 * - Traps Tab/Shift+Tab inside the modal.
 * - Optionally closes the modal on Escape.
 * - Restores focus to the previously-focused element on unmount.
 *
 * Implements rule "3. focus and dialogs (critical)" from the
 * fixing-accessibility skill.
 */
export function useModalA11y(
  containerRef: RefObject<HTMLElement | null>,
  onEscape?: () => void,
  initialFocusRef?: RefObject<HTMLElement | null>,
  options?: {
    /**
     * When the ref's current value is true at unmount, skip restoring
     * focus to the pre-modal element. Needed by flows that CLOSE the
     * modal by navigating somewhere else (e.g. search -> jump to a chat
     * turn): unconditionally yanking focus back to the trigger button
     * would fight the destination's own focus management.
     */
    suppressFocusRestoreRef?: RefObject<boolean>;
  },
): void {
  const suppressFocusRestoreRef = options?.suppressFocusRestoreRef;
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;

    const preferredInitial = initialFocusRef?.current;
    const initial = preferredInitial && container.contains(preferredInitial)
      ? preferredInitial
      : getFocusable(container)[0];
    if (initial) {
      initial.focus({ preventScroll: true });
    } else {
      if (!container.hasAttribute('tabindex')) container.setAttribute('tabindex', '-1');
      container.focus({ preventScroll: true });
    }

    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (!container) return;
      if (event.key === 'Escape' && onEscape) {
        event.stopPropagation();
        event.preventDefault();
        onEscape();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = getFocusable(container);
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !container.contains(active))) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!event.shiftKey && (active === last || !container.contains(active))) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    }

    container.addEventListener('keydown', onKeyDown);
    return () => {
      container.removeEventListener('keydown', onKeyDown);
      // Defer restoration so any in-flight focus changes (e.g. clicking a
      // button that unmounts the modal) settle before we yank focus back.
      queueMicrotask(() => {
        if (suppressFocusRestoreRef?.current) return;
        if (document.contains(container)) return;
        if (previouslyFocused && document.contains(previouslyFocused)) {
          previouslyFocused.focus?.({ preventScroll: true });
        }
      });
    };
  }, [containerRef, onEscape, initialFocusRef, suppressFocusRestoreRef]);
}

const FOCUSABLE_SELECTOR =
  'a[href], area[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), iframe, [tabindex]:not([tabindex="-1"])';

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => !element.hasAttribute('inert') && isVisible(element),
  );
}

function isVisible(element: HTMLElement): boolean {
  if (element.hidden) return false;
  // offsetParent is null for display:none ancestors and fixed-positioned roots,
  // but our modal elements are always rendered visible — so this is a sufficient
  // approximation without forcing layout.
  return element.offsetParent !== null || element === document.activeElement;
}
