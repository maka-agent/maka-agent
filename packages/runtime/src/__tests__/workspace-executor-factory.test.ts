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
  WorkspaceProfilePermissionError,
  type WorkspaceExecutor,
} from '../workspace-executor.js';
import type { BoundedProcessOptions, BoundedProcessResult } from '../shell-exec.js';
import type { MakaTool, MakaToolContext } from '../tool-runtime.js';
import type { SandboxTransformRequest, SandboxTransformResult } from '../sandbox/index.js';
import type { ShellRunToolController } from '../shell-tools.js';

describe('createPermissionAwareWorkspaceExecutor', () => {
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
    });

    const result = await built.executor.exec({
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
      '-lc',
      'echo ok',
    ]);
  });

  test('enforces read-only profile for file writes', async () => {
    const cwd = await normalizedTempDir('maka-permission-aware-executor-');
    const { executor, compiledProfile } = createPermissionAwareWorkspaceExecutor({
      mode: 'explore',
      cwd,
      sandboxManager: new RecordingSandboxManager(),
      platform: 'darwin',
      runProcess: new RecordingProcessRunner().run,
    });

    expect(compiledProfile.profileName).toBe('read-only');
    await expectRejectsWith(
      executor.writeFile({ cwd, path: join(cwd, 'notes.txt'), content: 'nope' }),
      WorkspaceProfilePermissionError,
      'write_denied',
    );
  });

  test('enforces workspace-write protected metadata for file writes', async () => {
    const cwd = await normalizedTempDir('maka-permission-aware-executor-');
    await mkdir(join(cwd, '.git'), { recursive: true });
    const { executor } = createPermissionAwareWorkspaceExecutor({
      mode: 'execute',
      cwd,
      sandboxManager: new RecordingSandboxManager(),
      platform: 'darwin',
      runProcess: new RecordingProcessRunner().run,
    });

    await executor.writeFile({ cwd, path: join(cwd, 'notes.txt'), content: 'ok' });
    expect((await readFile(join(cwd, 'notes.txt'), 'utf8'))).toBe('ok');
    await expectRejectsWith(
      executor.writeFile({ cwd, path: join(cwd, '.git', 'config'), content: 'nope' }),
      WorkspaceProfilePermissionError,
      'write_denied',
    );
  });

  test('compiles bypass to danger-full-access without requiring a sandbox backend', async () => {
    const cwd = await normalizedTempDir('maka-permission-aware-executor-');
    await mkdir(join(cwd, '.git'), { recursive: true });
    const runner = new RecordingProcessRunner();
    const { executor, compiledProfile } = createPermissionAwareWorkspaceExecutor({
      mode: 'bypass',
      cwd,
      platform: 'linux',
      runProcess: runner.run,
    });

    await executor.writeFile({ cwd, path: join(cwd, '.git', 'config'), content: 'allowed' });
    const result = await executor.exec({ command: 'echo unsafe', cwd, timeoutMs: 1_000 });

    expect(compiledProfile.profileName).toBe('danger-full-access');
    expect(await readFile(join(cwd, '.git', 'config'), 'utf8')).toBe('allowed');
    expect(result.exitCode).toBe(0);
    expect(runner.calls[0]?.argv).toEqual(['/bin/sh', '-lc', 'echo unsafe']);
  });
});

describe('buildPermissionAwareBuiltinTools', () => {
  test('uses the permission-aware executor for foreground Bash and file tools', async () => {
    const cwd = await normalizedTempDir('maka-permission-aware-tools-');
    const runner = new RecordingProcessRunner();
    const built = buildPermissionAwareBuiltinTools({
      mode: 'ask',
      cwd,
      sandboxManager: new RecordingSandboxManager(),
      platform: 'darwin',
      runProcess: runner.run,
    });
    const bash = requireTool(built.tools, 'Bash');
    const write = requireTool(built.tools, 'Write');

    await bash.impl({ command: 'echo ok' }, toolContext(cwd));
    await write.impl({ path: 'notes.txt', content: 'ok' }, toolContext(cwd));

    expect(runner.calls[0]?.argv).toEqual([
      '/usr/bin/sandbox-exec',
      '--',
      '/bin/sh',
      '-lc',
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
