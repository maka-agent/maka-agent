import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { visibleWidth } from '@earendil-works/pi-tui';
import type { SessionEvent } from '@maka/core/events';
import {
  appendUserPrompt,
  applyMakaSessionEventToTranscript,
  createMakaPiTranscriptState,
  renderMakaPiTranscript,
  submitPromptToTranscript,
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
});

class RecordingDriver {
  readonly prompts: string[] = [];

  constructor(private readonly events: SessionEvent[]) {}

  async *sendPrompt(prompt: string): AsyncIterable<SessionEvent> {
    this.prompts.push(prompt);
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
