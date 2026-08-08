import assert from 'node:assert/strict';
import { test } from 'node:test';
import { executeApplyPatchWithAdapter, type ApplyPatchFsAdapter } from '../apply-patch-engine.js';

test('preflights every hunk before the first mutation', async () => {
  const writes: string[] = [];
  const adapter: ApplyPatchFsAdapter = {
    lockKey: async (path) => path,
    snapshot: async () => ({ state: { kind: 'missing' }, token: 'missing' }),
    writeText: async (path, content) => {
      writes.push(`${path}:${content}`);
      return { path, bytes: Buffer.byteLength(content), token: 'written' };
    },
    deletePath: async (path) => ({ path }),
  };

  await assert.rejects(
    executeApplyPatchWithAdapter(
      `*** Begin Patch
*** Add File: created.txt
+created
*** Update File: missing.txt
@@
-old
+new
*** End Patch`,
      adapter,
      async (_key, run) => await run(),
    ),
    /Update File target missing/,
  );
  assert.deepEqual(writes, []);
});

test('obtains permission before reading file contents', async () => {
  const events: string[] = [];
  const adapter: ApplyPatchFsAdapter = {
    lockKey: async (path) => path,
    preflightPermissions: async () => {
      events.push('permission');
    },
    snapshot: async () => {
      events.push('snapshot');
      return { state: { kind: 'file', content: 'before\n' }, token: 'before' };
    },
    writeText: async (path, content) => ({
      path,
      bytes: Buffer.byteLength(content),
      token: 'after',
    }),
    deletePath: async (path) => ({ path }),
  };

  await executeApplyPatchWithAdapter(
    `*** Begin Patch
*** Update File: changed.txt
@@
-before
+after
*** End Patch`,
    adapter,
    async (_key, run) => await run(),
  );

  assert.deepEqual(events, ['permission', 'snapshot']);
});

test('passes each committed revision token to the next mutation of the same path', async () => {
  const expectedTokens: string[] = [];
  const adapter: ApplyPatchFsAdapter = {
    lockKey: async (path) => path,
    snapshot: async () => ({ state: { kind: 'missing' }, token: 'missing' }),
    writeText: async (path, content, _mode, expectedToken) => {
      expectedTokens.push(expectedToken);
      return {
        path,
        bytes: Buffer.byteLength(content),
        token: expectedToken === 'missing' ? 'created' : 'updated',
      };
    },
    deletePath: async (path) => ({ path }),
  };

  const result = await executeApplyPatchWithAdapter(
    `*** Begin Patch
*** Add File: same.txt
+before
*** Update File: same.txt
@@
-before
+after
*** End Patch`,
    adapter,
    async (_key, run) => await run(),
  );

  assert.equal(result.ok, true);
  assert.deepEqual(expectedTokens, ['missing', 'created']);
});

test('reports an uncertain write failure as a partial effect', async () => {
  const adapter: ApplyPatchFsAdapter = {
    lockKey: async (path) => path,
    snapshot: async () => ({ state: { kind: 'missing' }, token: 'missing' }),
    writeText: async () => {
      throw Object.assign(new Error('write outcome unknown'), { effectUnknown: true });
    },
    deletePath: async (path) => ({ path }),
  };

  const result = await executeApplyPatchWithAdapter(
    `*** Begin Patch
*** Add File: created.txt
+content
*** End Patch`,
    adapter,
    async (_key, run) => await run(),
  );

  assert.deepEqual(result, {
    ok: false,
    partial: true,
    effectUnknown: true,
    error: 'write outcome unknown',
    operations: [
      {
        operation: 'add',
        path: 'created.txt',
        status: 'failed',
        error: 'write outcome unknown',
        effectUnknown: true,
      },
    ],
    completed: [],
    uncompleted: ['created.txt'],
  });
});

test('keeps the committed prefix visible when a later mutation fails', async () => {
  const adapter: ApplyPatchFsAdapter = {
    lockKey: async (path) => path,
    snapshot: async () => ({ state: { kind: 'missing' }, token: 'missing' }),
    writeText: async (path, content) => {
      if (path === 'second.txt') throw new Error('second write failed');
      return { path, bytes: Buffer.byteLength(content), token: 'created' };
    },
    deletePath: async (path) => ({ path }),
  };

  const result = await executeApplyPatchWithAdapter(
    `*** Begin Patch
*** Add File: first.txt
+first
*** Add File: second.txt
+second
*** End Patch`,
    adapter,
    async (_key, run) => await run(),
  );

  assert.equal(result.ok, false);
  assert.equal(result.partial, true);
  assert.deepEqual(result.completed, ['first.txt']);
  assert.deepEqual(result.uncompleted, ['second.txt']);
});
