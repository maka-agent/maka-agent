/**
 * Watches workspace config files for external modifications and notifies the
 * renderer so the UI stays in sync when headless CLI, scripts, or the user's
 * editor modify llm-connections.json, credentials.json, or settings.json.
 *
 * Uses Node.js built-in fs.watch on the workspace directory (FSEvents on macOS,
 * inotify on Linux). Zero external dependencies.
 */
import { watch as fsWatch, type FSWatcher } from 'node:fs';
import { basename } from 'node:path';

export interface ConfigFileWatcherCallbacks {
  onConnectionsChanged: () => void;
  onSettingsChanged: () => void;
}

export interface ConfigFileWatcher {
  stop: () => void;
}

const DEBOUNCE_MS = 300;

type WatchListener = (eventType: string, filename: string | Buffer | null) => void;

type WatchImpl = (workspaceRoot: string, listener: WatchListener) => Pick<FSWatcher, 'on' | 'close'>;

interface ConfigFileWatcherOptions {
  watchImpl?: WatchImpl;
  debounceMs?: number;
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
}

const WATCHED_FILES: Record<string, keyof ConfigFileWatcherCallbacks> = {
  'llm-connections.json': 'onConnectionsChanged',
  'credentials.json': 'onConnectionsChanged',
  'settings.json': 'onSettingsChanged',
};

export function startConfigFileWatcher(
  workspaceRoot: string,
  callbacks: ConfigFileWatcherCallbacks,
  options: ConfigFileWatcherOptions = {},
): ConfigFileWatcher {
  const debounceMs = options.debounceMs ?? DEBOUNCE_MS;
  const setTimer = options.setTimeoutImpl ?? setTimeout;
  const clearTimer = options.clearTimeoutImpl ?? clearTimeout;
  const watchImpl = options.watchImpl ?? fsWatch;
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function schedule(timerKey: string, callbackKey: keyof ConfigFileWatcherCallbacks): void {
    const existing = debounceTimers.get(timerKey);
    if (existing) clearTimer(existing);
    debounceTimers.set(
      timerKey,
      setTimer(() => {
        debounceTimers.delete(timerKey);
        try {
          callbacks[callbackKey]();
        } catch {
          // non-fatal: watcher callback failure must not crash the app
        }
      }, debounceMs),
    );
  }

  let watcher: Pick<FSWatcher, 'on' | 'close'> | undefined;
  try {
    watcher = watchImpl(workspaceRoot, (_eventType, filename) => {
      if (!filename) {
        schedule('__fallback:connections', 'onConnectionsChanged');
        schedule('__fallback:settings', 'onSettingsChanged');
        return;
      }
      const name = basename(filename.toString());
      const callbackKey = WATCHED_FILES[name];
      if (!callbackKey) return;

      schedule(name, callbackKey);
    });
  } catch (error) {
    console.error('[config-watcher] failed to start:', error);
    return { stop() {} };
  }

  watcher.on('error', (error) => {
    console.error('[config-watcher] runtime error, stopping:', error);
    cleanup();
  });

  function cleanup(): void {
    watcher?.close();
    watcher = undefined;
    for (const timer of debounceTimers.values()) clearTimer(timer);
    debounceTimers.clear();
  }

  return { stop: cleanup };
}
