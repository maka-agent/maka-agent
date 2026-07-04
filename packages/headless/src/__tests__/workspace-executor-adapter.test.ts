import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  EXTERNAL_ISOLATED_WORKSPACE_EXECUTOR_FACTS,
  isolatedToolExecutorToWorkspaceExecutor,
} from '../workspace-executor-adapter.js';
import type { IsolatedToolExecutor } from '../isolation.js';

describe('isolatedToolExecutorToWorkspaceExecutor', () => {
  test('defaults to conservative local-impact facts unless isolation is explicitly asserted', async () => {
    const isolated: IsolatedToolExecutor = {
      async exec() {
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    };
    const executor = isolatedToolExecutorToWorkspaceExecutor(isolated);

    assert.deepEqual(executor.facts, {
      isolation: 'none',
      writesAffectHost: true,
      writeBack: 'direct',
      network: 'host',
      secrets: 'host_env',
    });
  });

  test('accepts explicit external sandbox facts', async () => {
    const isolated: IsolatedToolExecutor = {
      async exec() {
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    };
    const executor = isolatedToolExecutorToWorkspaceExecutor(
      isolated,
      EXTERNAL_ISOLATED_WORKSPACE_EXECUTOR_FACTS,
    );

    assert.deepEqual(executor.facts, {
      isolation: 'remote',
      writesAffectHost: false,
      writeBack: 'diff_review',
      network: 'sandbox',
      secrets: 'brokered',
    });
  });

  test('adapts isolated exec into workspace exec', async () => {
    const calls: unknown[] = [];
    const isolated: IsolatedToolExecutor = {
      async exec(input) {
        calls.push(input);
        return { exitCode: 0, stdout: 'out', stderr: 'err' };
      },
    };
    const executor = isolatedToolExecutorToWorkspaceExecutor(isolated);

    const result = await executor.exec({
      command: 'npm test',
      cwd: '/workspace',
      timeoutMs: 12_000,
    });

    assert.deepEqual(calls, [{
      command: 'npm test',
      cwd: '/workspace',
      timeoutMs: 12_000,
      boundedTail: true,
    }]);
    assert.deepEqual(result, {
      exitCode: 0,
      stdout: 'out',
      stderr: 'err',
      timedOut: false,
      aborted: false,
    });
  });

  test('delegates native write, glob, and grep operations when the isolated executor provides them', async () => {
    const calls: unknown[] = [];
    const isolated: IsolatedToolExecutor = {
      async exec() {
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      async writeFile(input) {
        calls.push({ kind: 'write', input });
        return { ok: true, path: input.path, bytes: 5 };
      },
      async globFiles(input) {
        calls.push({ kind: 'glob', input });
        return { files: ['src/main.ts'] };
      },
      async grepFiles(input) {
        calls.push({ kind: 'grep', input });
        return { matches: ['src/main.ts:1:token'] };
      },
    };
    const executor = isolatedToolExecutorToWorkspaceExecutor(isolated);

    assert.deepEqual(await executor.writeFile({ cwd: '/workspace', path: 'out.txt', content: 'hello' }), {
      ok: true,
      path: 'out.txt',
      bytes: 5,
    });
    assert.deepEqual(await executor.globFiles({ cwd: '/workspace', pattern: '**/*.ts', limit: 200 }), {
      files: ['src/main.ts'],
    });
    assert.deepEqual(await executor.grepFiles({
      cwd: '/workspace',
      pattern: 'token',
      path: 'src',
      maxCountPerFile: 50,
      limit: 200,
      timeoutMs: 12_000,
    }), {
      matches: ['src/main.ts:1:token'],
    });
    assert.deepEqual(calls, [
      { kind: 'write', input: { cwd: '/workspace', path: 'out.txt', content: 'hello' } },
      { kind: 'glob', input: { cwd: '/workspace', pattern: '**/*.ts' } },
      { kind: 'grep', input: { cwd: '/workspace', pattern: 'token', path: 'src' } },
    ]);
  });
});
