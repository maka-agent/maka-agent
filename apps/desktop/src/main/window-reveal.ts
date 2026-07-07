/**
 * PR-SHOW-AFTER-FIRST-COMMIT: shared reveal gate for the hidden main window.
 *
 * The BrowserWindow is created with `show: false` (main-window.ts) so the OS
 * never flashes the index.html `.maka-preload` skeleton before React paints.
 * Two callers reveal it: the `window:notifyRendererReady` IPC (fired from the
 * renderer's first React commit) and a fallback timer for a wedged renderer.
 * Both route through here so the show() decision lives in one place — and so
 * it stays unit-testable without an Electron runtime (main-window.ts itself
 * can't be imported under plain `node --test` because it pulls in `electron`).
 */

/** Minimal structural view of the BrowserWindow surface the gate touches. */
export interface RevealableWindow {
  isDestroyed(): boolean;
  isVisible(): boolean;
  show(): void;
}

/**
 * Reveal `win` unless it must stay hidden. Idempotent and focus-safe:
 * - `keepHidden` true (visual-smoke capture): never reveal — capture runs on
 *   the hidden window via `paintWhenInitiallyHidden`.
 * - null / destroyed window: no-op (teardown raced the timer or the IPC).
 * - already visible: no-op, so a second signal (HMR reload re-fires
 *   notifyRendererReady, or the timer races the signal) never re-shows and
 *   never steals foreground focus.
 */
export function showWindowOnceReady(win: RevealableWindow | null, keepHidden: boolean): void {
  if (keepHidden) return;
  if (!win || win.isDestroyed()) return;
  if (win.isVisible()) return;
  win.show();
}

/** Focus surface for deferred focus requests (see createWindowRevealGate). */
export interface FocusableRevealableWindow extends RevealableWindow {
  isMinimized(): boolean;
  restore(): void;
  focus(): void;
}

export interface WindowRevealGate {
  /** Re-arm for a freshly created window (macOS recreate after close-all). */
  reset(): void;
  /** Renderer first commit or fallback timeout: reveal + flush deferred focus. */
  markReady(win: FocusableRevealableWindow | null): void;
  /** Focus request (second-instance / activate): deferred until markReady. */
  requestFocus(win: FocusableRevealableWindow | null): void;
}

/**
 * Readiness-aware wrapper around showWindowOnceReady. Focus requests that
 * arrive before the renderer's first commit (user re-launches or clicks the
 * dock icon while the window is still hidden) must NOT show() the window —
 * that would flash the `.maka-preload` skeleton the hidden creation exists to
 * suppress. They are remembered and flushed as show()+focus() when markReady
 * fires, so the user's foreground intent is honored, just not early.
 *
 * `keepHidden` windows (visual-smoke capture / E2E) never show or take
 * focus from any path — captures run while the developer works elsewhere.
 */
export function createWindowRevealGate(keepHidden: boolean): WindowRevealGate {
  let ready = false;
  let pendingFocus = false;

  const focusNow = (win: FocusableRevealableWindow | null): void => {
    if (keepHidden) return;
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  };

  return {
    reset() {
      ready = false;
      pendingFocus = false;
    },
    markReady(win) {
      ready = true;
      showWindowOnceReady(win, keepHidden);
      if (pendingFocus) {
        pendingFocus = false;
        focusNow(win);
      }
    },
    requestFocus(win) {
      if (!ready) {
        pendingFocus = true;
        return;
      }
      focusNow(win);
    },
  };
}
