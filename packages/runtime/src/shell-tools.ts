import { z } from 'zod';
import { redactSecrets } from '@maka/core/redaction';
import type { ToolResultContent } from '@maka/core/events';
import type { ToolExecutionFacts } from '@maka/core/permission';
import type { MakaTool, MakaToolContext } from './tool-runtime.js';
import { runShellWithBoundedTail, type BoundedShellResult } from './shell-exec.js';
import { bashToolShellGuidance, defaultShellPlan, type ShellPlan } from './shell-detect.js';
import { truncateToolOutput } from './tool-output.js';
import {
  DEFAULT_BASH_TIMEOUT_MS,
  MAX_PTY_COLS,
  MAX_PTY_ROWS,
  MAX_FOREGROUND_BASH_TIMEOUT_MS,
  MAX_SHELL_RUN_TIMEOUT_MS,
  MAX_WRITE_STDIN_INPUT_BYTES,
  MIN_PTY_COLS,
  MIN_PTY_ROWS,
  type BackgroundTaskStopper,
  type PtyControlWriter,
  type ShellRunBashInput,
  isWellFormedTerminalInput,
} from './shell-run-contract.js';

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

export interface ShellRunLauncher {
  runForegroundBash(input: ShellRunBashInput): Promise<TerminalToolResult>;
  runBackgroundBash(input: ShellRunBashInput): Promise<ShellRunToolResult>;
}

export function buildForegroundBashTool(options: BuildForegroundBashToolOptions): MakaTool {
  const maxTimeoutMs = options.maxTimeoutMs ?? 600_000;
  return {
    name: 'Bash',
    activityKind: 'command',
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

export function buildLocalForegroundBashTool(
  options: { executionFacts?: ToolExecutionFacts; shell?: ShellPlan } = {},
): MakaTool {
  const shell = options.shell ?? defaultShellPlan();
  return buildForegroundBashTool({
    description: withShellGuidance('Run a shell command in the session cwd.', shell)
      + ' Subject to permission policy.',
    ...(options.executionFacts ? { executionFacts: options.executionFacts } : {}),
    defaultTimeoutMs: () => 120_000,
    execute: async ({ command, cwd, timeoutMs, ctx }) => runShellWithBoundedTail(command, {
      cwd,
      timeoutMs: timeoutMs ?? 120_000,
      abortSignal: ctx.abortSignal,
      emitOutput: ctx.emitOutput,
      shell,
    }),
  });
}

export function buildManagedBashTool(
  shellRuns: ShellRunLauncher,
  options: { executionFacts?: ToolExecutionFacts; shell?: ShellPlan } = {},
): MakaTool {
  const shell = options.shell ?? defaultShellPlan();
  return {
    name: 'Bash',
    activityKind: 'command',
    description:
      withShellGuidance('Run a shell command in the session cwd.', shell)
      + ` Foreground is the default (timeout ${DEFAULT_BASH_TIMEOUT_MS}ms, maximum ${MAX_FOREGROUND_BASH_TIMEOUT_MS}ms).`
      + ` Set run_in_background=true only when the command should continue as a tracked runtime background task; background commands have no default timeout (maximum explicit timeout ${MAX_SHELL_RUN_TIMEOUT_MS}ms).`
      + ' Set pty=true together with run_in_background=true only for terminal semantics or later input; use the returned ref with Read or WriteStdin. Subject to permission policy.',
    parameters: z.object({
      command: z.string().describe('The shell command to execute'),
      timeout_ms: z.number().int().positive().max(MAX_SHELL_RUN_TIMEOUT_MS).optional(),
      run_in_background: z.boolean().optional(),
      pty: z.boolean().optional(),
    }).strict().superRefine(({ timeout_ms, run_in_background, pty }, ctx) => {
      if (!run_in_background && timeout_ms !== undefined && timeout_ms > MAX_FOREGROUND_BASH_TIMEOUT_MS) {
        ctx.addIssue({
          code: 'too_big',
          maximum: MAX_FOREGROUND_BASH_TIMEOUT_MS,
          origin: 'number',
          inclusive: true,
          path: ['timeout_ms'],
          message: `Foreground Bash timeout may not exceed ${MAX_FOREGROUND_BASH_TIMEOUT_MS}ms`,
        });
      }
      if (pty && !run_in_background) {
        ctx.addIssue({
          code: 'custom',
          path: ['pty'],
          message: 'PTY Bash requires run_in_background=true',
        });
      }
    }),
    permissionRequired: true,
    ...(options.executionFacts ? { executionFacts: options.executionFacts } : {}),
    impl: async ({ command, timeout_ms, run_in_background, pty }, ctx) => shellRuns[
      run_in_background ? 'runBackgroundBash' : 'runForegroundBash'
    ]({
      sessionId: ctx.sessionId,
      ...(ctx.runId ? { sourceRunId: ctx.runId } : {}),
      sourceTurnId: ctx.turnId,
      sourceToolCallId: ctx.toolCallId,
      cwd: ctx.cwd,
      command,
      ...(pty !== undefined ? { pty } : {}),
      shell,
      ...(timeout_ms !== undefined ? { timeoutMs: timeout_ms } : {}),
      abortSignal: ctx.abortSignal,
      emitOutput: ctx.emitOutput,
    }),
  };
}

export function withShellGuidance(lead: string, shell: ShellPlan): string {
  const guidance = bashToolShellGuidance(shell);
  return guidance ? `${lead} ${guidance}` : lead;
}

export function buildStopBackgroundTaskTool(backgroundTasks: BackgroundTaskStopper): MakaTool {
  return {
    name: 'StopBackgroundTask',
    activityKind: 'command',
    description:
      'Stop a background task by runtime ref. Currently supports background shell run refs returned by Bash and shown in the turn tail.',
    parameters: z.object({
      ref: z.string().describe('The runtime background task ref, for example maka://runtime/background-tasks/<id>'),
    }),
    permissionRequired: false,
    impl: ({ ref }, ctx) => backgroundTasks.stopBackgroundTask(ctx.sessionId, ref, ctx.abortSignal),
  };
}

export function buildWriteStdinTool(ptyControls: PtyControlWriter): MakaTool {
  const parameters = z.object({
    ref: z.string().describe('The runtime ref returned by a PTY Bash task'),
    input: z.string()
      .refine((value) => value.length > 0, 'input must not be empty; omit it for a resize-only call')
      .refine(isWellFormedTerminalInput, 'input must be well-formed Unicode')
      .refine(
        (value) => Buffer.byteLength(value, 'utf8') <= MAX_WRITE_STDIN_INPUT_BYTES,
        `input must not exceed ${MAX_WRITE_STDIN_INPUT_BYTES} UTF-8 bytes`,
      )
      .optional(),
    size: z.object({
      cols: z.number().int().min(MIN_PTY_COLS).max(MAX_PTY_COLS),
      rows: z.number().int().min(MIN_PTY_ROWS).max(MAX_PTY_ROWS),
    }).strict().optional(),
  }).strict().refine((value) => value.input !== undefined || value.size !== undefined, {
    message: 'input and/or size is required',
  });
  return {
    name: 'WriteStdin',
    activityKind: 'command',
    description:
      'Send exact characters to a background PTY and/or resize it, then return the terminal state at the next parser cut. '
      + 'No newline is added: use \\r for Enter and \\u0003 for Ctrl-C. Input is ordinary audited tool-call data, not a secure secret channel. '
      + 'The returned output is the terminal state at that cut, not output attributed to this input; use Read on the ref to observe later output.',
    parameters,
    permissionRequired: true,
    impl: ({ ref, input, size }, ctx) => ptyControls.writeStdin({
      sessionId: ctx.sessionId,
      ref,
      ...(input !== undefined ? { input } : {}),
      ...(size !== undefined ? { size } : {}),
      abortSignal: ctx.abortSignal,
    }),
  };
}

export function shapeTerminalResult(input: {
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
    cwd: input.cwd,
    cmd: redactSecrets(input.command),
    status: terminalStatus(input.result),
    exitCode: input.result.exitCode,
    output: {
      mode: 'pipes',
      stdout: stdoutView.content,
      stderr: stderrView.content,
      stdoutTruncated: Boolean(input.result.stdoutTruncated) || stdoutView.truncated,
      stderrTruncated: Boolean(input.result.stderrTruncated) || stderrView.truncated,
      redacted: stdout !== input.result.stdout || stderr !== input.result.stderr,
    },
  };
}

function terminalStatus(result: ForegroundBashResult | BoundedShellResult): TerminalToolResult['status'] {
  if (result.timedOut) return 'timed_out';
  if (result.aborted) return 'cancelled';
  return result.exitCode === 0 ? 'completed' : 'failed';
}
