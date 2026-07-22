import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { buildBuiltinTools } from '../builtin-tools.js';
import type {
  PrepareGitFileMutationInput,
  PreparedFileMutationCarrier,
} from '../git-file-checkpoint-carrier.js';
import type { DurableToolPreparationContext } from '../tool-runtime.js';
import type { PreparedFileMutationFact } from '../tool-recovery-facts.js';

describe('builtin prepared file mutations', () => {
  test('Write prepares its exact UTF-8 after image before durable dispatch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-prepared-write-'));
    const carrier = new FakeCarrier();
    const write = buildBuiltinTools({ fileMutationCheckpointCarrier: carrier }).find(
      (candidate) => candidate.name === 'Write',
    );
    assert.ok(write?.prepareDurableExecution);

    const preparation = await write.prepareDurableExecution(
      { path: 'created.txt', content: 'hello 世界' },
      preparationContext(root),
    );
    assert.ok(preparation);

    assert.equal(carrier.prepared.length, 1);
    assert.equal(carrier.prepared[0]?.operationId, 'operation-1');
    assert.equal(carrier.prepared[0]?.workspaceRoot, root);
    assert.equal(carrier.prepared[0]?.targetPath, 'created.txt');
    assert.equal(carrier.prepared[0]?.transform.id, 'maka.write.utf8');
    assert.deepEqual(
      Buffer.from(expectedContent(carrier.prepared[0]!, undefined)).toString('utf8'),
      'hello 世界',
    );
    assert.equal(preparation.runtimeFacts[0]?.kind, 'maka.file.prepared_mutation');

    await preparation.execute();
    assert.deepEqual(carrier.redone, ['operation-1']);
    await preparation.release();
  });

  test('Edit derives the after image from the exact before bytes using the shared transform', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-prepared-edit-'));
    const carrier = new FakeCarrier(Buffer.from('alpha\n  beta\ngamma\n'));
    const edit = buildBuiltinTools({ fileMutationCheckpointCarrier: carrier }).find(
      (candidate) => candidate.name === 'Edit',
    );
    assert.ok(edit?.prepareDurableExecution);

    const preparation = await edit.prepareDurableExecution(
      {
        path: 'source.txt',
        old_string: 'alpha\nbeta',
        new_string: 'changed',
      },
      preparationContext(root),
    );
    assert.ok(preparation);

    const input = carrier.prepared[0];
    assert.ok(input);
    assert.equal(input.transform.id, 'maka.edit.compute_edited_source');
    assert.equal(
      Buffer.from(expectedContent(input, carrier.beforeContent)).toString('utf8'),
      'changed\ngamma\n',
    );
    assert.match(input.transform.argsHash, /^[0-9a-f]{64}$/);

    assert.deepEqual(await preparation.execute(), {
      ok: true,
      path: join(root, 'source.txt'),
      replacements: 1,
      matchedVia: 'line-trimmed',
      startLine: 1,
      endLine: 2,
    });
  });

  test('falls back to the legacy execution path when the cwd has no Git checkpoint carrier', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-prepared-unavailable-'));
    const carrier = new FakeCarrier(undefined, false);
    const write = buildBuiltinTools({ fileMutationCheckpointCarrier: carrier }).find(
      (candidate) => candidate.name === 'Write',
    );
    assert.ok(write?.prepareDurableExecution);

    assert.equal(
      await write.prepareDurableExecution(
        { path: 'created.txt', content: 'hello' },
        preparationContext(root),
      ),
      undefined,
    );
    assert.equal(carrier.prepared.length, 0);
  });
});

class FakeCarrier implements PreparedFileMutationCarrier {
  readonly prepared: PrepareGitFileMutationInput[] = [];
  readonly redone: string[] = [];

  constructor(
    readonly beforeContent?: Uint8Array,
    private readonly available = true,
  ) {}

  async isAvailable(): Promise<boolean> {
    return this.available;
  }

  async prepare(input: PrepareGitFileMutationInput): Promise<PreparedFileMutationFact> {
    this.prepared.push(input);
    expectedContent(input, this.beforeContent);
    return fact(input.operationId, input.workspaceRoot, input.targetPath);
  }

  async redo(input: PreparedFileMutationFact): Promise<void> {
    this.redone.push(input.operationId);
  }
}

function expectedContent(
  input: PrepareGitFileMutationInput,
  before: Uint8Array | undefined,
): Uint8Array {
  return input.expectedContent !== undefined
    ? input.expectedContent
    : input.deriveExpectedContent(before);
}

function preparationContext(cwd: string): DurableToolPreparationContext {
  return {
    operationId: 'operation-1',
    sessionId: 'session-1',
    runId: 'run-1',
    turnId: 'turn-1',
    toolCallId: 'tool-1',
    cwd,
    permissionMode: 'ask',
    abortSignal: new AbortController().signal,
  };
}

function fact(
  operationId: string,
  workspaceRoot: string,
  targetPath: string,
): PreparedFileMutationFact {
  return {
    protocol: 'prepared_file_mutation_v1',
    operationId,
    workspaceRoot,
    canonicalPath: join(workspaceRoot, targetPath),
    relativePath: targetPath,
    before: { kind: 'missing' },
    expectedAfter: {
      kind: 'file',
      sha256: 'a'.repeat(64),
      blobOid: 'b'.repeat(40),
      byteLength: 1,
      mode: 0o100644,
    },
    transform: { id: 'test', version: 1, argsHash: 'c'.repeat(64) },
    carrier: {
      kind: 'git_object_v1',
      repositoryCommonDir: join(workspaceRoot, '.git'),
      retentionRef: `refs/maka/checkpoints/operations/${operationId}`,
    },
  };
}
