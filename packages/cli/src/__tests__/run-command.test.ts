import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import type { SessionSummary } from '@maka/core/session';
import { parseMakaRunArgs } from '../run-command.js';

const fixturePath = fileURLToPath(new URL('./run-command-fixture.js', import.meta.url));

describe('maka run argument parsing', () => {
  test('parses prompt, target, thinking, timeout, and max steps', () => {
    assert.deepEqual(
      parseMakaRunArgs([
        'explain this',
        '--cwd',
        '/repo',
        '--connection',
        'local',
        '--model',
        'model-1',
        '--thinking',
        'high',
        '--timeout',
        '1.5',
        '--max-steps',
        '7',
      ]),
      {
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
      },
    );
  });

  test('recognizes stdin prompt mode and rejects malformed limits', () => {
    assert.deepEqual(parseMakaRunArgs(['-']), {
      kind: 'run',
      options: { stdinPrompt: true },
    });
    assert.equal(parseMakaRunArgs(['x', '--timeout', '0']).kind, 'error');
    assert.equal(parseMakaRunArgs(['x', '--max-steps', '1.5']).kind, 'error');
  });

  test('parses a non-interactive permission mode and repeatable exact rules', () => {
    assert.deepEqual(
      parseMakaRunArgs([
        'run tools',
        '--permission-mode',
        'execute',
        '--allow',
        'category:file_write',
        '--allow',
        'tool:WriteStdin',
        '--deny',
        'Bash(npm  test)',
        '--allow',
        'Bash(npm test)',
      ]),
      {
        kind: 'run',
        options: {
          prompt: 'run tools',
          stdinPrompt: false,
          permissionMode: 'execute',
          permissionRules: [
            { effect: 'allow', kind: 'category', category: 'file_write' },
            { effect: 'allow', kind: 'tool', toolName: 'WriteStdin' },
            { effect: 'deny', kind: 'bash_exact', command: 'npm  test' },
            { effect: 'allow', kind: 'bash_exact', command: 'npm test' },
          ],
        },
      },
    );
  });

  test('rejects interactive ask mode and malformed permission rules', () => {
    assert.equal(parseMakaRunArgs(['x', '--permission-mode', 'ask']).kind, 'error');
    assert.equal(parseMakaRunArgs(['x', '--allow', 'category:not-real']).kind, 'error');
    assert.equal(parseMakaRunArgs(['x', '--allow', 'tool:']).kind, 'error');
    assert.equal(parseMakaRunArgs(['x', '--allow', 'tool: WriteStdin']).kind, 'error');
    assert.equal(parseMakaRunArgs(['x', '--deny', 'Bash()']).kind, 'error');
    assert.equal(parseMakaRunArgs(['x', '--allow', 'Write(*)']).kind, 'error');
  });

  test('parses resume and continue session selectors and rejects combining them', () => {
    assert.deepEqual(parseMakaRunArgs(['next', '--resume', 'session-1']), {
      kind: 'run',
      options: { prompt: 'next', stdinPrompt: false, resumeId: 'session-1' },
    });
    assert.deepEqual(parseMakaRunArgs(['next', '--continue']), {
      kind: 'run',
      options: { prompt: 'next', stdinPrompt: false, continueLatest: true },
    });
    assert.equal(parseMakaRunArgs(['next', '--resume', 'session-1', '--continue']).kind, 'error');
  });

  test('preserves an explicit default thinking constraint for resumed sessions', () => {
    assert.deepEqual(parseMakaRunArgs(['next', '--resume', 'session-1', '--thinking', 'default']), {
      kind: 'run',
      options: {
        prompt: 'next',
        stdinPrompt: false,
        resumeId: 'session-1',
        thinkingDefaultExplicit: true,
      },
    });
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

  test('returns exit 1 without successful output when the explicit step limit is reached', async () => {
    const result = await runFixture(['hello'], { scenario: 'step-limit', input: '' });

    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /tool-step limit reached/);
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

  test('passes permission mode and rules only to this invocation', async () => {
    const permissionRules = [
      { effect: 'deny', kind: 'category', category: 'read' },
      { effect: 'allow', kind: 'bash_exact', command: 'npm test' },
    ];
    const result = await runFixture(
      [
        'hello',
        '--permission-mode',
        'bypass',
        '--deny',
        'category:read',
        '--allow',
        'Bash(npm test)',
      ],
      {
        input: '',
        env: {
          MAKA_RUN_EXPECT_PERMISSION_MODE: 'bypass',
          MAKA_RUN_EXPECT_PERMISSION_RULES: JSON.stringify(permissionRules),
        },
      },
    );

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, 'prompt=hello\n');
  });

  test('returns exit 2 for ask mode before runtime startup', async () => {
    const result = await runFixture(['hello', '--permission-mode', 'ask'], { input: '' });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /permission-mode must be explore, execute, or bypass/);
    assert.equal(result.stdout, '');
  });

  test('resumes an explicit session without creating a new identity', async () => {
    const cwd = await realpath(process.cwd());
    const resumed = fixtureSession({
      id: 'resume-me',
      cwd,
      llmConnectionSlug: 'fixture',
      model: 'fixture-model',
      permissionMode: 'execute',
    });
    const result = await runFixture(
      [
        'continue this',
        '--resume',
        resumed.id,
        '--connection',
        resumed.llmConnectionSlug,
        '--model',
        resumed.model,
        '--permission-mode',
        resumed.permissionMode,
      ],
      {
        input: '',
        env: {
          MAKA_RUN_FIXTURE_SESSIONS: JSON.stringify([resumed]),
          MAKA_RUN_EXPECT_NO_CREATE: '1',
          MAKA_RUN_EXPECT_SESSION_ID: resumed.id,
          MAKA_RUN_EXPECT_CONTEXT_CWD: cwd,
          MAKA_RUN_EXPECT_CONTEXT_CONNECTION: resumed.llmConnectionSlug,
          MAKA_RUN_EXPECT_CONTEXT_MODEL: resumed.model,
          MAKA_RUN_EXPECT_CWD_OVERRIDE: JSON.stringify({ sessionId: resumed.id, cwd }),
        },
      },
    );

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, 'prompt=continue this\n');
  });

  test('returns exit 2 when explicit configuration conflicts with a resumed session', async () => {
    const resumed = fixtureSession({ id: 'resume-me', cwd: process.cwd() });
    const result = await runFixture(
      ['continue this', '--resume', resumed.id, '--model', 'different-model'],
      {
        input: '',
        env: { MAKA_RUN_FIXTURE_SESSIONS: JSON.stringify([resumed]) },
      },
    );

    assert.equal(result.code, 2);
    assert.match(result.stderr, /--model conflicts with resumed session/);
    assert.equal(result.stdout, '');
  });

  test('continues the deterministic latest cwd-compatible session', async () => {
    const cwd = await realpath(process.cwd());
    const sessions = [
      fixtureSession({ id: 'b', cwd, lastMessageAt: 200 }),
      fixtureSession({ id: 'a', cwd, lastMessageAt: 200, status: 'aborted' }),
      fixtureSession({ id: 'newer-other-cwd', cwd: '/missing-other', lastMessageAt: 300 }),
    ];
    const result = await runFixture(['continue this', '--continue'], {
      input: '',
      env: {
        MAKA_RUN_FIXTURE_SESSIONS: JSON.stringify(sessions),
        MAKA_RUN_EXPECT_NO_CREATE: '1',
        MAKA_RUN_EXPECT_SESSION_ID: 'a',
        MAKA_RUN_EXPECT_CONTEXT_CWD: cwd,
        MAKA_RUN_EXPECT_CONTEXT_CONNECTION: 'fixture',
        MAKA_RUN_EXPECT_CONTEXT_MODEL: 'fixture-model',
        MAKA_RUN_EXPECT_CWD_OVERRIDE: JSON.stringify({ sessionId: 'a', cwd }),
      },
    });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, 'prompt=continue this\n');
  });

  test('returns exit 2 when continue finds no compatible session', async () => {
    const result = await runFixture(['continue this', '--continue'], {
      input: '',
      env: { MAKA_RUN_FIXTURE_SESSIONS: '[]' },
    });

    assert.equal(result.code, 2);
    assert.match(result.stderr, /no compatible session found for cwd/);
    assert.equal(result.stdout, '');
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
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    const ready = new Promise<void>((resolve) => {
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
        if (stderr.includes('fixture-ready')) resolve();
      });
    });
    await ready;
    child.kill('SIGINT');

    const [code, signal] = (await once(child, 'exit')) as [number | null, NodeJS.Signals | null];

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
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(options.input ?? '');
  });
}

function fixtureSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'fixture-existing',
    cwd: process.cwd(),
    name: 'Fixture existing',
    isFlagged: false,
    isArchived: false,
    labels: [],
    hasUnread: false,
    lastMessageAt: 100,
    status: 'active',
    backend: 'ai-sdk',
    llmConnectionSlug: 'fixture',
    connectionLocked: false,
    model: 'fixture-model',
    permissionMode: 'explore',
    ...overrides,
  };
}
