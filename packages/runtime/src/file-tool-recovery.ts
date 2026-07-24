import type {
  ToolReconcileDecision,
  ToolRecoveryContract,
  UnsettledToolOperation,
} from './tool-recovery-contract.js';
import { ToolRecoveryContractRegistry } from './tool-recovery-contract.js';
import { acquireFileWriteLock } from './file-write-lock.js';
import { computeEditedSource } from './edit-replace.js';
import {
  EDIT_FILE_TRANSFORM,
  WRITE_FILE_TRANSFORM,
  fileMutationArgsHash,
} from './file-mutation-transform.js';
import {
  decidePreparedFileMutation,
  type CurrentFileCheckpointState,
} from './prepared-file-mutation.js';
import type { PreparedFileMutationFact } from './tool-recovery-facts.js';
import type { PreparedFileMutationExecutionContext } from './local-file-checkpoint-carrier.js';
import { LocalFileMutationConflictError } from './local-file-checkpoint-carrier.js';

export interface PreparedFileRecoveryCarrier {
  resolveWorkspaceIdentity(workspaceRoot: string): Promise<string>;
  resolveTargetIdentity(workspaceRoot: string, targetPath: string): Promise<string>;
  inspect(fact: PreparedFileMutationFact): Promise<CurrentFileCheckpointState>;
  readCurrentContent(fact: PreparedFileMutationFact): Promise<Uint8Array | undefined>;
  apply(
    fact: PreparedFileMutationFact,
    expectedContent: Uint8Array,
    context?: PreparedFileMutationExecutionContext,
  ): Promise<void>;
  finalize(
    fact: PreparedFileMutationFact,
    context?: PreparedFileMutationExecutionContext,
  ): Promise<void>;
}

interface ValidatedPreparedFileBinding {
  trustedWorkspaceRoot: string;
  canonicalPath: string;
}

type PreparedFileRecoveryObservation =
  | { status: 'checkpoint_missing' }
  | { status: 'checkpoint_invalid' }
  | { status: 'prepared_file_unsafe'; reasonCode: string }
  | {
      status: 'prepared_after_matches' | 'prepared_redone' | 'prepared_file_drifted';
      current: CurrentFileCheckpointState;
    };

type PreparedFileRecoveryContract = ToolRecoveryContract<PreparedFileRecoveryObservation> & {
  reconcile(operation: UnsettledToolOperation): Promise<{
    observation: PreparedFileRecoveryObservation;
    decision: ToolReconcileDecision;
  }>;
};

export interface PreparedWriteEditRecoveryContracts {
  Write: PreparedFileRecoveryContract;
  Edit: PreparedFileRecoveryContract;
}

export function createPreparedWriteEditRecoveryContractRegistry(
  carrier: PreparedFileRecoveryCarrier,
): ToolRecoveryContractRegistry {
  const contracts = createPreparedWriteEditRecoveryContracts(carrier);
  return new ToolRecoveryContractRegistry([
    { toolName: 'Write', contract: contracts.Write },
    { toolName: 'Edit', contract: contracts.Edit },
  ]);
}

export function createPreparedWriteEditRecoveryContracts(
  carrier: PreparedFileRecoveryCarrier,
): PreparedWriteEditRecoveryContracts {
  return {
    Write: preparedFileContract('Write', carrier),
    Edit: preparedFileContract('Edit', carrier),
  };
}

function preparedFileContract(
  toolName: 'Write' | 'Edit',
  carrier: PreparedFileRecoveryCarrier,
): PreparedFileRecoveryContract {
  return {
    id: `maka.tool.${toolName.toLowerCase()}.prepared-file`,
    version: 1,
    mode: 'reconcile_then_decide',
    reconcile: async (operation) => reconcilePreparedFileOperation(toolName, carrier, operation),
  };
}

async function reconcilePreparedFileOperation(
  toolName: 'Write' | 'Edit',
  carrier: PreparedFileRecoveryCarrier,
  operation: UnsettledToolOperation,
): Promise<{
  observation: PreparedFileRecoveryObservation;
  decision: ToolReconcileDecision;
}> {
  const fact = operation.preparedFileMutation;
  if (!fact) {
    const observation = { status: 'checkpoint_missing' } as const;
    return {
      observation,
      decision: parked(`${toolName.toLowerCase()}_checkpoint_evidence_missing`),
    };
  }
  const binding = await validatePreparedFactOperation(toolName, fact, operation, carrier);
  if (!binding) {
    const observation = { status: 'checkpoint_invalid' } as const;
    return { observation, decision: parked('prepared_file_checkpoint_invalid') };
  }

  const lease = await acquireFileWriteLock(binding.canonicalPath);
  try {
    const executionContext: PreparedFileMutationExecutionContext = {
      cwd: binding.trustedWorkspaceRoot,
      mode: operation.permissionMode!,
    };
    let initial: CurrentFileCheckpointState;
    try {
      initial = await carrier.inspect(fact);
    } catch (error) {
      if (!(error instanceof LocalFileMutationConflictError)) throw error;
      const observation = {
        status: 'prepared_file_unsafe',
        reasonCode: error.reasonCode,
      } as const;
      return { observation, decision: parked(error.reasonCode) };
    }
    const initialDecision = decidePreparedFileMutation(fact, initial);
    if (initialDecision.disposition === 'finalize') {
      try {
        await carrier.finalize(fact, executionContext);
      } catch (error) {
        if (!(error instanceof LocalFileMutationConflictError)) throw error;
        const observation = {
          status: 'prepared_file_unsafe',
          reasonCode: error.reasonCode,
        } as const;
        return { observation, decision: parked(error.reasonCode) };
      }
      const observation = { status: 'prepared_after_matches', current: initial } as const;
      return {
        observation,
        decision: synthesizedPreparedResult(toolName, operation, fact, observation.status),
      };
    }
    if (initialDecision.disposition === 'park') {
      const observation = { status: 'prepared_file_drifted', current: initial } as const;
      return { observation, decision: parked(initialDecision.reasonCode) };
    }

    try {
      const expectedContent = await regenerateExpectedContent(toolName, operation, fact, carrier);
      await carrier.apply(fact, expectedContent, executionContext);
    } catch (error) {
      const afterFailure = await carrier.inspect(fact);
      const afterFailureDecision = decidePreparedFileMutation(fact, afterFailure);
      if (afterFailureDecision.disposition === 'park') {
        const observation = {
          status: 'prepared_file_drifted',
          current: afterFailure,
        } as const;
        return { observation, decision: parked(afterFailureDecision.reasonCode) };
      }
      throw error;
    }
    const installed = await carrier.inspect(fact);
    if (decidePreparedFileMutation(fact, installed).disposition !== 'finalize') {
      const observation = { status: 'prepared_file_drifted', current: installed } as const;
      return { observation, decision: parked('prepared_file_install_unverified') };
    }
    await carrier.finalize(fact, executionContext);
    const observation = { status: 'prepared_redone', current: installed } as const;
    return {
      observation,
      decision: synthesizedPreparedResult(toolName, operation, fact, observation.status),
    };
  } finally {
    lease.release();
  }
}

async function regenerateExpectedContent(
  toolName: 'Write' | 'Edit',
  operation: UnsettledToolOperation,
  fact: PreparedFileMutationFact,
  carrier: PreparedFileRecoveryCarrier,
): Promise<Uint8Array> {
  if (toolName === 'Write') {
    const args = parseWriteArgs(operation.args);
    if (!args) throw new Error('Write recovery arguments are invalid');
    return Buffer.from(args.content, 'utf8');
  }
  const args = parseEditArgs(operation.args);
  if (!args) throw new Error('Edit recovery arguments are invalid');
  const current = await carrier.readCurrentContent(fact);
  if (!current) throw new Error('Edit recovery before image is missing');
  return Buffer.from(
    computeEditedSource(
      Buffer.from(current).toString('utf8'),
      args.oldString,
      args.newString,
      args.path,
    ).content,
    'utf8',
  );
}

async function validatePreparedFactOperation(
  toolName: 'Write' | 'Edit',
  fact: PreparedFileMutationFact,
  operation: UnsettledToolOperation,
  carrier: PreparedFileRecoveryCarrier,
): Promise<ValidatedPreparedFileBinding | undefined> {
  if (!operation.operationId || fact.operationId !== operation.operationId) return undefined;
  if (!operation.workspaceCwd || !operation.permissionMode) return undefined;
  let trustedWorkspaceRoot: string;
  let canonicalOperationPath: string;
  try {
    trustedWorkspaceRoot = await carrier.resolveWorkspaceIdentity(operation.workspaceCwd);
    if (trustedWorkspaceRoot !== fact.workspaceRoot) return undefined;
    canonicalOperationPath = await carrier.resolveTargetIdentity(
      trustedWorkspaceRoot,
      filePath(operation.args),
    );
  } catch {
    return undefined;
  }
  if (canonicalOperationPath !== fact.canonicalPath) {
    return undefined;
  }
  if (toolName === 'Write') {
    const args = parseWriteArgs(operation.args);
    return args !== undefined &&
      fact.transform.id === WRITE_FILE_TRANSFORM.id &&
      fact.transform.version === WRITE_FILE_TRANSFORM.version &&
      fact.transform.argsHash === fileMutationArgsHash({ path: args.path, content: args.content })
      ? { trustedWorkspaceRoot, canonicalPath: canonicalOperationPath }
      : undefined;
  }
  const args = parseEditArgs(operation.args);
  return args !== undefined &&
    fact.transform.id === EDIT_FILE_TRANSFORM.id &&
    fact.transform.version === EDIT_FILE_TRANSFORM.version &&
    fact.transform.argsHash ===
      fileMutationArgsHash({
        path: args.path,
        old_string: args.oldString,
        new_string: args.newString,
      })
    ? { trustedWorkspaceRoot, canonicalPath: canonicalOperationPath }
    : undefined;
}

function synthesizedPreparedResult(
  toolName: 'Write' | 'Edit',
  operation: UnsettledToolOperation,
  fact: PreparedFileMutationFact,
  reasonCode: 'prepared_after_matches' | 'prepared_redone',
): ToolReconcileDecision {
  const args =
    toolName === 'Write' ? parseWriteArgs(operation.args) : parseEditArgs(operation.args);
  return {
    result: 'applied',
    reasonCode,
    nextAction: 'synthesize_response',
    synthesizedResult:
      toolName === 'Write'
        ? {
            ok: true,
            path: args?.path ?? fact.relativePath,
            bytes: fact.expectedAfter.byteLength,
            recovered: true,
          }
        : {
            ok: true,
            path: args?.path ?? fact.relativePath,
            replacements: 1,
            recovered: true,
          },
  };
}

function filePath(args: unknown): string {
  return isRecord(args) && typeof args.path === 'string' ? args.path : '';
}

function parked(reasonCode: string): ToolReconcileDecision {
  return { result: 'conflict', reasonCode, nextAction: 'park' };
}

function parseWriteArgs(args: unknown): { path: string; content: string } | undefined {
  if (!isRecord(args)) return undefined;
  return typeof args.path === 'string' && args.path.length > 0 && typeof args.content === 'string'
    ? { path: args.path, content: args.content }
    : undefined;
}

function parseEditArgs(
  args: unknown,
): { path: string; oldString: string; newString: string } | undefined {
  if (!isRecord(args)) return undefined;
  return typeof args.path === 'string' &&
    args.path.length > 0 &&
    typeof args.old_string === 'string' &&
    args.old_string.length > 0 &&
    typeof args.new_string === 'string'
    ? { path: args.path, oldString: args.old_string, newString: args.new_string }
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
