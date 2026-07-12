// packages/runtime/src/builtin-tools.ts
// Phase 1 baseline tool set. Each tool returned as MakaTool[] so
// wrapToolExecute can decorate with permission round-trip + tool_call/tool_result write.
//
// Read / Glob / Grep auto-approve.
// Bash / Write / Edit go through PermissionEngine.

import { z } from 'zod';
import { isAbsolute } from 'node:path';
import { computeEditedSource } from './edit-replace.js';
import {
  buildManagedBashTool,
  buildStopBackgroundTaskTool,
  buildWriteStdinTool,
  shapeTerminalResult,
  withShellGuidance,
} from './shell-tools.js';
import type { ShellRunLauncher } from './shell-tools.js';
import { defaultShellPlan, type ShellPlan } from './shell-detect.js';
import type {
  BackgroundTaskStopper,
  PtyControlWriter,
  RuntimeResourceReader,
} from './shell-run-contract.js';
import {
  createLocalWorkspaceExecutor,
  type WorkspaceExecResult,
  type WorkspaceExecutor,
} from './workspace-executor.js';

// tool-runtime.ts is the single source of truth for the tool shape; this
// re-export only keeps back-compat for callers that imported from
// builtin-tools directly.
import type { MakaTool, MakaToolContext } from './tool-runtime.js';
export type { MakaTool, MakaToolContext };
import { withFileWriteLock } from './file-write-lock.js';

// Generous wall-clock cap for the ripgrep-backed Grep tool. A search should be
// near-instant; this only bounds a pathological hang now that the stream
// watchdog is paused during tool execution.
const GREP_TIMEOUT_MS = 120_000;

export interface BuildBuiltinToolsOptions {
  shellRuns?: ShellRunLauncher;
  runtimeResources?: RuntimeResourceReader;
  backgroundTasks?: BackgroundTaskStopper;
  ptyControls?: PtyControlWriter;
  executor?: WorkspaceExecutor;
  /** Shell that runs Bash commands. Defaults to the process-wide detected shell. */
  shell?: ShellPlan;
}

export function buildBuiltinTools(options: BuildBuiltinToolsOptions = {}): MakaTool[] {
  const executor = options.executor ?? createLocalWorkspaceExecutor();
  const executionFacts = executor.facts;
  const readDescription = options.runtimeResources
    ? 'Read a file from disk using path relative to session cwd, or read a whole runtime resource using ref.'
    : 'Read a file from disk by path relative to session cwd.';
  const fileReadParameters = z.object({
    path: z.string().describe('A file path relative to the session cwd'),
    offset: z.number().int().nonnegative().optional(),
    limit: z.number().int().positive().optional(),
  }).strict();
  const readParameters = options.runtimeResources
    ? z.union([
        fileReadParameters,
        z.object({
          ref: z.string().describe('A runtime resource ref returned by another tool'),
        }).strict(),
      ])
    : fileReadParameters;
  const shell = options.shell ?? defaultShellPlan();
  const bashTools = options.shellRuns
    ? [buildManagedBashTool(options.shellRuns, { executionFacts, shell })]
    : [buildExecutorBashTool(executor, shell)];
  const backgroundTools = [
    ...(options.backgroundTasks ? [buildStopBackgroundTaskTool(options.backgroundTasks)] : []),
    ...(options.ptyControls ? [buildWriteStdinTool(options.ptyControls)] : []),
  ];
  return [
    ...bashTools,
    ...backgroundTools,
    {
      name: 'Read',
      activityKind: 'read',
      description: readDescription,
      parameters: readParameters,
      permissionRequired: false,
      executionFacts,
      impl: async (input, { cwd, sessionId, abortSignal }) => {
        if ('ref' in input) {
          const { ref } = input;
          if (classifyRuntimeResourceRef(ref) !== 'runtime') {
            throw new Error(`Unsupported runtime resource ref: ${ref}`);
          }
          if (!options.runtimeResources) throw new Error('Runtime resources are not available in this toolset');
          return await options.runtimeResources.readRuntimeResource(sessionId, ref, abortSignal);
        }

        const { path, offset, limit } = input;
        const runtimeRef = classifyRuntimeResourceRef(path);
        if (runtimeRef === 'unsupported') throw new Error(`Unsupported runtime resource ref: ${path}`);
        if (runtimeRef === 'runtime') {
          throw new Error('Runtime resources must be read with the ref parameter, not path');
        }
        const { path: resolvedPath } = await executor.resolveExistingPath({ cwd, path, label: 'Read' });
        return await executor.readFile({
          cwd,
          path: resolvedPath,
          ...(offset !== undefined ? { offset } : {}),
          ...(limit !== undefined ? { limit } : {}),
        });
      },
    },
    {
      name: 'Write',
      activityKind: 'edit',
      description: 'Write content to a file (creates or overwrites). Subject to permission policy.',
      parameters: z.object({ path: z.string(), content: z.string() }),
      permissionRequired: true,
      executionFacts,
      impl: async ({ path, content }, { cwd }) => {
        const { key } = await executor.writeLockKey({ cwd, path });
        return await withFileWriteLock(key, async () => {
          const { path: resolvedPath } = await executor.resolveWritablePath({ cwd, path, label: 'Write' });
          return await executor.writeFile({ cwd, path: resolvedPath, content });
        });
      },
    },
    {
      name: 'Edit',
      activityKind: 'edit',
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
      executionFacts,
      impl: async ({ path, old_string, new_string }, { cwd }) => {
        const { key } = await executor.writeLockKey({ cwd, path });
        return await withFileWriteLock(key, async () => {
          const { path: resolvedPath } = await executor.resolveExistingPath({ cwd, path, label: 'Edit' });
          const { content: current } = await executor.readFile({ cwd, path: resolvedPath });
          const result = computeEditedSource(current, old_string, new_string, path);
          await executor.writeFile({ cwd, path: resolvedPath, content: result.content });
          return {
            ok: true,
            path: resolvedPath,
            replacements: 1,
            matchedVia: result.matchedVia,
            startLine: result.startLine,
            endLine: result.endLine,
          };
        });
      },
    },
    {
      name: 'FormatJson',
      activityKind: 'edit',
      description:
        'Validate and normalize a JSON file in place. Reads the file at `path`, '
        + 'parses it (throwing a parse-error hint on invalid JSON), optionally sorts '
        + 'object keys lexicographically, and rewrites it with canonical 2-space '
        + 'indentation. Returns only a diagnostic (valid + byte delta) — the content '
        + 'is never round-tripped back through the prompt. Useful for config hygiene '
        + 'after a Write.',
      parameters: z.object({
        path: z.string().describe('Path to the JSON file to validate and normalize, relative to the session cwd.'),
        sort_keys: z.boolean().optional()
          .describe('Sort object keys lexicographically; default false.'),
      }),
      permissionRequired: true,
      executionFacts,
      impl: async ({ path, sort_keys }, { cwd }) => {
        const { key } = await executor.writeLockKey({ cwd, path });
        return await withFileWriteLock(key, async () => {
          const { path: resolvedPath } = await executor.resolveExistingPath({ cwd, path, label: 'FormatJson' });
          const { content: original } = await executor.readFile({ cwd, path: resolvedPath });
          const bytesBefore = Buffer.byteLength(original, 'utf8');
          let parsed: unknown;
          try {
            parsed = JSON.parse(original);
          } catch (e) {
            return {
              ok: false,
              valid: false,
              error: `FormatJson: invalid JSON: ${(e as Error).message}`,
              path: resolvedPath,
              bytesBefore,
              byteDelta: 0,
              changed: false,
            };
          }
          const value = sort_keys ? sortKeysDeep(parsed) : parsed;
          const formatted = JSON.stringify(value, null, 2);
          const { bytes: bytesAfter } = await executor.writeFile({ cwd, path: resolvedPath, content: formatted });
          return {
            ok: true,
            path: resolvedPath,
            valid: true,
            bytesBefore,
            bytesAfter,
            byteDelta: bytesAfter - bytesBefore,
            changed: formatted !== original,
          };
        });
      },
    },
    {
      name: 'Glob',
      activityKind: 'search',
      description:
        'Find files matching a glob pattern (case-insensitive, capped at 200, sorted by walk order).',
      parameters: z.object({
        pattern: z.string(),
        cwd: z.string().optional(),
      }),
      permissionRequired: false,
      executionFacts,
      impl: async ({ pattern, cwd: relCwd }, { cwd }) => {
        assertRelativeGlobPattern(pattern);
        const { path: base } = await executor.resolveExistingPath({
          cwd,
          path: relCwd ?? '.',
          label: 'Glob cwd',
        });
        return await executor.globFiles({ cwd: base, pattern, limit: 200 });
      },
    },
    {
      name: 'Grep',
      activityKind: 'search',
      description: 'Search file contents with a regex via ripgrep.',
      parameters: z.object({
        pattern: z.string(),
        path: z.string().optional(),
        glob: z.string().optional(),
      }),
      permissionRequired: false,
      executionFacts,
      impl: async ({ pattern, path, glob }, { cwd, abortSignal }) => {
        const { path: searchPath } = await executor.resolveExistingPath({
          cwd,
          path: path ?? '.',
          label: 'Grep',
        });
        // Self-bound: ripgrep finishes in well under a second normally, but a
        // pathological tree (network mount, /proc, a FIFO) could hang it. The
        // stream watchdog no longer caps tool execution, so each spawning tool
        // must carry its own wall-clock timeout and honour the turn's abort.
        return await executor.grepFiles({
          cwd,
          pattern,
          path: searchPath,
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

function buildExecutorBashTool(executor: WorkspaceExecutor, shell: ShellPlan): MakaTool {
  return {
    name: 'Bash',
    activityKind: 'command',
    description: withShellGuidance('Run a shell command in the session cwd.', shell)
      + ' Subject to permission policy.',
    parameters: z.object({
      command: z.string().describe('The shell command to execute'),
      timeout_ms: z.number().int().positive().max(600_000).optional(),
    }),
    permissionRequired: true,
    executionFacts: executor.facts,
    impl: async ({ command, timeout_ms }, { cwd, abortSignal, emitOutput }) => {
      const timeout = timeout_ms ?? 120_000;
      const result = await executor.exec({
        command,
        cwd,
        timeoutMs: timeout,
        ...(abortSignal ? { abortSignal } : {}),
        emitOutput,
        shell,
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

export function classifyRuntimeResourceRef(path: string): 'runtime' | 'file' | 'unsupported' {
  let url: URL;
  try {
    url = new URL(path);
  } catch {
    return path.trimStart().toLowerCase().startsWith('maka:') ? 'unsupported' : 'file';
  }
  if (url.protocol !== 'maka:') return 'file';
  if (
    url.hostname !== 'runtime'
    || url.username
    || url.password
    || url.port
    || !url.pathname
    || url.pathname === '/'
  ) {
    return 'unsupported';
  }
  return 'runtime';
}

// Object.fromEntries creates own data properties, so special keys like
// "__proto__" are preserved instead of triggering the inherited setter.
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeysDeep((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}
