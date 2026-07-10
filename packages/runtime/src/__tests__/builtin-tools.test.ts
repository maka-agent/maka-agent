import { describe, test } from 'node:test';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from '../test-helpers.js';
import { buildBuiltinTools } from '../builtin-tools.js';
import type { ShellRunToolController } from '../shell-tools.js';
import {
  LOCAL_WORKSPACE_EXECUTOR_FACTS,
  type WorkspaceExecInput,
  type WorkspaceExecutor,
  type WorkspaceExecutorFacts,
} from '../workspace-executor.js';

describe('builtin tool activity kinds', () => {
  test('declares stable semantic categories independently of tool names', () => {
    const kinds = Object.fromEntries(buildBuiltinTools().map((tool) => [tool.name, tool.activityKind]));

    expect(kinds).toEqual({
      Bash: 'command',
      Read: 'read',
      Write: 'edit',
      Edit: 'edit',
      Glob: 'search',
      Grep: 'search',
    });
  });

  test('categorizes background task controls as command activity', () => {
    const shellRuns = {
      runBash: () => Promise.reject(new Error('not used')),
      readResource: () => Promise.reject(new Error('not used')),
      stopResource: () => Promise.reject(new Error('not used')),
    } satisfies ShellRunToolController;
    const kinds = Object.fromEntries(buildBuiltinTools({ shellRuns }).map((tool) => [tool.name, tool.activityKind]));

    expect(kinds.Bash).toBe('command');
    expect(kinds.StopBackgroundTask).toBe('command');
  });
});

describe('builtin tool executor facts', () => {
  test('attaches executor facts to every built-in tool', () => {
    const facts: WorkspaceExecutorFacts = {
      isolation: 'worktree',
      writesAffectHost: false,
      writeBack: 'diff_review',
      network: 'sandbox',
      secrets: 'none',
    };

    const tools = buildBuiltinTools({ executor: fakeExecutor({ facts }) });

    expect(tools.length > 0).toBe(true);
    expect(tools.every((tool) => tool.executionFacts === facts)).toBe(true);
  });
});

describe('builtin Bash description declares the executing shell', () => {
  test('executor Bash executes with the same shell it declares', async () => {
    // /bin/echo stands in for pwsh.exe: if the shell reaches the local
    // executor's spawn, stdout echoes the PowerShell flags back instead of a
    // bare 'wired-marker' from the default POSIX shell.
    const tools = buildBuiltinTools({
      shell: { kind: 'pwsh', displayName: 'PowerShell 7 (pwsh)', exe: '/bin/echo' },
    });
    const bash = tools.find((tool) => tool.name === 'Bash')!;
    const result = await bash.impl({ command: 'echo wired-marker' }, {
      sessionId: 'session-1',
      turnId: 'turn-1',
      toolCallId: 'tool-1',
      cwd: process.cwd(),
      abortSignal: new AbortController().signal,
      emitOutput: () => {},
    }) as { stdout: string };
    expect(result.stdout.startsWith('-NoLogo -NoProfile -NonInteractive -Command echo wired-marker\n')).toBe(true);
  });

  test('executor Bash tells the model commands run under PowerShell 7', () => {
    const tools = buildBuiltinTools({
      executor: fakeExecutor({ facts: LOCAL_WORKSPACE_EXECUTOR_FACTS }),
      shell: { kind: 'pwsh', displayName: 'PowerShell 7 (pwsh)', exe: 'C:\\pf\\pwsh.exe' },
    });
    const bash = tools.find((tool) => tool.name === 'Bash');
    expect(bash !== undefined).toBe(true);
    expect(/PowerShell 7 \(pwsh\)/.test(bash!.description)).toBe(true);
    expect(/git ls-files/.test(bash!.description)).toBe(true);
  });
});

describe('builtin Bash streaming output', () => {
  test('background-capable Bash returns runtime refs and forwards yield_time_ms', async () => {
    const calls: unknown[] = [];
    const shellRuns = {
      async runBash(input: unknown) {
        calls.push(input);
        return {
          kind: 'shell_run',
          ref: 'maka://runtime/background-tasks/shell-run-1',
          status: 'running',
          cwd: '/workspace',
          cmd: 'sleep 60',
          startedAt: 1,
          updatedAt: 1,
          stdout: '',
          stderr: '',
          stdoutTruncated: false,
          stderrTruncated: false,
        };
      },
      async readResource(sessionId: string, ref: string) {
        return { content: `session=${sessionId} ref=${ref}` };
      },
      async stopResource() {
        throw new Error('not used');
      },
    } satisfies ShellRunToolController;
    const tools = buildBuiltinTools({ shellRuns });
    const names = tools.map((tool) => tool.name);

    expect(names.filter((name) => name === 'Bash')).toHaveLength(1);
    expect(names.includes('StopBackgroundTask')).toBe(true);
    const bash = tools.find((tool) => tool.name === 'Bash');
    if (!bash) throw new Error('Bash tool missing');
    const result = await bash.impl(
      { command: 'sleep 60', timeout_ms: 2_000, yield_time_ms: 1_234 },
      {
        sessionId: 'session-1',
        runId: 'run-1',
        turnId: 'turn-1',
        cwd: '/workspace',
        toolCallId: 'tool-1',
        abortSignal: new AbortController().signal,
        emitOutput: () => {},
      },
    );

    expect((result as { kind: string }).kind).toBe('shell_run');
    expect((result as { ref?: string }).ref).toBe('maka://runtime/background-tasks/shell-run-1');
    expect((calls[0] as { yieldTimeMs?: number }).yieldTimeMs).toBe(1_234);
    expect((calls[0] as { timeoutMs?: number }).timeoutMs).toBe(2_000);
    expect((calls[0] as { sourceRunId?: string }).sourceRunId).toBe('run-1');
  });

  test('Read treats runtime background task refs as whole resources', async () => {
    const calls: unknown[] = [];
    const shellRuns = {
      async runBash() {
        throw new Error('not used');
      },
      async readResource(sessionId: string, ref: string) {
        calls.push({ sessionId, ref });
        return { content: 'background task detail' };
      },
      async stopResource() {
        throw new Error('not used');
      },
    } satisfies ShellRunToolController;
    const read = buildBuiltinTools({ shellRuns }).find((tool) => tool.name === 'Read');
    if (!read) throw new Error('Read tool missing');

    const result = await read.impl(
      { path: 'maka://runtime/background-tasks/shell-run-1', offset: 2, limit: 4 },
      {
        sessionId: 'session-1',
        runId: 'run-1',
        turnId: 'turn-1',
        cwd: '/workspace',
        toolCallId: 'tool-1',
        abortSignal: new AbortController().signal,
        emitOutput: () => {},
      },
    );

    expect(result).toEqual({ content: 'background task detail' });
    expect(calls).toEqual([{
      sessionId: 'session-1',
      ref: 'maka://runtime/background-tasks/shell-run-1',
    }]);
  });

  test('StopBackgroundTask stops a runtime ref in the current session', async () => {
    const calls: unknown[] = [];
    const shellRuns = {
      async runBash() {
        throw new Error('not used');
      },
      async readResource() {
        throw new Error('not used');
      },
      async stopResource(sessionId: string, ref: string) {
        calls.push({ sessionId, ref });
        return {
          kind: 'shell_run',
          ref,
          status: 'cancelled',
          cwd: '/workspace',
          cmd: 'sleep 60',
          startedAt: 1,
          updatedAt: 2,
          completedAt: 2,
          exitCode: 130,
          failureMessage: 'Command cancelled',
          stdout: '',
          stderr: '',
          stdoutTruncated: false,
          stderrTruncated: false,
          cancelled: true,
        };
      },
    } satisfies ShellRunToolController;
    const stop = buildBuiltinTools({ shellRuns }).find((tool) => tool.name === 'StopBackgroundTask');
    if (!stop) throw new Error('StopBackgroundTask tool missing');

    const result = await stop.impl(
      { ref: 'maka://runtime/background-tasks/shell-run-1' },
      {
        sessionId: 'session-1',
        runId: 'run-1',
        turnId: 'turn-1',
        cwd: '/workspace',
        toolCallId: 'tool-1',
        abortSignal: new AbortController().signal,
        emitOutput: () => {},
      },
    );

    expect(result).toMatchObject({ kind: 'shell_run', status: 'cancelled', cancelled: true });
    expect(calls).toEqual([{
      sessionId: 'session-1',
      ref: 'maka://runtime/background-tasks/shell-run-1',
    }]);
  });

  test('delegates Bash execution to an injected workspace executor', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-bash-executor-'));
    const calls: WorkspaceExecInput[] = [];
    const events: Array<{ stream: 'stdout' | 'stderr'; chunk: string }> = [];
    const bash = buildBuiltinTools({ executor: fakeExecutor({
      exec: async (input) => {
        calls.push(input);
        input.emitOutput?.('stdout', 'delegated-out');
        return {
          exitCode: 0,
          stdout: 'delegated-out',
          stderr: 'delegated-err',
          timedOut: false,
          aborted: false,
        };
      },
    }) }).find((tool) => tool.name === 'Bash');
    if (!bash) throw new Error('Bash tool missing');

    const result = await bash.impl(
      { command: 'npm test', timeout_ms: 12_345 },
      {
        sessionId: 'session-1',
        turnId: 'turn-1',
        cwd,
        toolCallId: 'tool-1',
        abortSignal: new AbortController().signal,
        emitOutput: (stream, chunk) => events.push({ stream, chunk }),
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe('npm test');
    expect(calls[0]?.cwd).toBe(cwd);
    expect(calls[0]?.timeoutMs).toBe(12_345);
    expect(events).toEqual([{ stream: 'stdout', chunk: 'delegated-out' }]);
    expect(result).toMatchObject({
      kind: 'terminal',
      cwd,
      cmd: 'npm test',
      exitCode: 0,
      stdout: 'delegated-out',
      stderr: 'delegated-err',
    });
  });

  test('preserves Bash failure contract when the executor reports non-zero exit', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-bash-executor-'));
    const bash = buildBuiltinTools({ executor: fakeExecutor({
      exec: async () => ({
        exitCode: 4,
        stdout: 'out-data',
        stderr: 'err-data',
        timedOut: false,
        aborted: false,
      }),
    }) }).find((tool) => tool.name === 'Bash');
    if (!bash) throw new Error('Bash tool missing');

    let err: { code?: number; stdout?: string; stderr?: string } | null = null;
    try {
      await bash.impl(
        { command: 'fail', timeout_ms: 5_000 },
        {
          sessionId: 'session-1',
          turnId: 'turn-1',
          cwd,
          toolCallId: 'tool-1',
          abortSignal: new AbortController().signal,
          emitOutput: () => {},
        },
      );
    } catch (e: unknown) {
      err = e as { code?: number; stdout?: string; stderr?: string };
    }

    expect(err?.code).toBe(4);
    expect(err?.stdout).toBe('out-data');
    expect(err?.stderr).toBe('err-data');
  });

  test('emits stdout/stderr chunks before returning terminal result', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-bash-'));
    const events: Array<{ stream: 'stdout' | 'stderr'; chunk: string }> = [];
    const bash = buildBuiltinTools().find((tool) => tool.name === 'Bash');
    if (!bash) throw new Error('Bash tool missing');

    const result = await bash.impl(
      {
        command: 'printf "out"; printf "err" >&2',
        timeout_ms: 5_000,
      },
      {
        sessionId: 'session-1',
        turnId: 'turn-1',
        cwd,
        toolCallId: 'tool-1',
        abortSignal: new AbortController().signal,
        emitOutput: (stream, chunk) => events.push({ stream, chunk }),
      },
    );

    expect(events.some((event) => event.stream === 'stdout' && event.chunk.includes('out'))).toBe(true);
    expect(events.some((event) => event.stream === 'stderr' && event.chunk.includes('err'))).toBe(true);
    expect(result).toMatchObject({
      kind: 'terminal',
      cwd,
      cmd: 'printf "out"; printf "err" >&2',
      exitCode: 0,
      stdout: 'out',
      stderr: 'err',
    });
  });

  test('aborted Bash command rejects and keeps already emitted output', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-bash-'));
    const events: Array<{ stream: 'stdout' | 'stderr'; chunk: string }> = [];
    const abort = new AbortController();
    const bash = buildBuiltinTools().find((tool) => tool.name === 'Bash');
    if (!bash) throw new Error('Bash tool missing');

    const run = bash.impl(
      {
        command: 'printf "started"; sleep 5',
        timeout_ms: 10_000,
      },
      {
        sessionId: 'session-1',
        turnId: 'turn-1',
        cwd,
        toolCallId: 'tool-1',
        abortSignal: abort.signal,
        emitOutput: (stream, chunk) => events.push({ stream, chunk }),
      },
    );
    await waitFor(() => events.length > 0);
    abort.abort();

    await expectRejects(Promise.resolve(run), /Command aborted/);
    expect(events.some((event) => event.stream === 'stdout' && event.chunk.includes('started'))).toBe(true);
  });

  test('large output is bounded to a tail instead of being discarded', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-bash-'));
    const bash = buildBuiltinTools().find((tool) => tool.name === 'Bash');
    if (!bash) throw new Error('Bash tool missing');

    const result = await bash.impl(
      { command: "awk 'BEGIN{for(i=1;i<=5000;i++)print \"line\"i}'", timeout_ms: 10_000 },
      {
        sessionId: 'session-1',
        turnId: 'turn-1',
        cwd,
        toolCallId: 'tool-1',
        abortSignal: new AbortController().signal,
        emitOutput: () => {},
      },
    ) as { exitCode: number; stdout: string; stdoutTruncated: boolean };

    expect(result.exitCode).toBe(0); // no reject — the old code threw away everything past the cap
    expect(result.stdout.includes('line5000')).toBe(true); // tail preserved
    expect(result.stdout.includes('truncated')).toBe(true); // truncation marker present
    expect(result.stdout.includes('line1\n')).toBe(false); // head dropped, not the whole output
    expect(result.stdoutTruncated).toBe(true);
  });

  test('foreground Bash marks retained-tail truncation even when model shaping does not truncate again', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-bash-'));
    const bash = buildBuiltinTools().find((tool) => tool.name === 'Bash');
    if (!bash) throw new Error('Bash tool missing');

    const result = await bash.impl(
      { command: "perl -e 'print \"x\" x 2000000'", timeout_ms: 10_000 },
      {
        sessionId: 'session-1',
        turnId: 'turn-1',
        cwd,
        toolCallId: 'tool-1',
        abortSignal: new AbortController().signal,
        emitOutput: () => {},
      },
    ) as { stdout: string; stdoutTruncated: boolean };

    expect(result.stdoutTruncated).toBe(true);
    expect(result.stdout).toContain('omitted for safety');
  });

  test('a failing command surfaces stdout/stderr on the rejection error', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-bash-'));
    const bash = buildBuiltinTools().find((tool) => tool.name === 'Bash');
    if (!bash) throw new Error('Bash tool missing');

    let err: { code?: number; stdout?: string; stderr?: string } | null = null;
    try {
      await bash.impl(
        { command: 'printf "out-data"; printf "err-data" >&2; exit 3', timeout_ms: 5_000 },
        {
          sessionId: 'session-1',
          turnId: 'turn-1',
          cwd,
          toolCallId: 'tool-1',
          abortSignal: new AbortController().signal,
          emitOutput: () => {},
        },
      );
    } catch (e: unknown) {
      err = e as { code?: number; stdout?: string; stderr?: string };
    }

    expect(err?.code).toBe(3);
    expect(err?.stdout).toBe('out-data');
    expect(err?.stderr).toBe('err-data');
  });

  test('a timed-out command still surfaces the stdout/stderr captured before the timeout', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-bash-'));
    const bash = buildBuiltinTools().find((tool) => tool.name === 'Bash');
    if (!bash) throw new Error('Bash tool missing');

    let err: { code?: number; stdout?: string; stderr?: string } | null = null;
    try {
      await bash.impl(
        { command: 'printf "out-before"; printf "err-before" >&2; sleep 5', timeout_ms: 200 },
        {
          sessionId: 'session-1',
          turnId: 'turn-1',
          cwd,
          toolCallId: 'tool-1',
          abortSignal: new AbortController().signal,
          emitOutput: () => {},
        },
      );
    } catch (e: unknown) {
      err = e as { code?: number; stdout?: string; stderr?: string };
    }

    expect(err?.code).toBe(124);
    expect(err?.stdout).toBe('out-before');
    expect(err?.stderr).toBe('err-before');
  });
});

describe('builtin read tools path containment', () => {
  test('Read delegates file loading to the injected workspace executor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-read-executor-'));
    await writeFile(join(root, 'inside.txt'), 'local-content', 'utf8');
    const readInputs: unknown[] = [];
    const read = buildBuiltinTools({ executor: fakeExecutor({
      readFile: async (input) => {
        readInputs.push(input);
        return { content: 'executor-window' };
      },
    }) }).find((candidate) => candidate.name === 'Read');
    if (!read) throw new Error('Read tool missing');

    const result = await runTool(read, { path: 'inside.txt', offset: 1, limit: 1 }, root);

    expect(readInputs).toHaveLength(1);
    expect(readInputs[0]).toMatchObject({
      offset: 1,
      limit: 1,
    });
    expect(String((readInputs[0] as { path?: string }).path)).toMatch(/inside\.txt$/);
    expect(result).toMatchObject({ content: 'executor-window' });
  });

  test('Read rejects absolute, parent traversal, and symlink escape paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-read-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'maka-read-outside-'));
    await writeFile(join(root, 'inside.txt'), 'inside', 'utf8');
    await writeFile(join(outside, 'secret.txt'), 'secret', 'utf8');
    await symlink(join(outside, 'secret.txt'), join(root, 'secret-link.txt'));
    const read = tool('Read');

    await expectRejects(runTool(read, { path: '/etc/hosts' }, root), /Read path must be relative/);
    await expectRejects(runTool(read, { path: '../outside.txt' }, root), /Read path must stay inside/);
    await expectRejects(runTool(read, { path: 'secret-link.txt' }, root), /Read path must stay inside/);

    const result = await runTool(read, { path: 'inside.txt' }, root);
    expect(result).toMatchObject({ content: 'inside' });
  });

  test('Glob and Grep constrain search roots to session cwd', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-read-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'maka-read-outside-'));
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'main.ts'), 'export const token = 1;\n', 'utf8');
    await symlink(outside, join(root, 'outside-link'));
    const glob = tool('Glob');
    const grep = tool('Grep');

    await expectRejects(runTool(glob, { pattern: '../*.txt' }, root), /Glob pattern must stay inside/);
    await expectRejects(runTool(glob, { pattern: '*.txt', cwd: 'outside-link' }, root), /Glob cwd path must stay inside/);
    await expectRejects(runTool(grep, { pattern: 'token', path: '/etc' }, root), /Grep path must be relative/);
    await expectRejects(runTool(grep, { pattern: 'secret', path: 'outside-link' }, root), /Grep path must stay inside/);

    const globResult = await runTool(glob, { pattern: '**/*.ts' }, root);
    expect(globResult).toMatchObject({ files: ['src/main.ts'] });
    const grepResult = await runTool(grep, { pattern: 'token', path: 'src' }, root);
    expect(JSON.stringify(grepResult).includes('main.ts')).toBe(true);
  });

  test('Glob delegates matching to the injected workspace executor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-glob-executor-'));
    await mkdir(join(root, 'src'), { recursive: true });
    const calls: Array<{ cwd: string; pattern: string; limit?: number }> = [];
    const glob = buildBuiltinTools({ executor: fakeExecutor({
      globFiles: async (input) => {
        calls.push(input);
        return { files: ['from-executor.ts'] };
      },
    }) }).find((candidate) => candidate.name === 'Glob');
    if (!glob) throw new Error('Glob tool missing');

    const result = await runTool(glob, { pattern: '**/*.ts', cwd: 'src' }, root);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.cwd.endsWith('src')).toBe(true);
    expect(calls[0]?.pattern).toBe('**/*.ts');
    expect(calls[0]?.limit).toBe(200);
    expect(result).toMatchObject({ files: ['from-executor.ts'] });
  });

  test('Grep delegates searching to the injected workspace executor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-grep-executor-'));
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'main.ts'), 'local token\n', 'utf8');
    const calls: Array<{ cwd: string; pattern: string; path: string; glob?: string; maxCountPerFile: number; limit: number }> = [];
    const grep = buildBuiltinTools({ executor: fakeExecutor({
      grepFiles: async (input) => {
        calls.push(input);
        return { matches: ['from-executor.ts:1:token'] };
      },
    }) }).find((candidate) => candidate.name === 'Grep');
    if (!grep) throw new Error('Grep tool missing');

    const result = await runTool(grep, { pattern: 'token', path: 'src', glob: '*.ts' }, root);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.cwd).toBe(root);
    expect(calls[0]?.path.endsWith('src')).toBe(true);
    expect(calls[0]?.glob).toBe('*.ts');
    expect(calls[0]?.maxCountPerFile).toBe(50);
    expect(calls[0]?.limit).toBe(200);
    expect(result).toMatchObject({ matches: ['from-executor.ts:1:token'] });
  });
});

describe('builtin write tools path containment', () => {
  test('Write can delegate path resolution to a remote executor when cwd is not on the host', async () => {
    const writes: Array<{ cwd: string; path: string; content: string }> = [];
    const write = buildBuiltinTools({ executor: fakeExecutor({
      writeLockKey: async ({ cwd, path }) => ({ key: JSON.stringify([cwd, path]) }),
      resolveWritablePath: async ({ cwd, path }) => ({ path: `${cwd}/${path}` }),
      writeFile: async ({ cwd, path, content }) => {
        writes.push({ cwd, path, content });
        return { ok: true, path, bytes: Buffer.byteLength(content, 'utf8') };
      },
    }) }).find((candidate) => candidate.name === 'Write');
    if (!write) throw new Error('Write tool missing');

    const result = await runTool(write, { path: 'created.txt', content: 'from-executor' }, '/workspace');

    expect(writes).toEqual([{
      cwd: '/workspace',
      path: '/workspace/created.txt',
      content: 'from-executor',
    }]);
    expect(result).toMatchObject({ ok: true, path: '/workspace/created.txt', bytes: 13 });
  });

  test('Write delegates file writing to the injected workspace executor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-write-executor-'));
    const writes: Array<{ path: string; content: string }> = [];
    const write = buildBuiltinTools({ executor: fakeExecutor({
      writeFile: async ({ path, content }) => {
        writes.push({ path, content });
        return { ok: true, path, bytes: Buffer.byteLength(content, 'utf8') };
      },
    }) }).find((candidate) => candidate.name === 'Write');
    if (!write) throw new Error('Write tool missing');

    const result = await runTool(write, { path: 'created.txt', content: 'from-executor' }, root);

    expect(writes).toHaveLength(1);
    expect(writes[0]?.path.endsWith('created.txt')).toBe(true);
    expect(writes[0]?.content).toBe('from-executor');
    expect(result).toMatchObject({ ok: true, bytes: 13 });
  });

  test('Edit reads and writes through the injected workspace executor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-edit-executor-'));
    await writeFile(join(root, 'data.txt'), 'local content that should not be used', 'utf8');
    const reads: string[] = [];
    const writes: Array<{ path: string; content: string }> = [];
    const edit = buildBuiltinTools({ executor: fakeExecutor({
      readFile: async ({ path }) => {
        reads.push(path);
        return { content: 'hello world\n' };
      },
      writeFile: async ({ path, content }) => {
        writes.push({ path, content });
        return { ok: true, path, bytes: Buffer.byteLength(content, 'utf8') };
      },
    }) }).find((candidate) => candidate.name === 'Edit');
    if (!edit) throw new Error('Edit tool missing');

    const result = await runTool(edit, { path: 'data.txt', old_string: 'world', new_string: 'Maka' }, root);

    expect(reads).toHaveLength(1);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.content).toBe('hello Maka\n');
    expect(result).toMatchObject({
      ok: true,
      replacements: 1,
    });
  });

  test('Write rejects absolute, parent traversal, and symlink-parent escape paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-write-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'maka-write-outside-'));
    await symlink(outside, join(root, 'outside-link'));
    const write = tool('Write');

    await expectRejects(runTool(write, { path: '/tmp/outside.txt', content: 'x' }, root), /Write path must be relative/);
    await expectRejects(runTool(write, { path: '../outside.txt', content: 'x' }, root), /Write path must stay inside/);
    await expectRejects(runTool(write, { path: 'outside-link/new.txt', content: 'x' }, root), /Write path must stay inside/);

    await mkdir(join(root, 'src'), { recursive: true });
    await runTool(write, { path: 'src/new.txt', content: 'inside' }, root);
    expect(await readFile(join(root, 'src', 'new.txt'), 'utf8')).toBe('inside');
  });

  test('Edit rejects absolute, parent traversal, and symlink file escapes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-edit-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'maka-edit-outside-'));
    await writeFile(join(root, 'inside.txt'), 'hello world', 'utf8');
    await writeFile(join(outside, 'secret.txt'), 'secret', 'utf8');
    await symlink(join(outside, 'secret.txt'), join(root, 'secret-link.txt'));
    const edit = tool('Edit');

    await expectRejects(runTool(edit, { path: '/tmp/outside.txt', old_string: 'x', new_string: 'y' }, root), /Edit path must be relative/);
    await expectRejects(runTool(edit, { path: '../outside.txt', old_string: 'x', new_string: 'y' }, root), /Edit path must stay inside/);
    await expectRejects(runTool(edit, { path: 'secret-link.txt', old_string: 'secret', new_string: 'edited' }, root), /Edit path must stay inside/);

    await runTool(edit, { path: 'inside.txt', old_string: 'world', new_string: 'Maka' }, root);
    expect(await readFile(join(root, 'inside.txt'), 'utf8')).toBe('hello Maka');
  });

  test('concurrent Edits to the same file serialize — no lost update', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-edit-lock-'));
    const n = 20;
    const markers = Array.from({ length: n }, (_, i) => `marker-${String(i).padStart(2, '0')}`);
    await writeFile(join(root, 'data.txt'), `${markers.join('\n')}\n`, 'utf8');
    const edit = tool('Edit');
    // Each Edit is a read-modify-write (fs.readFile -> replace -> fs.writeFile).
    // Fired concurrently without the per-path lock, the writes clobber each other
    // and most edits are lost; the lock serializes them so every one lands.
    const results = await Promise.all(markers.map((m, i) =>
      runTool(edit, { path: 'data.txt', old_string: m, new_string: `done-${String(i).padStart(2, '0')}` }, root),
    ));
    expect(results.every((r) => (r as { ok: boolean; replacements: number }).ok === true
      && (r as { replacements: number }).replacements === 1)).toBe(true);
    const expected = `${Array.from({ length: n }, (_, i) => `done-${String(i).padStart(2, '0')}`).join('\n')}\n`;
    expect(await readFile(join(root, 'data.txt'), 'utf8')).toBe(expected);
  });

  test('concurrent Edits via different path spellings serialize on one key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-edit-spelling-'));
    const n = 20;
    const markers = Array.from({ length: n }, (_, i) => `marker-${String(i).padStart(2, '0')}`);
    await writeFile(join(root, 'data.txt'), `${markers.join('\n')}\n`, 'utf8');
    const edit = tool('Edit');
    // Alternate the spelling of the same file. The key resolves both spellings to
    // one absolute path, so all edits share a lock; without that collapse the two
    // groups would run concurrently and clobber each other.
    const results = await Promise.all(markers.map((m, i) =>
      runTool(edit, { path: i % 2 === 0 ? 'data.txt' : './data.txt', old_string: m, new_string: `done-${String(i).padStart(2, '0')}` }, root),
    ));
    expect(results.every((r) => (r as { ok: boolean }).ok === true)).toBe(true);
    const expected = `${Array.from({ length: n }, (_, i) => `done-${String(i).padStart(2, '0')}`).join('\n')}\n`;
    expect(await readFile(join(root, 'data.txt'), 'utf8')).toBe(expected);
  });

  test('Write then Edit on one file resolves inside the lock — the fresh file is found', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-write-edit-'));
    const write = tool('Write');
    const edit = tool('Edit');
    // Edit now resolves its target inside the lock (containment + existence check
    // moved in). This guards that flow: a Write creates a brand-new file, then an
    // Edit on the same path still resolves and rewrites it.
    await runTool(write, { path: 'fresh.txt', content: 'hello world\n' }, root);
    await runTool(edit, { path: 'fresh.txt', old_string: 'world', new_string: 'Maka' }, root);
    expect(await readFile(join(root, 'fresh.txt'), 'utf8')).toBe('hello Maka\n');
  });

  test('a failing Edit releases the lock for the next op on the same file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-edit-wedge-'));
    await writeFile(join(root, 'data.txt'), 'hello world\n', 'utf8');
    const edit = tool('Edit');
    // An Edit whose old_string is absent rejects; the lock must not wedge, so the
    // next Edit on the same file still runs.
    await expectRejects(runTool(edit, { path: 'data.txt', old_string: 'absent', new_string: 'x' }, root), /./);
    await runTool(edit, { path: 'data.txt', old_string: 'world', new_string: 'Maka' }, root);
    expect(await readFile(join(root, 'data.txt'), 'utf8')).toBe('hello Maka\n');
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for predicate');
}

async function expectRejects(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error instanceof Error ? error.message : String(error)).toMatch(pattern);
    return;
  }
  throw new Error('expected promise to reject');
}

function tool(name: string) {
  const found = buildBuiltinTools().find((candidate) => candidate.name === name);
  if (!found) throw new Error(`${name} tool missing`);
  return found;
}

function runTool(tool: ReturnType<typeof buildBuiltinTools>[number], args: unknown, cwd: string): Promise<unknown> {
  return Promise.resolve(tool.impl(args as never, {
    sessionId: 'session-1',
    turnId: 'turn-1',
    cwd,
    toolCallId: 'tool-1',
    abortSignal: new AbortController().signal,
    emitOutput: () => {},
  }));
}

function fakeExecutor(overrides: Partial<WorkspaceExecutor>): WorkspaceExecutor {
  const base: WorkspaceExecutor = {
    facts: LOCAL_WORKSPACE_EXECUTOR_FACTS,
    exec: async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
      aborted: false,
    }),
    readFile: async () => ({ content: '' }),
    writeFile: async ({ path, content }) => ({
      ok: true,
      path,
      bytes: Buffer.byteLength(content, 'utf8'),
    }),
    resolveExistingPath: async ({ path }) => ({ path }),
    resolveWritablePath: async ({ path }) => ({ path }),
    writeLockKey: async ({ cwd, path }) => ({ key: `${cwd}:${path}` }),
    globFiles: async () => ({ files: [] }),
    grepFiles: async () => ({ matches: [] }),
  };
  return Object.assign(base, overrides);
}
