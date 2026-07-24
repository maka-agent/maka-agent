import { DurableToolExecutionUnsettledError } from './durable-tool-execution.js';
import {
  FilesystemWorkerClientError,
  type FilesystemWorkerClient,
  type FilesystemWorkerExecuteInput,
} from './filesystem-worker/client.js';
import type {
  PrepareFileMutationInput,
  PreparedFileMutationCarrier,
  PreparedFileMutationExecutionContext,
} from './local-file-checkpoint-carrier.js';
import type { CurrentFileCheckpointState } from './prepared-file-mutation.js';
import type { PreparedFileMutationFact } from './tool-recovery-facts.js';

export type PreparedFileMutationExecutionOwner = 'disabled' | 'host_local' | 'filesystem_worker';

export interface PreparedFileMutationCarrierSelection {
  executionOwner: PreparedFileMutationExecutionOwner;
  carrier: PreparedFileMutationCarrier | undefined;
}

/**
 * Host-side checkpoint preparation/observation with worker-owned mutation.
 * There is deliberately no host-local apply fallback once a worker is wired.
 */
export class WorkerBackedFileCheckpointCarrier implements PreparedFileMutationCarrier {
  constructor(
    private readonly local: PreparedFileMutationCarrier,
    private readonly worker: Pick<FilesystemWorkerClient, 'execute'>,
  ) {}

  async supports(workspaceRoot: string, targetPath: string): Promise<boolean> {
    return (await this.local.supports?.(workspaceRoot, targetPath)) ?? true;
  }

  async resolveWorkspaceIdentity(workspaceRoot: string): Promise<string> {
    return await this.local.resolveWorkspaceIdentity(workspaceRoot);
  }

  async resolveTargetIdentity(workspaceRoot: string, targetPath: string): Promise<string> {
    return await this.local.resolveTargetIdentity(workspaceRoot, targetPath);
  }

  async prepare(input: PrepareFileMutationInput): Promise<PreparedFileMutationFact> {
    return await this.local.prepare(input);
  }

  async inspect(fact: PreparedFileMutationFact): Promise<CurrentFileCheckpointState> {
    return await this.local.inspect(fact);
  }

  async readCurrentContent(fact: PreparedFileMutationFact): Promise<Uint8Array | undefined> {
    return await this.local.readCurrentContent(fact);
  }

  async apply(
    fact: PreparedFileMutationFact,
    expectedContent: Uint8Array,
    context?: PreparedFileMutationExecutionContext,
  ): Promise<void> {
    if (!context) {
      throw new Error('Worker-backed prepared file mutation requires explicit execution context');
    }
    await applyPreparedFileThroughWorker(this.worker, fact, expectedContent, context);
  }

  async finalize(
    fact: PreparedFileMutationFact,
    context?: PreparedFileMutationExecutionContext,
  ): Promise<void> {
    if (!context) {
      throw new Error('Worker-backed prepared file mutation requires explicit execution context');
    }
    await finalizePreparedFileThroughWorker(this.worker, fact, context);
  }
}

/**
 * Selects the prepared-mutation data plane once during host assembly.
 *
 * A host-local carrier is a deliberate deployment capability for hosts without
 * a filesystem worker, not a runtime fallback. Once the worker owner is
 * selected, worker failures remain failures/unsettled outcomes and never call
 * the local carrier's apply method.
 */
export function selectPreparedFileMutationCarrier(
  local: PreparedFileMutationCarrier | undefined,
  worker?: Pick<FilesystemWorkerClient, 'execute'>,
): PreparedFileMutationCarrierSelection {
  if (!local) return { executionOwner: 'disabled', carrier: undefined };
  if (!worker) return { executionOwner: 'host_local', carrier: local };
  return {
    executionOwner: 'filesystem_worker',
    carrier: new WorkerBackedFileCheckpointCarrier(local, worker),
  };
}

export async function applyPreparedFileThroughWorker(
  worker: Pick<FilesystemWorkerClient, 'execute'>,
  fact: PreparedFileMutationFact,
  expectedContent: Uint8Array,
  context?: PreparedFileMutationExecutionContext,
): Promise<void> {
  if (!context) {
    throw new Error('Worker-backed prepared file mutation requires explicit execution context');
  }
  const input: FilesystemWorkerExecuteInput = {
    operation: {
      kind: 'prepared_file_apply',
      path: fact.canonicalPath,
      fact,
      expectedContentBase64: Buffer.from(expectedContent).toString('base64'),
    },
    cwd: context.cwd,
    mode: context.mode,
    ...(context.permissionProfile ? { permissionProfile: context.permissionProfile } : {}),
    ...(context.additionalGrant ? { additionalGrant: context.additionalGrant } : {}),
    ...(context.abortSignal ? { abortSignal: context.abortSignal } : {}),
  };
  try {
    await worker.execute(input);
  } catch (error) {
    if (error instanceof FilesystemWorkerClientError && error.effectMayHaveStarted) {
      throw new DurableToolExecutionUnsettledError('effect_may_have_started', error);
    }
    throw error;
  }
}

export async function finalizePreparedFileThroughWorker(
  worker: Pick<FilesystemWorkerClient, 'execute'>,
  fact: PreparedFileMutationFact,
  context: PreparedFileMutationExecutionContext,
): Promise<void> {
  try {
    await worker.execute({
      operation: {
        kind: 'prepared_file_finalize',
        path: fact.canonicalPath,
        fact,
      },
      cwd: context.cwd,
      mode: context.mode,
      ...(context.permissionProfile ? { permissionProfile: context.permissionProfile } : {}),
      ...(context.additionalGrant ? { additionalGrant: context.additionalGrant } : {}),
      ...(context.abortSignal ? { abortSignal: context.abortSignal } : {}),
    });
  } catch (error) {
    if (error instanceof FilesystemWorkerClientError && error.effectMayHaveStarted) {
      throw new DurableToolExecutionUnsettledError('effect_may_have_started', error);
    }
    throw error;
  }
}
