// packages/runtime/src/builtin-tools.ts
// Phase 1 baseline tool set. Each tool returned as MakaTool[] so
// wrapToolExecute can decorate with permission round-trip + tool_call/tool_result write.
//
// Read / Glob / Grep auto-approve.
// Bash / Write / Edit go through PermissionEngine.

import { z } from 'zod';
import { isAbsolute } from 'node:path';
import {
  buildBackgroundBashTool,
  buildStopBackgroundTaskTool,
  shapeTerminalResult,
} from './shell-tools.js';
import type { ShellRunToolController } from './shell-tools.js';
import { isShellRunResourceRef } from './shell-run-manager.js';
import {
  type WorkspaceExecResult,
  type WorkspaceBashExecutor,
  type WorkspaceExecutor,
  type WorkspaceFileOperations,
} from './workspace-executor.js';

// Single source of truth for tool shape. AiSdkBackend exports them; we just
// re-export here for back-compat with external callers that imported from
// builtin-tools directly.
import type { MakaTool, MakaToolContext } from './ai-sdk-backend.js';
export type { MakaTool, MakaToolContext };
import { withFileWriteLock } from './file-write-lock.js';

// Generous wall-clock cap for the ripgrep-backed Grep tool. A search should be
// near-instant; this only bounds a pathological hang now that the stream
// watchdog is paused during tool execution.
const GREP_TIMEOUT_MS = 120_000;

export interface BuildBuiltinToolsOptions {
  shellRuns?: ShellRunToolController;
  commandExecutor?: WorkspaceBashExecutor;
  fileOperations?: WorkspaceFileOperations;
  /** @deprecated Pass commandExecutor and fileOperations explicitly. */
  executor?: WorkspaceExecutor;
}

export function buildBuiltinTools(options: BuildBuiltinToolsOptions): MakaTool[] {
  const commandExecutor = options.commandExecutor ?? options.executor;
  const fileOperations = options.fileOperations ?? options.executor;
  if (!commandExecutor || !fileOperations) {
    throw new Error('buildBuiltinTools requires explicit commandExecutor and fileOperations');
  }
  const commandExecutionFacts = commandExecutor.facts;
  const fileExecutionFacts = fileOperations.facts;
  const readDescription = options.shellRuns
    ? 'Read a file from disk by path relative to session cwd, or read a runtime background task ref.'
    : 'Read a file from disk by path relative to session cwd.';
  const bashTools = options.shellRuns
    ? [
      buildBackgroundBashTool(options.shellRuns, { executionFacts: commandExecutionFacts }),
      buildStopBackgroundTaskTool(options.shellRuns),
    ]
    : [buildExecutorBashTool(commandExecutor)];
  return [
    ...bashTools,
    {
      name: 'Read',
      description: readDescription,
      parameters: z.object({
        path: z.string(),
        offset: z.number().int().nonnegative().optional(),
        limit: z.number().int().positive().optional(),
      }),
      permissionRequired: false,
      sandboxRequirement: 'filesystem',
      executionFacts: fileExecutionFacts,
      impl: async ({ path, offset, limit }, { cwd, sessionId }) => {
        if (path.startsWith('maka://runtime/')) {
          if (!isShellRunResourceRef(path)) throw new Error(`Unsupported runtime resource ref: ${path}`);
          if (!options.shellRuns) throw new Error('Runtime background task resources are not available in this toolset');
          return await options.shellRuns.readResource(sessionId, path);
        }
        return await fileOperations.read({
          cwd,
          path,
          ...(offset !== undefined ? { offset } : {}),
          ...(limit !== undefined ? { limit } : {}),
        });
      },
    },
    {
      name: 'Write',
      description: 'Write content to a file (creates or overwrites). Subject to permission policy.',
      parameters: z.object({ path: z.string(), content: z.string() }),
      permissionRequired: true,
      sandboxRequirement: 'filesystem',
      executionFacts: fileExecutionFacts,
      impl: async ({ path, content }, { cwd }) => {
        const { key } = await fileOperations.writeLockKey({ cwd, path });
        return await withFileWriteLock(key, async () => {
          return await fileOperations.write({ cwd, path, content });
        });
      },
    },
    {
      name: 'Edit',
      description:
        'Replace old_string with new_string in a file. Prefers an exact, unique match; '
        + 'if exact fails it tolerates limited whitespace/indentation/escape drift in old_string, '
        + 'but only when the match is unambiguous (otherwise it errors — re-read and retry with exact text). '
        + 'new_string is written verbatim, so provide the exact final text/indentation you want. '
        + 'Errors if old_string is not found or not unique.',
      parameters: z.object({
        path: z.string(),
        old_string: z.string(),
        new_string: z.string(),
      }),
      permissionRequired: true,
      sandboxRequirement: 'filesystem',
      executionFacts: fileExecutionFacts,
      impl: async ({ path, old_string, new_string }, { cwd }) => {
        const { key } = await fileOperations.writeLockKey({ cwd, path });
        return await withFileWriteLock(key, async () => {
          return await fileOperations.edit({
            cwd,
            path,
            oldString: old_string,
            newString: new_string,
          });
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
      sandboxRequirement: 'filesystem',
      executionFacts: fileExecutionFacts,
      impl: async ({ pattern, cwd: relCwd }, { cwd }) => {
        assertRelativeGlobPattern(pattern);
        return await fileOperations.glob({
          cwd,
          path: relCwd ?? '.',
          pattern,
          limit: 200,
        });
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
      sandboxRequirement: 'filesystem',
      executionFacts: fileExecutionFacts,
      impl: async ({ pattern, path, glob }, { cwd, abortSignal }) => {
        // Self-bound: ripgrep finishes in well under a second normally, but a
        // pathological tree (network mount, /proc, a FIFO) could hang it. The
        // stream watchdog no longer caps tool execution, so each spawning tool
        // must carry its own wall-clock timeout and honour the turn's abort.
        return await fileOperations.grep({
          cwd,
          pattern,
          path: path ?? '.',
          ...(glob ? { glob } : {}),
          maxCountPerFile: 50,
          limit: 200,
          timeoutMs: GREP_TIMEOUT_MS,
          ...(abortSignal ? { abortSignal } : {}),
        });
      },
    },
  ];
}

function buildExecutorBashTool(executor: WorkspaceBashExecutor): MakaTool {
  return {
    name: 'Bash',
    description: 'Run a shell command in the session cwd. Subject to permission policy.',
    parameters: z.object({
      command: z.string().describe('The shell command to execute'),
      timeout_ms: z.number().int().positive().max(600_000).optional(),
    }),
    permissionRequired: true,
    sandboxRequirement: 'command',
    executionFacts: executor.facts,
    impl: async ({ command, timeout_ms }, { cwd, abortSignal, emitOutput }) => {
      const timeout = timeout_ms ?? 120_000;
      const result = await executor.exec({
        command,
        cwd,
        timeoutMs: timeout,
        ...(abortSignal ? { abortSignal } : {}),
        emitOutput,
      });
      if (result.timedOut) throw terminalError(`Command timed out after ${timeout}ms`, result, 124);
      if (result.aborted) throw terminalError('Command aborted', result, 130);
      if (result.exitCode !== 0) {
        throw terminalError(`Command failed with exit code ${result.exitCode}`, result, result.exitCode);
      }
      return shapeTerminalResult({ cwd, command, result });
    },
  };
}

function terminalError(
  message: string,
  result: Pick<WorkspaceExecResult, 'stdout' | 'stderr' | 'stdoutTruncated' | 'stderrTruncated'>,
  code: number,
): Error {
  const error = new Error(message);
  Object.assign(error, {
    stdout: result.stdout,
    stderr: result.stderr,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
    code,
  });
  return error;
}

function assertRelativeGlobPattern(pattern: string): void {
  if (isAbsolute(pattern) || pattern.split(/[\\/]+/).includes('..')) {
    throw new Error('Glob pattern must stay inside session cwd');
  }
}
