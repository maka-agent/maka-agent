import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type {
  ToolReconcileDecision,
  ToolRecoveryContract,
  UnsettledToolOperation,
} from './tool-recovery-contract.js';
import { ToolRecoveryContractRegistry } from './tool-recovery-contract.js';

export type ReadOnlyFileObservation =
  | { status: 'missing' }
  | { status: 'text'; content: string }
  | { status: 'unreadable' };

export interface ReadOnlyFileRecoveryObserver {
  readText(path: string, operation: UnsettledToolOperation): Promise<ReadOnlyFileObservation>;
}

export interface LocalReadOnlyFileRecoveryObserverOptions {
  maxBytes?: number;
}

export function createLocalReadOnlyFileRecoveryObserver(
  options: LocalReadOnlyFileRecoveryObserverOptions = {},
): ReadOnlyFileRecoveryObserver {
  const maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error('File recovery observer maxBytes must be a positive safe integer');
  }
  return {
    readText: async (path, operation) => {
      const cwd = operation.workspaceCwd;
      if (!cwd) return { status: 'unreadable' };
      const target = resolve(cwd, path);
      if (!isPathWithin(cwd, target)) return { status: 'unreadable' };
      try {
        const [canonicalCwd, targetInfo] = await Promise.all([realpath(cwd), lstat(target)]);
        if (!targetInfo.isFile() || targetInfo.isSymbolicLink() || targetInfo.size > maxBytes) {
          return { status: 'unreadable' };
        }
        const canonicalTarget = await realpath(target);
        if (!isPathWithin(canonicalCwd, canonicalTarget)) return { status: 'unreadable' };
        const bytes = await readFile(canonicalTarget);
        if (bytes.length > maxBytes || bytes.includes(0)) return { status: 'unreadable' };
        try {
          return {
            status: 'text',
            content: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
          };
        } catch {
          return { status: 'unreadable' };
        }
      } catch (error) {
        return isNodeError(error) && error.code === 'ENOENT'
          ? { status: 'missing' }
          : { status: 'unreadable' };
      }
    },
  };
}

export function createWriteEditRecoveryContractRegistry(
  observer: ReadOnlyFileRecoveryObserver,
): ToolRecoveryContractRegistry {
  const contracts = createWriteEditRecoveryContracts(observer);
  return new ToolRecoveryContractRegistry([
    { toolName: 'Write', contract: contracts.Write },
    { toolName: 'Edit', contract: contracts.Edit },
  ]);
}

type FileToolObservation =
  | { status: 'invalid_args' }
  | { status: 'checkpoint_missing' }
  | ({ path: string } & ReadOnlyFileObservation);

export interface WriteEditRecoveryContracts {
  Write: ReadOnlyFileRecoveryContract;
  Edit: ReadOnlyFileRecoveryContract;
}

type ReadOnlyFileRecoveryContract = ToolRecoveryContract<FileToolObservation> & {
  observe(operation: UnsettledToolOperation): Promise<FileToolObservation>;
  decide(input: {
    operation: UnsettledToolOperation;
    observation: FileToolObservation;
  }): ToolReconcileDecision;
};

export function createWriteEditRecoveryContracts(
  observer: ReadOnlyFileRecoveryObserver,
): WriteEditRecoveryContracts {
  return {
    Write: {
      id: 'maka.tool.write.reconcile',
      version: 1,
      mode: 'reconcile_then_decide',
      observe: (operation) => observeFileTarget(observer, operation, parseWriteArgs),
      decide: ({ operation, observation }) => decideWrite(operation, observation),
    },
    Edit: {
      id: 'maka.tool.edit.reconcile',
      version: 1,
      mode: 'reconcile_then_decide',
      // Edit cannot be reconciled safely from old_string/new_string occurrence
      // counts. Until the durable dispatch carries a prepared before/after file
      // checkpoint, do not inspect the live file and do not infer an outcome.
      observe: async (operation) =>
        parseEditArgs(operation.args)
          ? { status: 'checkpoint_missing' }
          : { status: 'invalid_args' },
      decide: ({ operation, observation }) => decideEdit(operation, observation),
    },
  };
}

async function observeFileTarget(
  observer: ReadOnlyFileRecoveryObserver,
  operation: UnsettledToolOperation,
  parseArgs: (args: unknown) => { path: string } | undefined,
): Promise<FileToolObservation> {
  const args = parseArgs(operation.args);
  if (!args) return { status: 'invalid_args' };
  return { path: args.path, ...(await observer.readText(args.path, operation)) };
}

function decideWrite(
  operation: UnsettledToolOperation,
  observation: FileToolObservation,
): ToolReconcileDecision {
  const args = parseWriteArgs(operation.args);
  if (!args || observation.status === 'invalid_args') {
    return parked('write_arguments_invalid');
  }
  if (observation.status === 'missing') {
    return {
      result: 'not_applied',
      reasonCode: 'write_target_missing',
      nextAction: 'retry_allowed',
    };
  }
  if (observation.status === 'checkpoint_missing') {
    return parked('write_checkpoint_evidence_missing');
  }
  if (observation.status === 'unreadable') return parked('write_target_unreadable');
  if (observation.content === args.content) {
    return {
      result: 'applied',
      reasonCode: 'write_postcondition_matches',
      nextAction: 'synthesize_response',
      synthesizedResult: {
        ok: true,
        path: args.path,
        bytes: Buffer.byteLength(args.content, 'utf8'),
        recovered: true,
      },
    };
  }
  return parked('write_postcondition_conflict');
}

function decideEdit(
  operation: UnsettledToolOperation,
  observation: FileToolObservation,
): ToolReconcileDecision {
  const args = parseEditArgs(operation.args);
  if (!args || observation.status === 'invalid_args') return parked('edit_arguments_invalid');
  return parked('edit_checkpoint_evidence_missing');
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

function isPathWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(resolve(root), resolve(candidate));
  return pathFromRoot === '' || (!pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
