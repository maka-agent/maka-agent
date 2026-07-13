import { randomUUID } from 'node:crypto';
import { isAbsolute, relative, resolve } from 'node:path';
import {
  canReadPath,
  canWritePath,
  type PermissionProfile,
} from '@maka/core/permission-profile';
import {
  applyAdditionalPermissionProfile,
  type AdditionalPermissionProfile,
} from '@maka/core/additional-permissions';

import { hashAdditionalPermissionProfile } from '../additional-permission-hash.js';
import { normalizeAdditionalPermissionPath } from '../additional-permissions.js';
import type { PermissionAwareSandboxContext } from '../sandbox/permission-aware-context.js';
import { deriveFilesystemWorkerProfile } from '../sandbox/permission-aware-context.js';
import type { SandboxErrorDomain, SandboxErrorStage } from '../sandbox/errors.js';
import type { SandboxTransformFailureReason, SandboxType } from '../sandbox/types.js';
import type {
  FilesystemWorkerLaunchSpecProvider,
} from './launch-spec.js';
import {
  FILESYSTEM_WORKER_DEFAULT_TIMEOUT_MS,
  type FilesystemWorkerProcessRunner,
  runFilesystemWorkerProcess,
} from './process-runner.js';
import {
  FILESYSTEM_WORKER_PROTOCOL_VERSION,
  FilesystemWorkerOperationSchema,
  parseFilesystemWorkerResponse,
  type FilesystemWorkerErrorCode,
  type FilesystemWorkerOperation,
  type FilesystemWorkerResult,
} from './protocol.js';

export const FILESYSTEM_WORKER_MAX_REQUEST_BYTES = 16 * 1024 * 1024;

export type FilesystemWorkerClientOperation = FilesystemWorkerOperation extends infer Operation
  ? Operation extends { cwd: string }
    ? Omit<Operation, 'cwd'>
    : never
  : never;

export interface FilesystemWorkerClientInput {
  getLaunchSpec: FilesystemWorkerLaunchSpecProvider;
  runProcess?: FilesystemWorkerProcessRunner;
  newId?: () => string;
  timeoutMs?: number;
}

export interface FilesystemWorkerExecuteInput {
  operation: FilesystemWorkerClientOperation;
  context: PermissionAwareSandboxContext;
  abortSignal?: AbortSignal;
  additionalPermissions?: AdditionalPermissionProfile;
  permissionsHash?: string;
}

export type FilesystemWorkerClientErrorReason =
  | 'invalid_operation'
  | 'request_overflow'
  | 'worker_bundle_unavailable'
  | 'runtime_executable_unavailable'
  | 'invalid_exec_argv'
  | 'spawn_failed'
  | 'timeout'
  | 'aborted'
  | 'response_overflow'
  | 'worker_crashed'
  | 'invalid_response'
  | 'response_id_mismatch'
  | 'response_kind_mismatch'
  | FilesystemWorkerErrorCode
  | SandboxTransformFailureReason;

export class FilesystemWorkerClientError extends Error {
  readonly code = 'SANDBOX_FILESYSTEM_OPERATION_FAILED';
  readonly domain: SandboxErrorDomain = 'filesystem';
  readonly stage: SandboxErrorStage;
  readonly reason: FilesystemWorkerClientErrorReason;
  readonly recoverable: boolean;
  readonly backend?: SandboxType;
  readonly profileName?: string;
  readonly requestId?: string;

  constructor(input: {
    stage: SandboxErrorStage;
    reason: FilesystemWorkerClientErrorReason;
    message?: string;
    recoverable?: boolean;
    backend?: SandboxType;
    profile?: PermissionProfile;
    requestId?: string;
  }) {
    super(input.message ?? `Filesystem worker failed: ${input.reason}.`);
    this.name = 'FilesystemWorkerClientError';
    this.stage = input.stage;
    this.reason = input.reason;
    this.recoverable = input.recoverable ?? false;
    this.backend = input.backend;
    this.profileName = input.profile?.name;
    this.requestId = input.requestId;
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
    if (input.abortSignal?.aborted) {
      throw new FilesystemWorkerClientError({ stage: 'launch', reason: 'aborted' });
    }
    const requestId = this.newId();
    if (
      Boolean(input.additionalPermissions) !== Boolean(input.permissionsHash)
      || (input.additionalPermissions
        && input.permissionsHash !== hashAdditionalPermissionProfile(input.additionalPermissions))
    ) {
      throw new FilesystemWorkerClientError({
        stage: 'validation',
        reason: 'invalid_request',
        requestId,
      });
    }
    const parsedOperation = FilesystemWorkerOperationSchema.safeParse({
      ...input.operation,
      cwd: input.context.cwd,
    });
    if (!parsedOperation.success) {
      throw new FilesystemWorkerClientError({
        stage: 'validation',
        reason: 'invalid_operation',
        requestId,
      });
    }
    const effectiveProfile = input.additionalPermissions
      ? applyAdditionalPermissionProfile(input.context.profile, input.additionalPermissions)
      : input.context.profile;
    const operationAccess = filesystemOperationAccess(parsedOperation.data.kind);
    const operationScope = filesystemOperationScope(parsedOperation.data.kind);
    const lexicalPath = resolve(input.context.cwd, parsedOperation.data.path);
    let enforcementPath = lexicalPath;
    if (input.additionalPermissions || !pathWithinRoot(lexicalPath, input.context.cwd)) {
      try {
        enforcementPath = (await normalizeAdditionalPermissionPath({
          path: parsedOperation.data.path,
          access: operationAccess,
          scope: operationScope,
          cwd: input.context.cwd,
        })).enforcementPath;
      } catch {
        throw new FilesystemWorkerClientError({
          stage: 'validation',
          reason: 'invalid_operation',
          profile: effectiveProfile,
          requestId,
        });
      }
    }
    const allowed = operationAccess === 'write'
      ? canWritePath(effectiveProfile, enforcementPath, input.context.pathContext)
      : canReadPath(effectiveProfile, enforcementPath, input.context.pathContext);
    if (!allowed) {
      throw new FilesystemWorkerClientError({
        stage: 'validation',
        reason: 'path_denied',
        profile: effectiveProfile,
        requestId,
      });
    }
    const operation = FilesystemWorkerOperationSchema.parse({
      ...parsedOperation.data,
      path: enforcementPath,
    });
    // The worker receives only the canonical path capability needed by this operation.
    // The original user-approved grant has already been validated and applied above.
    const workerPermissions: AdditionalPermissionProfile = {
      fileSystem: {
        entries: [{
          path: enforcementPath,
          access: operationAccess,
          scope: operationScope,
        }],
      },
    };
    const request = {
      version: FILESYSTEM_WORKER_PROTOCOL_VERSION,
      requestId,
      operation,
      additionalPermissions: workerPermissions,
      permissionsHash: hashAdditionalPermissionProfile(workerPermissions),
    } as const;
    const requestJson = JSON.stringify(request);
    if (Buffer.byteLength(requestJson, 'utf8') > FILESYSTEM_WORKER_MAX_REQUEST_BYTES) {
      throw new FilesystemWorkerClientError({
        stage: 'validation',
        reason: 'request_overflow',
        requestId,
      });
    }

    const launch = await this.input.getLaunchSpec();
    if (!launch.ok) {
      throw new FilesystemWorkerClientError({
        stage: 'launch',
        reason: launch.reason,
        message: launch.message,
        requestId,
      });
    }
    const operationProfile = deriveFilesystemWorkerProfile(
      effectiveProfile,
      profileOperation(operation.kind),
    );
    const transformed = input.context.sandboxManager.transform({
      command: {
        program: launch.spec.program,
        args: launch.spec.args,
        cwd: input.context.cwd,
        env: launch.spec.env,
        profile: operationProfile,
        pathContext: {
          ...input.context.pathContext,
          runtimeReadableRoots: launch.spec.runtimeReadableRoots,
          executableRoots: launch.spec.executableRoots,
        },
      },
      ...(input.context.preference ? { preference: input.context.preference } : {}),
      ...(input.context.platform ? { platform: input.context.platform } : {}),
    });
    if (!transformed.ok) {
      throw new FilesystemWorkerClientError({
        stage: 'transform',
        reason: transformed.reason,
        message: transformed.message,
        backend: transformed.sandboxType,
        profile: operationProfile,
        requestId,
      });
    }
    if (!transformed.exec.argv[0]) {
      throw new FilesystemWorkerClientError({
        stage: 'validation',
        reason: 'invalid_exec_argv',
        backend: transformed.sandboxType,
        profile: operationProfile,
        requestId,
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
      throw new FilesystemWorkerClientError({
        stage: 'launch',
        reason: 'spawn_failed',
        backend: transformed.sandboxType,
        profile: operationProfile,
        requestId,
      });
    }
    if (processResult.timedOut) throw processFailure('timeout');
    if (processResult.aborted) throw processFailure('aborted');
    if (processResult.responseOverflow) throw processFailure('response_overflow');
    if (processResult.exitCode !== 0) throw processFailure('worker_crashed');

    let response: ReturnType<typeof parseFilesystemWorkerResponse>;
    try {
      response = parseFilesystemWorkerResponse(JSON.parse(processResult.stdout));
    } catch {
      throw processFailure('invalid_response', 'protocol');
    }
    if (response.requestId !== requestId) throw processFailure('response_id_mismatch', 'protocol');
    if (!response.ok) {
      throw new FilesystemWorkerClientError({
        stage: 'operation',
        reason: response.error.code,
        message: response.error.message,
        recoverable: isRecoverableOperationError(response.error.code),
        backend: transformed.sandboxType,
        profile: operationProfile,
        requestId,
      });
    }
    if (response.result.kind !== operation.kind) {
      throw processFailure('response_kind_mismatch', 'protocol');
    }
    return response.result;

    function processFailure(
      reason: FilesystemWorkerClientErrorReason,
      stage: SandboxErrorStage = 'launch',
    ): FilesystemWorkerClientError {
      return new FilesystemWorkerClientError({
        stage,
        reason,
        backend: transformed.ok ? transformed.sandboxType : undefined,
        profile: operationProfile,
        requestId,
      });
    }
  }
}

function profileOperation(kind: FilesystemWorkerOperation['kind']) {
  if (kind === 'read') return 'read' as const;
  if (kind === 'glob' || kind === 'grep') return 'search' as const;
  return kind;
}

function filesystemOperationAccess(kind: FilesystemWorkerOperation['kind']): 'read' | 'write' {
  return kind === 'write' || kind === 'edit' ? 'write' : 'read';
}

function filesystemOperationScope(kind: FilesystemWorkerOperation['kind']): 'exact' | 'subtree' {
  return kind === 'glob' || kind === 'grep' ? 'subtree' : 'exact';
}

function pathWithinRoot(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function isRecoverableOperationError(code: FilesystemWorkerErrorCode): boolean {
  return code === 'not_found' || code === 'edit_conflict' || code === 'grep_unavailable';
}
