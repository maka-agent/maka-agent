import { promises as fs } from 'node:fs';
import { exec } from 'node:child_process';
import { glob as nodeGlob } from 'node:fs/promises';
import { tmpdir as osTmpdir } from 'node:os';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { ToolExecutionFacts } from '@maka/core/permission';
import {
  canReadPath,
  canWritePath,
  type PermissionProfile,
  type PermissionProfileMatchContext,
} from '@maka/core/permission-profile';
import {
  runProcessWithBoundedTail,
  runShellWithBoundedTail,
  type BoundedProcessOptions,
  type BoundedProcessResult,
} from './shell-exec.js';
import type {
  SandboxPathContext,
  SandboxPlatform,
  SandboxTransformFailureReason,
  SandboxTransformRequest,
  SandboxTransformResult,
  SandboxType,
  SandboxablePreference,
} from './sandbox/index.js';
import { computeEditedSource, type EditMatchStrategy } from './edit-replace.js';
import type { SandboxErrorDomain, SandboxErrorStage } from './sandbox/errors.js';

const execAsync = promisify(exec);

export type WorkspaceIsolationKind = ToolExecutionFacts['isolation'];
export type WorkspaceWriteBackMode = ToolExecutionFacts['writeBack'];
export type WorkspaceNetworkMode = ToolExecutionFacts['network'];
export type WorkspaceSecretMode = ToolExecutionFacts['secrets'];
export type WorkspaceExecutorFacts = ToolExecutionFacts;

export const LOCAL_WORKSPACE_EXECUTOR_FACTS: WorkspaceExecutorFacts = {
  isolation: 'none',
  writesAffectHost: true,
  writeBack: 'direct',
  network: 'host',
  secrets: 'host_env',
};

export interface WorkspaceExecInput {
  command: string;
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  abortSignal?: AbortSignal;
  emitOutput?: (stream: 'stdout' | 'stderr', chunk: string) => void;
}

export interface WorkspaceExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  timedOut: boolean;
  aborted: boolean;
}

export interface WorkspaceReadFileInput {
  cwd: string;
  path: string;
  offset?: number;
  limit?: number;
}

export interface WorkspaceReadFileResult {
  content: string;
}

export interface WorkspaceWriteFileInput {
  cwd: string;
  path: string;
  content: string;
}

export interface WorkspaceWriteFileResult {
  ok: boolean;
  path: string;
  bytes: number;
}

export interface WorkspaceResolvePathInput {
  cwd: string;
  path: string;
  label: string;
}

export interface WorkspaceResolvePathResult {
  path: string;
}

export interface WorkspaceWriteLockKeyInput {
  cwd: string;
  path: string;
}

export interface WorkspaceWriteLockKeyResult {
  key: string;
}

export interface WorkspaceGlobInput {
  cwd: string;
  pattern: string;
  limit?: number;
}

export interface WorkspaceGlobResult {
  files: string[];
}

export interface WorkspaceGrepInput {
  cwd: string;
  pattern: string;
  path: string;
  glob?: string;
  maxCountPerFile: number;
  limit: number;
  timeoutMs: number;
  abortSignal?: AbortSignal;
}

export interface WorkspaceGrepResult {
  matches: string[];
}

export interface WorkspaceReadInput extends WorkspaceReadFileInput {}
export type WorkspaceReadResult = WorkspaceReadFileResult;

export interface WorkspaceWriteInput extends WorkspaceWriteFileInput {}
export type WorkspaceWriteResult = WorkspaceWriteFileResult;

export interface WorkspaceEditInput {
  cwd: string;
  path: string;
  oldString: string;
  newString: string;
}

export interface WorkspaceEditResult {
  ok: true;
  path: string;
  replacements: 1;
  matchedVia: EditMatchStrategy;
  startLine: number;
  endLine: number;
}

export interface WorkspaceGlobOperationInput {
  cwd: string;
  path: string;
  pattern: string;
  limit?: number;
}

export interface WorkspaceGrepOperationInput extends WorkspaceGrepInput {}

export interface WorkspaceFileOperations extends WorkspaceExecutorFactsProvider, WorkspaceWriteLockProvider {
  read(input: WorkspaceReadInput): Promise<WorkspaceReadResult>;
  write(input: WorkspaceWriteInput): Promise<WorkspaceWriteResult>;
  edit(input: WorkspaceEditInput): Promise<WorkspaceEditResult>;
  glob(input: WorkspaceGlobOperationInput): Promise<WorkspaceGlobResult>;
  grep(input: WorkspaceGrepOperationInput): Promise<WorkspaceGrepResult>;
}

export interface WorkspaceExecutorFactsProvider {
  readonly facts: WorkspaceExecutorFacts;
}

export interface WorkspaceCommandExecutor {
  exec(input: WorkspaceExecInput): Promise<WorkspaceExecResult>;
}

export interface WorkspaceReadFileExecutor {
  readFile(input: WorkspaceReadFileInput): Promise<WorkspaceReadFileResult>;
}

export interface WorkspaceWriteFileExecutor {
  writeFile(input: WorkspaceWriteFileInput): Promise<WorkspaceWriteFileResult>;
}

export interface WorkspaceExistingPathResolver {
  resolveExistingPath(input: WorkspaceResolvePathInput): Promise<WorkspaceResolvePathResult>;
}

export interface WorkspaceWritablePathResolver {
  resolveWritablePath(input: WorkspaceResolvePathInput): Promise<WorkspaceResolvePathResult>;
}

export interface WorkspaceWriteLockProvider {
  writeLockKey(input: WorkspaceWriteLockKeyInput): Promise<WorkspaceWriteLockKeyResult>;
}

export interface WorkspaceGlobFilesExecutor {
  globFiles(input: WorkspaceGlobInput): Promise<WorkspaceGlobResult>;
}

export interface WorkspaceGrepFilesExecutor {
  grepFiles(input: WorkspaceGrepInput): Promise<WorkspaceGrepResult>;
}

export type WorkspaceBashExecutor = WorkspaceExecutorFactsProvider & WorkspaceCommandExecutor;

export type WorkspaceReadExecutor =
  & WorkspaceExecutorFactsProvider
  & WorkspaceExistingPathResolver
  & WorkspaceReadFileExecutor;

export type WorkspaceWriteExecutor =
  & WorkspaceExecutorFactsProvider
  & WorkspaceWritablePathResolver
  & WorkspaceWriteLockProvider
  & WorkspaceWriteFileExecutor;

export type WorkspaceEditExecutor =
  & WorkspaceExecutorFactsProvider
  & WorkspaceExistingPathResolver
  & WorkspaceWriteLockProvider
  & WorkspaceReadFileExecutor
  & WorkspaceWriteFileExecutor;

export type WorkspaceGlobExecutor =
  & WorkspaceExecutorFactsProvider
  & WorkspaceExistingPathResolver
  & WorkspaceGlobFilesExecutor;

export type WorkspaceGrepExecutor =
  & WorkspaceExecutorFactsProvider
  & WorkspaceExistingPathResolver
  & WorkspaceGrepFilesExecutor;

export type WorkspaceSearchExecutor = WorkspaceGlobExecutor & WorkspaceGrepExecutor;

export interface WorkspaceExecutor
  extends WorkspaceBashExecutor,
    WorkspaceFileOperations,
    WorkspaceReadExecutor,
    WorkspaceWriteExecutor,
    WorkspaceEditExecutor,
    WorkspaceGlobExecutor,
    WorkspaceGrepExecutor {}

export interface WorkspaceCommandSandboxManager {
  transform(request: SandboxTransformRequest): SandboxTransformResult;
}

export interface WorkspaceCommandSandboxContext {
  profile: PermissionProfile;
  workspaceRoots: readonly string[];
  sandboxManager: WorkspaceCommandSandboxManager;
  preference?: SandboxablePreference;
  platform?: SandboxPlatform;
  pathContext?: Partial<Omit<SandboxPathContext, 'workspaceRoots'>>;
}

export type WorkspaceCommandSandboxContextProvider =
  () => WorkspaceCommandSandboxContext | undefined;

export type WorkspaceCommandRunner = (
  argv: readonly string[],
  options: BoundedProcessOptions,
) => Promise<BoundedProcessResult>;

export type WorkspaceCommandSandboxErrorReason =
  | 'missing_context'
  | 'missing_workspace_roots'
  | SandboxTransformFailureReason;

export interface WorkspaceCommandSandboxErrorDetails {
  reason: WorkspaceCommandSandboxErrorReason;
  sandboxType?: SandboxType;
  requiresSandbox?: boolean;
  message?: string;
}

export class WorkspaceCommandSandboxError extends Error {
  readonly code = 'SANDBOX_COMMAND_BLOCKED';
  readonly domain: SandboxErrorDomain = 'command';
  readonly stage: SandboxErrorStage;
  readonly reason: WorkspaceCommandSandboxErrorReason;
  readonly sandboxType?: SandboxType;
  readonly backend?: SandboxType;
  readonly requiresSandbox?: boolean;
  readonly recoverable = false;

  constructor(details: WorkspaceCommandSandboxErrorDetails) {
    super(details.message ?? defaultSandboxErrorMessage(details.reason));
    this.name = 'WorkspaceCommandSandboxError';
    this.stage = sandboxErrorStage(details.reason);
    this.reason = details.reason;
    this.sandboxType = details.sandboxType;
    this.backend = details.sandboxType;
    this.requiresSandbox = details.requiresSandbox;
  }
}

export interface SandboxedCommandWorkspaceExecutorOptions {
  inner: WorkspaceExecutor;
  getSandboxContext: WorkspaceCommandSandboxContextProvider;
  runProcess?: WorkspaceCommandRunner;
}

export interface WorkspaceProfileEnforcementContext {
  profile: PermissionProfile;
  workspaceRoots: readonly string[];
  pathContext?: Partial<Omit<PermissionProfileMatchContext, 'workspaceRoots'>>;
}

export type WorkspaceProfileEnforcementContextProvider =
  () => WorkspaceProfileEnforcementContext | undefined;

export type WorkspaceProfileOperation = 'read' | 'write' | 'search';

export type WorkspaceProfilePermissionErrorReason =
  | 'missing_context'
  | 'missing_workspace_roots'
  | 'read_denied'
  | 'write_denied';

export interface WorkspaceProfilePermissionErrorDetails {
  operation: WorkspaceProfileOperation;
  path: string;
  reason: WorkspaceProfilePermissionErrorReason;
  profileName?: string;
  message?: string;
}

export class WorkspaceProfilePermissionError extends Error {
  readonly code = 'WORKSPACE_PROFILE_PERMISSION_DENIED';
  readonly domain: SandboxErrorDomain = 'filesystem';
  readonly stage: SandboxErrorStage;
  readonly operation: WorkspaceProfileOperation;
  readonly path: string;
  readonly reason: WorkspaceProfilePermissionErrorReason;
  readonly recoverable = false;
  readonly profileName?: string;

  constructor(details: WorkspaceProfilePermissionErrorDetails) {
    super(details.message ?? defaultProfilePermissionErrorMessage(details));
    this.name = 'WorkspaceProfilePermissionError';
    this.stage = profilePermissionErrorStage(details.reason);
    this.operation = details.operation;
    this.path = details.path;
    this.reason = details.reason;
    this.profileName = details.profileName;
  }
}

export interface WorkspaceFilePathValidationErrorDetails {
  operation: WorkspaceProfileOperation;
  path: string;
  profileName?: string;
  message?: string;
}

export class WorkspaceFilePathValidationError extends Error {
  readonly code = 'SANDBOX_FILESYSTEM_PATH_DENIED';
  readonly domain: SandboxErrorDomain = 'filesystem';
  readonly stage: SandboxErrorStage = 'validation';
  readonly reason = 'path_denied';
  readonly recoverable = false;
  readonly operation: WorkspaceProfileOperation;
  readonly path: string;
  readonly profileName?: string;

  constructor(details: WorkspaceFilePathValidationErrorDetails) {
    super(details.message ?? `Workspace ${details.operation} path was denied: ${details.path}`);
    this.name = 'WorkspaceFilePathValidationError';
    this.operation = details.operation;
    this.path = details.path;
    this.profileName = details.profileName;
  }
}

export interface ProfileEnforcedWorkspaceExecutorOptions {
  inner: WorkspaceExecutor;
  getProfileContext: WorkspaceProfileEnforcementContextProvider;
}

export class LocalWorkspaceExecutor implements WorkspaceExecutor {
  readonly facts = LOCAL_WORKSPACE_EXECUTOR_FACTS;

  async exec(input: WorkspaceExecInput): Promise<WorkspaceExecResult> {
    const result = await runShellWithBoundedTail(input.command, {
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
      ...(input.env ? { env: input.env } : {}),
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
      ...(input.emitOutput ? { emitOutput: input.emitOutput } : {}),
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.timedOut ? 124 : result.aborted ? 130 : result.exitCode,
      stdoutTruncated: result.stdoutTruncated,
      stderrTruncated: result.stderrTruncated,
      timedOut: result.timedOut,
      aborted: result.aborted,
    };
  }

  async readFile(input: WorkspaceReadFileInput): Promise<WorkspaceReadFileResult> {
    const content = await fs.readFile(input.path, 'utf8');
    if (input.offset === undefined && input.limit === undefined) return { content };
    const lines = content.split('\n');
    const start = input.offset ?? 0;
    const end = input.limit ? start + input.limit : lines.length;
    return { content: lines.slice(start, end).join('\n') };
  }

  async writeFile(input: WorkspaceWriteFileInput): Promise<WorkspaceWriteFileResult> {
    await fs.writeFile(input.path, input.content, 'utf8');
    return {
      ok: true,
      path: input.path,
      bytes: Buffer.byteLength(input.content, 'utf8'),
    };
  }

  async resolveExistingPath(input: WorkspaceResolvePathInput): Promise<WorkspaceResolvePathResult> {
    return { path: await resolveExistingInsideCwd(input.cwd, input.path, input.label) };
  }

  async resolveWritablePath(input: WorkspaceResolvePathInput): Promise<WorkspaceResolvePathResult> {
    return { path: await resolveWritableInsideCwd(input.cwd, input.path, input.label) };
  }

  async writeLockKey(input: WorkspaceWriteLockKeyInput): Promise<WorkspaceWriteLockKeyResult> {
    return { key: resolve(await fs.realpath(input.cwd), input.path) };
  }

  async globFiles(input: WorkspaceGlobInput): Promise<WorkspaceGlobResult> {
    const files: string[] = [];
    const limit = input.limit ?? 200;
    for await (const file of nodeGlob(input.pattern, { cwd: input.cwd })) {
      files.push(typeof file === 'string' ? file : (file as { name: string }).name);
      if (files.length >= limit) break;
    }
    return { files };
  }

  async grepFiles(input: WorkspaceGrepInput): Promise<WorkspaceGrepResult> {
    const args = ['-n', '--no-heading', `--max-count=${input.maxCountPerFile}`];
    if (input.glob) args.push('--glob', input.glob);
    args.push(input.pattern, input.path);
    const command = `rg ${args.map(shellEscape).join(' ')}`;
    try {
      const { stdout } = await execAsync(command, {
        cwd: input.cwd,
        maxBuffer: 5 * 1024 * 1024,
        timeout: input.timeoutMs,
        ...(input.abortSignal ? { signal: input.abortSignal } : {}),
      });
      return { matches: stdout.split('\n').filter(Boolean).slice(0, input.limit) };
    } catch (error: any) {
      if (error?.code === 1) return { matches: [] };
      throw error;
    }
  }

  async read(input: WorkspaceReadInput): Promise<WorkspaceReadResult> {
    const { path } = await this.resolveExistingPath({ cwd: input.cwd, path: input.path, label: 'Read' });
    return await this.readFile({
      ...input,
      path,
    });
  }

  async write(input: WorkspaceWriteInput): Promise<WorkspaceWriteResult> {
    const { path } = await this.resolveWritablePath({ cwd: input.cwd, path: input.path, label: 'Write' });
    return await this.writeFile({ ...input, path });
  }

  async edit(input: WorkspaceEditInput): Promise<WorkspaceEditResult> {
    const { path } = await this.resolveExistingPath({ cwd: input.cwd, path: input.path, label: 'Edit' });
    const { content } = await this.readFile({ cwd: input.cwd, path });
    const result = computeEditedSource(content, input.oldString, input.newString, input.path);
    await this.writeFile({ cwd: input.cwd, path, content: result.content });
    return {
      ok: true,
      path,
      replacements: 1,
      matchedVia: result.matchedVia,
      startLine: result.startLine,
      endLine: result.endLine,
    };
  }

  async glob(input: WorkspaceGlobOperationInput): Promise<WorkspaceGlobResult> {
    const { path } = await this.resolveExistingPath({ cwd: input.cwd, path: input.path, label: 'Glob cwd' });
    return await this.globFiles({ cwd: path, pattern: input.pattern, limit: input.limit });
  }

  async grep(input: WorkspaceGrepOperationInput): Promise<WorkspaceGrepResult> {
    const { path } = await this.resolveExistingPath({ cwd: input.cwd, path: input.path, label: 'Grep' });
    return await this.grepFiles({ ...input, path });
  }
}

export class SandboxedCommandWorkspaceExecutor implements WorkspaceExecutor {
  readonly facts: WorkspaceExecutorFacts;
  private readonly inner: WorkspaceExecutor;
  private readonly getSandboxContext: WorkspaceCommandSandboxContextProvider;
  private readonly runProcess: WorkspaceCommandRunner;

  constructor(options: SandboxedCommandWorkspaceExecutorOptions) {
    this.inner = options.inner;
    this.facts = options.inner.facts;
    this.getSandboxContext = options.getSandboxContext;
    this.runProcess = options.runProcess ?? runProcessWithBoundedTail;
  }

  async exec(input: WorkspaceExecInput): Promise<WorkspaceExecResult> {
    const context = this.getSandboxContext();
    if (!context) {
      throw new WorkspaceCommandSandboxError({
        reason: 'missing_context',
        message: 'Sandbox context is required for command execution but was unavailable.',
      });
    }
    if (!context.workspaceRoots || context.workspaceRoots.length === 0) {
      throw new WorkspaceCommandSandboxError({
        reason: 'missing_workspace_roots',
        message: 'Sandbox workspace roots are required for command execution but were unavailable.',
      });
    }

    const transform = context.sandboxManager.transform({
      command: {
        program: '/bin/sh',
        args: ['-c', input.command],
        cwd: input.cwd,
        ...(input.env ? { env: input.env } : {}),
        profile: context.profile,
        pathContext: {
          tmpdir: osTmpdir(),
          slashTmp: '/tmp',
          ...context.pathContext,
          workspaceRoots: context.workspaceRoots,
        },
      },
      ...(context.preference ? { preference: context.preference } : {}),
      ...(context.platform ? { platform: context.platform } : {}),
    });

    if (!transform.ok) {
      throw new WorkspaceCommandSandboxError({
        reason: transform.reason,
        sandboxType: transform.sandboxType,
        requiresSandbox: transform.requiresSandbox,
        message: transform.message,
      });
    }

    const result = await this.runProcess(transform.exec.argv, {
      cwd: transform.exec.cwd,
      timeoutMs: input.timeoutMs,
      ...(transform.exec.env ? { env: transform.exec.env as NodeJS.ProcessEnv } : {}),
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
      ...(input.emitOutput ? { emitOutput: input.emitOutput } : {}),
    });

    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.timedOut ? 124 : result.aborted ? 130 : result.exitCode,
      stdoutTruncated: result.stdoutTruncated,
      stderrTruncated: result.stderrTruncated,
      timedOut: result.timedOut,
      aborted: result.aborted,
    };
  }

  readFile(input: WorkspaceReadFileInput): Promise<WorkspaceReadFileResult> {
    return this.inner.readFile(input);
  }

  writeFile(input: WorkspaceWriteFileInput): Promise<WorkspaceWriteFileResult> {
    return this.inner.writeFile(input);
  }

  resolveExistingPath(input: WorkspaceResolvePathInput): Promise<WorkspaceResolvePathResult> {
    return this.inner.resolveExistingPath(input);
  }

  resolveWritablePath(input: WorkspaceResolvePathInput): Promise<WorkspaceResolvePathResult> {
    return this.inner.resolveWritablePath(input);
  }

  writeLockKey(input: WorkspaceWriteLockKeyInput): Promise<WorkspaceWriteLockKeyResult> {
    return this.inner.writeLockKey(input);
  }

  globFiles(input: WorkspaceGlobInput): Promise<WorkspaceGlobResult> {
    return this.inner.globFiles(input);
  }

  grepFiles(input: WorkspaceGrepInput): Promise<WorkspaceGrepResult> {
    return this.inner.grepFiles(input);
  }

  read(input: WorkspaceReadInput): Promise<WorkspaceReadResult> {
    return this.inner.read(input);
  }

  write(input: WorkspaceWriteInput): Promise<WorkspaceWriteResult> {
    return this.inner.write(input);
  }

  edit(input: WorkspaceEditInput): Promise<WorkspaceEditResult> {
    return this.inner.edit(input);
  }

  glob(input: WorkspaceGlobOperationInput): Promise<WorkspaceGlobResult> {
    return this.inner.glob(input);
  }

  grep(input: WorkspaceGrepOperationInput): Promise<WorkspaceGrepResult> {
    return this.inner.grep(input);
  }
}

export class ProfileEnforcedWorkspaceExecutor implements WorkspaceExecutor {
  readonly facts: WorkspaceExecutorFacts;
  private readonly inner: WorkspaceExecutor;
  private readonly getProfileContext: WorkspaceProfileEnforcementContextProvider;

  constructor(options: ProfileEnforcedWorkspaceExecutorOptions) {
    this.inner = options.inner;
    this.facts = options.inner.facts;
    this.getProfileContext = options.getProfileContext;
  }

  exec(input: WorkspaceExecInput): Promise<WorkspaceExecResult> {
    return this.inner.exec(input);
  }

  async readFile(input: WorkspaceReadFileInput): Promise<WorkspaceReadFileResult> {
    this.assertCanRead(input.path, 'read');
    return await this.inner.readFile(input);
  }

  async writeFile(input: WorkspaceWriteFileInput): Promise<WorkspaceWriteFileResult> {
    this.assertCanWrite(input.path, 'write');
    return await this.inner.writeFile(input);
  }

  async resolveExistingPath(input: WorkspaceResolvePathInput): Promise<WorkspaceResolvePathResult> {
    const result = await this.inner.resolveExistingPath(input);
    this.assertCanRead(result.path, 'read');
    return result;
  }

  async resolveWritablePath(input: WorkspaceResolvePathInput): Promise<WorkspaceResolvePathResult> {
    const result = await this.inner.resolveWritablePath(input);
    this.assertCanWrite(result.path, 'write');
    return result;
  }

  writeLockKey(input: WorkspaceWriteLockKeyInput): Promise<WorkspaceWriteLockKeyResult> {
    return this.inner.writeLockKey(input);
  }

  async globFiles(input: WorkspaceGlobInput): Promise<WorkspaceGlobResult> {
    this.assertCanRead(input.cwd, 'search');
    return await this.inner.globFiles(input);
  }

  async grepFiles(input: WorkspaceGrepInput): Promise<WorkspaceGrepResult> {
    this.assertCanRead(input.path, 'search');
    return await this.inner.grepFiles(input);
  }

  async read(input: WorkspaceReadInput): Promise<WorkspaceReadResult> {
    const resolved = await this.resolveExistingPath({ cwd: input.cwd, path: input.path, label: 'Read' });
    return await this.readFile({ ...input, path: resolved.path });
  }

  async write(input: WorkspaceWriteInput): Promise<WorkspaceWriteResult> {
    const resolved = await this.resolveWritablePath({ cwd: input.cwd, path: input.path, label: 'Write' });
    return await this.writeFile({ ...input, path: resolved.path });
  }

  async edit(input: WorkspaceEditInput): Promise<WorkspaceEditResult> {
    const resolved = await this.resolveExistingPath({ cwd: input.cwd, path: input.path, label: 'Edit' });
    const { content } = await this.readFile({ cwd: input.cwd, path: resolved.path });
    const result = computeEditedSource(content, input.oldString, input.newString, input.path);
    await this.writeFile({ cwd: input.cwd, path: resolved.path, content: result.content });
    return {
      ok: true,
      path: resolved.path,
      replacements: 1,
      matchedVia: result.matchedVia,
      startLine: result.startLine,
      endLine: result.endLine,
    };
  }

  async glob(input: WorkspaceGlobOperationInput): Promise<WorkspaceGlobResult> {
    const resolved = await this.resolveExistingPath({ cwd: input.cwd, path: input.path, label: 'Glob cwd' });
    return await this.globFiles({ cwd: resolved.path, pattern: input.pattern, limit: input.limit });
  }

  async grep(input: WorkspaceGrepOperationInput): Promise<WorkspaceGrepResult> {
    const resolved = await this.resolveExistingPath({ cwd: input.cwd, path: input.path, label: 'Grep' });
    return await this.grepFiles({ ...input, path: resolved.path });
  }

  private assertCanRead(path: string, operation: 'read' | 'search'): void {
    const { profile, matchContext } = this.requireProfileContext(operation, path);
    if (canReadPath(profile, path, matchContext)) return;
    throw new WorkspaceProfilePermissionError({
      operation,
      path,
      reason: 'read_denied',
      profileName: profileName(profile),
    });
  }

  private assertCanWrite(path: string, operation: 'write'): void {
    const { profile, matchContext } = this.requireProfileContext(operation, path);
    if (canWritePath(profile, path, matchContext)) return;
    throw new WorkspaceProfilePermissionError({
      operation,
      path,
      reason: 'write_denied',
      profileName: profileName(profile),
    });
  }

  private requireProfileContext(
    operation: WorkspaceProfileOperation,
    path: string,
  ): { profile: PermissionProfile; matchContext: PermissionProfileMatchContext } {
    const context = this.getProfileContext();
    if (!context) {
      throw new WorkspaceProfilePermissionError({
        operation,
        path,
        reason: 'missing_context',
      });
    }
    if (!context.workspaceRoots || context.workspaceRoots.length === 0) {
      throw new WorkspaceProfilePermissionError({
        operation,
        path,
        reason: 'missing_workspace_roots',
        profileName: profileName(context.profile),
      });
    }
    return {
      profile: context.profile,
      matchContext: {
        tmpdir: osTmpdir(),
        slashTmp: '/tmp',
        ...context.pathContext,
        workspaceRoots: context.workspaceRoots,
      },
    };
  }
}

export function createLocalWorkspaceExecutor(): WorkspaceExecutor {
  return new LocalWorkspaceExecutor();
}

function defaultSandboxErrorMessage(reason: WorkspaceCommandSandboxErrorReason): string {
  if (reason === 'missing_context') return 'Sandbox context is required for command execution but was unavailable.';
  if (reason === 'missing_workspace_roots') return 'Sandbox workspace roots are required for command execution but were unavailable.';
  return `Sandbox command transform failed: ${reason}.`;
}

function sandboxErrorStage(reason: WorkspaceCommandSandboxErrorReason): SandboxErrorStage {
  if (reason === 'missing_context') return 'context';
  if (reason === 'missing_workspace_roots') return 'validation';
  return 'transform';
}

function defaultProfilePermissionErrorMessage(details: WorkspaceProfilePermissionErrorDetails): string {
  if (details.reason === 'missing_context') {
    return 'Permission profile context is required for workspace file access but was unavailable.';
  }
  if (details.reason === 'missing_workspace_roots') {
    return 'Permission profile workspace roots are required for workspace file access but were unavailable.';
  }
  if (details.reason === 'read_denied') {
    return `Permission profile denied ${details.operation} access to path: ${details.path}`;
  }
  return `Permission profile denied write access to path: ${details.path}`;
}

function profilePermissionErrorStage(reason: WorkspaceProfilePermissionErrorReason): SandboxErrorStage {
  return reason === 'missing_context' ? 'context' : 'validation';
}

function profileName(profile: PermissionProfile): string | undefined {
  return profile.name;
}

function shellEscape(arg: string): string {
  return `'${arg.replaceAll("'", "'\\''")}'`;
}

async function resolveWritableInsideCwd(cwd: string, inputPath: string, label: string): Promise<string> {
  if (isAbsolute(inputPath)) {
    throw new Error(`${label} path must be relative to session cwd`);
  }
  const root = await fs.realpath(cwd);
  const candidate = resolve(root, inputPath);
  if (!isInside(root, candidate)) {
    throw new Error(`${label} path must stay inside session cwd`);
  }
  const parent = await fs.realpath(dirname(candidate));
  if (!isInside(root, parent)) {
    throw new Error(`${label} path must stay inside session cwd`);
  }
  return candidate;
}

async function resolveExistingInsideCwd(cwd: string, inputPath: string, label: string): Promise<string> {
  if (isAbsolute(inputPath)) {
    throw new Error(`${label} path must be relative to session cwd`);
  }
  const root = await fs.realpath(cwd);
  const candidate = resolve(root, inputPath);
  if (!isInside(root, candidate)) {
    throw new Error(`${label} path must stay inside session cwd`);
  }
  const target = await fs.realpath(candidate);
  if (!isInside(root, target)) {
    throw new Error(`${label} path must stay inside session cwd`);
  }
  return target;
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
