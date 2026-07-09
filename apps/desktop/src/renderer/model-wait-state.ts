/**
 * Pure model-wait derivation + rising-edge debounce for the "正在处理…"
 * indicator (#646).
 *
 * The indicator shows while the model is being awaited with nothing else
 * streaming — one derived predicate, plus a delay so a fast first token never
 * flashes it. Kept free of React so the timing is unit-tested with an injected
 * scheduler (fake timers) — the layer where the real bugs live (200ms race,
 * mid-turn recover, arm/cancel).
 */

/** Rising-edge delay before the processing indicator appears. Tunable. */
export const MODEL_PROCESSING_DELAY_MS = 200;

export interface ModelWaitInputs {
  /** Turn armed locally at send(); cleared on complete / error / abort. */
  turnActive: boolean;
  /** Active session's live assistant answer buffer. */
  streamingText: string;
  /** Active session's live reasoning buffer. */
  thinkingText: string;
  /** Whether any live tool is still pending / running / awaiting permission. */
  hasInFlightTools: boolean;
}

/**
 * True when the model is being awaited and nothing is currently streaming —
 * covers both the turn head (send → first content) and the mid-turn resume gap
 * after a tool settles: `hasInFlightTools` falls back to false, so the predicate
 * re-satisfies on its own with no explicit re-arm event.
 */
export function deriveModelWaitIdle(input: ModelWaitInputs): boolean {
  return (
    input.turnActive &&
    input.streamingText.length === 0 &&
    input.thinkingText.length === 0 &&
    !input.hasInFlightTools
  );
}

export interface DelayedFlagScheduler {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface DelayedFlag {
  /** Feed the current condition; drives the flag through the delay. */
  setCondition(active: boolean): void;
  /** Current visible flag. */
  get(): boolean;
  /** Cancel any pending timer (unmount / teardown). */
  dispose(): void;
}

/**
 * A rising-edge–delayed boolean. The flag turns true only after the condition
 * stays true for `delayMs`; if the condition drops before the delay elapses the
 * flag never turns true (the fast-response no-flash rule). Falling to false is
 * immediate. The scheduler is injected so the timing is testable with fake
 * timers instead of a real 200ms wall-clock wait.
 */
export function createDelayedFlag(opts: {
  delayMs: number;
  scheduler: DelayedFlagScheduler;
  onChange?: (visible: boolean) => void;
}): DelayedFlag {
  const { delayMs, scheduler, onChange } = opts;
  let condition = false;
  let visible = false;
  let timer: unknown = null;

  function clearTimer(): void {
    if (timer !== null) {
      scheduler.clearTimeout(timer);
      timer = null;
    }
  }

  function emit(next: boolean): void {
    if (next === visible) return;
    visible = next;
    onChange?.(visible);
  }

  return {
    setCondition(active: boolean): void {
      if (active === condition) return;
      condition = active;
      if (active) {
        // Rising edge: arm once. Already-visible (re-entrant true) keeps state.
        if (!visible && timer === null) {
          timer = scheduler.setTimeout(() => {
            timer = null;
            emit(true);
          }, delayMs);
        }
      } else {
        // Falling edge: cancel a pending reveal and hide immediately.
        clearTimer();
        emit(false);
      }
    },
    get(): boolean {
      return visible;
    },
    dispose(): void {
      clearTimer();
    },
  };
}
