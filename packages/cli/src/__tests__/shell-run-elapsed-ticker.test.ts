import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SessionEvent, ToolResultContent } from '@maka/core/events';
import {
  applyDetachedShellRunToTranscript,
  applyMakaSessionEventToTranscript,
  createMakaPiTranscriptState,
} from '../pi-transcript.js';
import { createShellRunElapsedTicker } from '../shell-run-elapsed-ticker.js';

test('runs the elapsed ticker only while a background Bash card is running', () => {
  const state = createMakaPiTranscriptState();
  let now = 1_000;
  let tick: (() => void) | undefined;
  let cancelled = 0;
  let renders = 0;
  const ticker = createShellRunElapsedTicker({
    state,
    now: () => now,
    onTick: () => { renders += 1; },
    schedule: (callback) => {
      tick = callback;
      return () => { cancelled += 1; tick = undefined; };
    },
  });

  ticker.sync();
  assert.equal(tick, undefined);

  applyMakaSessionEventToTranscript(state, event({
    type: 'tool_start', toolUseId: 'bash-bg', toolName: 'Bash', args: { command: 'sleep 30' },
  }));
  applyMakaSessionEventToTranscript(state, event({
    type: 'tool_result', toolUseId: 'bash-bg', isError: false,
    content: shellRun({ status: 'running' }),
  }));
  ticker.sync();
  assert.ok(tick);

  now = 6_500;
  (tick as (() => void) | undefined)?.();
  const tool = state.entries.find((entry) => entry.kind === 'tool');
  assert.equal(tool?.kind === 'tool' ? tool.durationMs : undefined, 5_500);
  assert.equal(renders, 1);

  applyDetachedShellRunToTranscript(state, 'bash-bg', shellRun({ updatedAt: 6_500 }));
  ticker.sync();
  assert.equal(tick, undefined);
  assert.equal(cancelled, 1);

  applyMakaSessionEventToTranscript(state, event({
    type: 'tool_result', toolUseId: 'bash-bg', isError: false,
    content: shellRun({ status: 'completed', completedAt: 6_500, updatedAt: 6_500, exitCode: 0 }),
  }));
  ticker.sync();
  assert.equal(tick, undefined);
  assert.equal(cancelled, 1);
});

function event(input: { type: SessionEvent['type'] } & Record<string, unknown>): SessionEvent {
  return { id: `${input.type}-id`, turnId: 'turn-1', ts: 1, ...input } as SessionEvent;
}

function shellRun(
  overrides: Partial<Extract<ToolResultContent, { kind: 'shell_run' }>>,
): Extract<ToolResultContent, { kind: 'shell_run' }> {
  return {
    kind: 'shell_run', ref: 'maka://runtime/background-tasks/bg-1',
    status: 'running', cwd: '/repo', cmd: 'sleep 30',
    startedAt: 1_000, updatedAt: 1_000,
    stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false,
    ...overrides,
  };
}
