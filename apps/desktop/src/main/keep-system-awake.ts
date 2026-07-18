/**
 * Keep-system-awake controller for the 定时任务 (scheduled task) capability.
 *
 * Scheduled reminders are driven by an in-process timer (see
 * `plan-reminders`); when the machine sleeps that timer is frozen and the
 * reminder silently never fires. When the user enables 保持系统唤醒 we hold an
 * Electron `powerSaveBlocker` so background scheduled work keeps running.
 *
 * `prevent-app-suspension` (NOT `prevent-display-sleep`) is deliberate: it
 * keeps the *system* from suspending the app while still letting the display
 * sleep. That is exactly right for background scheduled work — we do not want
 * to force the user's monitor to stay lit just to run a timer.
 *
 * Kept free of any `electron` import so the start/stop bookkeeping can be
 * unit-tested under plain `node --test` (the caller injects electron's
 * `powerSaveBlocker`), mirroring how `notifications-policy.ts` keeps its
 * decision logic Electron-free while `notifications-ipc-main.ts` owns the
 * Electron surface.
 */

/** Electron `powerSaveBlocker`'s surface, narrowed to what we use. */
export interface PowerSaveBlockerLike {
  start(type: 'prevent-app-suspension' | 'prevent-display-sleep'): number;
  stop(id: number): void;
  isStarted(id: number): boolean;
}

export interface KeepSystemAwakeController {
  /**
   * Reconcile the blocker with the desired state. Starts the blocker when
   * `enabled` and it is not already running; stops it when `!enabled` and it
   * is running. Idempotent — safe to call on every settings change and at
   * launch.
   */
  apply(enabled: boolean): void;
  /** Whether a blocker is currently held (for diagnostics / tests). */
  isActive(): boolean;
}

export function createKeepSystemAwakeController(
  blocker: PowerSaveBlockerLike,
): KeepSystemAwakeController {
  // The single blocker id we own, or null when nothing is held. Tracking the
  // id (plus an `isStarted` re-check) guards against a double-start leaking a
  // second, unreleasable blocker.
  let blockerId: number | null = null;

  function start(): void {
    // Guard double-start: if we already hold a live blocker, do nothing.
    if (blockerId !== null && blocker.isStarted(blockerId)) return;
    blockerId = blocker.start('prevent-app-suspension');
  }

  function stop(): void {
    if (blockerId === null) return;
    // The blocker may have been released out from under us (process teardown
    // races); only call stop when it is genuinely still running.
    if (blocker.isStarted(blockerId)) blocker.stop(blockerId);
    blockerId = null;
  }

  return {
    apply(enabled: boolean): void {
      if (enabled) start();
      else stop();
    },
    isActive(): boolean {
      return blockerId !== null && blocker.isStarted(blockerId);
    },
  };
}
