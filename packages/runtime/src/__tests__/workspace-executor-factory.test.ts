import { describe, test } from 'node:test';
import { mkdir, mkdtemp, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect } from '../test-helpers.js';
import {
  createPermissionAwareWorkspaceExecutor,
  buildPermissionAwareBuiltinTools,
} from '../workspace-executor-factory.js';
import {
  createLocalWorkspaceExecutor,
  WorkspaceProfilePermissionError,
  type WorkspaceExecutor,
} from '../workspace-executor.js';
import type { BoundedProcessOptions, BoundedProcessResult } from '../shell-exec.js';
import type { MakaTool, MakaToolContext } from '../tool-runtime.js';
import type { SandboxTransformRequest, SandboxTransformResult } from '../sandbox/index.js';
import type { ShellRunToolController } from '../shell-tools.js';
import { FilesystemWorkerClient } from '../filesystem-worker/client.js';

describe('createPermissionAwareWorkspaceExecutor', () => {
  test('fails closed when no filesystem worker or explicit file operations are provided', async () => {
    const cwd = await normalizedTempDir('maka-permission-aware-executor-');
    let failure: unknown;
    try {
      createPermissionAwareWorkspaceExecutor({
        mode: 'ask',
        cwd,
        sandboxManager: new RecordingSandboxManager(),
      });
    } catch (error) {
      failure = error;
    }
    expect(failure instanceof Error ? failure.message : failure)
      .toMatch(/require sandboxed filesystemWorkerClient or explicit fileOperations/);
  });

  test('compiles ask mode to workspace-write and routes foreground Bash through sandbox transform', async () => {
    const cwd = await normalizedTempDir('maka-permission-aware-executor-');
    const sandboxManager = new RecordingSandboxManager();
    const runner = new RecordingProcessRunner();
    const built = createPermissionAwareWorkspaceExecutor({
      mode: 'ask',
      cwd,
      sandboxManager,
      platform: 'darwin',
      runProcess: runner.run,
      fileOperations: createLocalWorkspaceExecutor(),
    });

    const result = await built.commandExecutor.exec({
      command: 'echo ok',
      cwd,
      timeoutMs: 1_000,
    });

    expect(built.compiledProfile.profileName).toBe('workspace-write');
    expect(built.compiledProfile.workspaceRoots).toEqual([cwd]);
    expect(result.exitCode).toBe(0);
    expect(sandboxManager.calls).toHaveLength(1);
    expect(sandboxManager.calls[0]?.command.profile.type).toBe('managed');
    expect(sandboxManager.calls[0]?.command.profile.name).toBe('workspace-write');
    expect(sandboxManager.calls[0]?.command.pathContext.workspaceRoots).toEqual([cwd]);
    expect(sandboxManager.calls[0]?.platform).toBe('darwin');
    expect(runner.calls[0]?.argv).toEqual([
      '/usr/bin/sandbox-exec',
      '--',
      '/bin/sh',
      '-c',
      'echo ok',
    ]);
  });

  test('enforces read-only profile for file writes', async () => {
    const cwd = await normalizedTempDir('maka-permission-aware-executor-');
    const { fileOperations, compiledProfile } = createPermissionAwareWorkspaceExecutor({
      mode: 'explore',
      cwd,
      sandboxManager: new RecordingSandboxManager(),
      platform: 'darwin',
      runProcess: new RecordingProcessRunner().run,
      fileOperations: createLocalWorkspaceExecutor(),
    });

    expect(compiledProfile.profileName).toBe('read-only');
    await expectRejectsWith(
      fileOperations.write({ cwd, path: 'notes.txt', content: 'nope' }),
      WorkspaceProfilePermissionError,
      'write_denied',
    );
  });

  test('enforces workspace-write protected metadata for file writes', async () => {
    const cwd = await normalizedTempDir('maka-permission-aware-executor-');
    await mkdir(join(cwd, '.git'), { recursive: true });
    const { fileOperations } = createPermissionAwareWorkspaceExecutor({
      mode: 'execute',
      cwd,
      sandboxManager: new RecordingSandboxManager(),
      platform: 'darwin',
      runProcess: new RecordingProcessRunner().run,
      fileOperations: createLocalWorkspaceExecutor(),
    });

    await fileOperations.write({ cwd, path: 'notes.txt', content: 'ok' });
    expect((await readFile(join(cwd, 'notes.txt'), 'utf8'))).toBe('ok');
    await expectRejectsWith(
      fileOperations.write({ cwd, path: '.git/config', content: 'nope' }),
      WorkspaceProfilePermissionError,
      'write_denied',
    );
  });

  test('compiles bypass to danger-full-access without requiring a sandbox backend', async () => {
    const cwd = await normalizedTempDir('maka-permission-aware-executor-');
    await mkdir(join(cwd, '.git'), { recursive: true });
    const runner = new RecordingProcessRunner();
    const { commandExecutor, fileOperations, compiledProfile } = createPermissionAwareWorkspaceExecutor({
      mode: 'bypass',
      cwd,
      platform: 'linux',
      runProcess: runner.run,
      fileOperations: createLocalWorkspaceExecutor(),
    });

    await fileOperations.write({ cwd, path: '.git/config', content: 'allowed' });
    const result = await commandExecutor.exec({ command: 'echo unsafe', cwd, timeoutMs: 1_000 });

    expect(compiledProfile.profileName).toBe('danger-full-access');
    expect(await readFile(join(cwd, '.git', 'config'), 'utf8')).toBe('allowed');
    expect(result.exitCode).toBe(0);
    expect(runner.calls[0]?.argv).toEqual(['/bin/sh', '-c', 'echo unsafe']);
  });
});

describe('buildPermissionAwareBuiltinTools', () => {
  test('routes default file tools through one worker request', async () => {
    const cwd = await normalizedTempDir('maka-permission-aware-worker-tools-');
    const operations: Array<{ kind: string; path: string }> = [];
    const filesystemWorkerClient = new FilesystemWorkerClient({
      getLaunchSpec: async () => ({
        ok: true,
        spec: {
          program: '/runtime/node',
          args: ['/runtime/filesystem-worker.js'],
          env: { TMPDIR: '/tmp' },
          runtimeReadableRoots: ['/runtime/filesystem-worker.js'],
          executableRoots: ['/runtime/node'],
        },
      }),
      newId: () => 'worker-request-1',
      runProcess: async (input) => {
        const request = JSON.parse(input.stdin) as {
          requestId: string;
          operation: { kind: string; path: string; content?: string };
        };
        operations.push(request.operation);
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            version: 1,
            requestId: request.requestId,
            ok: true,
            result: {
              kind: 'write',
              ok: true,
              path: join(cwd, request.operation.path),
              bytes: Buffer.byteLength(request.operation.content ?? '', 'utf8'),
            },
          }),
          stderrTail: '',
          timedOut: false,
          aborted: false,
          responseOverflow: false,
        };
      },
    });
    const built = buildPermissionAwareBuiltinTools({
      mode: 'execute',
      cwd,
      sandboxManager: new RecordingSandboxManager(),
      platform: 'darwin',
      runProcess: new RecordingProcessRunner().run,
      filesystemWorkerClient,
    });

    const write = requireTool(built.tools, 'Write');
    const result = await write.impl({ path: 'notes.txt', content: 'ok' }, toolContext(cwd));

    expect(operations).toEqual([{ kind: 'write', path: 'notes.txt', content: 'ok', cwd }]);
    expect(result).toMatchObject({ ok: true, path: join(cwd, 'notes.txt'), bytes: 2 });
    expect(write.executionFacts?.isolation).toBe('platform_sandbox');
  });

  test('uses the permission-aware executor for foreground Bash and file tools', async () => {
    const cwd = await normalizedTempDir('maka-permission-aware-tools-');
    const runner = new RecordingProcessRunner();
    const built = buildPermissionAwareBuiltinTools({
      mode: 'ask',
      cwd,
      sandboxManager: new RecordingSandboxManager(),
      platform: 'darwin',
      runProcess: runner.run,
      fileOperations: createLocalWorkspaceExecutor(),
    });
    const bash = requireTool(built.tools, 'Bash');
    const write = requireTool(built.tools, 'Write');

    await bash.impl({ command: 'echo ok' }, toolContext(cwd));
    await write.impl({ path: 'notes.txt', content: 'ok' }, toolContext(cwd));

    expect(runner.calls[0]?.argv).toEqual([
      '/usr/bin/sandbox-exec',
      '--',
      '/bin/sh',
      '-c',
      'echo ok',
    ]);
    expect(await readFile(join(cwd, 'notes.txt'), 'utf8')).toBe('ok');
  });

  test('preserves background Bash when shellRuns are provided while file tools use the permission-aware executor', async () => {
    const cwd = await normalizedTempDir('maka-permission-aware-tools-');
    const shellRuns = new RecordingShellRuns();
    const runner = new RecordingProcessRunner();
    const built = buildPermissionAwareBuiltinTools({
      mode: 'ask',
      cwd,
      shellRuns,
      sandboxManager: new RecordingSandboxManager(),
      platform: 'darwin',
      runProcess: runner.run,
      fileOperations: createLocalWorkspaceExecutor(),
    });
    const bash = requireTool(built.tools, 'Bash');
    const write = requireTool(built.tools, 'Write');

    await bash.impl({ command: 'echo background' }, toolContext(cwd));
    await write.impl({ path: 'notes.txt', content: 'ok' }, toolContext(cwd));

    expect(shellRuns.commands).toEqual(['echo background']);
    expect(runner.calls).toHaveLength(0);
    expect(await readFile(join(cwd, 'notes.txt'), 'utf8')).toBe('ok');
  });
});

class RecordingSandboxManager {
  readonly calls: SandboxTransformRequest[] = [];

  transform(request: SandboxTransformRequest): SandboxTransformResult {
    this.calls.push(request);
    const { command } = request;
    return {
      ok: true,
      exec: {
        argv: ['/usr/bin/sandbox-exec', '--', command.program, ...command.args],
        cwd: command.cwd,
        env: command.env,
        sandboxType: 'macos-seatbelt',
        effectiveProfile: command.profile,
      },
      sandboxType: 'macos-seatbelt',
      requiresSandbox: true,
      preference: request.preference ?? 'auto',
    };
  }
}

class RecordingProcessRunner {
  readonly calls: Array<{ argv: readonly string[]; options: BoundedProcessOptions }> = [];

  readonly run = async (
    argv: readonly string[],
    options: BoundedProcessOptions,
  ): Promise<BoundedProcessResult> => {
    this.calls.push({ argv, options });
    return {
      stdout: 'ok',
      stderr: '',
      exitCode: 0,
      timedOut: false,
      aborted: false,
      stdoutTruncated: false,
      stderrTruncated: false,
    };
  };
}

class RecordingShellRuns implements ShellRunToolController {
  readonly commands: string[] = [];

  async runBash(input: { command: string }) {
    this.commands.push(input.command);
    return {
      kind: 'terminal' as const,
      cwd: '',
      cmd: input.command,
      status: 'completed' as const,
      exitCode: 0,
      stdout: '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
    };
  }

  async readResource() {
    return { content: '' };
  }

  async stopResource() {
    return {
      kind: 'shell_run' as const,
      ref: 'maka://runtime/background-tasks/test',
      status: 'cancelled' as const,
      cwd: '',
      cmd: '',
      startedAt: 1,
      updatedAt: 2,
      stdout: '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
    };
  }
}

function requireTool(tools: readonly MakaTool[], name: string) {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool;
}

function toolContext(cwd: string): MakaToolContext {
  return {
    sessionId: 'session-1',
    turnId: 'turn-1',
    cwd,
    toolCallId: 'tool-1',
    abortSignal: new AbortController().signal,
    emitOutput: () => {},
  };
}

async function expectRejectsWith<T extends new (...args: never[]) => Error>(
  promise: Promise<unknown>,
  errorClass: T,
  reason: string,
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error instanceof errorClass).toBe(true);
    expect((error as { reason?: string }).reason).toBe(reason);
    return;
  }
  throw new Error('expected promise to reject');
}

async function normalizedTempDir(prefix: string): Promise<string> {
  return await realpath(await mkdtemp(join(tmpdir(), prefix)));
}
