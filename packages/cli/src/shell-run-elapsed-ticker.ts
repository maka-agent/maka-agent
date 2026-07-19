import { refreshRunningShellRunElapsed, type MakaPiTranscriptState } from './pi-transcript.js';

type CancelInterval = () => void;
type ScheduleInterval = (callback: () => void, intervalMs: number) => CancelInterval;

export interface ShellRunElapsedTicker {
  sync(): void;
  dispose(): void;
}

export function createShellRunElapsedTicker(input: {
  state: MakaPiTranscriptState;
  onTick: () => void;
  now?: () => number;
  schedule?: ScheduleInterval;
}): ShellRunElapsedTicker {
  const now = input.now ?? Date.now;
  const schedule = input.schedule ?? scheduleInterval;
  let cancel: CancelInterval | undefined;

  const stop = () => {
    cancel?.();
    cancel = undefined;
  };
  const tick = () => {
    if (!refreshRunningShellRunElapsed(input.state, now())) {
      stop();
      return;
    }
    input.onTick();
  };

  return {
    sync() {
      const running = refreshRunningShellRunElapsed(input.state, now());
      if (running && !cancel) cancel = schedule(tick, 1_000);
      if (!running) stop();
    },
    dispose: stop,
  };
}

function scheduleInterval(callback: () => void, intervalMs: number): CancelInterval {
  const handle = setInterval(callback, intervalMs);
  handle.unref();
  return () => clearInterval(handle);
}
