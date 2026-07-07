import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import {
  isTerminalShellRunStatus,
  type ShellRunRecord,
  type ShellRunStatus,
  type ShellRunStore,
} from '@maka/core';
import type { ToolResultContent } from '@maka/core/events';
import { redactSecrets } from '@maka/core/redaction';

import { BashTailBuffer } from './bash-tail-buffer.js';
import {
  BASH_MAX_LIVE_EMIT_CHARS,
  BASH_MAX_RETAINED_CHARS,
  LIVE_OUTPUT_SUPPRESSED_MARKER,
  SIGKILL_GRACE_MS,
  shellTailValueWithUnsafeDropMarker,
  terminateChildProcessTree,
} from './shell-exec.js';
import { truncateToolOutput } from './tool-output.js';

export const DEFAULT_BASH_YIELD_TIME_MS = 10_000;
export const DEFAULT_BASH_TIMEOUT_MS = 120_000;
export const MIN_BASH_YIELD_TIME_MS = 250;
export const MAX_BASH_YIELD_TIME_MS = 30_000;
export const MAX_SHELL_RUN_TIMEOUT_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_MAX_LIVE_SHELL_RUNS = 64;
export const DEFAULT_SHELL_RUN_FLUSH_INTERVAL_MS = 1_000;
export const DEFAULT_SHELL_RUN_FLUSH_BYTES = 64 * 1024;
export const SHELL_RUN_CONTEXT_SUMMARY_LIMIT = 8;
export const SHELL_RUN_RESOURCE_PREFIX = 'maka://runtime/background-tasks';

export interface ShellRunProcessManagerInput {
  store: ShellRunStore;
  newId: () => string;
  now: () => number;
  maxLiveShellRuns?: number;
  flushIntervalMs?: number;
  flushBytes?: number;
  maxRetainedChars?: number;
  maxLiveEmitChars?: number;
  killGraceMs?: number;
}

export interface ShellRunBashInput {
  sessionId: string;
  sourceRunId?: string;
  sourceTurnId: string;
  sourceToolCallId: string;
  cwd: string;
  command: string;
  yieldTimeMs?: number;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  emitOutput: (stream: 'stdout' | 'stderr', chunk: string) => void;
}

type TerminalToolResult = Extract<ToolResultContent, { kind: 'terminal' }>;
type ShellRunToolResult = Extract<ToolResultContent, { kind: 'shell_run' }>;
type ShellRunChildProcess = ChildProcessByStdio<null, Readable, Readable>;
type ShellRunResourceTarget = { shellRunId: string };

interface LiveShellRun {
  shellRunId: string;
  sessionId: string;
  child: ShellRunChildProcess;
  stdoutBuf: BashTailBuffer;
  stderrBuf: BashTailBuffer;
  stdoutChars: number;
  stderrChars: number;
  pendingFlushChars: number;
  flushTimer?: NodeJS.Timeout;
  flushChain: Promise<void>;
  created: Promise<ShellRunRecord>;
  finish: (record: ShellRunRecord) => void;
  fail: (error: unknown) => void;
  finished: Promise<ShellRunRecord>;
  timeoutMs?: number;
  timeoutTimer?: NodeJS.Timeout;
  killTimer?: NodeJS.Timeout;
  termination?: ShellRunTermination;
  settled: boolean;
  forwardLive: boolean;
  liveEmitted: Record<'stdout' | 'stderr', number>;
  liveSuppressed: Record<'stdout' | 'stderr', boolean>;
  emitOutput: (stream: 'stdout' | 'stderr', chunk: string) => void;
}

type ShellRunTermination =
  | { kind: 'timeout' }
  | { kind: 'cancel' }
  | { kind: 'shutdown' };

export class ShellRunProcessManager {
  private readonly live = new Map<string, LiveShellRun>();
  private readonly maxLiveShellRuns: number;
  private readonly flushIntervalMs: number;
  private readonly flushBytes: number;
  private readonly maxRetainedChars: number;
  private readonly maxLiveEmitChars: number;
  private readonly killGraceMs: number;

  constructor(private readonly input: ShellRunProcessManagerInput) {
    this.maxLiveShellRuns = input.maxLiveShellRuns ?? DEFAULT_MAX_LIVE_SHELL_RUNS;
    this.flushIntervalMs = input.flushIntervalMs ?? DEFAULT_SHELL_RUN_FLUSH_INTERVAL_MS;
    this.flushBytes = input.flushBytes ?? DEFAULT_SHELL_RUN_FLUSH_BYTES;
    this.maxRetainedChars = input.maxRetainedChars ?? BASH_MAX_RETAINED_CHARS;
    this.maxLiveEmitChars = input.maxLiveEmitChars ?? BASH_MAX_LIVE_EMIT_CHARS;
    this.killGraceMs = input.killGraceMs ?? SIGKILL_GRACE_MS;
  }

  async runBash(input: ShellRunBashInput): Promise<TerminalToolResult | ShellRunToolResult> {
    if (input.abortSignal?.aborted) {
      throw new Error('Command aborted before shell process started');
    }
    const yieldTimeMs = clampInt(
      input.yieldTimeMs ?? DEFAULT_BASH_YIELD_TIME_MS,
      MIN_BASH_YIELD_TIME_MS,
      MAX_BASH_YIELD_TIME_MS,
    );
    const timeoutMs = normalizeTimeoutMs(input.timeoutMs ?? DEFAULT_BASH_TIMEOUT_MS);
    const live = await this.start(input, timeoutMs);
    const initial = await Promise.race([
      live.finished.then(() => 'finished' as const),
      sleep(yieldTimeMs).then(() => 'yield' as const),
      waitForAbort(input.abortSignal).then(() => 'abort' as const),
    ]);
    if (initial === 'finished') {
      const finished = await live.finished;
      return this.markObservedAndReturnTerminal(finished);
    }
    if (initial === 'abort') {
      this.beginTermination(live, { kind: 'cancel' });
      const cancelled = await live.finished;
      return this.markObservedAndReturnTerminal(cancelled);
    }

    live.forwardLive = false;
    await this.flushLive(live);
    const record = await this.input.store.readShellRun(input.sessionId, live.shellRunId);
    return shellRunRefContent(record);
  }

  private async cancelShellRun(sessionId: string, shellRunId: string): Promise<ShellRunToolResult> {
    const record = await this.input.store.readShellRun(sessionId, shellRunId);
    if (record.status !== 'running') {
      return this.detail(sessionId, shellRunId, { markObserved: true, cancelled: false });
    }
    const live = this.live.get(shellRunId);
    if (!live || live.sessionId !== sessionId) {
      await this.markOrphaned(record, 'missing live shell process handle during cancel');
      return this.detail(sessionId, shellRunId, { markObserved: true, cancelled: false });
    }
    if (live.settled) {
      await live.finished;
      return this.detail(sessionId, shellRunId, { markObserved: true, cancelled: false });
    }
    this.beginTermination(live, { kind: 'cancel' });
    await live.finished;
    return this.detail(sessionId, shellRunId, { markObserved: true, cancelled: true });
  }

  async buildContextSummary(sessionId: string): Promise<string | undefined> {
    const records = await this.actionableRecords(sessionId);
    if (records.length === 0) return undefined;
    const visible = records.slice(0, SHELL_RUN_CONTEXT_SUMMARY_LIMIT);
    const lines = [
      'Background tasks for this session:',
      ...visible.map((record) => {
        const completed = record.completedAt !== undefined ? ` completedAt=${record.completedAt}` : '';
        return `- ref=${shellRunResourceRef(record.shellRunId)} status=${record.status} cwd=${record.cwd} updatedAt=${record.updatedAt}${completed} command=${JSON.stringify(record.command)}`;
      }),
    ];
    const overflow = records.length - visible.length;
    if (overflow > 0) lines.push(`- ${overflow} more background task(s) not shown in this turn tail.`);
    lines.push('Use Read on a ref to inspect stdout/stderr; this summary intentionally omits output.');
    return lines.join('\n');
  }

  async readResource(sessionId: string, ref: string): Promise<{ content: string }> {
    const target = parseShellRunResourceRef(ref);
    if (!target) throw new Error(`Unsupported runtime resource ref: ${ref}`);
    const content = await this.renderResourceDetail(sessionId, target.shellRunId);
    return { content };
  }

  async stopResource(sessionId: string, ref: string): Promise<ShellRunToolResult> {
    const target = parseShellRunResourceRef(ref);
    if (!target) throw new Error(`Unsupported runtime background task ref: ${ref}`);
    return this.cancelShellRun(sessionId, target.shellRunId);
  }

  async recoverOrphanedSession(sessionId: string): Promise<number> {
    const records = await this.input.store.listSessionShellRuns(sessionId);
    let recovered = 0;
    for (const record of records) {
      if (record.status !== 'running') continue;
      if (this.live.has(record.shellRunId)) continue;
      await this.markOrphaned(record, 'runtime restarted without a live shell process handle');
      recovered += 1;
    }
    return recovered;
  }

  async terminateSession(sessionId: string): Promise<void> {
    const targets = [...this.live.values()].filter((live) => live.sessionId === sessionId);
    await Promise.all(targets.map((live) => this.terminateLive(live, { kind: 'shutdown' })));
  }

  async terminateAll(): Promise<void> {
    await Promise.all([...this.live.values()].map((live) => this.terminateLive(live, { kind: 'shutdown' })));
  }

  liveCount(): number {
    return this.live.size;
  }

  private async start(input: ShellRunBashInput, timeoutMs: number | undefined): Promise<LiveShellRun> {
    if (this.live.size >= this.maxLiveShellRuns) {
      throw new Error(`Too many live background tasks (${this.maxLiveShellRuns}); read or stop an existing task first`);
    }

    const shellRunId = this.input.newId();
    const child = spawn(input.command, {
      cwd: input.cwd,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    let resolveCreated!: (record: ShellRunRecord) => void;
    let rejectCreated!: (error: unknown) => void;
    const created = new Promise<ShellRunRecord>((resolve, reject) => {
      resolveCreated = resolve;
      rejectCreated = reject;
    });
    let finish!: (record: ShellRunRecord) => void;
    let fail!: (error: unknown) => void;
    const finished = new Promise<ShellRunRecord>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
    const live: LiveShellRun = {
      shellRunId,
      sessionId: input.sessionId,
      child,
      stdoutBuf: new BashTailBuffer(this.maxRetainedChars),
      stderrBuf: new BashTailBuffer(this.maxRetainedChars),
      stdoutChars: 0,
      stderrChars: 0,
      pendingFlushChars: 0,
      flushChain: Promise.resolve(),
      created,
      finish,
      fail,
      finished,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      settled: false,
      forwardLive: true,
      liveEmitted: { stdout: 0, stderr: 0 },
      liveSuppressed: { stdout: false, stderr: false },
      emitOutput: input.emitOutput,
    };

    this.live.set(shellRunId, live);
    child.stdout.on('data', (chunk: string) => this.append(live, 'stdout', chunk));
    child.stderr.on('data', (chunk: string) => this.append(live, 'stderr', chunk));
    child.on('close', (code, signal) => void this.finalizeLive(live, code, signal));

    try {
      await waitForSpawn(child);
      const now = this.input.now();
      const record: ShellRunRecord = {
        shellRunId,
        sessionId: input.sessionId,
        ...(input.sourceRunId ? { sourceRunId: input.sourceRunId } : {}),
        sourceTurnId: input.sourceTurnId,
        sourceToolCallId: input.sourceToolCallId,
        cwd: input.cwd,
        command: redactSecrets(input.command),
        status: 'running',
        startedAt: now,
        updatedAt: now,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        stdoutTail: '',
        stderrTail: '',
        stdoutTruncated: false,
        stderrTruncated: false,
        ...(child.pid !== undefined ? { pid: child.pid } : {}),
      };
      const createdRecord = await this.input.store.createShellRun(record);
      resolveCreated(createdRecord);
      if (timeoutMs !== undefined && !live.settled) {
        live.timeoutTimer = setTimeout(() => this.beginTermination(live, { kind: 'timeout' }), timeoutMs);
      }
      return live;
    } catch (error) {
      rejectCreated(error);
      this.live.delete(shellRunId);
      this.beginTermination(live, { kind: 'shutdown' });
      throw error;
    }
  }

  private append(live: LiveShellRun, stream: 'stdout' | 'stderr', chunk: string): void {
    if (live.settled || chunk.length === 0) return;
    if (stream === 'stdout') {
      live.stdoutBuf.push(chunk);
      live.stdoutChars += chunk.length;
    } else {
      live.stderrBuf.push(chunk);
      live.stderrChars += chunk.length;
    }
    live.pendingFlushChars += chunk.length;
    this.emitLive(live, stream, chunk);
    this.scheduleFlush(live);
  }

  private emitLive(live: LiveShellRun, stream: 'stdout' | 'stderr', chunk: string): void {
    if (!live.forwardLive || live.liveSuppressed[stream]) return;
    if (live.liveEmitted[stream] + chunk.length <= this.maxLiveEmitChars) {
      live.emitOutput(stream, chunk);
      live.liveEmitted[stream] += chunk.length;
      return;
    }
    live.emitOutput(stream, LIVE_OUTPUT_SUPPRESSED_MARKER);
    live.liveSuppressed[stream] = true;
  }

  private scheduleFlush(live: LiveShellRun): void {
    if (live.pendingFlushChars >= this.flushBytes) {
      if (live.flushTimer) clearTimeout(live.flushTimer);
      live.flushTimer = undefined;
      void this.flushLive(live).catch(() => {});
      return;
    }
    if (live.flushTimer) return;
    live.flushTimer = setTimeout(() => {
      live.flushTimer = undefined;
      void this.flushLive(live).catch(() => {});
    }, this.flushIntervalMs);
  }

  private async flushLive(live: LiveShellRun): Promise<void> {
    if (live.flushTimer) {
      clearTimeout(live.flushTimer);
      live.flushTimer = undefined;
    }
    live.pendingFlushChars = 0;
    const patch = this.tailPatch(live);
    live.flushChain = live.flushChain.then(async () => {
      await live.created;
      await this.input.store.updateShellRun(live.sessionId, live.shellRunId, {
        ...patch,
        updatedAt: this.input.now(),
      });
    });
    await live.flushChain;
  }

  private async finalizeLive(
    live: LiveShellRun,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> {
    if (live.settled) return;
    live.settled = true;
    if (live.timeoutTimer) clearTimeout(live.timeoutTimer);
    if (live.killTimer) clearTimeout(live.killTimer);
    if (live.flushTimer) clearTimeout(live.flushTimer);

    try {
      await live.created;
      const now = this.input.now();
      const status = statusFromClose(code, signal, live.termination);
      const exitCode = exitCodeFromClose(code, signal, live.termination);
      const failureMessage = failureMessageFor(status, live.timeoutMs);
      live.flushChain = live.flushChain.then(async () => {
        const updated = await this.input.store.updateShellRun(live.sessionId, live.shellRunId, {
          ...this.tailPatch(live),
          status,
          exitCode,
          ...(failureMessage ? { failureMessage } : {}),
          updatedAt: now,
          completedAt: now,
        });
        live.finish(updated);
      });
      await live.flushChain;
    } catch (error) {
      live.fail(error);
    } finally {
      this.live.delete(live.shellRunId);
    }
  }

  private tailPatch(live: LiveShellRun): Pick<
    ShellRunRecord,
    'stdoutTail' | 'stderrTail' | 'stdoutTruncated' | 'stderrTruncated'
  > {
    const stdoutRawTail = shellTailValueWithUnsafeDropMarker(live.stdoutBuf);
    const stderrRawTail = shellTailValueWithUnsafeDropMarker(live.stderrBuf);
    return {
      stdoutTail: redactSecrets(stdoutRawTail),
      stderrTail: redactSecrets(stderrRawTail),
      stdoutTruncated: live.stdoutChars > stdoutRawTail.length || live.stdoutBuf.hasDroppedUnsafe(),
      stderrTruncated: live.stderrChars > stderrRawTail.length || live.stderrBuf.hasDroppedUnsafe(),
    };
  }

  private beginTermination(live: LiveShellRun, reason: ShellRunTermination): void {
    if (live.termination || live.settled) return;
    live.termination = reason;
    terminateChildProcessTree(live.child, 'SIGTERM');
    live.killTimer = setTimeout(() => terminateChildProcessTree(live.child, 'SIGKILL'), this.killGraceMs);
  }

  private async terminateLive(live: LiveShellRun, reason: ShellRunTermination): Promise<void> {
    this.beginTermination(live, reason);
    await live.finished.catch(() => undefined);
  }

  private async detail(
    sessionId: string,
    shellRunId: string,
    options: { markObserved: boolean; cancelled?: boolean },
  ): Promise<ShellRunToolResult> {
    const record = await this.input.store.readShellRun(sessionId, shellRunId);
    if (options.markObserved && isTerminalShellRunStatus(record.status)) {
      return shellRunContent(await this.markObserved(record), options.cancelled);
    }
    return shellRunContent(record, options.cancelled);
  }

  private async markObservedAndReturnTerminal(record: ShellRunRecord): Promise<TerminalToolResult> {
    return terminalContent(await this.markObserved(record));
  }

  private async markObserved(record: ShellRunRecord): Promise<ShellRunRecord> {
    if (!isTerminalShellRunStatus(record.status)) return record;
    const now = this.input.now();
    return this.input.store.updateShellRun(record.sessionId, record.shellRunId, {
      observedAt: now,
      updatedAt: now,
    });
  }

  private async markOrphaned(record: ShellRunRecord, reason: string): Promise<ShellRunRecord> {
    const now = this.input.now();
    return this.input.store.updateShellRun(record.sessionId, record.shellRunId, {
      status: 'orphaned',
      orphanedReason: reason,
      updatedAt: now,
      completedAt: now,
    });
  }

  private async actionableRecords(sessionId: string): Promise<ShellRunRecord[]> {
    const records = await this.input.store.listSessionShellRuns(sessionId);
    return records
      .filter((record) => record.status === 'running' || (record.observedAt === undefined && isTerminalShellRunStatus(record.status)))
      .sort(compareActionableShellRuns);
  }

  private async renderResourceDetail(sessionId: string, shellRunId: string): Promise<string> {
    let record = await this.input.store.readShellRun(sessionId, shellRunId);
    if (record.status === 'running') {
      const live = this.live.get(shellRunId);
      if (live && live.sessionId === sessionId) {
        if (live.settled) {
          record = await live.finished;
        } else {
          await this.flushLive(live);
          record = await this.input.store.readShellRun(sessionId, shellRunId);
        }
      } else {
        record = await this.markOrphaned(record, 'missing live shell process handle during resource read');
      }
    }
    if (isTerminalShellRunStatus(record.status)) {
      record = await this.markObserved(record);
    }
    return renderShellRunResource(record);
  }
}

function terminalContent(record: ShellRunRecord): TerminalToolResult {
  const stdout = truncateToolOutput(record.stdoutTail, { direction: 'tail' });
  const stderr = truncateToolOutput(record.stderrTail, { direction: 'tail' });
  if (record.exitCode === undefined) {
    throw new Error(`ShellRun ${record.shellRunId} cannot be returned as a terminal result without an exit code`);
  }
  const status = terminalResultStatus(record.status);
  return {
    kind: 'terminal',
    cwd: record.cwd,
    cmd: record.command,
    status,
    exitCode: record.exitCode,
    stdout: stdout.content,
    stderr: stderr.content,
    stdoutTruncated: record.stdoutTruncated || stdout.truncated,
    stderrTruncated: record.stderrTruncated || stderr.truncated,
  };
}

function terminalResultStatus(status: ShellRunStatus): TerminalToolResult['status'] {
  switch (status) {
    case 'completed':
    case 'failed':
    case 'timed_out':
    case 'cancelled':
      return status;
    case 'running':
    case 'orphaned':
      throw new Error(`ShellRun status ${status} cannot be returned as a terminal result`);
  }
}

function shellRunContent(record: ShellRunRecord, cancelled?: boolean): ShellRunToolResult {
  const stdout = truncateToolOutput(record.stdoutTail, { direction: 'tail' });
  const stderr = truncateToolOutput(record.stderrTail, { direction: 'tail' });
  return {
    kind: 'shell_run',
    ref: shellRunResourceRef(record.shellRunId),
    status: record.status,
    cwd: record.cwd,
    cmd: record.command,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    ...(record.completedAt !== undefined ? { completedAt: record.completedAt } : {}),
    ...(record.exitCode !== undefined ? { exitCode: record.exitCode } : {}),
    ...(record.failureMessage !== undefined ? { failureMessage: record.failureMessage } : {}),
    stdout: stdout.content,
    stderr: stderr.content,
    stdoutTruncated: record.stdoutTruncated || stdout.truncated,
    stderrTruncated: record.stderrTruncated || stderr.truncated,
    ...(record.timeoutMs !== undefined ? { timeoutMs: record.timeoutMs } : {}),
    ...(record.observedAt !== undefined ? { observedAt: record.observedAt } : {}),
    ...(record.orphanedReason !== undefined ? { orphanedReason: record.orphanedReason } : {}),
    ...(cancelled !== undefined ? { cancelled } : {}),
  };
}

function shellRunRefContent(record: ShellRunRecord): ShellRunToolResult {
  return {
    kind: 'shell_run',
    ref: shellRunResourceRef(record.shellRunId),
    status: record.status,
    cwd: record.cwd,
    cmd: record.command,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    ...(record.completedAt !== undefined ? { completedAt: record.completedAt } : {}),
    ...(record.timeoutMs !== undefined ? { timeoutMs: record.timeoutMs } : {}),
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

function compareActionableShellRuns(a: ShellRunRecord, b: ShellRunRecord): number {
  const rank = (record: ShellRunRecord) => record.status === 'running' ? 1 : 0;
  return rank(a) - rank(b) || b.updatedAt - a.updatedAt || b.startedAt - a.startedAt || a.shellRunId.localeCompare(b.shellRunId);
}

function statusFromClose(
  code: number | null,
  _signal: NodeJS.Signals | null,
  termination: ShellRunTermination | undefined,
): ShellRunStatus {
  if (termination?.kind === 'timeout') return 'timed_out';
  if (termination?.kind === 'cancel' || termination?.kind === 'shutdown') return 'cancelled';
  return code === 0 ? 'completed' : 'failed';
}

function exitCodeFromClose(
  code: number | null,
  signal: NodeJS.Signals | null,
  termination: ShellRunTermination | undefined,
): number {
  if (termination?.kind === 'timeout') return 124;
  if (termination?.kind === 'cancel' || termination?.kind === 'shutdown') return 130;
  return code ?? (signal ? 128 : 1);
}

function failureMessageFor(status: ShellRunStatus, timeoutMs: number | undefined): string | undefined {
  switch (status) {
    case 'timed_out':
      return `Command timed out after ${timeoutMs ?? 0}ms`;
    case 'cancelled':
      return 'Command cancelled';
    case 'failed':
      return 'Command failed';
    default:
      return undefined;
  }
}

function normalizeTimeoutMs(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  return clampInt(value, 1, MAX_SHELL_RUN_TIMEOUT_MS);
}

export function shellRunResourceRef(shellRunId: string): string {
  return `${SHELL_RUN_RESOURCE_PREFIX}/${encodeURIComponent(shellRunId)}`;
}

export function isShellRunResourceRef(ref: string): boolean {
  return parseShellRunResourceRef(ref) !== null;
}

function parseShellRunResourceRef(ref: string): ShellRunResourceTarget | null {
  let url: URL;
  try {
    url = new URL(ref);
  } catch {
    return null;
  }
  if (
    url.protocol !== 'maka:'
    || url.hostname !== 'runtime'
    || url.username
    || url.password
    || url.port
    || url.search
    || url.hash
  ) {
    return null;
  }
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length === 2 && parts[0] === 'background-tasks' && parts[1]) {
    try {
      return { shellRunId: decodeURIComponent(parts[1]) };
    } catch {
      return null;
    }
  }
  return null;
}

function renderShellRunResource(record: ShellRunRecord): string {
  const stdout = truncateToolOutput(record.stdoutTail, { direction: 'tail' });
  const stderr = truncateToolOutput(record.stderrTail, { direction: 'tail' });
  const lines = [
    'Background task',
    `ref: ${shellRunResourceRef(record.shellRunId)}`,
    `status: ${record.status}`,
    `cwd: ${record.cwd}`,
    `command: ${record.command}`,
    `startedAt: ${record.startedAt}`,
    `updatedAt: ${record.updatedAt}`,
    record.completedAt !== undefined ? `completedAt: ${record.completedAt}` : '',
    record.exitCode !== undefined ? `exitCode: ${record.exitCode}` : '',
    record.timeoutMs !== undefined ? `timeoutMs: ${record.timeoutMs}` : '',
    record.failureMessage ? `failureMessage: ${record.failureMessage}` : '',
    record.orphanedReason ? `orphanedReason: ${record.orphanedReason}` : '',
    '',
    `stdout${record.stdoutTruncated || stdout.truncated ? ' (truncated)' : ''}:`,
    stdout.content,
    '',
    `stderr${record.stderrTruncated || stderr.truncated ? ' (truncated)' : ''}:`,
    stderr.content,
  ];
  return lines.filter((line, index) => line.length > 0 || index > 0).join('\n');
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return new Promise(() => {});
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
}

function waitForSpawn(child: ShellRunChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSpawn = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      child.off('spawn', onSpawn);
      child.off('error', onError);
    };
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
}
