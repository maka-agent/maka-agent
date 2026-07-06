import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { visibleWidth } from '@earendil-works/pi-tui';
import type { SessionEvent } from '@maka/core/events';
import type { StoredMessage } from '@maka/core/session';
import {
  appendUserPrompt,
  applyMakaSessionEventToTranscript,
  createMakaPiTranscriptState,
  renderMakaPiTranscript,
  replaceTranscriptWithStoredMessages,
  submitCompactToTranscript,
  submitPromptToTranscript,
  toggleLatestToolExpansion,
} from '../pi-transcript.js';

describe('Maka Pi TUI transcript', () => {
  test('keeps assistant text after a tool call visible after the tool block', () => {
    const state = createMakaPiTranscriptState();
    appendUserPrompt(state, 'inspect the package');

    applyMakaSessionEventToTranscript(state, event({
      type: 'text_delta',
      messageId: 'message-1',
      text: 'I will inspect it.',
    }));
    applyMakaSessionEventToTranscript(state, event({
      type: 'tool_start',
      toolUseId: 'tool-1',
      toolName: 'Read',
      args: { path: 'package.json' },
    }));
    applyMakaSessionEventToTranscript(state, event({
      type: 'tool_result',
      toolUseId: 'tool-1',
      isError: false,
      content: { kind: 'text', text: '{ "name": "maka-agent" }' },
    }));
    applyMakaSessionEventToTranscript(state, event({
      type: 'text_delta',
      messageId: 'message-1',
      text: 'The package is named maka-agent.',
    }));
    applyMakaSessionEventToTranscript(state, event({
      type: 'complete',
      stopReason: 'end_turn',
    }));

    assert.deepEqual(state.entries.map((entry) => entry.kind), [
      'user',
      'assistant',
      'tool',
      'assistant',
    ]);
    assert.equal(state.entries[1]?.kind === 'assistant' ? state.entries[1].text : '', 'I will inspect it.');
    assert.equal(
      state.entries[3]?.kind === 'assistant' ? state.entries[3].text : '',
      'The package is named maka-agent.',
    );
  });

  test('streams a submitted prompt through the session driver into transcript state', async () => {
    const state = createMakaPiTranscriptState();
    const driver = new RecordingDriver([
      event({
        type: 'text_delta',
        messageId: 'message-1',
        text: 'Hello from Maka',
      }),
      event({ type: 'complete', stopReason: 'end_turn' }),
    ]);
    let changes = 0;

    await submitPromptToTranscript({
      state,
      driver,
      prompt: 'hi',
      onChange: () => {
        changes++;
      },
    });

    assert.deepEqual(driver.prompts, ['hi']);
    assert.deepEqual(state.entries.map((entry) => entry.kind), ['user', 'assistant']);
    assert.equal(state.entries[0]?.kind === 'user' ? state.entries[0].text : '', 'hi');
    assert.equal(state.entries[1]?.kind === 'assistant' ? state.entries[1].text : '', 'Hello from Maka');
    assert.ok(changes >= 2);
  });

  test('reports completed manual compact runs when there was nothing to compact', async () => {
    const state = createMakaPiTranscriptState();
    const driver = new RecordingDriver([
      event({ type: 'token_usage', input: 0, output: 0 }),
      event({ type: 'complete', stopReason: 'end_turn' }),
    ]);

    await submitCompactToTranscript({ state, driver });

    assert.equal(driver.compactCalls, 1);
    assert.ok(state.entries.some((entry) => entry.kind === 'notice' && entry.text === 'Nothing to compact.'));
  });

  test('reports manual compact failed-open diagnostics instead of no-op success', async () => {
    const state = createMakaPiTranscriptState();
    const driver = new RecordingDriver([
      event({
        type: 'token_usage',
        input: 0,
        output: 0,
        contextBudget: {
          enabled: true,
          estimatedTokensBefore: 100,
          estimatedTokensAfter: 100,
          keptTurns: 2,
          droppedTurns: 0,
          keptEvents: 4,
          droppedEvents: 0,
          compactionDecisions: [{
            stage: 'priorReplay',
            sourceKind: 'runtimeEvents',
            decision: 'failedOpen',
            boundaryKind: 'historyCompact',
            failOpenReason: 'write_failed',
          }],
        },
      }),
      event({ type: 'complete', stopReason: 'end_turn' }),
    ]);

    await submitCompactToTranscript({ state, driver });

    assert.ok(state.entries.some((entry) => entry.kind === 'notice' && entry.level === 'error' && entry.text === 'Context compaction skipped: write_failed.'));
    assert.equal(state.entries.some((entry) => entry.kind === 'notice' && entry.text === 'Nothing to compact.'), false);
  });

  test('shows failed-open compact diagnostics before success diagnostics', () => {
    const state = createMakaPiTranscriptState();

    applyMakaSessionEventToTranscript(state, event({
      type: 'token_usage',
      input: 0,
      output: 0,
      contextBudget: {
        enabled: true,
        estimatedTokensBefore: 100,
        estimatedTokensAfter: 40,
        keptTurns: 1,
        droppedTurns: 2,
        keptEvents: 2,
        droppedEvents: 4,
        compactionDecisions: [
          {
            stage: 'priorReplay',
            sourceKind: 'runtimeEvents',
            decision: 'replaced',
            boundaryKind: 'historyCompact',
          },
          {
            stage: 'priorReplay',
            sourceKind: 'runtimeEvents',
            decision: 'failedOpen',
            boundaryKind: 'historyCompact',
            failOpenReason: 'write_failed',
          },
        ],
      },
    }));

    assert.deepEqual(state.entries.filter((entry) => entry.kind === 'notice').map((entry) => ({ level: entry.level, text: entry.text })), [
      { level: 'error', text: 'Context compaction skipped: write_failed.' },
    ]);
  });

  test('rebuilds transcript from stored session messages', () => {
    const state = createMakaPiTranscriptState();

    replaceTranscriptWithStoredMessages(state, [
      {
        type: 'user',
        id: 'user-1',
        turnId: 'turn-1',
        ts: 1,
        text: 'What did we decide?',
      },
      {
        type: 'assistant',
        id: 'assistant-1',
        turnId: 'turn-1',
        ts: 2,
        text: 'We decided to keep the TUI small.',
        modelId: 'deepseek-v4-flash',
      },
      {
        type: 'tool_call',
        id: 'tool-1',
        turnId: 'turn-1',
        ts: 3,
        toolName: 'Read',
        args: { path: 'README.md' },
      },
      {
        type: 'tool_result',
        id: 'tool-result-1',
        turnId: 'turn-1',
        ts: 4,
        toolUseId: 'tool-1',
        isError: false,
        content: { kind: 'text', text: 'README contents' },
      },
    ] satisfies StoredMessage[]);

    assert.deepEqual(state.entries.map((entry) => entry.kind), ['user', 'assistant', 'tool']);
    assert.equal(state.entries[0]?.kind === 'user' ? state.entries[0].text : '', 'What did we decide?');
    assert.equal(
      state.entries[1]?.kind === 'assistant' ? state.entries[1].text : '',
      'We decided to keep the TUI small.',
    );
    assert.equal(state.entries[2]?.kind === 'tool' ? state.entries[2].output : '', 'README contents');
  });

  test('renders every transcript line within the terminal width', () => {
    const state = createMakaPiTranscriptState();
    appendUserPrompt(state, 'please inspect a very long path under packages/runtime/src');
    applyMakaSessionEventToTranscript(state, event({
      type: 'text_delta',
      messageId: 'message-1',
      text: 'I will inspect `packages/runtime/src/very-long-file-name.ts` now.',
    }));

    const lines = renderMakaPiTranscript(state, {
      title: 'Maka',
      cwd: '/Users/yuhan/workspace/oss/maka-agent/.worktree/maka-cli-tui',
      model: 'deepseek-v4-flash',
      connectionSlug: 'deepseek',
      permissionMode: 'bypass',
      busy: true,
    }, 12);

    assert.ok(lines.every((line) => visibleWidth(line) <= 12));
  });

  test('labels assistant messages as maka', () => {
    const state = createMakaPiTranscriptState();
    applyMakaSessionEventToTranscript(state, event({
      type: 'text_delta',
      messageId: 'message-1',
      text: 'hello',
    }));

    const visibleLines = renderMakaPiTranscript(state, {
      title: 'Maka',
      cwd: '/tmp/project',
      model: 'deepseek-v4-flash',
      connectionSlug: 'deepseek',
      permissionMode: 'bypass',
    }, 80).map(stripAnsi);

    assert.ok(visibleLines.includes('maka'));
    assert.ok(!visibleLines.includes('Assistant'));
  });

  test('uses logo blue instead of green for assistant headings', () => {
    const state = createMakaPiTranscriptState();
    applyMakaSessionEventToTranscript(state, event({
      type: 'text_delta',
      messageId: 'message-1',
      text: 'hello',
    }));

    const rawOutput = renderMakaPiTranscript(state, {
      title: 'Maka',
      cwd: '/tmp/project',
      model: 'deepseek-v4-flash',
      connectionSlug: 'deepseek',
      permissionMode: 'bypass',
    }, 80).join('\n');

    assert.match(rawOutput, /\x1b\[38;2;87;163;239mmaka\x1b\[39m/);
    assert.doesNotMatch(rawOutput, /\x1b\[32mmaka/);
  });

  test('surfaces context compaction diagnostics as transcript notes', () => {
    const state = createMakaPiTranscriptState();

    applyMakaSessionEventToTranscript(state, event({
      type: 'token_usage',
      input: 1200,
      output: 100,
      contextBudget: {
        enabled: true,
        policyName: 'cli-default-history-budget',
        maxHistoryEstimatedTokens: 32000,
        estimatedTokensBefore: 42000,
        estimatedTokensAfter: 18000,
        keptTurns: 3,
        droppedTurns: 5,
        keptEvents: 7,
        droppedEvents: 20,
        highWaterReason: 'history_compact',
        compactionDecisions: [{
          stage: 'priorReplay',
          sourceKind: 'runtimeEvents',
          decision: 'replaced',
          boundaryKind: 'historyCompact',
          coveredTurns: 5,
          coveredRuntimeEvents: 20,
          estimatedTokensSaved: 24000,
        }],
      },
    }));

    const visibleLines = renderMakaPiTranscript(state, {
      title: 'Maka',
      cwd: '/tmp/project',
      model: 'deepseek-v4-flash',
      connectionSlug: 'deepseek',
      permissionMode: 'bypass',
    }, 120).map(stripAnsi);

    assert.ok(visibleLines.some((line) => line.includes('Context compacted')));
    assert.ok(visibleLines.some((line) => line.includes('historyCompact')));
    assert.ok(visibleLines.some((line) => line.includes('saved ~24000 tokens')));
  });

  test('surfaces pending permission requests with terminal decision hints', () => {
    const state = createMakaPiTranscriptState();

    applyMakaSessionEventToTranscript(state, event({
      type: 'permission_request',
      requestId: 'permission-1',
      toolUseId: 'tool-1',
      toolName: 'Bash',
      category: 'shell_unsafe',
      reason: 'shell_dangerous',
      args: { command: 'npm test' },
      hint: 'Run tests before editing.',
    }));

    const visibleLines = renderMakaPiTranscript(state, {
      title: 'Maka',
      cwd: '/tmp/project',
      model: 'deepseek-v4-flash',
      connectionSlug: 'deepseek',
      permissionMode: 'ask',
    }, 100).map(stripAnsi);

    assert.equal(state.pendingPermission?.requestId, 'permission-1');
    assert.ok(visibleLines.some((line) => line.includes('Permission required')));
    assert.ok(visibleLines.some((line) => line.includes('Bash')));
    assert.ok(visibleLines.some((line) => line.includes('npm test')));
    assert.ok(visibleLines.some((line) => line.includes('y/Enter allow')));
    assert.ok(visibleLines.some((line) => line.includes('n/Esc deny')));
  });

  test('keeps tool cards compact until the latest tool is expanded', () => {
    const state = createMakaPiTranscriptState();
    const longStdout = `${'x'.repeat(900)}\nexpanded-tail`;

    applyMakaSessionEventToTranscript(state, event({
      type: 'tool_start',
      toolUseId: 'tool-1',
      toolName: 'Bash',
      args: { command: 'npm test' },
    }));
    applyMakaSessionEventToTranscript(state, event({
      type: 'tool_result',
      toolUseId: 'tool-1',
      isError: false,
      content: {
        kind: 'terminal',
        cwd: '/repo',
        cmd: 'npm test',
        status: 'completed',
        exitCode: 0,
        stdout: longStdout,
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
      },
    }));

    const compact = renderMakaPiTranscript(state, {
      title: 'Maka',
      cwd: '/tmp/project',
      model: 'deepseek-v4-flash',
      connectionSlug: 'deepseek',
      permissionMode: 'ask',
    }, 100).map(stripAnsi).join('\n');

    assert.match(compact, /Tool Bash done/);
    assert.match(compact, /command: npm test/);
    assert.match(compact, /Ctrl\+O expand/);
    assert.doesNotMatch(compact, /expanded-tail/);

    assert.equal(toggleLatestToolExpansion(state), true);
    const expanded = renderMakaPiTranscript(state, {
      title: 'Maka',
      cwd: '/tmp/project',
      model: 'deepseek-v4-flash',
      connectionSlug: 'deepseek',
      permissionMode: 'ask',
    }, 100).map(stripAnsi).join('\n');

    assert.match(expanded, /expanded-tail/);
  });
});

class RecordingDriver {
  readonly prompts: string[] = [];
  compactCalls = 0;

  constructor(private readonly events: SessionEvent[]) {}

  async *sendPrompt(prompt: string): AsyncIterable<SessionEvent> {
    this.prompts.push(prompt);
    for (const event of this.events) yield event;
  }

  async *compactSession(): AsyncIterable<SessionEvent> {
    this.compactCalls += 1;
    for (const event of this.events) yield event;
  }
}

function event(input: { type: SessionEvent['type'] } & Record<string, unknown>): SessionEvent {
  return {
    id: `${input.type}-id`,
    turnId: 'turn-1',
    ts: 1,
    ...input,
  } as SessionEvent;
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}
