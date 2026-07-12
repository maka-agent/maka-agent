import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { createWorkspaceWritePermissionProfile } from '@maka/core/permission-profile';

import {
  FILESYSTEM_WORKER_MAX_REQUEST_BYTES,
  FilesystemWorkerClient,
  FilesystemWorkerClientError,
} from '../filesystem-worker/client.js';
import {
  buildFilesystemWorkerEnv,
  createFilesystemWorkerLaunchSpecProvider,
  type FilesystemWorkerLaunchSpec,
} from '../filesystem-worker/launch-spec.js';
import {
  runFilesystemWorkerProcess,
  type FilesystemWorkerProcessRunInput,
  type FilesystemWorkerProcessRunResult,
} from '../filesystem-worker/process-runner.js';
import type { PermissionAwareSandboxContext } from '../sandbox/permission-aware-context.js';
import { createPermissionAwareSandboxContext } from '../sandbox/permission-aware-context.js';
import { createDefaultSandboxManager } from '../sandbox/default-sandbox-manager.js';
import { probeActiveSandboxCapabilities } from '../sandbox/active-capabilities.js';
import type { SandboxTransformRequest, SandboxTransformResult } from '../sandbox/types.js';
import { buildPermissionAwareBuiltinTools } from '../workspace-executor-factory.js';

describe('FilesystemWorkerClient', () => {
  test('narrows read operations, transforms the trusted worker argv, and validates the response', async () => {
    const transformCalls: SandboxTransformRequest[] = [];
    const processCalls: FilesystemWorkerProcessRunInput[] = [];
    const context = sandboxContext(transformCalls);
    const client = new FilesystemWorkerClient({
      getLaunchSpec: async () => ({ ok: true, spec: launchSpec() }),
      newId: () => 'request-1',
      runProcess: async (input) => {
        processCalls.push(input);
        const request = JSON.parse(input.stdin) as { requestId: string; operation: { kind: string; cwd: string } };
        return processResult(JSON.stringify({
          version: 1,
          requestId: request.requestId,
          ok: true,
          result: { kind: 'read', content: 'worker-result' },
        }));
      },
    });

    const result = await client.execute({
      context,
      operation: { kind: 'read', path: 'file.txt' },
    });

    assert.deepEqual(result, { kind: 'read', content: 'worker-result' });
    assert.equal(transformCalls.length, 1);
    const profile = transformCalls[0]?.command.profile;
    assert.equal(profile?.name, 'read-only');
    assert.equal(profile?.type, 'managed');
    if (profile?.type === 'managed') assert.equal(profile.network.kind, 'restricted');
    assert.deepEqual(transformCalls[0]?.command.pathContext.runtimeReadableRoots, [
      '/runtime/filesystem-worker.js',
    ]);
    assert.deepEqual(transformCalls[0]?.command.pathContext.executableRoots, ['/runtime/node']);
    assert.deepEqual(processCalls[0]?.argv, ['/runtime/node', '/runtime/filesystem-worker.js']);
    const request = JSON.parse(processCalls[0]!.stdin) as { operation: { cwd: string } };
    assert.equal(request.operation.cwd, '/workspace');
  });

  test('keeps workspace-write semantics for write operations', async () => {
    const transformCalls: SandboxTransformRequest[] = [];
    const client = new FilesystemWorkerClient({
      getLaunchSpec: async () => ({ ok: true, spec: launchSpec() }),
      newId: () => 'request-1',
      runProcess: async () => processResult(JSON.stringify({
        version: 1,
        requestId: 'request-1',
        ok: true,
        result: { kind: 'write', ok: true, path: '/workspace/file.txt', bytes: 2 },
      })),
    });

    await client.execute({
      context: sandboxContext(transformCalls),
      operation: { kind: 'write', path: 'file.txt', content: 'ok' },
    });

    assert.equal(transformCalls[0]?.command.profile.name, 'workspace-write');
  });

  test('fails closed before process launch when launch resolution or sandbox transform fails', async () => {
    let processCalls = 0;
    const missingBundle = new FilesystemWorkerClient({
      getLaunchSpec: async () => ({
        ok: false,
        reason: 'worker_bundle_unavailable',
        message: 'missing',
      }),
      newId: () => 'request-1',
      runProcess: async () => {
        processCalls += 1;
        return processResult('');
      },
    });
    await assert.rejects(
      missingBundle.execute({ context: sandboxContext(), operation: { kind: 'read', path: 'file.txt' } }),
      matchesClientError('launch', 'worker_bundle_unavailable'),
    );

    const context = sandboxContext();
    context.sandboxManager = {
      transform: () => ({
        ok: false,
        reason: 'backend_not_available',
        sandboxType: 'macos-seatbelt',
        requiresSandbox: true,
        platform: 'darwin',
        preference: 'auto',
      }),
    };
    const transformFailure = new FilesystemWorkerClient({
      getLaunchSpec: async () => ({ ok: true, spec: launchSpec() }),
      newId: () => 'request-1',
      runProcess: async () => {
        processCalls += 1;
        return processResult('');
      },
    });
    await assert.rejects(
      transformFailure.execute({ context, operation: { kind: 'read', path: 'file.txt' } }),
      matchesClientError('transform', 'backend_not_available'),
    );
    assert.equal(processCalls, 0);
  });

  test('revalidates launch after an available snapshot and never falls back to the host', async () => {
    let launchCalls = 0;
    let processCalls = 0;
    const getLaunchSpec = async () => {
      launchCalls += 1;
      return launchCalls === 1
        ? { ok: true as const, spec: launchSpec() }
        : {
            ok: false as const,
            reason: 'worker_bundle_unavailable' as const,
            message: 'worker removed after snapshot',
          };
    };
    const context = sandboxContext();
    const capabilities = await probeActiveSandboxCapabilities({
      context,
      getFilesystemWorkerLaunchSpec: getLaunchSpec,
      isExecutable: async () => true,
    });
    assert.equal(capabilities.filesystem.status, 'not_required');

    const client = new FilesystemWorkerClient({
      getLaunchSpec,
      newId: () => 'request-1',
      runProcess: async () => {
        processCalls += 1;
        return processResult('');
      },
    });
    await assert.rejects(
      client.execute({ context, operation: { kind: 'read', path: 'file.txt' } }),
      matchesClientError('launch', 'worker_bundle_unavailable'),
    );
    assert.equal(processCalls, 0);
  });

  test('fails before launch when a request exceeds 16 MiB', async () => {
    let launches = 0;
    const client = new FilesystemWorkerClient({
      getLaunchSpec: async () => {
        launches += 1;
        return { ok: true, spec: launchSpec() };
      },
      newId: () => 'request-1',
    });

    await assert.rejects(client.execute({
      context: sandboxContext(),
      operation: {
        kind: 'write',
        path: 'file.txt',
        content: 'x'.repeat(FILESYSTEM_WORKER_MAX_REQUEST_BYTES),
      },
    }), matchesClientError('validation', 'request_overflow'));
    assert.equal(launches, 0);
  });

  for (const [name, result, reason, stage] of [
    ['timeout', { timedOut: true }, 'timeout', 'launch'],
    ['abort', { aborted: true }, 'aborted', 'launch'],
    ['overflow', { responseOverflow: true }, 'response_overflow', 'launch'],
    ['crash', { exitCode: 2 }, 'worker_crashed', 'launch'],
    ['invalid JSON', { stdout: 'not-json' }, 'invalid_response', 'protocol'],
  ] as const) {
    test(`maps ${name} into a structured client error`, async () => {
      const client = clientWithProcessResult(processResult(result.stdout ?? '', result));
      await assert.rejects(
        client.execute({ context: sandboxContext(), operation: { kind: 'read', path: 'file.txt' } }),
        matchesClientError(stage, reason),
      );
    });
  }

  test('rejects response id and operation-kind mismatches', async () => {
    const mismatchedId = clientWithProcessResult(processResult(JSON.stringify({
      version: 1,
      requestId: 'other-request',
      ok: true,
      result: { kind: 'read', content: 'ok' },
    })));
    await assert.rejects(
      mismatchedId.execute({ context: sandboxContext(), operation: { kind: 'read', path: 'file.txt' } }),
      matchesClientError('protocol', 'response_id_mismatch'),
    );

    const mismatchedKind = clientWithProcessResult(processResult(JSON.stringify({
      version: 1,
      requestId: 'request-1',
      ok: true,
      result: { kind: 'glob', files: [] },
    })));
    await assert.rejects(
      mismatchedKind.execute({ context: sandboxContext(), operation: { kind: 'read', path: 'file.txt' } }),
      matchesClientError('protocol', 'response_kind_mismatch'),
    );
  });

  test('preserves safe operation errors and recoverability', async () => {
    const client = clientWithProcessResult(processResult(JSON.stringify({
      version: 1,
      requestId: 'request-1',
      ok: false,
      error: { code: 'not_found', message: 'The requested workspace path was not found.' },
    })));
    await assert.rejects(
      client.execute({ context: sandboxContext(), operation: { kind: 'read', path: 'missing.txt' } }),
      (error: unknown) => error instanceof FilesystemWorkerClientError
        && error.stage === 'operation'
        && error.reason === 'not_found'
        && error.recoverable,
    );
  });
});

describe('filesystem worker launch spec', () => {
  test('keeps only locale and tmp env, with Electron run-as-node when requested', () => {
    const hostEnv = {
      LANG: 'en_US.UTF-8',
      LC_ALL: 'C',
      NODE_OPTIONS: '--require secret.js',
      HTTPS_PROXY: 'http://secret',
      API_KEY: 'secret',
      PATH: '/secret/bin',
      RIPGREP_CONFIG_PATH: '/secret/rg',
    };
    assert.deepEqual(buildFilesystemWorkerEnv('node', hostEnv), {
      TMPDIR: '/tmp',
      OPENSSL_CONF: '/dev/null',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'C',
    });
    assert.deepEqual(buildFilesystemWorkerEnv('electron', hostEnv), {
      TMPDIR: '/tmp',
      OPENSSL_CONF: '/dev/null',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'C',
      ELECTRON_RUN_AS_NODE: '1',
    });
  });

  test('resolves canonical runtime, bundle, and rg paths without passing host secrets', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-fs-worker-launch-'));
    const rg = join(cwd, 'rg');
    await writeFile(rg, '#!/bin/sh\nexit 0\n', 'utf8');
    await chmod(rg, 0o755);
    const provider = createFilesystemWorkerLaunchSpecProvider({
      runtime: 'node',
      resourceLocation: { kind: 'runtime' },
      hostEnv: { API_KEY: 'secret', NODE_OPTIONS: '--inspect' },
      rgCandidates: [rg],
    });

    const result = await provider();

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.spec.program, await realpath(process.execPath));
    assert.equal(result.spec.grepExecutable, await realpath(rg));
    assert.deepEqual(result.spec.env, { TMPDIR: '/tmp', OPENSSL_CONF: '/dev/null' });
    assert.equal('API_KEY' in result.spec.env, false);
    assert.equal('NODE_OPTIONS' in result.spec.env, false);
  });
});

describe('runFilesystemWorkerProcess', () => {
  test('writes one stdin payload and captures one response', async () => {
    const result = await runNodeScript(
      "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>process.stdout.write(s));",
      { stdin: '{"ok":true}' },
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, '{"ok":true}');
  });

  test('bounds stderr and detects response overflow', async () => {
    const stderr = await runNodeScript("process.stderr.write('x'.repeat(200));process.exit(2)", {
      maxStderrBytes: 32,
    });
    assert.equal(stderr.exitCode, 2);
    assert.equal(stderr.stderrTail, 'x'.repeat(32));

    const overflow = await runNodeScript("process.stdout.write('x'.repeat(200));setInterval(()=>{},1000)", {
      maxResponseBytes: 32,
      killGraceMs: 20,
    });
    assert.equal(overflow.responseOverflow, true);
    assert.equal(overflow.stdout, '');
  });

  test('terminates the process group on timeout and abort', async () => {
    const timeout = await runNodeScript('setInterval(()=>{},1000)', {
      timeoutMs: 30,
      killGraceMs: 20,
    });
    assert.equal(timeout.timedOut, true);

    const controller = new AbortController();
    const aborted = runNodeScript('setInterval(()=>{},1000)', {
      timeoutMs: 5_000,
      killGraceMs: 20,
      abortSignal: controller.signal,
    });
    setTimeout(() => controller.abort(), 30);
    assert.equal((await aborted).aborted, true);
  });
});

if (process.platform === 'darwin') {
  describe('macOS sandboxed filesystem worker smoke', () => {
    test('runs all default file tools and independently denies protected metadata writes', async () => {
      const cwd = await realpath(await mkdtemp(join(tmpdir(), 'maka-fs-worker-seatbelt-')));
      await mkdir(join(cwd, '.git'));
      await writeFile(join(cwd, '.git', 'config'), 'protected', 'utf8');
      const sandboxManager = createDefaultSandboxManager();
      const context = createPermissionAwareSandboxContext({
        mode: 'execute',
        cwd,
        workspaceRoots: [cwd],
        sandboxManager,
        platform: 'darwin',
      }).context;
      const getLaunchSpec = createFilesystemWorkerLaunchSpecProvider({
        runtime: 'node',
        resourceLocation: { kind: 'runtime' },
      });
      const client = new FilesystemWorkerClient({
        getLaunchSpec,
      });
      const built = buildPermissionAwareBuiltinTools({
        mode: 'execute',
        cwd,
        workspaceRoots: [cwd],
        sandboxManager,
        platform: 'darwin',
        filesystemWorkerClient: client,
      });
      const toolContext = {
        sessionId: 'session-1',
        turnId: 'turn-1',
        cwd,
        toolCallId: 'tool-1',
        abortSignal: new AbortController().signal,
        emitOutput: () => {},
      };
      const fileTool = (name: string) => {
        const found = built.tools.find((tool) => tool.name === name);
        if (!found) throw new Error(`${name} tool missing`);
        return found;
      };

      await fileTool('Write').impl({ path: 'allowed.txt', content: 'before' }, toolContext);
      const read = await fileTool('Read').impl({ path: 'allowed.txt' }, toolContext) as { content: string };
      assert.equal(read.content, 'before');
      await fileTool('Edit').impl({
        path: 'allowed.txt',
        old_string: 'before',
        new_string: 'allowed',
      }, toolContext);
      assert.equal(await readFile(join(cwd, 'allowed.txt'), 'utf8'), 'allowed');
      const glob = await fileTool('Glob').impl({ pattern: '*.txt' }, toolContext) as { files: string[] };
      assert.equal(glob.files.includes('allowed.txt'), true);

      await assert.rejects(
        client.execute({
          context,
          operation: { kind: 'write', path: '.git/config', content: 'denied' },
        }),
        (error: unknown) => error instanceof FilesystemWorkerClientError
          && error.stage === 'operation'
          && error.reason === 'filesystem_denied',
      );
      assert.equal(await readFile(join(cwd, '.git', 'config'), 'utf8'), 'protected');

      await writeFile(join(cwd, 'search.txt'), 'sandbox-search-token\n', 'utf8');
      const launch = await getLaunchSpec();
      assert.equal(launch.ok, true);
      if (!launch.ok) return;
      if (launch.spec.grepExecutable) {
        const grep = await fileTool('Grep').impl({
          path: '.',
          pattern: 'sandbox-search-token',
        }, toolContext) as { matches: string[] };
        assert.equal(grep.matches.some((line) => line.includes('search.txt')), true);
      } else {
        await assert.rejects(
          client.execute({
            context,
            operation: {
              kind: 'grep',
              path: '.',
              pattern: 'sandbox-search-token',
              maxCountPerFile: 50,
              limit: 200,
              timeoutMs: 5_000,
            },
          }),
          matchesClientError('operation', 'grep_unavailable'),
        );
      }
    });
  });
}

function sandboxContext(
  calls: SandboxTransformRequest[] = [],
): PermissionAwareSandboxContext {
  return {
    cwd: '/workspace',
    workspaceRoots: ['/workspace'],
    profile: createWorkspaceWritePermissionProfile(),
    sandboxManager: {
      transform(request: SandboxTransformRequest): SandboxTransformResult {
        calls.push(request);
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
          preference: request.preference ?? 'auto',
        };
      },
    },
    pathContext: { workspaceRoots: ['/workspace'] },
  };
}

function launchSpec(): FilesystemWorkerLaunchSpec {
  return {
    program: '/runtime/node',
    args: ['/runtime/filesystem-worker.js'],
    env: { TMPDIR: '/tmp' },
    runtimeReadableRoots: ['/runtime/filesystem-worker.js'],
    executableRoots: ['/runtime/node'],
  };
}

function processResult(
  stdout: string,
  overrides: Partial<FilesystemWorkerProcessRunResult> = {},
): FilesystemWorkerProcessRunResult {
  return {
    exitCode: 0,
    stdout,
    stderrTail: '',
    timedOut: false,
    aborted: false,
    responseOverflow: false,
    ...overrides,
  };
}

function clientWithProcessResult(result: FilesystemWorkerProcessRunResult) {
  return new FilesystemWorkerClient({
    getLaunchSpec: async () => ({ ok: true, spec: launchSpec() }),
    newId: () => 'request-1',
    runProcess: async () => result,
  });
}

function matchesClientError(stage: string, reason: string) {
  return (error: unknown) => error instanceof FilesystemWorkerClientError
    && error.stage === stage
    && error.reason === reason;
}

async function runNodeScript(
  script: string,
  overrides: Partial<FilesystemWorkerProcessRunInput> = {},
) {
  return await runFilesystemWorkerProcess({
    argv: [process.execPath, '-e', script],
    cwd: process.cwd(),
    env: {},
    stdin: '',
    timeoutMs: 5_000,
    ...overrides,
  });
}
