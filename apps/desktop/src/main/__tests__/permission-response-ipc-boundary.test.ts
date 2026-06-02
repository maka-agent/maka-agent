import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { normalizePermissionResponse } from '../permission-response-guard.js';

describe('permission response IPC boundary', () => {
  it('normalizes valid allow / deny responses into the core shape', () => {
    assert.deepEqual(
      normalizePermissionResponse({
        requestId: 'permission-1',
        decision: 'allow',
        rememberForTurn: true,
        extra: 'ignored',
      }),
      {
        requestId: 'permission-1',
        decision: 'allow',
        rememberForTurn: true,
      },
    );
    assert.deepEqual(
      normalizePermissionResponse({ requestId: 'permission-2', decision: 'deny' }),
      { requestId: 'permission-2', decision: 'deny' },
    );
  });

  it('rejects malformed renderer decisions instead of treating them as allow', () => {
    assert.throws(() => normalizePermissionResponse(null), /Invalid permission response/);
    assert.throws(() => normalizePermissionResponse({ requestId: '', decision: 'allow' }), /requestId/);
    assert.throws(
      () => normalizePermissionResponse({ requestId: 'permission-1', decision: 'approve' }),
      /decision/,
    );
    assert.throws(
      () => normalizePermissionResponse({ requestId: 'permission-1', decision: 'deny', rememberForTurn: 'yes' }),
      /rememberForTurn/,
    );
  });

  it('routes sessions:respondToPermission through the main-process normalizer', async () => {
    const mainPath = fileURLToPath(new URL('../../../src/main/main.ts', import.meta.url));
    const main = await readFile(mainPath, 'utf8');
    const handler = main.match(/ipcMain\.handle\('sessions:respondToPermission'[\s\S]*?\n  \);/)?.[0] ?? '';

    assert.match(handler, /normalizePermissionResponse\(response\)/);
    assert.doesNotMatch(handler, /runtime\.respondToPermission\(sessionId,\s*response\)/);
  });
});
