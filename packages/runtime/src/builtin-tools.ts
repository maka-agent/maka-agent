// packages/runtime/src/builtin-tools.ts
// Built-in tool set. Each tool is returned as MakaTool[] so wrapToolExecute can
// decorate with permission round-trip + tool_call/tool_result write.

import { z } from 'zod';
import { computeEditedSource } from './edit-replace.js';
import { withFileWriteLock } from './file-write-lock.js';
import { truncateToolOutput } from './tool-output.js';
import {
  LocalWorkspaceExecutor,
  defaultWorkspaceFileLockKey,
  type WorkspaceExecutor,
} from './workspace-executor.js';

// Single source of truth for tool shape. AiSdkBackend exports them; we just
// re-export here for back-compat with external callers that imported from
// builtin-tools directly.
import type { MakaTool, MakaToolContext } from './ai-sdk-backend.js';
export type { MakaTool, MakaToolContext };

export interface BuildBuiltinToolsOptions {
  executor?: WorkspaceExecutor;
}

export function buildBuiltinTools(options: BuildBuiltinToolsOptions = {}): MakaTool[] {
  const executor = options.executor ?? new LocalWorkspaceExecutor();
  return [
    {
      name: 'Bash',
      description: 'Run a shell command in the session cwd. Subject to permission policy.',
      parameters: z.object({
        command: z.string().describe('The shell command to execute'),
        timeout_ms: z.number().int().positive().max(600_000).optional(),
      }),
      permissionRequired: true,
      impl: async ({ command, timeout_ms }, { cwd, abortSignal, emitOutput }) => {
        const result = await runExecutorShell(executor, command, {
          cwd,
          timeout: timeout_ms ?? 120_000,
          abortSignal,
          emitOutput,
        });
        return {
          kind: 'terminal',
          cwd,
          cmd: command,
          exitCode: result.exitCode,
          stdout: truncateToolOutput(result.stdout, { direction: 'tail' }).content,
          stderr: truncateToolOutput(result.stderr, { direction: 'tail' }).content,
        };
      },
    },
    {
      name: 'Read',
      description: 'Read a file from disk by path relative to session cwd.',
      parameters: z.object({
        path: z.string(),
        offset: z.number().int().nonnegative().optional(),
        limit: z.number().int().positive().optional(),
      }),
      permissionRequired: false,
      impl: async ({ path, offset, limit }, { cwd }) => {
        return await executor.readFile({ cwd, path, offset, limit });
      },
    },
    {
      name: 'Write',
      description: 'Write content to a file (creates or overwrites). Subject to permission policy.',
      parameters: z.object({ path: z.string(), content: z.string() }),
      permissionRequired: true,
      impl: async ({ path, content }, { cwd }) => {
        return await withFileWriteLock(
          await defaultWorkspaceFileLockKey(executor, { cwd, path }),
          async () => await executor.writeFile({ cwd, path, content }),
        );
      },
    },
    {
      name: 'Edit',
      description:
        'Replace old_string with new_string in a file. Prefers an exact, unique match; '
        + 'if exact fails it tolerates limited whitespace/indentation/escape drift in old_string, '
        + 'but only when the match is unambiguous (otherwise it errors - re-read and retry with exact text). '
        + 'new_string is written verbatim, so provide the exact final text/indentation you want. '
        + 'Errors if old_string is not found or not unique.',
      parameters: z.object({
        path: z.string(),
        old_string: z.string(),
        new_string: z.string(),
      }),
      permissionRequired: true,
      impl: async ({ path, old_string, new_string }, { cwd }) => {
        return await withFileWriteLock(await defaultWorkspaceFileLockKey(executor, { cwd, path }), async () => {
          const { content: current } = await executor.readFile({ cwd, path, label: 'Edit' });
          const result = computeEditedSource(current, old_string, new_string, path);
          const write = await executor.writeFile({ cwd, path, label: 'Edit', content: result.content });
          return {
            ok: true,
            path: write.path,
            replacements: 1,
            matchedVia: result.matchedVia,
            startLine: result.startLine,
            endLine: result.endLine,
          };
        });
      },
    },
    {
      name: 'Glob',
      description:
        'Find files matching a glob pattern (case-insensitive, capped at 200, sorted by walk order).',
      parameters: z.object({
        pattern: z.string(),
        cwd: z.string().optional(),
      }),
      permissionRequired: false,
      impl: async ({ pattern, cwd: relCwd }, { cwd }) => {
        return await executor.globFiles({ cwd, pattern, searchCwd: relCwd });
      },
    },
    {
      name: 'Grep',
      description: 'Search file contents with a regex via ripgrep.',
      parameters: z.object({
        pattern: z.string(),
        path: z.string().optional(),
        glob: z.string().optional(),
      }),
      permissionRequired: false,
      impl: async ({ pattern, path, glob }, { cwd, abortSignal }) => {
        return await executor.grepFiles({ cwd, pattern, path, glob, abortSignal });
      },
    },
  ];
}

// Keeps the builtin Bash contract: throw on timeout / abort / non-zero exit
// with stdout+stderr+code attached, stream live via emitOutput, and return the
// bounded tail on success.
async function runExecutorShell(
  executor: WorkspaceExecutor,
  command: string,
  options: {
    cwd: string;
    timeout: number;
    abortSignal: AbortSignal;
    emitOutput: (stream: 'stdout' | 'stderr', chunk: string) => void;
  },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const result = await executor.exec({
    command,
    cwd: options.cwd,
    timeoutMs: options.timeout,
    abortSignal: options.abortSignal,
    emitOutput: options.emitOutput,
  });
  if (result.timedOut) throw terminalError(`Command timed out after ${options.timeout}ms`, result, 124);
  if (result.aborted) throw terminalError('Command aborted', result, 130);
  if (result.exitCode !== 0) throw terminalError(`Command failed with exit code ${result.exitCode}`, result, result.exitCode);
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
}

function terminalError(
  message: string,
  result: { stdout: string; stderr: string },
  code: number,
): Error {
  const error = new Error(message);
  Object.assign(error, { stdout: result.stdout, stderr: result.stderr, code });
  return error;
}
