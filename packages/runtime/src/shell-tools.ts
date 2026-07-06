import { z } from 'zod';
import { redactSecrets } from '@maka/core/redaction';
import type { ToolResultContent } from '@maka/core/events';
import type { ToolExecutionFacts } from '@maka/core/permission';
import type { MakaTool, MakaToolContext } from './tool-runtime.js';
import { runShellWithBoundedTail, type BoundedShellResult } from './shell-exec.js';
import { truncateToolOutput } from './tool-output.js';
import {
  DEFAULT_SHELL_WAIT_YIELD_TIME_MS,
  MAX_SHELL_RUN_TIMEOUT_MS,
  type ShellRunBashInput,
} from './shell-run-manager.js';

export interface ForegroundBashExecuteInput {
  command: string;
  cwd: string;
  timeoutMs?: number;
  ctx: MakaToolContext;
}

export interface ForegroundBashResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  timedOut?: boolean;
  aborted?: boolean;
}

export interface BuildForegroundBashToolOptions {
  description: string;
  executionFacts?: ToolExecutionFacts;
  defaultTimeoutMs?: (command: string) => number | undefined;
  maxTimeoutMs?: number;
  emitReturnedOutput?: boolean;
  execute: (input: ForegroundBashExecuteInput) => Promise<ForegroundBashResult>;
  afterResult?: (
    input: { command: string; cwd: string; timeoutMs?: number },
    result: ForegroundBashResult,
    ctx: MakaToolContext,
  ) => Promise<void> | void;
}

type TerminalToolResult = Extract<ToolResultContent, { kind: 'terminal' }>;
type ShellRunToolResult = Extract<ToolResultContent, { kind: 'shell_run' }>;
type ShellRunListToolResult = Extract<ToolResultContent, { kind: 'shell_run_list' }>;

export interface ShellRunToolController {
  runBash(input: ShellRunBashInput): Promise<TerminalToolResult | ShellRunToolResult>;
  status(sessionId: string, shellRunId?: string): Promise<ShellRunToolResult | ShellRunListToolResult>;
  wait(sessionId: string, shellRunId: string, yieldTimeMs?: number): Promise<ShellRunToolResult>;
  cancel(sessionId: string, shellRunId: string): Promise<ShellRunToolResult>;
}

export function buildForegroundBashTool(options: BuildForegroundBashToolOptions): MakaTool {
  const maxTimeoutMs = options.maxTimeoutMs ?? 600_000;
  return {
    name: 'Bash',
    description: options.description,
    parameters: z.object({
      command: z.string().describe('The shell command to execute'),
      timeout_ms: z.number().int().positive().max(maxTimeoutMs).optional(),
    }),
    permissionRequired: true,
    ...(options.executionFacts ? { executionFacts: options.executionFacts } : {}),
    impl: async ({ command, timeout_ms }, ctx) => {
      const timeoutMs = timeout_ms ?? options.defaultTimeoutMs?.(command);
      const result = await options.execute({ command, cwd: ctx.cwd, timeoutMs, ctx });
      if (options.emitReturnedOutput) {
        if (result.stdout) ctx.emitOutput('stdout', result.stdout);
        if (result.stderr) ctx.emitOutput('stderr', result.stderr);
      }
      await options.afterResult?.({ command, cwd: ctx.cwd, ...(timeoutMs !== undefined ? { timeoutMs } : {}) }, result, ctx);
      return shapeTerminalResult({
        cwd: ctx.cwd,
        command,
        result,
      });
    },
  };
}

export function buildLocalForegroundBashTool(options: { executionFacts?: ToolExecutionFacts } = {}): MakaTool {
  return buildForegroundBashTool({
    description: 'Run a shell command in the session cwd. Subject to permission policy.',
    ...(options.executionFacts ? { executionFacts: options.executionFacts } : {}),
    defaultTimeoutMs: () => 120_000,
    execute: async ({ command, cwd, timeoutMs, ctx }) => runShellWithBoundedTail(command, {
      cwd,
      timeoutMs: timeoutMs ?? 120_000,
      abortSignal: ctx.abortSignal,
      emitOutput: ctx.emitOutput,
    }),
  });
}

export function buildBackgroundBashTool(
  shellRuns: ShellRunToolController,
  options: { executionFacts?: ToolExecutionFacts } = {},
): MakaTool {
  return {
    name: 'Bash',
    description:
      'Run a shell command in the session cwd. Commands that outlive yield_time_ms continue as observable ShellRuns. Subject to permission policy.',
    parameters: z.object({
      command: z.string().describe('The shell command to execute'),
      timeout_ms: z.number().int().positive().max(MAX_SHELL_RUN_TIMEOUT_MS).optional(),
      yield_time_ms: z.number().int().positive().optional(),
    }),
    permissionRequired: true,
    ...(options.executionFacts ? { executionFacts: options.executionFacts } : {}),
    impl: async ({ command, timeout_ms, yield_time_ms }, ctx) => shellRuns.runBash({
      sessionId: ctx.sessionId,
      ...(ctx.runId ? { sourceRunId: ctx.runId } : {}),
      sourceTurnId: ctx.turnId,
      sourceToolCallId: ctx.toolCallId,
      cwd: ctx.cwd,
      command,
      ...(yield_time_ms !== undefined ? { yieldTimeMs: yield_time_ms } : {}),
      ...(timeout_ms !== undefined ? { timeoutMs: timeout_ms } : {}),
      abortSignal: ctx.abortSignal,
      emitOutput: ctx.emitOutput,
    }),
  };
}

export function buildShellRunControlTools(shellRuns: ShellRunToolController): MakaTool[] {
  return [
    {
      name: 'ShellStatus',
      description:
        'List actionable background shell runs for this session, or read one ShellRun detail by shell_run_id.',
      parameters: z.object({
        shell_run_id: z.string().optional(),
      }),
      permissionRequired: false,
      impl: ({ shell_run_id }, ctx) => shellRuns.status(ctx.sessionId, shell_run_id),
    },
    {
      name: 'ShellWait',
      description: 'Wait for an existing ShellRun to finish, or return its current running snapshot after yield_time_ms.',
      parameters: z.object({
        shell_run_id: z.string(),
        yield_time_ms: z.number().int().positive().optional(),
      }),
      permissionRequired: false,
      impl: ({ shell_run_id, yield_time_ms }, ctx) =>
        shellRuns.wait(ctx.sessionId, shell_run_id, yield_time_ms ?? DEFAULT_SHELL_WAIT_YIELD_TIME_MS),
    },
    {
      name: 'ShellCancel',
      description: 'Cancel a running ShellRun owned by this session. Known terminal ShellRuns are returned idempotently.',
      parameters: z.object({
        shell_run_id: z.string(),
      }),
      permissionRequired: false,
      impl: ({ shell_run_id }, ctx) => shellRuns.cancel(ctx.sessionId, shell_run_id),
    },
  ];
}

export function shapeTerminalResult(input: {
  shellRunId?: string;
  cwd: string;
  command: string;
  result: ForegroundBashResult | BoundedShellResult;
}): TerminalToolResult {
  const stdout = redactSecrets(input.result.stdout);
  const stderr = redactSecrets(input.result.stderr);
  const stdoutView = truncateToolOutput(stdout, { direction: 'tail' });
  const stderrView = truncateToolOutput(stderr, { direction: 'tail' });
  return {
    kind: 'terminal',
    ...(input.shellRunId ? { shellRunId: input.shellRunId } : {}),
    cwd: input.cwd,
    cmd: redactSecrets(input.command),
    status: terminalStatus(input.result),
    exitCode: input.result.exitCode,
    stdout: stdoutView.content,
    stderr: stderrView.content,
    stdoutTruncated: Boolean(input.result.stdoutTruncated) || stdoutView.truncated,
    stderrTruncated: Boolean(input.result.stderrTruncated) || stderrView.truncated,
  };
}

function terminalStatus(result: ForegroundBashResult | BoundedShellResult): TerminalToolResult['status'] {
  if (result.timedOut) return 'timed_out';
  if (result.aborted) return 'cancelled';
  return result.exitCode === 0 ? 'completed' : 'failed';
}
