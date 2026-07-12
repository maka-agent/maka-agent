import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import { parseMakaRunArgs } from '../run-command.js';

const fixturePath = fileURLToPath(new URL('./run-command-fixture.js', import.meta.url));

describe('maka run argument parsing', () => {
  test('parses prompt, target, thinking, timeout, and max steps', () => {
    assert.deepEqual(parseMakaRunArgs([
      'explain this',
      '--cwd', '/repo',
      '--connection', 'local',
      '--model', 'model-1',
      '--thinking', 'high',
      '--timeout', '1.5',
      '--max-steps', '7',
    ]), {
      kind: 'run',
      options: {
        prompt: 'explain this',
        stdinPrompt: false,
        cwd: '/repo',
        connection: 'local',
        model: 'model-1',
        thinking: 'high',
        timeoutMs: 1500,
        maxSteps: 7,
      },
    });
  });

  test('recognizes stdin prompt mode and rejects malformed limits', () => {
    assert.deepEqual(parseMakaRunArgs(['-']), {
      kind: 'run',
      options: { stdinPrompt: true },
    });
    assert.equal(parseMakaRunArgs(['x', '--timeout', '0']).kind, 'error');
    assert.equal(parseMakaRunArgs(['x', '--max-steps', '1.5']).kind, 'error');
  });
});

describe('maka run process contract', () => {
  test('writes only the final answer to stdout', async () => {
    const result = await runFixture(['hello'], { input: '' });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, 'prompt=hello\n');
    assert.equal(result.stderr, '');
  });

  test('uses stdin as the complete prompt for run -', async () => {
    const result = await runFixture(['-'], { input: 'from stdin\nsecond line' });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, 'prompt=from stdin\nsecond line\n');
  });

  test('uses non-TTY stdin as the prompt when no positional prompt is provided', async () => {
    const result = await runFixture([], { input: 'implicit stdin prompt' });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, 'prompt=implicit stdin prompt\n');
  });

  test('combines a positional instruction with piped stdin context', async () => {
    const result = await runFixture(['summarize'], { input: 'document body' });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, 'prompt=summarize\n\ndocument body\n');
  });

  test('returns exit 2 for missing input and pre-invocation configuration errors', async () => {
    const missing = await runFixture([], { input: '' });
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /missing prompt input/);

    const config = await runFixture(['hello'], { scenario: 'config-error', input: '' });
    assert.equal(config.code, 2);
    assert.match(config.stderr, /unknown connection/);
  });

  test('returns exit 1 for runtime failure and missing final output', async () => {
    const runtime = await runFixture(['hello'], { scenario: 'runtime-error', input: '' });
    assert.equal(runtime.code, 1);
    assert.match(runtime.stderr, /provider failed after startup/);

    const missing = await runFixture(['hello'], { scenario: 'missing-output', input: '' });
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /no final output/);
  });

  test('denies an unresolved permission prompt and exits 1', async () => {
    const result = await runFixture(['hello'], { scenario: 'permission', input: '' });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /denied permission request for WebSearch/);
    assert.match(result.stderr, /permission request permission-1 was denied/);
    assert.equal(result.stdout, '');
  });

  test('passes max steps as an invocation-local context limit', async () => {
    const result = await runFixture(['hello', '--max-steps', '3'], {
      input: '',
      env: { MAKA_RUN_EXPECT_MAX_STEPS: '3' },
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /^maxSteps=3;/);
  });

  test('returns exit 1 when the invocation timeout stops the run', async () => {
    const result = await runFixture(['hello', '--timeout', '0.05'], {
      scenario: 'slow',
      input: '',
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /timed out after 50ms/);
  });

  test('returns exit 130 on SIGINT', async () => {
    const child = spawn(process.execPath, [fixturePath, 'hello'], {
      env: { ...process.env, MAKA_RUN_FIXTURE_SCENARIO: 'slow' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.end();
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    const ready = new Promise<void>((resolve) => {
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
        if (stderr.includes('fixture-ready')) resolve();
      });
    });
    await ready;
    child.kill('SIGINT');

    const [code, signal] = await once(child, 'exit') as [number | null, NodeJS.Signals | null];

    assert.equal(signal, null);
    assert.equal(code, 130, stderr);
    assert.equal(stdout, '');
  });
});

function runFixture(
  args: string[],
  options: {
    scenario?: string;
    input?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [fixturePath, ...args], {
      env: {
        ...process.env,
        ...(options.scenario ? { MAKA_RUN_FIXTURE_SCENARIO: options.scenario } : {}),
        ...options.env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(options.input ?? '');
  });
}
