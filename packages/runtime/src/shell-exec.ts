// packages/runtime/src/shell-exec.ts
//
// Single shared shell runner for BOTH Bash paths — the in-process builtin Bash
// tool (builtin-tools.ts) and the Harbor/local isolated executor
// (headless/harbor-cell.ts).
//
// WHY THIS EXISTS: the builtin streamed via spawn with a memory-bounded tail,
// but the Harbor executor used execAsync({ maxBuffer }). A command whose output
// passed maxBuffer was KILLED mid-run and only its first maxBuffer bytes (the
// HEAD) were returned — so the benchmark path never delivered the recoverable,
// bounded TAIL the builtin did, and reported a wrong (killed) exit code. This
// module is the one place a shell command runs: it streams stdout/stderr into a
// BashTailBuffer (keeping only the last `maxRetainedChars` per stream) and lets
// the command run to completion regardless of output size.
//
// It is the dumb core: it always RESOLVES with { exitCode, stdout, stderr,
// timedOut, aborted }, rejecting only when the process cannot be spawned at all.
// Each caller maps that to its own contract — the builtin throws on
// timeout/abort/non-zero; the Harbor executor returns the result verbatim.

import { spawn } from 'node:child_process';
import { BashTailBuffer } from './bash-tail-buffer.js';
import { OUTPUT_RECOVERY_HINT } from './tool-output.js';

// Per-stream cap on the output RETAINED for the result (~1MB). This only bounds
// what is kept to return. The tool layer (truncateToolOutput) trims this further
// to the model's budget. Shared so both Bash paths retain identically.
export const BASH_MAX_RETAINED_CHARS = 1024 * 1024;

// Per-stream cap on output forwarded LIVE via emitOutput (~1MB). The command is
// never killed for size and the full recoverable tail is still RETAINED (above),
// but a runaway command printing tens of MB must not flood the event stream /
// UI with per-chunk deltas (tool-output-delta has no aggregate cap). Once a
// stream passes this, we emit one suppressed marker and stop forwarding live;
// chunks keep flowing into the retained tail buffer.
export const BASH_MAX_LIVE_EMIT_CHARS = 1024 * 1024;

// Grace period after SIGTERM (on timeout/abort) before escalating to SIGKILL. A
// well-behaved child exits on SIGTERM and 'close' fires well within this window;
// a child that traps/ignores SIGTERM is force-killed so the promise still
// settles promptly (bounded by this) rather than hanging.
export const SIGKILL_GRACE_MS = 2000;

// Emitted once per stream when live forwarding is suppressed. The full output is
// not lost — it still feeds the retained tail and the returned result.
const LIVE_OUTPUT_SUPPRESSED_MARKER =
  '[live output suppressed: too much output to stream live; the command keeps ' +
  'running and its result still contains the most recent output]';

// Appended to a stream when BashTailBuffer dropped an oversized line that had no
// newline to truncate at (dropped whole for redaction safety). Without it, a
// command whose only output was one giant line would look like it produced
// nothing. Carries no dropped content — just a recoverable notice.
const UNSAFE_DROP_MARKER =
  '[a single line larger than the output limit was omitted for safety. '
  + OUTPUT_RECOVERY_HINT + ']';

function withUnsafeDropMarker(buf: BashTailBuffer): string {
  const text = buf.value(); // value() trims first, so the drop flag is current after it
  if (!buf.hasDroppedUnsafe()) return text;
  // Append (not prepend) so a later tail-keeping truncateToolOutput retains it.
  return text ? `${text}\n${UNSAFE_DROP_MARKER}` : UNSAFE_DROP_MARKER;
}

export interface BoundedShellOptions {
  cwd: string;
  /** Hard wall-clock cap; the child is SIGTERM'd and `timedOut` is set. */
  timeoutMs: number;
  /** Per-stream retained-tail cap in characters. Defaults to BASH_MAX_RETAINED_CHARS. */
  maxRetainedChars?: number;
  /** Per-stream cap on LIVE emitOutput forwarding. Defaults to BASH_MAX_LIVE_EMIT_CHARS. */
  maxLiveEmitChars?: number;
  /** Child environment. Defaults to the parent process env (spawn's default). */
  env?: NodeJS.ProcessEnv;
  /** Aborts the child (sets `aborted`). */
  abortSignal?: AbortSignal;
  /** Grace after SIGTERM before SIGKILL on timeout/abort. Defaults to SIGKILL_GRACE_MS. */
  killGraceMs?: number;
  /** Receives every raw chunk live, before tail-bounding. */
  emitOutput?: (stream: 'stdout' | 'stderr', chunk: string) => void;
}

export interface BoundedShellResult {
  exitCode: number;
  /** Last `maxRetainedChars` of stdout (line-aligned; see BashTailBuffer). */
  stdout: string;
  /** Last `maxRetainedChars` of stderr. */
  stderr: string;
  /** The command exceeded timeoutMs and was killed. */
  timedOut: boolean;
  /** The abortSignal fired and the command was killed. */
  aborted: boolean;
}

/**
 * Run `command` in a shell, streaming output into a memory-bounded tail. Never
 * kills the command for producing too much output — it keeps only the last
 * `maxRetainedChars` per stream. On timeout/abort it SIGTERMs (then SIGKILLs
 * after a grace period) and resolves only once the child has actually exited, so
 * it never reports "timed out" while the process keeps running in the
 * background. Resolves with the result (including timeout / abort flags); rejects
 * only when the process cannot be spawned.
 */
export function runShellWithBoundedTail(
  command: string,
  options: BoundedShellOptions,
): Promise<BoundedShellResult> {
  const cap = options.maxRetainedChars ?? BASH_MAX_RETAINED_CHARS;
  const liveCap = options.maxLiveEmitChars ?? BASH_MAX_LIVE_EMIT_CHARS;
  const graceMs = options.killGraceMs ?? SIGKILL_GRACE_MS;
  return new Promise<BoundedShellResult>((resolvePromise, reject) => {
    const child = spawn(command, {
      cwd: options.cwd,
      env: options.env,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      // POSIX: make the shell its own process-group leader (setsid) so we can
      // signal the WHOLE tree on timeout/abort. Killing only the shell PID would
      // leave its children running — and if one keeps the stdout/stderr pipe
      // open, 'close' never fires and the runner hangs. Not unref'd: we keep
      // tracking it until it exits. Windows has no process groups; we use
      // taskkill /T instead (see terminateTree).
      detached: process.platform !== 'win32',
    });
    const stdoutBuf = new BashTailBuffer(cap);
    const stderrBuf = new BashTailBuffer(cap);
    let settled = false;
    // Per-stream live-forwarding budget (see BASH_MAX_LIVE_EMIT_CHARS). Once a
    // stream passes liveCap we emit one marker and stop forwarding it live.
    let liveEmitted = { stdout: 0, stderr: 0 };
    let liveSuppressed = { stdout: false, stderr: false };
    // Set when timeout/abort begins terminating the child. 'close' is the single
    // resolve point, so this remembers WHY we resolve once the child is gone.
    let termination: { timedOut?: boolean; aborted?: boolean } | null = null;
    let killTimer: NodeJS.Timeout | undefined;

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => append('stdout', chunk));
    child.stderr?.on('data', (chunk: string) => append('stderr', chunk));
    child.on('error', (error: Error) => {
      // The process could not be spawned at all (e.g. the shell binary is
      // missing). This is exceptional — reject so callers surface it.
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    // 'close' fires only after the process has exited AND its stdio has closed,
    // so resolving here guarantees the child is gone and no further output can
    // arrive — even when we triggered the kill ourselves.
    child.on('close', (code, signal) => resolveOnce(code, signal));

    const timer = setTimeout(() => beginTermination({ timedOut: true }), options.timeoutMs);
    const abort = () => beginTermination({ aborted: true });
    if (options.abortSignal) {
      if (options.abortSignal.aborted) abort();
      else options.abortSignal.addEventListener('abort', abort, { once: true });
    }

    function append(stream: 'stdout' | 'stderr', chunk: string): void {
      if (settled) return; // never capture or emit after we have resolved
      // Always retain (the result keeps the bounded tail regardless of live cap).
      if (stream === 'stdout') stdoutBuf.push(chunk);
      else stderrBuf.push(chunk);
      emitLive(stream, chunk);
    }

    // Forward a chunk to the live emitOutput feed, bounded per stream so a
    // runaway command cannot flood the event queue. The retained tail above is
    // untouched by this cap.
    function emitLive(stream: 'stdout' | 'stderr', chunk: string): void {
      const emit = options.emitOutput;
      if (!emit || liveSuppressed[stream]) return;
      if (liveEmitted[stream] + chunk.length <= liveCap) {
        emit(stream, chunk);
        liveEmitted[stream] += chunk.length;
        return;
      }
      // First chunk to cross the cap: emit one marker, then go silent for this
      // stream.
      emit(stream, LIVE_OUTPUT_SUPPRESSED_MARKER);
      liveSuppressed[stream] = true;
    }

    // Begin terminating a still-running child (timeout or abort). SIGTERM first
    // so a well-behaved child can flush and exit; if it ignores SIGTERM, SIGKILL
    // after a grace period guarantees it dies. We do NOT resolve here — 'close'
    // is the single resolve point, so the promise settles only once the child is
    // actually gone (no zombie left running, no output after resolve).
    function beginTermination(reason: { timedOut?: boolean; aborted?: boolean }): void {
      if (termination || settled) return;
      termination = reason;
      terminateTree('SIGTERM');
      killTimer = setTimeout(() => terminateTree('SIGKILL'), graceMs);
    }

    // Signal the shell AND every process it launched. POSIX: the shell is a
    // process-group leader (detached above), so a negative PID targets the whole
    // group. Windows: no groups/SIGTERM — taskkill /T /F force-kills the tree in
    // one shot (the later SIGKILL call is then a harmless no-op on a dead PID).
    function terminateTree(signal: 'SIGTERM' | 'SIGKILL'): void {
      const pid = child.pid;
      if (!pid) return;
      if (process.platform === 'win32') {
        killWindowsTree(pid);
        return;
      }
      try {
        process.kill(-pid, signal); // negative PID → the child's process group
      } catch {
        // Group already gone, or it never became a group leader — fall back to
        // the single PID so we at least signal the shell itself.
        try { child.kill(signal); } catch { /* already exited */ }
      }
    }

    // Settle once, on 'close'. exitCode reflects how we terminated: 124 timeout,
    // 130 abort, else the child's own code (or 128+signal when signal-killed).
    function resolveOnce(code: number | null, signal: NodeJS.Signals | null): void {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise({
        exitCode: termination ? (termination.timedOut ? 124 : 130) : (code ?? (signal ? 128 : 1)),
        stdout: withUnsafeDropMarker(stdoutBuf),
        stderr: withUnsafeDropMarker(stderrBuf),
        timedOut: !!termination?.timedOut,
        aborted: !!termination?.aborted,
      });
    }

    function cleanup(): void {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (options.abortSignal) options.abortSignal.removeEventListener('abort', abort);
    }
  });
}

/**
 * Force-kill a process tree on Windows, which has no process groups or SIGTERM
 * semantics (POSIX uses `process.kill(-pid)` on the detached group instead).
 * `taskkill /T` walks the tree by PID, `/F` forces it. Best-effort and untested
 * on non-Windows CI — exported so the error-handling path can be exercised on
 * any platform.
 *
 * The spawned taskkill MUST have an 'error' listener: a child process with no
 * 'error' handler turns an async spawn failure (e.g. taskkill not on PATH) into
 * an unhandled 'error' event that can crash the host process.
 */
export function killWindowsTree(pid: number): void {
  try {
    const killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore' });
    killer.on('error', () => { /* taskkill unavailable / failed — nothing more we can do */ });
  } catch {
    /* synchronous spawn failure — nothing more we can do */
  }
}
