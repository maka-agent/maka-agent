import { describe, test } from 'node:test';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from '../test-helpers.js';
import { buildBuiltinTools } from '../builtin-tools.js';

describe('builtin Bash streaming output', () => {
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
});

describe('builtin read tools path containment', () => {
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
