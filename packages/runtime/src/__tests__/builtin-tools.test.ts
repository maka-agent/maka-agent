import { describe, test } from 'node:test';
import { mkdir, mkdtemp, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from '../test-helpers.js';
import { buildBuiltinTools } from '../builtin-tools.js';
import type { WorkspaceExecutor } from '../workspace-executor.js';

describe('builtin Bash streaming output', () => {
  test('emits stdout/stderr chunks before returning terminal result', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-bash-'));
    const events: Array<{ stream: 'stdout' | 'stderr'; chunk: string }> = [];
    const bash = buildBuiltinTools().find((tool) => tool.name === 'Bash');
    if (!bash) throw new Error('Bash tool missing');

    const result = await bash.impl(
      {
        command: 'node -e "process.stdout.write(\'out\'); process.stderr.write(\'err\')"',
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
      cmd: 'node -e "process.stdout.write(\'out\'); process.stderr.write(\'err\')"',
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
        command: 'node -e "process.stdout.write(\'started\'); setTimeout(() => {}, 5000)"',
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
      { command: 'node -e "for (let i = 1; i <= 5000; i++) console.log(\'line\' + i)"', timeout_ms: 10_000 },
      {
        sessionId: 'session-1',
        turnId: 'turn-1',
        cwd,
        toolCallId: 'tool-1',
        abortSignal: new AbortController().signal,
        emitOutput: () => {},
      },
    ) as { exitCode: number; stdout: string };

    expect(result.exitCode).toBe(0); // no reject — the old code threw away everything past the cap
    expect(result.stdout.includes('line5000')).toBe(true); // tail preserved
    expect(result.stdout.includes('truncated')).toBe(true); // truncation marker present
    expect(result.stdout.includes('line1\n')).toBe(false); // head dropped, not the whole output
  });

  test('a failing command surfaces stdout/stderr on the rejection error', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-bash-'));
    const bash = buildBuiltinTools().find((tool) => tool.name === 'Bash');
    if (!bash) throw new Error('Bash tool missing');

    let err: { code?: number; stdout?: string; stderr?: string } | null = null;
    try {
      await bash.impl(
        {
          command: 'node -e "process.stdout.write(\'out-data\'); process.stderr.write(\'err-data\'); process.exit(3)"',
          timeout_ms: 5_000,
        },
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
        {
          command: 'node -e "process.stdout.write(\'out-before\'); process.stderr.write(\'err-before\'); setTimeout(() => {}, 5000)"',
          timeout_ms: 200,
        },
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

    // Without the fix the model would see a bare "timed out" with no logs; now
    // the error carries a code (124) and the bounded tail captured pre-timeout.
    expect(err?.code).toBe(124);
    expect(err?.stdout).toBe('out-before');
    expect(err?.stderr).toBe('err-before');
  });
});

describe('builtin tools workspace executor routing', () => {
  test('Bash and file tools can be redirected to a sandbox cwd without mutating the real cwd', async () => {
    const realCwd = await mkdtemp(join(tmpdir(), 'maka-real-workspace-'));
    const sandboxCwd = await mkdtemp(join(tmpdir(), 'maka-sandbox-workspace-'));
    await mkdir(join(realCwd, 'src'), { recursive: true });
    await mkdir(join(sandboxCwd, 'src'), { recursive: true });
    await writeFile(join(realCwd, 'src', 'data.txt'), 'real token\n', 'utf8');
    await writeFile(join(sandboxCwd, 'src', 'data.txt'), 'sandbox token\n', 'utf8');

    const executor = makeSandboxExecutor(realCwd, sandboxCwd);
    const tools = buildBuiltinTools({ executor });
    const bash = requireTool(tools, 'Bash');
    const read = requireTool(tools, 'Read');
    const write = requireTool(tools, 'Write');
    const edit = requireTool(tools, 'Edit');
    const glob = requireTool(tools, 'Glob');
    const grep = requireTool(tools, 'Grep');

    const events: Array<{ stream: 'stdout' | 'stderr'; chunk: string }> = [];
    const bashResult = await runTool(bash, { command: 'touch generated-by-bash.txt', timeout_ms: 5_000 }, realCwd, {
      emitOutput: (stream, chunk) => events.push({ stream, chunk }),
    });
    await runTool(write, { path: 'src/new.txt', content: 'created in sandbox\n' }, realCwd);
    await runTool(edit, {
      path: 'src/data.txt',
      old_string: 'sandbox token',
      new_string: 'edited sandbox token',
    }, realCwd);

    const readResult = await runTool(read, { path: 'src/data.txt' }, realCwd);
    const globResult = await runTool(glob, { pattern: '*.txt', cwd: 'src' }, realCwd);
    const grepResult = await runTool(grep, { pattern: 'edited sandbox token', path: 'src' }, realCwd);

    expect(bashResult).toMatchObject({
      kind: 'terminal',
      cwd: realCwd,
      cmd: 'touch generated-by-bash.txt',
      exitCode: 0,
      stdout: 'sandbox stdout',
    });
    expect(events.some((event) => event.stream === 'stdout' && event.chunk.includes('sandbox stdout'))).toBe(true);
    expect(readResult).toMatchObject({ content: 'edited sandbox token\n' });
    expect(globResult).toMatchObject({ files: ['data.txt', 'new.txt'] });
    expect(grepResult).toMatchObject({ matches: ['src/data.txt:1:edited sandbox token'] });
    expect(await readOptional(join(realCwd, 'src', 'data.txt'))).toBe('real token\n');
    expect(await readOptional(join(realCwd, 'src', 'new.txt'))).toBeNull();
    expect(await readOptional(join(realCwd, 'generated-by-bash.txt'))).toBeNull();
    expect(await readFile(join(sandboxCwd, 'src', 'data.txt'), 'utf8')).toBe('edited sandbox token\n');
    expect(await readFile(join(sandboxCwd, 'src', 'new.txt'), 'utf8')).toBe('created in sandbox\n');
    expect(await readFile(join(sandboxCwd, 'generated-by-bash.txt'), 'utf8')).toBe('touch generated-by-bash.txt\n');
  });
});

describe('builtin read tools path containment', () => {
  test('Read rejects absolute, parent traversal, and symlink escape paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-read-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'maka-read-outside-'));
    await writeFile(join(root, 'inside.txt'), 'inside', 'utf8');
    await writeFile(join(outside, 'secret.txt'), 'secret', 'utf8');
    await linkDirectory(outside, join(root, 'outside-link'));
    const read = tool('Read');

    await expectRejects(runTool(read, { path: '/etc/hosts' }, root), /Read path must be relative/);
    await expectRejects(runTool(read, { path: '../outside.txt' }, root), /Read path must stay inside/);
    await expectRejects(runTool(read, { path: 'outside-link/secret.txt' }, root), /Read path must stay inside/);

    const result = await runTool(read, { path: 'inside.txt' }, root);
    expect(result).toMatchObject({ content: 'inside' });
  });

  test('Glob and Grep constrain search roots to session cwd', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-read-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'maka-read-outside-'));
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'main.ts'), 'export const token = 1;\n', 'utf8');
    await linkDirectory(outside, join(root, 'outside-link'));
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

describe('builtin write tools path containment', () => {
  test('Write rejects absolute, parent traversal, and symlink-parent escape paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-write-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'maka-write-outside-'));
    await linkDirectory(outside, join(root, 'outside-link'));
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
    await linkDirectory(outside, join(root, 'outside-link'));
    const edit = tool('Edit');

    await expectRejects(runTool(edit, { path: '/tmp/outside.txt', old_string: 'x', new_string: 'y' }, root), /Edit path must be relative/);
    await expectRejects(runTool(edit, { path: '../outside.txt', old_string: 'x', new_string: 'y' }, root), /Edit path must stay inside/);
    await expectRejects(runTool(edit, { path: 'outside-link/secret.txt', old_string: 'secret', new_string: 'edited' }, root), /Edit path must stay inside/);

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

function requireTool(tools: ReturnType<typeof buildBuiltinTools>, name: string) {
  const found = tools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`${name} tool missing`);
  return found;
}

function runTool(
  tool: ReturnType<typeof buildBuiltinTools>[number],
  args: unknown,
  cwd: string,
  options: { emitOutput?: (stream: 'stdout' | 'stderr', chunk: string) => void } = {},
): Promise<unknown> {
  return Promise.resolve(tool.impl(args as never, {
    sessionId: 'session-1',
    turnId: 'turn-1',
    cwd,
    toolCallId: 'tool-1',
    abortSignal: new AbortController().signal,
    emitOutput: options.emitOutput ?? (() => {}),
  }));
}

function makeSandboxExecutor(realCwd: string, sandboxCwd: string): WorkspaceExecutor {
  const mapCwd = (cwd: string) => {
    expect(cwd).toBe(realCwd);
    return sandboxCwd;
  };
  return {
    facts: {
      isolation: 'worktree',
      writesAffectHost: false,
      writeBack: 'diff_review',
      network: 'host',
      secrets: 'host_env',
      gitMetadata: 'host_shared',
    },
    exec: async ({ command, cwd, emitOutput }: {
      command: string;
      cwd: string;
      emitOutput?: (stream: 'stdout' | 'stderr', chunk: string) => void;
    }) => {
      const sandbox = mapCwd(cwd);
      await writeFile(join(sandbox, 'generated-by-bash.txt'), `${command}\n`, 'utf8');
      emitOutput?.('stdout', 'sandbox stdout');
      return { exitCode: 0, stdout: 'sandbox stdout', stderr: '', timedOut: false, aborted: false };
    },
    readFile: async ({ cwd, path, offset, limit }: {
      cwd: string;
      path: string;
      offset?: number;
      limit?: number;
    }) => {
      const content = await readFile(join(mapCwd(cwd), path), 'utf8');
      if (offset === undefined && limit === undefined) return { content };
      const lines = content.split('\n');
      const start = offset ?? 0;
      const end = limit ? start + limit : lines.length;
      return { content: lines.slice(start, end).join('\n') };
    },
    writeFile: async ({ cwd, path, content }: { cwd: string; path: string; content: string }) => {
      const abs = join(mapCwd(cwd), path);
      await mkdir(join(abs, '..'), { recursive: true });
      await writeFile(abs, content, 'utf8');
      return { ok: true, path: abs, bytes: Buffer.byteLength(content, 'utf8') };
    },
    globFiles: async ({ cwd, searchCwd }: { cwd: string; pattern: string; searchCwd?: string }) => {
      const base = searchCwd ? join(mapCwd(cwd), searchCwd) : mapCwd(cwd);
      const files = (await readdir(base)).filter((name) => name.endsWith('.txt')).sort();
      return { files };
    },
    grepFiles: async ({ cwd, pattern, path }: { cwd: string; pattern: string; path?: string }) => {
      const base = path ? join(mapCwd(cwd), path) : mapCwd(cwd);
      const matches: string[] = [];
      await collectTextMatches(base, path ?? '', pattern, matches);
      return { matches };
    },
  };
}

async function collectTextMatches(abs: string, rel: string, pattern: string, matches: string[]): Promise<void> {
  const current = await stat(abs);
  if (current.isDirectory()) {
    for (const name of await readdir(abs)) {
      await collectTextMatches(join(abs, name), rel ? `${rel}/${name}` : name, pattern, matches);
    }
    return;
  }
  const lines = (await readFile(abs, 'utf8')).split('\n');
  lines.forEach((line, index) => {
    if (line.includes(pattern)) matches.push(`${rel}:${index + 1}:${line}`);
  });
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

async function linkDirectory(target: string, path: string): Promise<void> {
  await symlink(target, path, process.platform === 'win32' ? 'junction' : 'dir');
}
