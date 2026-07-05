import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { startConfigFileWatcher, type ConfigFileWatcher, type ConfigFileWatcherCallbacks } from '../config-file-watcher.js';

const GRACE_SETTLE_MS = 400;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type WatchListener = (eventType: string, filename: string | Buffer | null) => void;

interface FakeStartResult {
  emit: (filename: string | Buffer | null) => void;
  watcher: ConfigFileWatcher;
}

function startWithFakeWatcher(callbacks: ConfigFileWatcherCallbacks): FakeStartResult {
  let listener: WatchListener | undefined;
  const start = startConfigFileWatcher as unknown as (
    workspaceRoot: string,
    callbacks: ConfigFileWatcherCallbacks,
    options: {
      watchImpl: (workspaceRoot: string, listener: WatchListener) => { on(event: 'error', listener: (error: Error) => void): void; close(): void };
      startupGraceMs: number;
      debounceMs: number;
      now: () => number;
      setTimeoutImpl: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
      clearTimeoutImpl: (timer: ReturnType<typeof setTimeout>) => void;
    },
  ) => ConfigFileWatcher;

  const watcher = start('/fake-workspace', callbacks, {
    watchImpl: (_workspaceRoot, nextListener) => {
      listener = nextListener;
      return { on() {}, close() {} };
    },
    startupGraceMs: 0,
    debounceMs: 0,
    now: () => 1_000,
    setTimeoutImpl: (callback) => {
      callback();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeoutImpl: () => {},
  });

  return {
    watcher,
    emit(filename) {
      assert.ok(listener, 'fake watcher listener must be registered');
      listener('change', filename);
    },
  };
}

describe('config-file-watcher', () => {
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
      await wait(GRACE_SETTLE_MS);
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
      await wait(GRACE_SETTLE_MS);
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
      await wait(GRACE_SETTLE_MS);
      await writeFile(join(dir, 'settings.json'), '{"appearance":{"theme":"dark"}}');
      await wait(800);
      assert.ok(called >= 1, `expected onSettingsChanged to fire, got ${called} calls`);
    } finally {
      watcher.stop();
    }
  });

  test('does not fire for unrelated files', async () => {
    let connectionsCalled = 0;
    let settingsCalled = 0;
    const watcher = startConfigFileWatcher(dir, {
      onConnectionsChanged: () => { connectionsCalled++; },
      onSettingsChanged: () => { settingsCalled++; },
    });
    try {
      await wait(GRACE_SETTLE_MS);
      await writeFile(join(dir, 'telemetry.json'), '{}');
      await writeFile(join(dir, 'random.txt'), 'hello');
      await wait(500);
      assert.equal(connectionsCalled, 0);
      assert.equal(settingsCalled, 0);
    } finally {
      watcher.stop();
    }
  });

  test('debounces rapid writes into a single callback', async () => {
    let called = 0;
    const watcher = startConfigFileWatcher(dir, {
      onConnectionsChanged: () => { called++; },
      onSettingsChanged: () => {},
    });
    try {
      await wait(GRACE_SETTLE_MS);
      await writeFile(join(dir, 'llm-connections.json'), '{"v":1}');
      await wait(50);
      await writeFile(join(dir, 'llm-connections.json'), '{"v":2}');
      await wait(50);
      await writeFile(join(dir, 'llm-connections.json'), '{"v":3}');
      await wait(500);
      assert.equal(called, 1, `expected debounce to coalesce into 1 call, got ${called} calls`);
    } finally {
      watcher.stop();
    }
  });

  test('stop() prevents further callbacks', async () => {
    let called = 0;
    const watcher = startConfigFileWatcher(dir, {
      onConnectionsChanged: () => { called++; },
      onSettingsChanged: () => {},
    });
    await wait(GRACE_SETTLE_MS);
    watcher.stop();
    await writeFile(join(dir, 'llm-connections.json'), '{"after-stop": true}');
    await wait(500);
    assert.equal(called, 0, 'should not fire after stop()');
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
