import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { createAutomationStore } from '../embedded-automation-store.js';

interface TestRecord {
  id: string;
  name: string;
  status?: string;
}

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('embedded Automation store', () => {
  test('preserves the production load/save/remove/sync API and schema', async () => {
    const root = await freshRoot();
    const store = createAutomationStore<TestRecord>(root);
    assert.deepEqual(await store.loadAll(), []);

    await store.save({ id: 'auto-1', name: 'first' });
    await store.save({ id: 'auto-2', name: 'second' });
    await store.save({ id: 'auto-1', name: 'updated', status: 'active' });
    assert.deepEqual(await store.loadAll(), [
      { id: 'auto-1', name: 'updated', status: 'active' },
      { id: 'auto-2', name: 'second' },
    ]);

    await store.remove('missing');
    await store.remove('auto-1');
    assert.deepEqual(await store.loadAll(), [{ id: 'auto-2', name: 'second' }]);

    await store.sync([{ id: 'replacement', name: 'replacement' }]);
    assert.deepEqual(await store.loadAll(), [{ id: 'replacement', name: 'replacement' }]);
    assert.deepEqual(JSON.parse(await readFile(join(root, 'automations.json'), 'utf8')), {
      version: 1,
      automations: [{ id: 'replacement', name: 'replacement' }],
    });
  });

  test('serializes concurrent saves', async () => {
    const root = await freshRoot();
    const store = createAutomationStore<TestRecord>(root);
    await Promise.all([
      store.save({ id: 'a', name: 'alpha' }),
      store.save({ id: 'b', name: 'beta' }),
      store.save({ id: 'c', name: 'gamma' }),
    ]);
    assert.deepEqual(
      (await store.loadAll()).map((record) => record.id),
      ['a', 'b', 'c'],
    );
  });

  test('fails loud for corrupt or unrecognized files', async () => {
    const root = await freshRoot();
    const path = join(root, 'automations.json');
    const store = createAutomationStore<TestRecord>(root);
    await writeFile(path, 'not valid json{{{', 'utf8');
    await assert.rejects(() => store.loadAll(), /not valid JSON/);

    await writeFile(path, JSON.stringify({ version: 99, automations: [] }), 'utf8');
    await assert.rejects(() => store.loadAll(), /unrecognized shape or version/);
  });
});

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'maka-embedded-automation-store-'));
  roots.push(root);
  return root;
}
