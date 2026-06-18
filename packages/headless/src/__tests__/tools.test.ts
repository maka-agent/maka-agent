import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildIsolatedBashTool, buildIsolatedHeadlessTools } from '../tools.js';

describe('isolated headless tools', () => {
  test('Bash delegates execution to the isolated executor', async () => {
    const calls: unknown[] = [];
    const emitted: Array<{ stream: string; chunk: string }> = [];
    const bash = buildIsolatedBashTool({
      async exec(input) {
        calls.push(input);
        return { exitCode: 7, stdout: 'out\n', stderr: 'err\n' };
      },
    });

    const result = await bash.impl(
      { command: 'npm test', timeout_ms: 12_000 },
      {
        sessionId: 's',
        turnId: 't',
        cwd: '/workspace',
        toolCallId: 'tool-1',
        abortSignal: new AbortController().signal,
        emitOutput: (stream, chunk) => emitted.push({ stream, chunk }),
      },
    );

    assert.deepEqual(calls, [{ command: 'npm test', cwd: '/workspace', timeoutMs: 12_000 }]);
    assert.deepEqual(emitted, [
      { stream: 'stdout', chunk: 'out\n' },
      { stream: 'stderr', chunk: 'err\n' },
    ]);
    assert.deepEqual(result, {
      kind: 'terminal',
      cwd: '/workspace',
      cmd: 'npm test',
      exitCode: 7,
      stdout: 'out\n',
      stderr: 'err\n',
    });
  });

  test('standard isolated tool surface replaces only Bash', () => {
    const tools = buildIsolatedHeadlessTools({
      async exec() {
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    const names = tools.map((tool) => tool.name);
    assert.equal(names[0], 'Bash');
    assert.ok(names.includes('Read'));
    assert.ok(names.includes('Write'));
    assert.equal(names.filter((name) => name === 'Bash').length, 1);
  });
});
