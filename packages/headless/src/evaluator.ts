import { type ChildProcess, spawn } from 'node:child_process';

/**
 * Kill the verification command and any children it spawned. The child is
 * a process-group leader (spawned detached), so a negative pid signals the
 * whole group. Windows has no process groups — fall back to the shell.
 */
function killTree(child: ChildProcess): void {
  try {
    if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

export interface EvaluationResult {
  /** Exit code 0 and not timed out. */
  passed: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Cap captured output so a runaway command can't exhaust memory. */
const MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Run a Task's verification command in the throwaway workspace AFTER the
 * agent has finished. The evaluator runs separately from the agent so a
 * config under test cannot tamper with its own grading.
 *
 * `shell: true` so ordinary commands ("npm test", "pytest -q") work; the
 * lab is a trusted batch context running known fixtures, distinct from
 * Maka's interactive permission model.
 */
export function runVerification(
  command: string,
  cwd: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  env?: Record<string, string>,
): Promise<EvaluationResult> {
  return new Promise((resolve) => {
    // detached: the shell becomes its own process-group leader so a
    // timeout can kill the WHOLE tree (backgrounded grandchildren
    // included), not just the shell.
    const child = spawn(command, {
      cwd,
      shell: true,
      detached: true,
      env: env ? { ...process.env, ...env } : undefined,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const cap = (buf: string, chunk: Buffer): string =>
      buf.length >= MAX_OUTPUT_BYTES
        ? buf
        : (buf + chunk.toString('utf8')).slice(0, MAX_OUTPUT_BYTES);

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = cap(stdout, chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = cap(stderr, chunk);
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        passed: false,
        exitCode: null,
        stdout,
        stderr: `${stderr}${String(err)}`,
        timedOut,
      });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ passed: code === 0 && !timedOut, exitCode: code, stdout, stderr, timedOut });
    });
  });
}
