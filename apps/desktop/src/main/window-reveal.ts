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
