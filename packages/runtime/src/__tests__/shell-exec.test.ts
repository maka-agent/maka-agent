import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runShellWithBoundedTail, killWindowsTree } from '../shell-exec.js';

const base = (over: Record<string, unknown> = {}) => ({ cwd: process.cwd(), timeoutMs: 30_000, ...over });
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('runShellWithBoundedTail', () => {
  test('returns full small output and exit 0 without throwing', async () => {
    const r = await runShellWithBoundedTail("printf 'hello\\nworld\\n'", base());
    assert.deepEqual(
      { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut, aborted: r.aborted },
      { exitCode: 0, stdout: 'hello\nworld\n', stderr: '', timedOut: false, aborted: false },
    );
  });

  test('keeps only the bounded, line-aligned TAIL of large output (never killed by size)', async () => {
    const r = await runShellWithBoundedTail(
      "printf 'HEADMARK\\n'; seq 1 50; printf 'TAILMARK\\n'",
      base({ maxRetainedChars: 12 }),
    );
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes('TAILMARK'), 'tail retained');
    assert.ok(!r.stdout.includes('HEADMARK'), 'head dropped — it is a tail');
    assert.ok(r.stdout.length <= 12, `tail bounded to cap, got ${r.stdout.length}`);
  });

  test('captures stderr and a non-zero exit code as data (does not reject)', async () => {
    const r = await runShellWithBoundedTail("printf 'oops\\n' >&2; exit 3", base());
    assert.equal(r.exitCode, 3);
    assert.equal(r.stderr, 'oops\n');
    assert.equal(r.stdout, '');
  });

  test('times out a slow command, kills it, and reports timedOut', async () => {
    const r = await runShellWithBoundedTail('sleep 5', base({ timeoutMs: 150 }));
    assert.equal(r.timedOut, true);
    assert.equal(r.exitCode, 124);
  });

  test('on timeout, escalates SIGTERM->SIGKILL and resolves only after the child is actually dead', async () => {
    // A child that traps/ignores SIGTERM would, under the old "kill then resolve
    // immediately" path, keep running (and emitting) after we told the caller
    // "timed out". Now we wait for the child to actually exit (SIGKILL after the
    // grace) before resolving — proven by the heartbeat file no longer growing.
    const dir = await fs.mkdtemp(join(tmpdir(), 'shell-exec-kill-'));
    const beat = join(dir, 'beat');
    const cmd = `trap '' TERM; while true; do echo STILL; echo x >> '${beat}'; sleep 0.02; done`;
    const emits: string[] = [];
    try {
      const r = await runShellWithBoundedTail(
        cmd,
        base({ timeoutMs: 100, killGraceMs: 150, emitOutput: (_s: string, c: string) => emits.push(c) }),
      );
      assert.equal(r.timedOut, true);
      assert.equal(r.exitCode, 124);
      const sizeAtResolve = (await fs.stat(beat)).size;
      const emitsAtResolve = emits.length;
      await delay(300); // a live child would append ~15 more lines in this window
      const sizeLater = (await fs.stat(beat)).size;
      assert.ok(
        sizeLater - sizeAtResolve <= 2, // tolerate at most one in-flight append
        `child kept writing after resolve (grew ${sizeLater - sizeAtResolve} bytes) — not actually killed`,
      );
      assert.equal(emits.length, emitsAtResolve, 'no emitOutput after resolve');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('on timeout, kills the whole process tree so a child holding the pipe cannot hang the runner', async () => {
    // The shell spawns a grandchild (node) that inherits stdout and never exits.
    // Killing only the shell PID would leave it holding the pipe, so 'close'
    // would never fire and this test would HANG. Killing the process group lets
    // 'close' fire and the grandchild is actually gone.
    const dir = await fs.mkdtemp(join(tmpdir(), 'shell-exec-tree-'));
    const pidFile = join(dir, 'child.pid');
    const cmd =
      `node -e 'require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)'`;
    try {
      const r = await runShellWithBoundedTail(cmd, base({ timeoutMs: 200, killGraceMs: 150 }));
      assert.equal(r.timedOut, true);
      assert.equal(r.exitCode, 124);
      await delay(150); // let the OS reap the killed tree
      const childPid = Number((await fs.readFile(pidFile, 'utf8')).trim());
      assert.ok(Number.isInteger(childPid) && childPid > 0, 'grandchild recorded its pid');
      assert.throws(() => process.kill(childPid, 0), /ESRCH/, 'grandchild was killed with the tree');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('surfaces a safety marker (not bare empty) when an oversized no-newline line is dropped', async () => {
    // One 500-char line with no newline, cap 50: BashTailBuffer drops it whole
    // (no safe truncation boundary), so without a marker the result would look
    // like the command produced nothing.
    const r = await runShellWithBoundedTail("head -c 500 /dev/zero | tr '\\0' x", base({ maxRetainedChars: 50 }));
    assert.equal(r.exitCode, 0);
    assert.ok(!r.stdout.includes('xxxx'), 'dropped content is not leaked');
    assert.ok(r.stdout.includes('omitted for safety'), 'a recoverable safety marker is present');
    // Shares the recovery hint with truncateToolOutput: re-run only when safe.
    assert.ok(r.stdout.includes('safe to re-run'), 'recovery guidance is conditioned on safety');
    assert.ok(r.stdout.includes('side effects'), 'warns about repeating side effects');
  });

  test('emits every chunk live via emitOutput', async () => {
    const seen: Array<[string, string]> = [];
    await runShellWithBoundedTail(
      "printf 'aaa'; printf 'bbb' >&2",
      base({ emitOutput: (s: 'stdout' | 'stderr', c: string) => seen.push([s, c]) }),
    );
    assert.ok(seen.some(([s, c]) => s === 'stdout' && c.includes('aaa')));
    assert.ok(seen.some(([s, c]) => s === 'stderr' && c.includes('bbb')));
  });

  test('caps live emitOutput per stream with a single suppressed marker (result keeps full tail)', async () => {
    const seen: Array<[string, string]> = [];
    const r = await runShellWithBoundedTail(
      "printf 'HEAD\\n'; seq 1 2000; printf 'TAIL\\n'",
      base({
        maxLiveEmitChars: 20, // tiny cap so the stream trips it almost immediately
        emitOutput: (s: 'stdout' | 'stderr', c: string) => seen.push([s, c]),
      }),
    );
    assert.equal(r.exitCode, 0);
    const stdoutEmits = seen.filter(([s]) => s === 'stdout');
    const markers = stdoutEmits.filter(([, c]) => c.includes('live output suppressed'));
    assert.equal(markers.length, 1, 'exactly one suppressed marker, not one per chunk');
    const liveChars = stdoutEmits
      .filter(([, c]) => !c.includes('live output suppressed'))
      .reduce((n, [, c]) => n + c.length, 0);
    assert.ok(liveChars <= 20, `live emit bounded to cap, got ${liveChars}`);
    // The suppressed LIVE feed does not lose the result: the retained tail still
    // carries the real output (the last bytes the command produced).
    assert.ok(r.stdout.includes('TAIL'), 'retained tail keeps the command output');
  });

  test('killWindowsTree swallows a taskkill spawn failure instead of crashing', async () => {
    // On non-Windows hosts `taskkill` is absent, so spawn emits an async 'error'
    // (ENOENT). Without the error listener that would be an unhandled 'error'
    // event and crash the process — so this exercises the exact safety path the
    // Windows branch relies on. Reaching the assertion means it was swallowed.
    killWindowsTree(999_999); // bogus pid; taskkill is missing here regardless
    await delay(150); // let the async spawn-failure 'error' fire
    assert.ok(true, 'no unhandled error propagated from the taskkill spawn failure');
  });

  test('Windows: timeout kills the process tree via taskkill', { skip: process.platform !== 'win32' }, async () => {
    // Windows analogue of the POSIX process-tree test above; runs only on a
    // Windows runner. A grandchild that holds stdout open would hang the runner
    // unless taskkill /T kills the whole tree.
    const dir = await fs.mkdtemp(join(tmpdir(), 'shell-exec-win-'));
    const pidFile = join(dir, 'child.pid');
    const cmd =
      'node -e "require(\'fs\').writeFileSync(process.env.MAKA_PIDOUT, String(process.pid)); setInterval(() => {}, 1000)"';
    try {
      const r = await runShellWithBoundedTail(
        cmd,
        base({ timeoutMs: 500, killGraceMs: 200, env: { ...process.env, MAKA_PIDOUT: pidFile } }),
      );
      assert.equal(r.timedOut, true);
      assert.equal(r.exitCode, 124);
      await delay(300);
      const childPid = Number((await fs.readFile(pidFile, 'utf8')).trim());
      assert.throws(() => process.kill(childPid, 0), /ESRCH/, 'grandchild was killed via taskkill /T');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
