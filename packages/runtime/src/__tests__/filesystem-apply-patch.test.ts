import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createBoundaryFilesystemExecutor } from '../filesystem-executor.js';
import { createLocalWorkspaceExecutor } from '../workspace-executor.js';

test('applies one multi-file patch through the filesystem authority', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'maka-apply-patch-authority-'));
  try {
    await writeFile(join(cwd, 'changed.txt'), 'before\n', 'utf8');
    await writeFile(join(cwd, 'removed.txt'), 'remove\n', 'utf8');
    const filesystem = createBoundaryFilesystemExecutor({
      workspace: createLocalWorkspaceExecutor(),
    });

    const result = await filesystem.applyPatch({
      cwd,
      patch: `*** Begin Patch
*** Add File: added.txt
+added
*** Update File: changed.txt
@@
-before
+after
*** Delete File: removed.txt
*** End Patch`,
    });

    assert.equal(result.ok, true);
    assert.equal(await readFile(join(cwd, 'added.txt'), 'utf8'), 'added\n');
    assert.equal(await readFile(join(cwd, 'changed.txt'), 'utf8'), 'after\n');
    await assert.rejects(readFile(join(cwd, 'removed.txt'), 'utf8'), { code: 'ENOENT' });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
