import { describe, test } from 'node:test';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createReadOnlyPermissionProfile,
  createWorkspaceWritePermissionProfile,
} from '@maka/core/permission-profile';
import { expect } from '../test-helpers.js';
import {
  LOCAL_WORKSPACE_EXECUTOR_FACTS,
  LocalWorkspaceExecutor,
  ProfileEnforcedWorkspaceExecutor,
  SandboxedCommandWorkspaceExecutor,
  WorkspaceCommandSandboxError,
  WorkspaceProfilePermissionError,
  type WorkspaceExecInput,
  type WorkspaceCommandSandboxContext,
  type WorkspaceExecutor,
  type WorkspaceProfileEnforcementContext,
} from '../workspace-executor.js';
import type { BoundedProcessOptions } from '../shell-exec.js';
import type { SandboxTransformRequest, SandboxTransformResult } from '../sandbox/index.js';

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
      emitOutput: (stream: 'stdout' | 'stderr', chunk: string) => events.push({ stream, chunk }),
    });

    expect(result).toMatchObject({
      exitCode: 0,
      stdout: 'from-cwd',
      stderr: 'err-data',
    });
    expect(events.some((event) => event.stream === 'stdout' && event.chunk.includes('from-cwd'))).toBe(true);
    expect(events.some((event) => event.stream === 'stderr' && event.chunk.includes('err-data'))).toBe(true);
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

describe('SandboxedCommandWorkspaceExecutor exec', () => {
  test('transforms /bin/sh -c command and executes the final sandbox argv', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-sandboxed-command-'));
    const transformCalls: SandboxTransformRequest[] = [];
    const runCalls: Array<{ argv: readonly string[]; options: unknown }> = [];
    const abort = new AbortController();
    const events: Array<{ stream: 'stdout' | 'stderr'; chunk: string }> = [];
    const sandboxManager = {
      transform(request: SandboxTransformRequest): SandboxTransformResult {
        transformCalls.push(request);
        return {
          ok: true,
          exec: {
            argv: ['/usr/bin/sandbox-exec', '-p', 'policy', '--', request.command.program, ...request.command.args],
            cwd: request.command.cwd,
            env: request.command.env,
            sandboxType: 'macos-seatbelt',
            effectiveProfile: request.command.profile,
          },
          sandboxType: 'macos-seatbelt',
          requiresSandbox: true,
          preference: 'auto',
        };
      },
    };
    const executor = new SandboxedCommandWorkspaceExecutor({
      inner: fakeExecutor(),
      getSandboxContext: () => ({
        profile: createWorkspaceWritePermissionProfile(),
        workspaceRoots: [cwd],
        sandboxManager,
        platform: 'darwin',
        preference: 'auto',
        pathContext: { minimalRoots: ['/usr', '/bin'] },
      }),
      runProcess: async (argv: readonly string[], options: BoundedProcessOptions) => {
        runCalls.push({ argv, options });
        options.emitOutput?.('stdout', 'live-out');
        return {
          exitCode: 0,
          stdout: 'sandbox-out',
          stderr: 'sandbox-err',
          stdoutTruncated: false,
          stderrTruncated: false,
          timedOut: false,
          aborted: false,
        };
      },
    });

    const result = await executor.exec({
      command: 'echo "$PHASE6"',
      cwd,
      env: { PHASE6: 'ok' },
      timeoutMs: 12_345,
      abortSignal: abort.signal,
      emitOutput: (stream: 'stdout' | 'stderr', chunk: string) => events.push({ stream, chunk }),
    });

    expect(transformCalls).toHaveLength(1);
    expect(transformCalls[0]?.command.program).toBe('/bin/sh');
    expect(transformCalls[0]?.command.args).toEqual(['-c', 'echo "$PHASE6"']);
    expect(transformCalls[0]?.command.cwd).toBe(cwd);
    expect(transformCalls[0]?.command.env).toEqual({ PHASE6: 'ok' });
    expect(transformCalls[0]?.command.pathContext).toMatchObject({
      workspaceRoots: [cwd],
      slashTmp: '/tmp',
      minimalRoots: ['/usr', '/bin'],
    });
    expect(transformCalls[0]?.preference).toBe('auto');
    expect(transformCalls[0]?.platform).toBe('darwin');
    expect(runCalls).toHaveLength(1);
    expect(runCalls[0]?.argv).toEqual([
      '/usr/bin/sandbox-exec',
      '-p',
      'policy',
      '--',
      '/bin/sh',
      '-c',
      'echo "$PHASE6"',
    ]);
    expect(runCalls[0]?.options).toMatchObject({
      cwd,
      env: { PHASE6: 'ok' },
      timeoutMs: 12_345,
      abortSignal: abort.signal,
    });
    expect(events).toEqual([{ stream: 'stdout', chunk: 'live-out' }]);
    expect(result).toMatchObject({
      exitCode: 0,
      stdout: 'sandbox-out',
      stderr: 'sandbox-err',
      timedOut: false,
      aborted: false,
    });
  });

  test('fails closed when sandbox context is missing', async () => {
    const executor = new SandboxedCommandWorkspaceExecutor({
      inner: fakeExecutor(),
      getSandboxContext: () => undefined,
    });

    const err = await captureError(() => executor.exec({
      command: 'echo no-context',
      cwd: '/workspace',
      timeoutMs: 1_000,
    }));

    expect(err instanceof WorkspaceCommandSandboxError).toBe(true);
    expect((err as WorkspaceCommandSandboxError).code).toBe('SANDBOX_COMMAND_BLOCKED');
    expect((err as WorkspaceCommandSandboxError).reason).toBe('missing_context');
  });

  test('fails closed when workspaceRoots are missing or empty', async () => {
    const missing = await captureError(() => executorWithContext({
      profile: createWorkspaceWritePermissionProfile(),
      sandboxManager: passthroughSandboxManager(),
    } as WorkspaceCommandSandboxContext).exec({
      command: 'echo missing-roots',
      cwd: '/workspace',
      timeoutMs: 1_000,
    }));
    const empty = await captureError(() => executorWithContext({
      profile: createWorkspaceWritePermissionProfile(),
      workspaceRoots: [],
      sandboxManager: passthroughSandboxManager(),
    }).exec({
      command: 'echo empty-roots',
      cwd: '/workspace',
      timeoutMs: 1_000,
    }));

    expect((missing as WorkspaceCommandSandboxError).reason).toBe('missing_workspace_roots');
    expect((empty as WorkspaceCommandSandboxError).reason).toBe('missing_workspace_roots');
  });

  test('throws structured error when sandbox transform fails', async () => {
    const executor = executorWithContext({
      profile: createWorkspaceWritePermissionProfile(),
      workspaceRoots: ['/workspace'],
      sandboxManager: {
        transform(): SandboxTransformResult {
          return {
            ok: false,
            reason: 'backend_not_available',
            sandboxType: 'macos-seatbelt',
            requiresSandbox: true,
            platform: 'darwin',
            preference: 'auto',
            message: 'macOS Seatbelt backend is not registered.',
          };
        },
      },
      platform: 'darwin',
    });

    const err = await captureError(() => executor.exec({
      command: 'echo blocked',
      cwd: '/workspace',
      timeoutMs: 1_000,
    }));

    expect(err instanceof WorkspaceCommandSandboxError).toBe(true);
    expect((err as WorkspaceCommandSandboxError).code).toBe('SANDBOX_COMMAND_BLOCKED');
    expect((err as WorkspaceCommandSandboxError).reason).toBe('backend_not_available');
    expect((err as WorkspaceCommandSandboxError).sandboxType).toBe('macos-seatbelt');
    expect((err as WorkspaceCommandSandboxError).requiresSandbox).toBe(true);
    expect(err.message).toContain('macOS Seatbelt backend is not registered.');
  });

  test('delegates non-command workspace operations to the inner executor', async () => {
    const calls: string[] = [];
    const executor = new SandboxedCommandWorkspaceExecutor({
      inner: fakeExecutor({
        readFile: async () => {
          calls.push('readFile');
          return { content: 'read' };
        },
        writeFile: async () => {
          calls.push('writeFile');
          return { ok: true, path: '/workspace/out.txt', bytes: 3 };
        },
        resolveExistingPath: async () => {
          calls.push('resolveExistingPath');
          return { path: '/workspace/existing.txt' };
        },
        resolveWritablePath: async () => {
          calls.push('resolveWritablePath');
          return { path: '/workspace/new.txt' };
        },
        writeLockKey: async () => {
          calls.push('writeLockKey');
          return { key: 'lock' };
        },
        globFiles: async () => {
          calls.push('globFiles');
          return { files: ['a.ts'] };
        },
        grepFiles: async () => {
          calls.push('grepFiles');
          return { matches: ['a.ts:1:x'] };
        },
      }),
      getSandboxContext: () => {
        throw new Error('non-command methods must not request sandbox context');
      },
    });

    expect(await executor.readFile({ cwd: '/workspace', path: '/workspace/a.txt' })).toEqual({ content: 'read' });
    expect(await executor.writeFile({ cwd: '/workspace', path: '/workspace/out.txt', content: 'out' })).toMatchObject({ ok: true });
    expect(await executor.resolveExistingPath({ cwd: '/workspace', path: 'existing.txt', label: 'Read' })).toEqual({ path: '/workspace/existing.txt' });
    expect(await executor.resolveWritablePath({ cwd: '/workspace', path: 'new.txt', label: 'Write' })).toEqual({ path: '/workspace/new.txt' });
    expect(await executor.writeLockKey({ cwd: '/workspace', path: 'out.txt' })).toEqual({ key: 'lock' });
    expect(await executor.globFiles({ cwd: '/workspace', pattern: '*.ts', limit: 200 })).toEqual({ files: ['a.ts'] });
    expect(await executor.grepFiles({
      cwd: '/workspace',
      pattern: 'x',
      path: '/workspace',
      maxCountPerFile: 50,
      limit: 200,
      timeoutMs: 1_000,
    })).toEqual({ matches: ['a.ts:1:x'] });
    expect(calls).toEqual([
      'readFile',
      'writeFile',
      'resolveExistingPath',
      'resolveWritablePath',
      'writeLockKey',
      'globFiles',
      'grepFiles',
    ]);
  });
});

describe('ProfileEnforcedWorkspaceExecutor file operations', () => {
  test('fails closed when profile context is missing', async () => {
    const executor = new ProfileEnforcedWorkspaceExecutor({
      inner: fakeExecutor(),
      getProfileContext: () => undefined,
    });

    const err = await captureError(() => executor.readFile({
      cwd: '/workspace',
      path: '/workspace/file.txt',
    }));

    expect(err instanceof WorkspaceProfilePermissionError).toBe(true);
    expect((err as WorkspaceProfilePermissionError).code).toBe('WORKSPACE_PROFILE_PERMISSION_DENIED');
    expect((err as WorkspaceProfilePermissionError).reason).toBe('missing_context');
    expect((err as WorkspaceProfilePermissionError).operation).toBe('read');
  });

  test('fails closed when workspaceRoots are missing or empty', async () => {
    const missing = await captureError(() => profileExecutor({
      profile: createWorkspaceWritePermissionProfile(),
    } as WorkspaceProfileEnforcementContext).readFile({
      cwd: '/workspace',
      path: '/workspace/file.txt',
    }));
    const empty = await captureError(() => profileExecutor({
      profile: createWorkspaceWritePermissionProfile(),
      workspaceRoots: [],
    }).writeFile({
      cwd: '/workspace',
      path: '/workspace/file.txt',
      content: 'x',
    }));

    expect((missing as WorkspaceProfilePermissionError).reason).toBe('missing_workspace_roots');
    expect((missing as WorkspaceProfilePermissionError).operation).toBe('read');
    expect((empty as WorkspaceProfilePermissionError).reason).toBe('missing_workspace_roots');
    expect((empty as WorkspaceProfilePermissionError).operation).toBe('write');
  });

  test('allows read-only reads but denies writes', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'maka-profile-read-only-'));
    const file = join(workspace, 'src.txt');
    const writes: string[] = [];
    const executor = profileExecutor({
      profile: createReadOnlyPermissionProfile(),
      workspaceRoots: [workspace],
    }, fakeExecutor({
      readFile: async () => ({ content: 'visible' }),
      writeFile: async ({ path }) => {
        writes.push(path);
        return { ok: true, path, bytes: 1 };
      },
    }));

    const read = await executor.readFile({ cwd: workspace, path: file });
    const err = await captureError(() => executor.writeFile({
      cwd: workspace,
      path: join(workspace, 'out.txt'),
      content: 'x',
    }));

    expect(read).toEqual({ content: 'visible' });
    expect(err instanceof WorkspaceProfilePermissionError).toBe(true);
    expect((err as WorkspaceProfilePermissionError).reason).toBe('write_denied');
    expect(writes).toEqual([]);
  });

  test('allows workspace-write ordinary writes and denies protected metadata writes', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'maka-profile-workspace-write-'));
    const written: string[] = [];
    const executor = profileExecutor({
      profile: createWorkspaceWritePermissionProfile(),
      workspaceRoots: [workspace],
    }, fakeExecutor({
      writeFile: async ({ path, content }) => {
        written.push(path);
        return { ok: true, path, bytes: Buffer.byteLength(content, 'utf8') };
      },
    }));

    const result = await executor.writeFile({
      cwd: workspace,
      path: join(workspace, 'out.txt'),
      content: 'ok',
    });
    const err = await captureError(() => executor.writeFile({
      cwd: workspace,
      path: join(workspace, '.git', 'config'),
      content: 'blocked',
    }));

    expect(result).toMatchObject({ ok: true, path: join(workspace, 'out.txt'), bytes: 2 });
    expect((err as WorkspaceProfilePermissionError).reason).toBe('write_denied');
    expect((err as WorkspaceProfilePermissionError).path).toBe(join(workspace, '.git', 'config'));
    expect(written).toEqual([join(workspace, 'out.txt')]);
  });

  test('denies reads and writes outside workspace roots', async () => {
    const workspace = '/workspace';
    const outside = '/outside';
    const executor = profileExecutor({
      profile: createWorkspaceWritePermissionProfile(),
      workspaceRoots: [workspace],
    }, fakeExecutor({
      readFile: async () => ({ content: 'outside' }),
      writeFile: async ({ path }) => ({ ok: true, path, bytes: 1 }),
    }));

    const readErr = await captureError(() => executor.readFile({
      cwd: workspace,
      path: join(outside, 'secret.txt'),
    }));
    const writeErr = await captureError(() => executor.writeFile({
      cwd: workspace,
      path: join(outside, 'secret.txt'),
      content: 'x',
    }));

    expect((readErr as WorkspaceProfilePermissionError).reason).toBe('read_denied');
    expect((readErr as WorkspaceProfilePermissionError).operation).toBe('read');
    expect((writeErr as WorkspaceProfilePermissionError).reason).toBe('write_denied');
    expect((writeErr as WorkspaceProfilePermissionError).operation).toBe('write');
  });

  test('checks resolved paths after inner realpath containment', async () => {
    const workspace = '/workspace';
    const outside = '/outside';
    const calls: string[] = [];
    const executor = profileExecutor({
      profile: createWorkspaceWritePermissionProfile(),
      workspaceRoots: [workspace],
    }, fakeExecutor({
      resolveExistingPath: async () => {
        calls.push('resolveExistingPath');
        return { path: join(outside, 'read.txt') };
      },
      resolveWritablePath: async () => {
        calls.push('resolveWritablePath');
        return { path: join(outside, 'write.txt') };
      },
    }));

    const readErr = await captureError(() => executor.resolveExistingPath({
      cwd: workspace,
      path: 'read-link',
      label: 'Read',
    }));
    const writeErr = await captureError(() => executor.resolveWritablePath({
      cwd: workspace,
      path: 'write-link',
      label: 'Write',
    }));

    expect(calls).toEqual(['resolveExistingPath', 'resolveWritablePath']);
    expect((readErr as WorkspaceProfilePermissionError).reason).toBe('read_denied');
    expect((readErr as WorkspaceProfilePermissionError).path).toBe(join(outside, 'read.txt'));
    expect((writeErr as WorkspaceProfilePermissionError).reason).toBe('write_denied');
    expect((writeErr as WorkspaceProfilePermissionError).path).toBe(join(outside, 'write.txt'));
  });

  test('checks Glob and Grep search roots for read access', async () => {
    const workspace = '/workspace';
    const outside = '/outside';
    const calls: string[] = [];
    const executor = profileExecutor({
      profile: createWorkspaceWritePermissionProfile(),
      workspaceRoots: [workspace],
    }, fakeExecutor({
      globFiles: async () => {
        calls.push('globFiles');
        return { files: ['src/a.ts'] };
      },
      grepFiles: async () => {
        calls.push('grepFiles');
        return { matches: ['src/a.ts:1:x'] };
      },
    }));

    expect(await executor.globFiles({ cwd: workspace, pattern: '**/*.ts', limit: 200 })).toEqual({ files: ['src/a.ts'] });
    expect(await executor.grepFiles({
      cwd: workspace,
      pattern: 'x',
      path: workspace,
      maxCountPerFile: 50,
      limit: 200,
      timeoutMs: 1_000,
    })).toEqual({ matches: ['src/a.ts:1:x'] });
    const globErr = await captureError(() => executor.globFiles({
      cwd: outside,
      pattern: '**/*.ts',
      limit: 200,
    }));
    const grepErr = await captureError(() => executor.grepFiles({
      cwd: workspace,
      pattern: 'x',
      path: outside,
      maxCountPerFile: 50,
      limit: 200,
      timeoutMs: 1_000,
    }));

    expect(calls).toEqual(['globFiles', 'grepFiles']);
    expect((globErr as WorkspaceProfilePermissionError).operation).toBe('search');
    expect((globErr as WorkspaceProfilePermissionError).reason).toBe('read_denied');
    expect((grepErr as WorkspaceProfilePermissionError).operation).toBe('search');
    expect((grepErr as WorkspaceProfilePermissionError).reason).toBe('read_denied');
  });

  test('delegates exec and writeLockKey without requesting profile context', async () => {
    const calls: string[] = [];
    const executor = new ProfileEnforcedWorkspaceExecutor({
      inner: fakeExecutor({
        exec: async () => {
          calls.push('exec');
          return {
            exitCode: 0,
            stdout: 'ok',
            stderr: '',
            timedOut: false,
            aborted: false,
          };
        },
        writeLockKey: async () => {
          calls.push('writeLockKey');
          return { key: 'lock-key' };
        },
      }),
      getProfileContext: () => {
        throw new Error('exec and writeLockKey must not request profile context');
      },
    });

    expect(await executor.exec({ command: 'echo ok', cwd: '/workspace', timeoutMs: 1_000 })).toMatchObject({
      exitCode: 0,
      stdout: 'ok',
    });
    expect(await executor.writeLockKey({ cwd: '/workspace', path: 'file.txt' })).toEqual({ key: 'lock-key' });
    expect(calls).toEqual(['exec', 'writeLockKey']);
  });
});

function executorWithContext(context: WorkspaceCommandSandboxContext): SandboxedCommandWorkspaceExecutor {
  return new SandboxedCommandWorkspaceExecutor({
    inner: fakeExecutor(),
    getSandboxContext: () => context,
    runProcess: async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
      aborted: false,
    }),
  });
}

function profileExecutor(
  context: WorkspaceProfileEnforcementContext,
  inner: WorkspaceExecutor = fakeExecutor(),
): ProfileEnforcedWorkspaceExecutor {
  return new ProfileEnforcedWorkspaceExecutor({
    inner,
    getProfileContext: () => context,
  });
}

function passthroughSandboxManager() {
  return {
    transform(request: SandboxTransformRequest): SandboxTransformResult {
      return {
        ok: true,
        exec: {
          argv: [request.command.program, ...request.command.args],
          cwd: request.command.cwd,
          env: request.command.env,
          sandboxType: 'none',
          effectiveProfile: request.command.profile,
        },
        sandboxType: 'none',
        requiresSandbox: false,
        preference: 'auto',
      };
    },
  };
}

function fakeExecutor(overrides: Partial<WorkspaceExecutor> = {}): WorkspaceExecutor {
  const base: WorkspaceExecutor = {
    facts: LOCAL_WORKSPACE_EXECUTOR_FACTS,
    exec: async (_input: WorkspaceExecInput) => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
      aborted: false,
    }),
    readFile: async () => ({ content: '' }),
    writeFile: async ({ path, content }) => ({ ok: true, path, bytes: Buffer.byteLength(content, 'utf8') }),
    resolveExistingPath: async ({ path }) => ({ path }),
    resolveWritablePath: async ({ path }) => ({ path }),
    writeLockKey: async ({ cwd, path }) => ({ key: `${cwd}:${path}` }),
    globFiles: async () => ({ files: [] }),
    grepFiles: async () => ({ matches: [] }),
    read: async () => ({ content: '' }),
    write: async ({ path, content }) => ({ ok: true, path, bytes: Buffer.byteLength(content, 'utf8') }),
    edit: async ({ path }) => ({
      ok: true,
      path,
      replacements: 1,
      matchedVia: 'exact',
      startLine: 1,
      endLine: 1,
    }),
    glob: async () => ({ files: [] }),
    grep: async () => ({ matches: [] }),
  };
  return Object.assign(base, overrides);
}

async function captureError(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(String(error));
  }
  throw new Error('expected function to reject');
}
