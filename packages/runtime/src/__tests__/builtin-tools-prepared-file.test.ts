import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { buildBuiltinTools } from '../builtin-tools.js';
import { DurableToolExecutionUnsettledError } from '../durable-tool-execution.js';
import {
  FilesystemWorkerClient,
  FilesystemWorkerClientError,
} from '../filesystem-worker/client.js';
import type {
  PrepareFileMutationInput,
  PreparedFileMutationCarrier,
} from '../local-file-checkpoint-carrier.js';
import { LocalFileCheckpointCarrier } from '../local-file-checkpoint-carrier.js';
import type { CurrentFileCheckpointState } from '../prepared-file-mutation.js';
import type { DurableToolPreparationContext } from '../tool-runtime.js';
import type { PreparedFileMutationFact } from '../tool-recovery-facts.js';
import {
  applyPreparedFileThroughWorker,
  finalizePreparedFileThroughWorker,
  selectPreparedFileMutationCarrier,
  WorkerBackedFileCheckpointCarrier,
} from '../worker-backed-file-checkpoint-carrier.js';

describe('builtin prepared file mutations', () => {
  test('routes prepared file application through the filesystem worker when both are installed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-prepared-worker-'));
    const carrier = new FakeCarrier();
    carrier.rejectHostApply = true;
    const workerCalls: unknown[] = [];
    const write = buildBuiltinTools({
      fileMutationCheckpointCarrier: carrier,
      filesystemWorker: {
        execute: async (input) => {
          workerCalls.push(input);
          return { kind: 'write', ok: true, path: join(root, 'created.txt'), bytes: 5 };
        },
      },
    }).find((candidate) => candidate.name === 'Write');
    assert.ok(write?.prepareDurableExecution);

    const preparation = await write.prepareDurableExecution(
      { path: 'created.txt', content: 'hello' },
      preparationContext(root),
    );
    assert.ok(preparation);

    await preparation.execute();
    assert.equal(workerCalls.length, 1);
    assert.equal(
      (workerCalls[0] as { operation?: { kind?: string } }).operation?.kind,
      'prepared_file_apply',
    );
    assert.deepEqual(carrier.redone, []);
  });

  test('keeps recovery redo on the worker without a host-local fallback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-prepared-recovery-worker-'));
    const local = new FakeCarrier();
    local.rejectHostApply = true;
    const calls: unknown[] = [];
    const carrier = new WorkerBackedFileCheckpointCarrier(local, {
      execute: async (input) => {
        calls.push(input);
        return { kind: 'prepared_file_apply', ok: true };
      },
    });
    const checkpoint = fact('operation-1', root, 'created.txt');

    await carrier.apply(checkpoint, Buffer.from('hello'), {
      cwd: root,
      mode: 'ask',
    });

    assert.equal(calls.length, 1);
    assert.equal((calls[0] as { mode?: string }).mode, 'ask');
    assert.deepEqual(local.redone, []);
  });

  test('keeps recovery finalization on the worker without host-local cleanup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-prepared-finalize-worker-'));
    const calls: unknown[] = [];
    const checkpoint = fact('operation-finalize', root, 'created.txt');

    await finalizePreparedFileThroughWorker(
      {
        execute: async (input) => {
          calls.push(input);
          return { kind: 'prepared_file_finalize', ok: true };
        },
      },
      checkpoint,
      { cwd: root, mode: 'ask' },
    );

    assert.equal(calls.length, 1);
    assert.equal(
      (calls[0] as { operation?: { kind?: string } }).operation?.kind,
      'prepared_file_finalize',
    );
    assert.equal((calls[0] as { cwd?: string }).cwd, root);
  });

  test('keeps cancellation before worker launch out of durable recovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-prepared-worker-cancelled-'));
    const abortController = new AbortController();
    abortController.abort();
    const worker = new FilesystemWorkerClient({
      getLaunchSpec: async () => {
        throw new Error('worker launch must not be reached');
      },
      sandboxManager: {} as never,
    });

    await assert.rejects(
      applyPreparedFileThroughWorker(
        worker,
        fact('operation-cancelled', root, 'created.txt'),
        Buffer.from('hello'),
        { cwd: root, mode: 'ask', abortSignal: abortController.signal },
      ),
      (error: unknown) =>
        error instanceof FilesystemWorkerClientError && error.reason === 'aborted',
    );
  });

  test('keeps ambiguous worker exits and protocol failures in durable recovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-prepared-worker-ambiguous-'));
    for (const error of [
      new FilesystemWorkerClientError({
        reason: 'aborted',
        stage: 'launch',
        effectMayHaveStarted: true,
      }),
      new FilesystemWorkerClientError({
        reason: 'invalid_response',
        stage: 'protocol',
        effectMayHaveStarted: true,
      }),
    ]) {
      await assert.rejects(
        applyPreparedFileThroughWorker(
          {
            execute: async () => {
              throw error;
            },
          },
          fact('operation-ambiguous', root, 'created.txt'),
          Buffer.from('hello'),
          { cwd: root, mode: 'ask' },
        ),
        (thrown: unknown) => thrown instanceof DurableToolExecutionUnsettledError,
      );
    }
  });

  test('makes the prepared mutation execution owner an explicit host capability', () => {
    const local = new FakeCarrier();
    const hostLocal = selectPreparedFileMutationCarrier(local);
    assert.equal(hostLocal.executionOwner, 'host_local');
    assert.equal(hostLocal.carrier, local);

    const worker = {
      execute: async () => ({ kind: 'prepared_file_apply' as const, ok: true as const }),
    };
    const isolated = selectPreparedFileMutationCarrier(local, worker);
    assert.equal(isolated.executionOwner, 'filesystem_worker');
    assert.ok(isolated.carrier instanceof WorkerBackedFileCheckpointCarrier);

    assert.deepEqual(selectPreparedFileMutationCarrier(undefined, worker), {
      executionOwner: 'disabled',
      carrier: undefined,
    });
  });

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

  test('prepares and applies a recoverable Write in a directory with no Git repository', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-prepared-unavailable-'));
    const carrier = new LocalFileCheckpointCarrier();
    const write = buildBuiltinTools({ fileMutationCheckpointCarrier: carrier }).find(
      (candidate) => candidate.name === 'Write',
    );
    assert.ok(write?.prepareDurableExecution);

    const preparation = await write.prepareDurableExecution(
      { path: 'created.txt', content: 'hello' },
      preparationContext(root),
    );
    assert.ok(preparation);
    const payload = preparation.runtimeFacts[0]?.payload as PreparedFileMutationFact | undefined;
    assert.ok(payload);
    assert.equal(payload.carrier, undefined);
    await preparation.execute();
    assert.equal(await readFile(join(root, 'created.txt'), 'utf8'), 'hello');
    await preparation.release();
  });
});

class FakeCarrier implements PreparedFileMutationCarrier {
  readonly prepared: PrepareFileMutationInput[] = [];
  readonly redone: string[] = [];
  rejectHostApply = false;

  constructor(readonly beforeContent?: Uint8Array) {}

  async resolveWorkspaceIdentity(workspaceRoot: string): Promise<string> {
    return workspaceRoot;
  }

  async resolveTargetIdentity(workspaceRoot: string, targetPath: string): Promise<string> {
    return join(workspaceRoot, targetPath);
  }

  async prepare(input: PrepareFileMutationInput): Promise<PreparedFileMutationFact> {
    this.prepared.push(input);
    expectedContent(input, this.beforeContent);
    return fact(input.operationId, input.workspaceRoot, input.targetPath);
  }

  async inspect(): Promise<CurrentFileCheckpointState> {
    return { kind: 'missing' };
  }

  async readCurrentContent(): Promise<Uint8Array | undefined> {
    return this.beforeContent;
  }

  async apply(input: PreparedFileMutationFact): Promise<void> {
    if (this.rejectHostApply) throw new Error('host-local prepared apply was invoked');
    this.redone.push(input.operationId);
  }

  async finalize(): Promise<void> {}
}

function expectedContent(
  input: PrepareFileMutationInput,
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
