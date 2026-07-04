import type {
  WorkspaceExecInput,
  WorkspaceExecResult,
  WorkspaceExecutor,
  WorkspaceExecutorFacts,
  WorkspaceGlobInput,
  WorkspaceGlobResult,
  WorkspaceGrepInput,
  WorkspaceGrepResult,
  WorkspaceReadFileInput,
  WorkspaceReadFileResult,
  WorkspaceWriteFileInput,
  WorkspaceWriteFileResult,
} from '@maka/runtime/workspace-executor';
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

export function isolatedToolExecutorToWorkspaceExecutor(
  executor: IsolatedToolExecutor,
  facts: WorkspaceExecutorFacts = ISOLATED_WORKSPACE_EXECUTOR_FACTS,
): WorkspaceExecutor {
  return {
    facts,
    exec: (input) => isolatedExec(executor, input),
    readFile: unsupportedReadFile,
    writeFile: (input) => isolatedWriteFile(executor, input),
    globFiles: (input) => isolatedGlobFiles(executor, input),
    grepFiles: (input) => isolatedGrepFiles(executor, input),
  };
}

async function isolatedExec(
  executor: IsolatedToolExecutor,
  input: WorkspaceExecInput,
): Promise<WorkspaceExecResult> {
  const result = await executor.exec({
    command: input.command,
    cwd: input.cwd,
    timeoutMs: input.timeoutMs,
    boundedTail: true,
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: false,
    aborted: false,
  };
}

async function unsupportedReadFile(_input: WorkspaceReadFileInput): Promise<WorkspaceReadFileResult> {
  throw new Error('IsolatedToolExecutor adapter does not provide readFile; use headless isolated Read tool instead');
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

async function isolatedGlobFiles(
  executor: IsolatedToolExecutor,
  input: WorkspaceGlobInput,
): Promise<WorkspaceGlobResult> {
  if (!executor.globFiles) {
    throw new Error('IsolatedToolExecutor adapter requires native globFiles for WorkspaceExecutor.globFiles');
  }
  const result = await executor.globFiles({
    cwd: input.cwd,
    pattern: input.pattern,
  });
  return { files: result.files.slice(0, input.limit ?? result.files.length) };
}

async function isolatedGrepFiles(
  executor: IsolatedToolExecutor,
  input: WorkspaceGrepInput,
): Promise<WorkspaceGrepResult> {
  if (!executor.grepFiles) {
    throw new Error('IsolatedToolExecutor adapter requires native grepFiles for WorkspaceExecutor.grepFiles');
  }
  const result = await executor.grepFiles({
    cwd: input.cwd,
    pattern: input.pattern,
    path: input.path,
    ...(input.glob ? { glob: input.glob } : {}),
  });
  return { matches: result.matches.slice(0, input.limit) };
}
