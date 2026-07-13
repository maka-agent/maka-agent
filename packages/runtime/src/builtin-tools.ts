// packages/runtime/src/builtin-tools.ts
// Phase 1 baseline tool set. Each tool returned as MakaTool[] so
// wrapToolExecute can decorate with permission round-trip + tool_call/tool_result write.
//
// Read / Glob / Grep auto-approve.
// Bash / Write / Edit go through PermissionEngine.

import { z } from 'zod';
import { isAbsolute } from 'node:path';
import {
  bashSandboxPermissionsSchema,
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
import {
  planDeclaredBashAdditionalPermission,
  planFileToolAdditionalPermission,
  type AdditionalPermissionPlanningContext,
} from './additional-permissions.js';
import {
  planDeclaredBashSandboxEscalation,
} from './sandbox-escalation.js';

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
  /** Required by the permission-aware factory; omitted only by legacy/custom assembly. */
  additionalPermissionPlanningContext?: AdditionalPermissionPlanningContext;
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
    ? 'Read a file by path, or read a runtime background task ref. Paths outside the active profile require one-time approval.'
    : 'Read a file by path. Paths outside the active profile require one-time approval.';
  const bashTools = options.shellRuns
    ? [
      buildBackgroundBashTool(options.shellRuns, {
        executionFacts: commandExecutionFacts,
        ...(options.additionalPermissionPlanningContext ? {
          planAdditionalPermissions: (args, context) => planDeclaredBashAdditionalPermission({
            declaration: args.sandbox_permissions,
            cwd: context.cwd,
            mode: context.mode,
            command: args.command,
            context: options.additionalPermissionPlanningContext!,
          }),
          planSandboxEscalation: (args, context) => planDeclaredBashSandboxEscalation({
            declaration: args.sandbox_permissions,
            cwd: context.cwd,
            mode: context.mode,
            command: args.command,
            args: context.args,
            ...(context.recentSandboxDenial ? { recentSandboxDenial: true } : {}),
          }),
        } : {}),
      }),
      buildStopBackgroundTaskTool(options.shellRuns),
    ]
    : [buildExecutorBashTool(commandExecutor, options.additionalPermissionPlanningContext)];
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
      ...(options.additionalPermissionPlanningContext ? {
        planAdditionalPermissions: ({ path }, context) => (
          path.startsWith('maka://runtime/')
            ? { kind: 'not_required' as const }
            : planFileToolAdditionalPermission({
                toolName: 'Read',
                path,
                cwd: context.cwd,
                mode: context.mode,
                args: context.args,
                context: options.additionalPermissionPlanningContext!,
              })
        ),
      } : {}),
      impl: async ({ path, offset, limit }, { cwd, sessionId, permissionContext }) => {
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
          permissionContext,
        });
      },
    },
    {
      name: 'Write',
      description: 'Write content to a file (creates or overwrites). Paths outside the active profile require one-time approval.',
      parameters: z.object({ path: z.string(), content: z.string() }),
      permissionRequired: true,
      sandboxRequirement: 'filesystem',
      executionFacts: fileExecutionFacts,
      ...(options.additionalPermissionPlanningContext ? {
        planAdditionalPermissions: ({ path }, context) => planFileToolAdditionalPermission({
          toolName: 'Write', path, cwd: context.cwd, mode: context.mode, args: context.args,
          context: options.additionalPermissionPlanningContext!,
        }),
      } : {}),
      impl: async ({ path, content }, { cwd, permissionContext }) => {
        const { key } = await fileOperations.writeLockKey({ cwd, path, permissionContext });
        return await withFileWriteLock(key, async () => {
          return await fileOperations.write({ cwd, path, content, permissionContext });
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
        + 'Errors if old_string is not found or not unique. Paths outside the active profile require one-time approval.',
      parameters: z.object({
        path: z.string(),
        old_string: z.string(),
        new_string: z.string(),
      }),
      permissionRequired: true,
      sandboxRequirement: 'filesystem',
      executionFacts: fileExecutionFacts,
      ...(options.additionalPermissionPlanningContext ? {
        planAdditionalPermissions: ({ path }, context) => planFileToolAdditionalPermission({
          toolName: 'Edit', path, cwd: context.cwd, mode: context.mode, args: context.args,
          context: options.additionalPermissionPlanningContext!,
        }),
      } : {}),
      impl: async ({ path, old_string, new_string }, { cwd, permissionContext }) => {
        const { key } = await fileOperations.writeLockKey({ cwd, path, permissionContext });
        return await withFileWriteLock(key, async () => {
          return await fileOperations.edit({
            cwd,
            path,
            oldString: old_string,
            newString: new_string,
            permissionContext,
          });
        });
      },
    },
    {
      name: 'Glob',
      description:
        'Find files matching a glob pattern (case-insensitive, capped at 200, sorted by walk order). Search roots outside the active profile require one-time approval.',
      parameters: z.object({
        pattern: z.string(),
        cwd: z.string().optional(),
      }),
      permissionRequired: false,
      sandboxRequirement: 'filesystem',
      executionFacts: fileExecutionFacts,
      ...(options.additionalPermissionPlanningContext ? {
        planAdditionalPermissions: ({ cwd: relCwd }, context) => planFileToolAdditionalPermission({
          toolName: 'Glob', path: relCwd ?? '.', cwd: context.cwd, mode: context.mode, args: context.args,
          context: options.additionalPermissionPlanningContext!,
        }),
      } : {}),
      impl: async ({ pattern, cwd: relCwd }, { cwd, permissionContext }) => {
        assertRelativeGlobPattern(pattern);
        return await fileOperations.glob({
          cwd,
          path: relCwd ?? '.',
          pattern,
          limit: 200,
          permissionContext,
        });
      },
    },
    {
      name: 'Grep',
      description: 'Search file contents with a regex via ripgrep. Search roots outside the active profile require one-time approval.',
      parameters: z.object({
        pattern: z.string(),
        path: z.string().optional(),
        glob: z.string().optional(),
      }),
      permissionRequired: false,
      sandboxRequirement: 'filesystem',
      executionFacts: fileExecutionFacts,
      ...(options.additionalPermissionPlanningContext ? {
        planAdditionalPermissions: ({ path }, context) => planFileToolAdditionalPermission({
          toolName: 'Grep', path: path ?? '.', cwd: context.cwd, mode: context.mode, args: context.args,
          context: options.additionalPermissionPlanningContext!,
        }),
      } : {}),
      impl: async ({ pattern, path, glob }, { cwd, abortSignal, permissionContext }) => {
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
          permissionContext,
        });
      },
    },
  ];
}

function buildExecutorBashTool(
  executor: WorkspaceBashExecutor,
  planningContext?: AdditionalPermissionPlanningContext,
): MakaTool {
  return {
    name: 'Bash',
    description: 'Run a shell command in the session cwd. Subject to permission policy.',
    parameters: z.object({
      command: z.string().describe('The shell command to execute'),
      timeout_ms: z.number().int().positive().max(600_000).optional(),
      sandbox_permissions: bashSandboxPermissionsSchema
        .describe('Optional one-call permission request. Prefer with_additional_permissions for minimal access; use require_escalated only when sandboxed execution cannot work. Approval is routed by the active permission mode.')
        .optional(),
    }),
    permissionRequired: true,
    sandboxRequirement: 'command',
    executionFacts: executor.facts,
    ...(planningContext ? {
      planAdditionalPermissions: (args, context) => planDeclaredBashAdditionalPermission({
        declaration: args.sandbox_permissions,
        cwd: context.cwd,
        mode: context.mode,
        command: args.command,
        context: planningContext,
      }),
      planSandboxEscalation: (args, context) => planDeclaredBashSandboxEscalation({
        declaration: args.sandbox_permissions,
        cwd: context.cwd,
        mode: context.mode,
        command: args.command,
        args: context.args,
        ...(context.recentSandboxDenial ? { recentSandboxDenial: true } : {}),
      }),
    } : {}),
    impl: async ({ command, timeout_ms }, { cwd, abortSignal, emitOutput, permissionContext }) => {
      const timeout = timeout_ms ?? 120_000;
      const result = await executor.exec({
        command,
        cwd,
        timeoutMs: timeout,
        ...(abortSignal ? { abortSignal } : {}),
        emitOutput,
        permissionContext,
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
  result: Pick<
    WorkspaceExecResult,
    'stdout' | 'stderr' | 'stdoutTruncated' | 'stderrTruncated' | 'sandboxType' | 'sandboxed'
  >,
  code: number,
): Error {
  const error = new Error(message);
  const sandboxDenied = isLikelySandboxDenial(result);
  Object.assign(error, {
    stdout: result.stdout,
    stderr: result.stderr,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
    code,
    ...(result.sandboxType ? { sandboxType: result.sandboxType } : {}),
    sandboxed: result.sandboxed === true,
    ...(sandboxDenied ? { reason: 'sandbox_denial', recoverable: true } : {}),
  });
  return error;
}

function isLikelySandboxDenial(
  result: Pick<WorkspaceExecResult, 'stdout' | 'stderr' | 'sandboxed'>,
): boolean {
  if (result.sandboxed !== true) return false;
  const output = `${result.stderr}\n${result.stdout}`;
  return /operation not permitted|sandbox-exec|sandbox(?:ed)?[^\n]*den(?:y|ied)/i.test(output);
}

function assertRelativeGlobPattern(pattern: string): void {
  if (isAbsolute(pattern) || pattern.split(/[\\/]+/).includes('..')) {
    throw new Error('Glob pattern must stay inside session cwd');
  }
}
