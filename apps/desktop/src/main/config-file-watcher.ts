/**
 * Watches workspace config files for external modifications and notifies the
 * renderer so the UI stays in sync when headless CLI, scripts, or the user's
 * editor modify llm-connections.json, credentials.json, or settings.json.
 *
 * Uses Node.js built-in fs.watch on the workspace directory (FSEvents on macOS,
 * inotify on Linux). Zero external dependencies.
 */
import { watch, type FSWatcher } from 'node:fs';
import { basename } from 'node:path';

export interface ConfigFileWatcherCallbacks {
  onConnectionsChanged: () => void;
  onSettingsChanged: () => void;
}

export interface ConfigFileWatcher {
  stop: () => void;
  suppressSelfWrite: (filename: string) => void;
}

const DEBOUNCE_MS = 300;
const SELF_WRITE_SUPPRESS_MS = 500;
const STARTUP_GRACE_MS = 350;

const WATCHED_FILES: Record<string, keyof ConfigFileWatcherCallbacks> = {
  'llm-connections.json': 'onConnectionsChanged',
  'credentials.json': 'onConnectionsChanged',
  'settings.json': 'onSettingsChanged',
};

export function startConfigFileWatcher(
  workspaceRoot: string,
  callbacks: ConfigFileWatcherCallbacks,
): ConfigFileWatcher {
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const suppressUntil = new Map<string, number>();
  const startedAt = Date.now();

  let watcher: FSWatcher | undefined;
  try {
    watcher = watch(workspaceRoot, (_eventType, filename) => {
      if (Date.now() - startedAt < STARTUP_GRACE_MS) return;
      if (!filename) return;
      const name = basename(filename);
      const callbackKey = WATCHED_FILES[name];
      if (!callbackKey) return;

      const until = suppressUntil.get(name);
      if (until && Date.now() < until) return;

      const existing = debounceTimers.get(name);
      if (existing) clearTimeout(existing);
      debounceTimers.set(
        name,
        setTimeout(() => {
          debounceTimers.delete(name);
          try {
            callbacks[callbackKey]();
          } catch {
            // non-fatal: watcher callback failure must not crash the app
          }
        }, DEBOUNCE_MS),
      );
    });
  } catch (error) {
    console.error('[config-watcher] failed to start:', error);
    return { stop() {}, suppressSelfWrite() {} };
  }

  watcher.on('error', (error) => {
    console.error('[config-watcher] runtime error, stopping:', error);
    cleanup();
  });

  function cleanup(): void {
    watcher?.close();
    watcher = undefined;
    for (const timer of debounceTimers.values()) clearTimeout(timer);
    debounceTimers.clear();
  }

  return {
    stop: cleanup,
    suppressSelfWrite(filename: string) {
      suppressUntil.set(filename, Date.now() + SELF_WRITE_SUPPRESS_MS);
    },
  };
}
