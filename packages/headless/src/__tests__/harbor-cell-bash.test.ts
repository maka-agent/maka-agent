import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { describe, test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultShellPlan } from '@maka/runtime';
import { createHarborCellLocalToolExecutor } from '../harbor-cell.js';
import { buildIsolatedBashTool } from '../tools.js';

// These run the REAL local executor (actual child processes) — not a fake exec —
// so they exercise the failure point the fake-executor tests cannot: before this
// fix the executor used execAsync({ maxBuffer: 10MB }), so a command exceeding
// 10MB was KILLED mid-run and only its first 10MB (the head) was returned. The
// benchmark Bash path now streams into a bounded tail and runs to completion.

const toolCtx = (cwd: string) => ({
  sessionId: 's',
  turnId: 't',
  cwd,
  toolCallId: 'tool-1',
  abortSignal: new AbortController().signal,
  emitOutput: () => {},
});

describe('Harbor local executor Bash (real spawn, >10MB)', () => {
  test('keeps a bounded TAIL of >10MB stdout instead of being killed at the old maxBuffer (P1)', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-harbor-bash-big-'));
    const bash = buildIsolatedBashTool(createHarborCellLocalToolExecutor());
    // ~20MB of stdout, well past the retired 10MB maxBuffer, bracketed by sentinels.
    const result = (await bash.impl(
      { command: 'echo HEAD_SENTINEL; seq 1 3000000; echo TAIL_SENTINEL' },
      toolCtx(cwd),
    )) as { exitCode: number; output: { stdout: string } };

    assert.equal(result.exitCode, 0); // ran to completion — not killed by maxBuffer
    assert.ok(result.output.stdout.includes('TAIL_SENTINEL'), 'true tail retained');
    assert.ok(
      !result.output.stdout.includes('HEAD_SENTINEL'),
      'head dropped — it is a tail, not the head',
    );
    assert.ok(result.output.stdout.includes('truncated'), 'model-budget truncation marker present');
  });

  test('keeps a bounded TAIL of >10MB stderr without being killed', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'maka-harbor-bash-bigerr-'));
    const bash = buildIsolatedBashTool(createHarborCellLocalToolExecutor());
    const result = (await bash.impl(
      { command: '{ echo HEAD_SENTINEL; seq 1 3000000; echo TAIL_SENTINEL; } 1>&2' },
      toolCtx(cwd),
    )) as { exitCode: number; output: { stderr: string } };

    assert.equal(result.exitCode, 0);
    assert.ok(result.output.stderr.includes('TAIL_SENTINEL'), 'true stderr tail retained');
    assert.ok(!result.output.stderr.includes('HEAD_SENTINEL'), 'stderr head dropped');
    assert.ok(result.output.stderr.includes('truncated'), 'stderr truncation marker present');
  });

  test('declares the same shell it spawns in — no selection-without-declaration gap', () => {
    // The executor runs commands through defaultShellPlan() (PowerShell on
    // Windows). It must expose that same plan so buildIsolatedBashTool declares
    // the dialect to the model instead of leaving it to guess (shell-detect.ts).
    const executor = createHarborCellLocalToolExecutor();
    assert.deepEqual(executor.shell, defaultShellPlan());
  });
});
