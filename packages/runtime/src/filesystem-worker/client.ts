import { randomUUID } from 'node:crypto';
import type { PermissionProfile } from '@maka/core/permission-profile';

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
    const operation = FilesystemWorkerOperationSchema.safeParse({
      ...input.operation,
      cwd: input.context.cwd,
    });
    if (!operation.success) {
      throw new FilesystemWorkerClientError({
        stage: 'validation',
        reason: 'invalid_operation',
        requestId,
      });
    }
    const request = {
      version: FILESYSTEM_WORKER_PROTOCOL_VERSION,
      requestId,
      operation: operation.data,
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
      input.context.profile,
      profileOperation(operation.data.kind),
    );
    const transformed = input.context.sandboxManager.transform({
      command: {
        program: launch.spec.program,
        args: launch.spec.args,
        cwd: input.context.cwd,
        env: launch.spec.env,
        profile: operationProfile,
        pathContext: input.context.pathContext,
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
    if (response.result.kind !== operation.data.kind) {
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

function isRecoverableOperationError(code: FilesystemWorkerErrorCode): boolean {
  return code === 'not_found' || code === 'edit_conflict' || code === 'grep_unavailable';
}
