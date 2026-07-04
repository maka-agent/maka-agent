import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { startConfigFileWatcher } from '../config-file-watcher.js';

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('config-file-watcher', () => {
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
      await wait(100);
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
      await wait(100);
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
      await wait(100);
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
      await writeFile(join(dir, 'telemetry.json'), '{}');
      await writeFile(join(dir, 'random.txt'), 'hello');
      await wait(500);
      assert.equal(connectionsCalled, 0);
      assert.equal(settingsCalled, 0);
    } finally {
      watcher.stop();
    }
  });

  test('suppressSelfWrite prevents firing for the suppressed window', async () => {
    let called = 0;
    const watcher = startConfigFileWatcher(dir, {
      onConnectionsChanged: () => { called++; },
      onSettingsChanged: () => {},
    });
    try {
      watcher.suppressSelfWrite('llm-connections.json');
      await writeFile(join(dir, 'llm-connections.json'), '{"suppressed": true}');
      await wait(500);
      assert.equal(called, 0, 'should not fire during suppression window');
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
      await writeFile(join(dir, 'llm-connections.json'), '{"v":1}');
      await wait(50);
      await writeFile(join(dir, 'llm-connections.json'), '{"v":2}');
      await wait(50);
      await writeFile(join(dir, 'llm-connections.json'), '{"v":3}');
      await wait(500);
      assert.ok(called <= 2, `expected debounce to coalesce, got ${called} calls`);
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
