import type {
  WorkspaceExecInput,
  WorkspaceExecResult,
  WorkspaceExistingPathResolver,
  WorkspaceExecutorFactsProvider,
  WorkspaceExecutorFacts,
  WorkspaceResolvePathInput,
  WorkspaceResolvePathResult,
  WorkspaceGlobInput,
  WorkspaceGlobResult,
  WorkspaceGrepInput,
  WorkspaceGrepResult,
  WorkspaceWritablePathResolver,
  WorkspaceWriteExecutor,
  WorkspaceWriteFileInput,
  WorkspaceWriteFileResult,
  WorkspaceWriteLockKeyInput,
  WorkspaceWriteLockKeyResult,
} from '@maka/runtime/workspace-executor';
import { posix as pathPosix } from 'node:path';
import type { IsolatedToolExecutor } from './isolation.js';

export const ISOLATED_WORKSPACE_EXECUTOR_FACTS: WorkspaceExecutorFacts = {
  isolation: 'none',
  writesAffectHost: true,
  writeBack: 'direct',
  network: 'host',
  secrets: 'host_env',
};

export const EXTERNAL_ISOLATED_WORKSPACE_EXECUTOR_FACTS: WorkspaceExecutorFacts = {
  isolation: 'remote',
  writesAffectHost: false,
  writeBack: 'diff_review',
  network: 'sandbox',
  secrets: 'brokered',
};

export type IsolatedWorkspaceExecutorAdapter =
  & WorkspaceExecutorFactsProvider
  & WorkspaceExistingPathResolver
  & WorkspaceWritablePathResolver
  & WorkspaceWriteExecutor;

export function isolatedToolExecutorToWorkspaceExecutor(
  executor: IsolatedToolExecutor,
  facts: WorkspaceExecutorFacts = ISOLATED_WORKSPACE_EXECUTOR_FACTS,
): IsolatedWorkspaceExecutorAdapter {
  const adapter = {
    facts,
    exec: unsupportedExec,
    writeFile: (input: WorkspaceWriteFileInput) => isolatedWriteFile(executor, input),
    resolveExistingPath: isolatedResolvePath,
    resolveWritablePath: isolatedResolvePath,
    writeLockKey: isolatedWriteLockKey,
    globFiles: unsupportedGlobFiles,
    grepFiles: unsupportedGrepFiles,
  };
  return adapter;
}

async function unsupportedExec(_input: WorkspaceExecInput): Promise<WorkspaceExecResult> {
  throw new Error(
    'IsolatedToolExecutor adapter does not adapt Bash; WorkspaceExecutor.exec requires abort, timeout, and live-output controls that IsolatedToolExecutor cannot preserve. Use buildIsolatedHeadlessTools instead.',
  );
}

async function isolatedWriteFile(
  executor: IsolatedToolExecutor,
  input: WorkspaceWriteFileInput,
): Promise<WorkspaceWriteFileResult> {
  if (!executor.writeFile) {
    throw new Error('IsolatedToolExecutor adapter requires native writeFile for WorkspaceExecutor.writeFile');
  }
  return await executor.writeFile({
    cwd: input.cwd,
    path: input.path,
    content: input.content,
  });
}

async function isolatedResolvePath(input: WorkspaceResolvePathInput): Promise<WorkspaceResolvePathResult> {
  return { path: resolveIsolatedWorkspacePath(input.cwd, input.path, input.label) };
}

async function isolatedWriteLockKey(input: WorkspaceWriteLockKeyInput): Promise<WorkspaceWriteLockKeyResult> {
  return {
    key: JSON.stringify([
      pathPosix.normalize(input.cwd),
      resolveIsolatedWorkspacePath(input.cwd, input.path, 'Write path'),
    ]),
  };
}

async function unsupportedGlobFiles(_input: WorkspaceGlobInput): Promise<WorkspaceGlobResult> {
  throw new Error(
    'IsolatedToolExecutor adapter does not adapt Glob; WorkspaceExecutor.globFiles requires search and limit controls that IsolatedToolExecutor cannot preserve. Use buildIsolatedHeadlessTools instead.',
  );
}

async function unsupportedGrepFiles(_input: WorkspaceGrepInput): Promise<WorkspaceGrepResult> {
  throw new Error(
    'IsolatedToolExecutor adapter does not adapt Grep; WorkspaceExecutor.grepFiles requires abort, timeout, max-count, and limit controls that IsolatedToolExecutor cannot preserve. Use buildIsolatedHeadlessTools instead.',
  );
}

function resolveIsolatedWorkspacePath(cwd: string, inputPath: string, label: string): string {
  // Lexical preflight only. The isolated workspace may live in a remote/container
  // filesystem that this process cannot realpath; symlink and mount escape checks
  // are the responsibility of the native isolated backend.
  if (inputPath.length === 0 || /^[A-Za-z]:[\\/]/.test(inputPath)) {
    throw new Error(`${label} must stay inside workspace`);
  }
  const root = pathPosix.normalize(cwd);
  const target = inputPath.startsWith('/')
    ? pathPosix.normalize(inputPath)
    : pathPosix.resolve(root, inputPath);
  if (!isInsidePosix(root, target)) {
    throw new Error(`${label} must stay inside workspace`);
  }
  return target;
}

function isInsidePosix(root: string, target: string): boolean {
  const rel = pathPosix.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !pathPosix.isAbsolute(rel));
}
