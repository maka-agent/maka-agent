import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  applyAdditionalPermissionProfile,
  canReadPath,
  canWritePath,
  compilePermissionProfile,
  type PermissionMode,
  type PermissionProfile,
} from '@maka/core';

import { hashAdditionalPermissionProfile } from '../additional-permission-hash.js';
import {
  normalizeAdditionalPermissionPath,
  revalidateAdditionalPermissionGrant,
  type AdditionalPermissionGrant,
} from '../additional-permissions.js';
import { preparedFileMutationAuxiliaryPaths } from '../local-file-checkpoint-carrier.js';
import type { SandboxManager } from '../sandbox/sandbox-manager.js';
import type { SandboxPlatform } from '../sandbox/types.js';
import { parsePreparedFileMutationFact } from '../tool-recovery-facts.js';
import type { FilesystemWorkerLaunchSpecProvider } from './launch-spec.js';
import {
  FILESYSTEM_WORKER_DEFAULT_TIMEOUT_MS,
  runFilesystemWorkerProcess,
  type FilesystemWorkerProcessRunner,
} from './process-runner.js';
import {
  FILESYSTEM_WORKER_MAX_REQUEST_BYTES,
  FILESYSTEM_WORKER_PROTOCOL_VERSION,
  FilesystemWorkerOperationSchema,
  parseFilesystemWorkerResponse,
  type FilesystemWorkerErrorCode,
  type FilesystemWorkerOperation,
  type FilesystemWorkerResult,
} from './protocol.js';

export { FILESYSTEM_WORKER_MAX_REQUEST_BYTES } from './protocol.js';

export type FilesystemWorkerClientOperation = FilesystemWorkerOperation extends infer Operation
  ? Operation extends { cwd: string }
    ? Omit<Operation, 'cwd'>
    : never
  : never;

export interface FilesystemWorkerClientInput {
  getLaunchSpec: FilesystemWorkerLaunchSpecProvider;
  sandboxManager: SandboxManager;
  runProcess?: FilesystemWorkerProcessRunner;
  newId?: () => string;
  timeoutMs?: number;
  platform?: SandboxPlatform;
}

export interface FilesystemWorkerExecuteInput {
  operation: FilesystemWorkerClientOperation;
  cwd: string;
  mode: PermissionMode;
  /** Explicit embedding policy. Mode-based defaults are compiled only when omitted. */
  permissionProfile?: PermissionProfile;
  abortSignal?: AbortSignal;
  additionalGrant?: AdditionalPermissionGrant;
}

export type FilesystemWorkerClientErrorReason =
  | 'invalid_operation'
  | 'invalid_request'
  | 'request_overflow'
  | 'worker_bundle_unavailable'
  | 'runtime_executable_unavailable'
  | 'spawn_failed'
  | 'timeout'
  | 'aborted'
  | 'response_overflow'
  | 'worker_crashed'
  | 'invalid_response'
  | 'response_id_mismatch'
  | 'response_kind_mismatch'
  | FilesystemWorkerErrorCode
  | 'unsupported_platform'
  | 'backend_not_available'
  | 'backend_not_implemented'
  | 'sandbox_required';

export class FilesystemWorkerClientError extends Error {
  readonly code = 'SANDBOX_FILESYSTEM_OPERATION_FAILED';
  readonly domain = 'filesystem' as const;
  readonly reason: FilesystemWorkerClientErrorReason;
  readonly stage: 'validation' | 'transform' | 'launch' | 'protocol' | 'operation';
  readonly recoverable: boolean;
  /**
   * True only after the worker process was launched and the caller can no
   * longer prove that a mutating operation had no effect.
   */
  readonly effectMayHaveStarted: boolean;
  readonly requestId?: string;
  readonly backend?: 'none' | 'macos-seatbelt' | 'linux';
  readonly profileName?: string;

  constructor(input: {
    reason: FilesystemWorkerClientErrorReason;
    stage: FilesystemWorkerClientError['stage'];
    message?: string;
    recoverable?: boolean;
    effectMayHaveStarted?: boolean;
    requestId?: string;
    backend?: 'none' | 'macos-seatbelt' | 'linux';
    profileName?: string;
  }) {
    super(input.message ?? `Filesystem worker failed: ${input.reason}.`);
    this.name = 'FilesystemWorkerClientError';
    this.reason = input.reason;
    this.stage = input.stage;
    this.recoverable = input.recoverable ?? false;
    this.effectMayHaveStarted = input.effectMayHaveStarted ?? false;
    this.requestId = input.requestId;
    this.backend = input.backend;
    this.profileName = input.profileName;
  }
}

export class FilesystemWorkerClient {
  private readonly runProcess: FilesystemWorkerProcessRunner;
  private readonly newId: () => string;
  private readonly timeoutMs: number;

  constructor(private readonly input: FilesystemWorkerClientInput) {
    this.runProcess = input.runProcess ?? runFilesystemWorkerProcess;
    this.newId = input.newId ?? randomUUID;
    this.timeoutMs = input.timeoutMs ?? FILESYSTEM_WORKER_DEFAULT_TIMEOUT_MS;
  }

  async execute(input: FilesystemWorkerExecuteInput): Promise<FilesystemWorkerResult> {
    const requestId = this.newId();
    if (input.abortSignal?.aborted) throw clientError('aborted', 'launch', requestId);
    const canonicalCwd = await realpath(input.cwd).catch(() => {
      throw clientError(
        'invalid_operation',
        'validation',
        requestId,
        'Session cwd is unavailable.',
      );
    });
    if (input.additionalGrant) {
      if (
        input.additionalGrant.permissionsHash !==
        hashAdditionalPermissionProfile(input.additionalGrant.profile)
      ) {
        throw clientError('invalid_request', 'validation', requestId);
      }
      await revalidateAdditionalPermissionGrant({
        grant: input.additionalGrant,
        cwd: canonicalCwd,
      });
    }

    const parsedOperation = FilesystemWorkerOperationSchema.safeParse({
      ...input.operation,
      cwd: canonicalCwd,
    });
    if (!parsedOperation.success) throw clientError('invalid_operation', 'validation', requestId);

    const access = operationAccess(parsedOperation.data.kind);
    const target = await normalizeAdditionalPermissionPath({
      path: parsedOperation.data.path,
      access,
      scope: operationScope(parsedOperation.data.kind),
      cwd: canonicalCwd,
    }).catch(() => {
      throw clientError('invalid_operation', 'validation', requestId);
    });
    const compiled = input.permissionProfile
      ? {
          profile: input.permissionProfile,
          workspaceRoots: [canonicalCwd],
        }
      : compilePermissionProfile({ mode: input.mode, cwd: canonicalCwd });
    const effectiveProfile = input.additionalGrant
      ? applyAdditionalPermissionProfile(compiled.profile, input.additionalGrant.profile)
      : compiled.profile;
    const pathContext = {
      workspaceRoots: compiled.workspaceRoots,
      tmpdir: await canonicalPath(tmpdir()),
      slashTmp: await canonicalPath('/tmp'),
    };
    const allowed =
      access === 'write'
        ? canWritePath(effectiveProfile, target.enforcementPath, pathContext)
        : canReadPath(effectiveProfile, target.enforcementPath, pathContext);
    if (!allowed) throw clientError('path_denied', 'validation', requestId);

    const operationPermissionEntries: Array<{
      path: string;
      access: 'read' | 'write';
      scope: 'exact' | 'subtree';
    }> = [{ path: target.enforcementPath, access, scope: target.scope }];
    if (parsedOperation.data.kind === 'prepared_file_apply') {
      const fact = parsePreparedFileMutationFact(parsedOperation.data.fact);
      if (!fact || fact.canonicalPath !== target.enforcementPath) {
        throw clientError('invalid_operation', 'validation', requestId);
      }
      const auxiliary = preparedFileMutationAuxiliaryPaths(fact);
      operationPermissionEntries.push(
        { path: auxiliary.tempPath, access: 'write', scope: 'exact' },
        { path: auxiliary.beforeBackupPath, access: 'write', scope: 'exact' },
        { path: auxiliary.parentDirectory, access: 'write', scope: 'exact' },
      );
    }
    const operationPermission = {
      fileSystem: {
        entries: operationPermissionEntries,
      },
    } as const;
    const operation = FilesystemWorkerOperationSchema.parse({
      ...parsedOperation.data,
      path: target.enforcementPath,
    });
    const request = {
      version: FILESYSTEM_WORKER_PROTOCOL_VERSION,
      requestId,
      operation,
      operationPermission,
      permissionsHash: hashAdditionalPermissionProfile(operationPermission),
      expectedTarget: {
        enforcementPath: target.enforcementPath,
        access,
        scope: target.scope,
        targetType: target.targetType,
      },
    } as const;
    const requestJson = JSON.stringify(request);
    if (Buffer.byteLength(requestJson, 'utf8') > FILESYSTEM_WORKER_MAX_REQUEST_BYTES) {
      throw clientError('request_overflow', 'validation', requestId);
    }

    const launch = await this.input.getLaunchSpec();
    if (!launch.ok) throw clientError(launch.reason, 'launch', requestId, launch.message);
    const workerProfile = deriveWorkerProfile(effectiveProfile, operationPermission);
    const transformed = this.input.sandboxManager.transform({
      platform: this.input.platform ?? process.platform,
      command: {
        program: launch.spec.program,
        args: launch.spec.args,
        cwd: canonicalCwd,
        env: launch.spec.env,
        profile: workerProfile,
        pathContext: {
          ...pathContext,
          runtimeReadableRoots: launch.spec.runtimeReadableRoots,
          executableRoots: launch.spec.executableRoots,
        },
      },
    });
    if (!transformed.ok) {
      throw clientError(transformed.reason, 'transform', requestId, transformed.message, false, {
        backend: transformed.sandboxType,
        profileName: effectiveProfile.name ?? effectiveProfile.type,
      });
    }

    let processResult: Awaited<ReturnType<FilesystemWorkerProcessRunner>>;
    try {
      processResult = await this.runProcess({
        argv: transformed.exec.argv,
        cwd: transformed.exec.cwd,
        env: transformed.exec.env ?? {},
        stdin: requestJson,
        timeoutMs: this.timeoutMs,
        ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
      });
    } catch {
      throw clientError('spawn_failed', 'launch', requestId);
    }
    if (processResult.timedOut)
      throw clientError('timeout', 'launch', requestId, undefined, false, {
        effectMayHaveStarted: true,
      });
    if (processResult.aborted)
      throw clientError('aborted', 'launch', requestId, undefined, false, {
        effectMayHaveStarted: true,
      });
    if (processResult.responseOverflow)
      throw clientError('response_overflow', 'launch', requestId, undefined, false, {
        effectMayHaveStarted: true,
      });
    if (processResult.exitCode !== 0) {
      throw clientError(
        'worker_crashed',
        'launch',
        requestId,
        processResult.stderrTail || undefined,
        false,
        { effectMayHaveStarted: true },
      );
    }

    let response: ReturnType<typeof parseFilesystemWorkerResponse>;
    try {
      response = parseFilesystemWorkerResponse(JSON.parse(processResult.stdout));
    } catch {
      throw clientError('invalid_response', 'protocol', requestId, undefined, false, {
        effectMayHaveStarted: true,
      });
    }
    if (response.requestId !== requestId)
      throw clientError('response_id_mismatch', 'protocol', requestId, undefined, false, {
        effectMayHaveStarted: true,
      });
    if (!response.ok) {
      throw clientError(
        response.error.code,
        'operation',
        requestId,
        response.error.message,
        response.error.code === 'not_found' || response.error.code === 'edit_conflict',
        response.error.code === 'effect_unsettled' ? { effectMayHaveStarted: true } : undefined,
      );
    }
    if (
      response.result.kind !== operation.kind &&
      !(operation.kind === 'read' && response.result.kind === 'read_image')
    ) {
      throw clientError('response_kind_mismatch', 'protocol', requestId, undefined, false, {
        effectMayHaveStarted: true,
      });
    }
    return response.result;
  }
}

function deriveWorkerProfile(
  profile: PermissionProfile,
  operationPermission: {
    readonly fileSystem: {
      readonly entries: readonly {
        readonly path: string;
        readonly access: 'read' | 'write';
        readonly scope: 'exact' | 'subtree';
      }[];
    };
  },
): PermissionProfile {
  if (profile.type !== 'managed' || profile.fileSystem.kind !== 'restricted') return profile;
  return {
    ...profile,
    fileSystem: {
      ...profile.fileSystem,
      entries: [
        ...profile.fileSystem.entries.filter((entry) => entry.access === 'deny'),
        ...operationPermission.fileSystem.entries.map((entry) => ({
          kind: 'path' as const,
          path: entry.path,
          access: entry.access,
          match: entry.scope,
        })),
      ],
    },
    network: { kind: 'restricted' },
  };
}

function operationAccess(kind: FilesystemWorkerOperation['kind']): 'read' | 'write' {
  return kind === 'write' ||
    kind === 'edit' ||
    kind === 'prepared_file_apply' ||
    kind === 'format_json'
    ? 'write'
    : 'read';
}

function operationScope(kind: FilesystemWorkerOperation['kind']): 'exact' | 'subtree' | 'auto' {
  if (kind === 'glob') return 'subtree';
  return kind === 'grep' ? 'auto' : 'exact';
}

async function canonicalPath(path: string): Promise<string> {
  return await realpath(path).catch(() => path);
}

function clientError(
  reason: FilesystemWorkerClientErrorReason,
  stage: FilesystemWorkerClientError['stage'],
  requestId: string,
  message?: string,
  recoverable = false,
  metadata: {
    backend?: 'none' | 'macos-seatbelt' | 'linux';
    profileName?: string;
    effectMayHaveStarted?: boolean;
  } = {},
): FilesystemWorkerClientError {
  return new FilesystemWorkerClientError({
    reason,
    stage,
    requestId,
    message,
    recoverable,
    ...metadata,
  });
}
