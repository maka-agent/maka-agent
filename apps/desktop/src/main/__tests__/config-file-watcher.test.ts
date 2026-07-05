import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { startConfigFileWatcher, type ConfigFileWatcher, type ConfigFileWatcherCallbacks } from '../config-file-watcher.js';

const WATCH_SETTLE_MS = 400;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type WatchListener = (eventType: string, filename: string | Buffer | null) => void;
type WatchErrorListener = (error: Error) => void;

interface FakeStartResult {
  emit: (filename: string | Buffer | null) => void;
  emitError: (error?: Error) => void;
  watcher: ConfigFileWatcher;
  closeCount: () => number;
  pendingTimers: () => Array<ReturnType<typeof setTimeout>>;
  clearedTimers: () => Array<ReturnType<typeof setTimeout>>;
  runPendingTimers: () => void;
}

interface FakeWatcherOptions {
  immediateTimers?: boolean;
}

function startWithFakeWatcher(callbacks: ConfigFileWatcherCallbacks, fakeOptions: FakeWatcherOptions = {}): FakeStartResult {
  let listener: WatchListener | undefined;
  let errorListener: WatchErrorListener | undefined;
  let closeCalls = 0;
  let nextTimer = 0;
  const pendingTimers = new Map<ReturnType<typeof setTimeout>, () => void>();
  const clearedTimers: Array<ReturnType<typeof setTimeout>> = [];
  const start = startConfigFileWatcher as unknown as (
    workspaceRoot: string,
    callbacks: ConfigFileWatcherCallbacks,
    options: {
      watchImpl: (workspaceRoot: string, listener: WatchListener) => { on(event: 'error', listener: WatchErrorListener): void; close(): void };
      debounceMs: number;
      setTimeoutImpl: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
      clearTimeoutImpl: (timer: ReturnType<typeof setTimeout>) => void;
    },
  ) => ConfigFileWatcher;

  const watcher = start('/fake-workspace', callbacks, {
    watchImpl: (_workspaceRoot, nextListener) => {
      listener = nextListener;
      return {
        on(_event, nextErrorListener) { errorListener = nextErrorListener; },
        close() { closeCalls++; },
      };
    },
    debounceMs: 0,
    setTimeoutImpl: (callback) => {
      const timer = ++nextTimer as unknown as ReturnType<typeof setTimeout>;
      if (fakeOptions.immediateTimers === false) pendingTimers.set(timer, callback);
      else callback();
      return timer;
    },
    clearTimeoutImpl: (timer) => {
      clearedTimers.push(timer);
      pendingTimers.delete(timer);
    },
  });

  return {
    watcher,
    emit(filename) {
      assert.ok(listener, 'fake watcher listener must be registered');
      listener('change', filename);
    },
    emitError(error = new Error('watch failed')) {
      assert.ok(errorListener, 'fake watcher error listener must be registered');
      errorListener(error);
    },
    closeCount: () => closeCalls,
    pendingTimers: () => Array.from(pendingTimers.keys()),
    clearedTimers: () => [...clearedTimers],
    runPendingTimers() {
      for (const [timer, callback] of [...pendingTimers.entries()]) {
        pendingTimers.delete(timer);
        callback();
      }
    },
  };
}

describe('config-file-watcher', () => {
  test('does not drop named config events emitted immediately after startup', () => {
    let connectionsCalled = 0;
    let settingsCalled = 0;
    const { emit, watcher } = startWithFakeWatcher({
      onConnectionsChanged: () => { connectionsCalled++; },
      onSettingsChanged: () => { settingsCalled++; },
    });
    try {
      emit('llm-connections.json');
      emit('settings.json');
      assert.equal(connectionsCalled, 1, 'startup must not drop immediate connection-file changes');
      assert.equal(settingsCalled, 1, 'startup must not drop immediate settings changes');
    } finally {
      watcher.stop();
    }
  });

  test('runtime watcher errors close the watcher and clear pending debounce timers', () => {
    let connectionsCalled = 0;
    const fake = startWithFakeWatcher({
      onConnectionsChanged: () => { connectionsCalled++; },
      onSettingsChanged: () => {},
    }, { immediateTimers: false });
    try {
      fake.emit('llm-connections.json');
      assert.equal(fake.pendingTimers().length, 1, 'named changes should create a pending debounce timer');
      fake.emitError();
      assert.equal(fake.closeCount(), 1, 'runtime watcher error should close the watcher');
      assert.equal(fake.clearedTimers().length, 1, 'runtime watcher error should clear pending debounce timers');
      assert.equal(fake.pendingTimers().length, 0, 'runtime watcher error should leave no pending debounce timers');
      assert.equal(connectionsCalled, 0, 'cleared debounce callback must not run after watcher error');
      fake.watcher.stop();
      assert.equal(fake.closeCount(), 1, 'stop after runtime error should be idempotent');
    } finally {
      fake.watcher.stop();
    }
  });

  test('refreshes settings and connections when fs.watch omits the filename', () => {
    let connectionsCalled = 0;
    let settingsCalled = 0;
    const { emit, watcher } = startWithFakeWatcher({
      onConnectionsChanged: () => { connectionsCalled++; },
      onSettingsChanged: () => { settingsCalled++; },
    });
    try {
      emit(null);
      assert.equal(connectionsCalled, 1, 'filename-less events should conservatively refresh connection state');
      assert.equal(settingsCalled, 1, 'filename-less events should conservatively refresh settings state');
    } finally {
      watcher.stop();
    }
  });

  test('does not suppress a real external write after an internal write marker', () => {
    let connectionsCalled = 0;
    const { emit, watcher } = startWithFakeWatcher({
      onConnectionsChanged: () => { connectionsCalled++; },
      onSettingsChanged: () => {},
    });
    try {
      (watcher as unknown as { suppressSelfWrite?: (filename: string) => void }).suppressSelfWrite?.('llm-connections.json');
      emit('llm-connections.json');
      assert.equal(connectionsCalled, 1, 'external writes must not be swallowed by a filename/time suppression window');
    } finally {
      watcher.stop();
    }
  });

  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'maka-watcher-test-'));
    await writeFile(join(dir, 'llm-connections.json'), '{}');
    await writeFile(join(dir, 'credentials.json'), '{}');
    await writeFile(join(dir, 'settings.json'), '{}');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('fires onConnectionsChanged when llm-connections.json is modified', async () => {
    let called = 0;
    const watcher = startConfigFileWatcher(dir, {
      onConnectionsChanged: () => { called++; },
      onSettingsChanged: () => {},
    });
    try {
      await wait(WATCH_SETTLE_MS);
      await writeFile(join(dir, 'llm-connections.json'), '{"changed": true}');
      await wait(800);
      assert.ok(called >= 1, `expected onConnectionsChanged to fire, got ${called} calls`);
    } finally {
      watcher.stop();
    }
  });

  test('fires onConnectionsChanged when credentials.json is modified', async () => {
    let called = 0;
    const watcher = startConfigFileWatcher(dir, {
      onConnectionsChanged: () => { called++; },
      onSettingsChanged: () => {},
    });
    try {
      await wait(WATCH_SETTLE_MS);
      await writeFile(join(dir, 'credentials.json'), '{"version":1,"values":{}}');
      await wait(800);
      assert.ok(called >= 1, `expected onConnectionsChanged to fire, got ${called} calls`);
    } finally {
      watcher.stop();
    }
  });

  test('fires onSettingsChanged when settings.json is modified', async () => {
    let called = 0;
    const watcher = startConfigFileWatcher(dir, {
      onConnectionsChanged: () => {},
      onSettingsChanged: () => { called++; },
    });
    try {
      await wait(WATCH_SETTLE_MS);
      await writeFile(join(dir, 'settings.json'), '{"appearance":{"theme":"dark"}}');
      await wait(800);
      assert.ok(called >= 1, `expected onSettingsChanged to fire, got ${called} calls`);
    } finally {
      watcher.stop();
    }
  });

  test('does not fire for unrelated files', () => {
    let connectionsCalled = 0;
    let settingsCalled = 0;
    const { emit, watcher } = startWithFakeWatcher({
      onConnectionsChanged: () => { connectionsCalled++; },
      onSettingsChanged: () => { settingsCalled++; },
    });
    try {
      emit('telemetry.json');
      emit('random.txt');
      assert.equal(connectionsCalled, 0);
      assert.equal(settingsCalled, 0);
    } finally {
      watcher.stop();
    }
  });

  test('debounces rapid writes into a single callback', () => {
    let called = 0;
    const fake = startWithFakeWatcher({
      onConnectionsChanged: () => { called++; },
      onSettingsChanged: () => {},
    }, { immediateTimers: false });
    try {
      fake.emit('llm-connections.json');
      fake.emit('llm-connections.json');
      fake.emit('llm-connections.json');
      assert.equal(fake.pendingTimers().length, 1, 'rapid writes should leave one pending debounce timer');
      assert.equal(fake.clearedTimers().length, 2, 'rapid writes should clear superseded debounce timers');
      fake.runPendingTimers();
      assert.equal(called, 1, `expected debounce to coalesce into 1 call, got ${called} calls`);
    } finally {
      fake.watcher.stop();
    }
  });

  test('stop() clears pending callbacks', () => {
    let called = 0;
    const fake = startWithFakeWatcher({
      onConnectionsChanged: () => { called++; },
      onSettingsChanged: () => {},
    }, { immediateTimers: false });
    fake.emit('llm-connections.json');
    assert.equal(fake.pendingTimers().length, 1, 'named changes should create a pending debounce timer');
    fake.watcher.stop();
    assert.equal(fake.clearedTimers().length, 1, 'stop should clear pending debounce timers');
    fake.runPendingTimers();
    assert.equal(called, 0, 'cleared debounce callback must not run after stop()');
  });

  test('returns no-op watcher when directory does not exist', () => {
    const watcher = startConfigFileWatcher('/nonexistent/path/xyz', {
      onConnectionsChanged: () => {},
      onSettingsChanged: () => {},
    });
    // Should not throw, just returns a no-op
    watcher.stop();
  });
});
