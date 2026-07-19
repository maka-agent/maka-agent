import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from '../test-helpers.js';
import { LocalWorkspaceExecutor } from '../workspace-executor.js';

describe('LocalWorkspaceExecutor exec', () => {
  test('runs commands in the provided cwd and streams stdout/stderr', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-workspace-exec-'));
    await writeFile(join(cwd, 'marker.txt'), 'from-cwd', 'utf8');
    const executor = new LocalWorkspaceExecutor();
    const events: Array<{ stream: 'stdout' | 'stderr'; chunk: string }> = [];

    const result = await executor.exec({
      command: 'printf "$(cat marker.txt)"; printf "err-data" >&2',
      cwd,
      timeoutMs: 5_000,
      emitOutput: (stream, chunk) => events.push({ stream, chunk }),
    });

    expect(result).toMatchObject({
      exitCode: 0,
      stdout: 'from-cwd',
      stderr: 'err-data',
    });
    expect(
      events.some((event) => event.stream === 'stdout' && event.chunk.includes('from-cwd')),
    ).toBe(true);
    expect(
      events.some((event) => event.stream === 'stderr' && event.chunk.includes('err-data')),
    ).toBe(true);
  });

  test('reports non-zero exit without throwing so tools can preserve their own error contract', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-workspace-exec-'));
    const executor = new LocalWorkspaceExecutor();

    const result = await executor.exec({
      command: 'printf "out-data"; printf "err-data" >&2; exit 7',
      cwd,
      timeoutMs: 5_000,
    });

    expect(result).toMatchObject({
      exitCode: 7,
      stdout: 'out-data',
      stderr: 'err-data',
    });
    expect(result.timedOut).toBe(false);
    expect(result.aborted).toBe(false);
  });

  test('runs argv commands without routing through the host shell', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-workspace-exec-argv-'));
    const executor = new LocalWorkspaceExecutor();

    const result = await executor.exec({
      command: 'ignored display command',
      argv: [
        process.execPath,
        '-e',
        'process.stdout.write(process.argv[1])',
        'literal $HOME && ok',
      ],
      cwd,
      timeoutMs: 5_000,
    });

    expect(result).toMatchObject({
      exitCode: 0,
      stdout: 'literal $HOME && ok',
      stderr: '',
    });
  });

  test('reports timeout with captured output', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-workspace-exec-'));
    const executor = new LocalWorkspaceExecutor();

    const result = await executor.exec({
      command: 'printf "before-timeout"; sleep 5',
      cwd,
      timeoutMs: 200,
    });

    expect(result.exitCode).toBe(124);
    expect(result.timedOut).toBe(true);
    expect(result.stdout).toBe('before-timeout');
  });

  test('reports abort with captured output', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-workspace-exec-'));
    const executor = new LocalWorkspaceExecutor();
    const controller = new AbortController();

    const resultPromise = executor.exec({
      command: 'printf "before-abort"; sleep 5; printf "after-abort"',
      cwd,
      timeoutMs: 5_000,
      abortSignal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);
    const result = await resultPromise;

    expect(result.exitCode).toBe(130);
    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toBe('before-abort');
  });
});

describe('LocalWorkspaceExecutor file operations', () => {
  test('reads PNG, JPEG, GIF, and WebP images by magic bytes', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-workspace-images-'));
    const executor = new LocalWorkspaceExecutor();
    const fixtures = [
      ['image.PNG', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'image/png'],
      ['image.jpg', [0xff, 0xd8, 0xff], 'image/jpeg'],
      ['image.jpeg', [...Buffer.from('GIF89a')], 'image/gif'],
      ['image.webp', [...Buffer.from('RIFF0000WEBP')], 'image/webp'],
    ] as const;

    for (const [name, bytes, mimeType] of fixtures) {
      const file = join(cwd, name);
      await writeFile(file, Uint8Array.from(bytes));
      const result = await executor.readFile({ cwd, path: file });
      if (!('bytes' in result)) throw new Error('expected image result');
      expect(result.mimeType).toBe(mimeType);
      expect([...result.bytes]).toEqual([...bytes]);
    }
  });

  test('ignores text windows when reading an image', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-workspace-images-'));
    const executor = new LocalWorkspaceExecutor();
    const file = join(cwd, 'image.png');
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await writeFile(file, bytes);

    const result = await executor.readFile({ cwd, path: file, offset: 1, limit: 1 });

    if (!('bytes' in result)) throw new Error('expected image result');
    expect([...result.bytes]).toEqual([...bytes]);
  });

  test('rejects extension-only and over-limit image files', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-workspace-images-'));
    const executor = new LocalWorkspaceExecutor();
    const fake = join(cwd, 'fake.png');
    const huge = join(cwd, 'huge.webp');
    await writeFile(fake, 'not an image');
    await writeFile(huge, 'RIFF0000WEBP');
    await truncate(huge, 5 * 1024 * 1024 + 1);

    await assert.rejects(
      executor.readFile({ cwd, path: fake }),
      /^Error: Image content is not a supported PNG, JPEG, GIF, or WebP file\.$/,
    );
    await assert.rejects(
      executor.readFile({ cwd, path: huge }),
      /exceeds the 5MB model input limit/,
    );
  });

  test('reads and writes text files by absolute path', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-workspace-files-'));
    const executor = new LocalWorkspaceExecutor();
    const file = join(cwd, 'data.txt');

    const writeResult = await executor.writeFile({ cwd, path: file, content: 'hello' });
    const readResult = await executor.readFile({ cwd, path: file });

    expect(writeResult).toMatchObject({
      ok: true,
      path: file,
      bytes: 5,
    });
    expect(readResult).toMatchObject({ content: 'hello' });
    expect(await readFile(file, 'utf8')).toBe('hello');
  });

  test('applies read offset and limit at the executor boundary', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-workspace-files-'));
    const executor = new LocalWorkspaceExecutor();
    const file = join(cwd, 'data.txt');
    await writeFile(file, 'line1\nline2\nline3\nline4', 'utf8');

    const readResult = await executor.readFile({ cwd, path: file, offset: 1, limit: 2 });

    expect(readResult).toMatchObject({ content: 'line2\nline3' });
  });

  test('globs files from the provided cwd with a result cap', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-workspace-glob-'));
    await mkdir(join(cwd, 'src'), { recursive: true });
    await writeFile(join(cwd, 'src', 'a.ts'), 'a', 'utf8');
    await writeFile(join(cwd, 'src', 'b.ts'), 'b', 'utf8');
    await writeFile(join(cwd, 'src', 'c.js'), 'c', 'utf8');
    const executor = new LocalWorkspaceExecutor();

    const result = await executor.globFiles({ cwd, pattern: 'src/*.*', limit: 2 });

    expect(result.files).toHaveLength(2);
    expect(result.files.every((file) => file.startsWith('src/'))).toBe(true);
  });

  test('greps file contents with rg-compatible no-match behavior', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-workspace-grep-'));
    await mkdir(join(cwd, 'src'), { recursive: true });
    await writeFile(join(cwd, 'src', 'main.ts'), 'export const token = 1;\n', 'utf8');
    const executor = new LocalWorkspaceExecutor();

    const hit = await executor.grepFiles({
      cwd,
      pattern: 'token',
      path: join(cwd, 'src'),
      maxCountPerFile: 50,
      limit: 200,
      timeoutMs: 5_000,
    });
    const miss = await executor.grepFiles({
      cwd,
      pattern: 'absent',
      path: join(cwd, 'src'),
      maxCountPerFile: 50,
      limit: 200,
      timeoutMs: 5_000,
    });

    expect(hit.matches.some((match) => match.includes('main.ts'))).toBe(true);
    expect(miss).toMatchObject({ matches: [] });
  });
});
