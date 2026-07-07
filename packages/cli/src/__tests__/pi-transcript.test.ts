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
  toggleAllThinkingExpansion,
  toggleAllToolExpansion,
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
        thinking: { text: 'recall the decision' },
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

    // Stored thinking happened before the reply text, so it resumes above it.
    assert.deepEqual(state.entries.map((entry) => entry.kind), ['user', 'thinking', 'assistant', 'tool']);
    assert.equal(state.entries[0]?.kind === 'user' ? state.entries[0].text : '', 'What did we decide?');
    assert.equal(state.entries[1]?.kind === 'thinking' ? state.entries[1].text : '', 'recall the decision');
    assert.equal(
      state.entries[2]?.kind === 'assistant' ? state.entries[2].text : '',
      'We decided to keep the TUI small.',
    );
    assert.equal(state.entries[3]?.kind === 'tool' ? state.entries[3].output : '', 'README contents');
  });

  test('rebuilds automatic context compaction notes from stored session messages', () => {
    const state = createMakaPiTranscriptState();

    replaceTranscriptWithStoredMessages(state, [
      {
        type: 'system_note',
        id: 'note-1',
        turnId: 'turn-1',
        ts: 1,
        kind: 'context_compacted',
      },
    ] satisfies StoredMessage[]);

    assert.deepEqual(state.entries.filter((entry) => entry.kind === 'notice'), [
      {
        kind: 'notice',
        level: 'info',
        text: 'Context compacted to keep this session within the model window.',
      },
    ]);
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

  test('orders thinking entries by arrival, before text and around tools', () => {
    const state = createMakaPiTranscriptState();

    applyMakaSessionEventToTranscript(state, event({
      type: 'thinking_delta', messageId: 'message-1', text: 'plan ',
    }));
    applyMakaSessionEventToTranscript(state, event({
      type: 'thinking_delta', messageId: 'message-1', text: 'first',
    }));
    applyMakaSessionEventToTranscript(state, event({
      type: 'tool_start', toolUseId: 'tool-1', toolName: 'Read', args: { path: 'a.ts' },
    }));
    applyMakaSessionEventToTranscript(state, event({
      type: 'tool_result', toolUseId: 'tool-1', isError: false, content: { kind: 'text', text: 'ok' },
    }));
    applyMakaSessionEventToTranscript(state, event({
      type: 'text_delta', messageId: 'message-1', text: 'the answer',
    }));

    // Entries mirror event order: thinking, then the tool, then the reply.
    assert.deepEqual(state.entries.map((entry) => entry.kind), ['thinking', 'tool', 'assistant']);
    assert.equal(state.entries[0]?.kind === 'thinking' ? state.entries[0].text : '', 'plan first');

    const collapsed = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi);
    const markerIndex = collapsed.findIndex((line) => line.includes('思考（Ctrl+T 展开）'));
    const toolIndex = collapsed.findIndex((line) => line.includes('Tool Read'));
    const answerIndex = collapsed.findIndex((line) => line.includes('the answer'));
    assert.ok(markerIndex >= 0);
    assert.ok(markerIndex < toolIndex);
    assert.ok(toolIndex < answerIndex);
    assert.equal(collapsed.some((line) => line.includes('plan first')), false);

    assert.equal(toggleAllThinkingExpansion(state), true);
    const expanded = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi);
    const bodyIndex = expanded.findIndex((line) => line.includes('plan first'));
    assert.ok(bodyIndex >= 0);
    assert.ok(bodyIndex < expanded.findIndex((line) => line.includes('the answer')));
  });

  test('replaces the streamed thinking entry when thinking_complete arrives after the reply', () => {
    const state = createMakaPiTranscriptState();

    applyMakaSessionEventToTranscript(state, event({
      type: 'thinking_delta', messageId: 'message-1', text: 'partial thought',
    }));
    applyMakaSessionEventToTranscript(state, event({
      type: 'text_delta', messageId: 'message-1', text: 'the reply',
    }));
    applyMakaSessionEventToTranscript(state, event({
      type: 'thinking_complete', messageId: 'message-1', text: 'the complete thought',
    }));

    // No duplicate thinking entry; the streamed one is replaced in place.
    assert.deepEqual(state.entries.map((entry) => entry.kind), ['thinking', 'assistant']);
    assert.equal(
      state.entries[0]?.kind === 'thinking' ? state.entries[0].text : '',
      'the complete thought',
    );
  });

  test('keeps tool cards compact until the latest tool is expanded', () => {
    const state = createMakaPiTranscriptState();
    // `head-line` is first; the compact one-line summary shows only the last
    // non-empty line, and expanding reveals the full stdout.
    const stdout = `head-line\n${Array.from({ length: 30 }, (_, i) => `row-${i}`).join('\n')}`;

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
        stdout,
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
      },
    }));

    const compactLines = renderMakaPiTranscript(state, meta(), 120).map(stripAnsi);
    const compact = compactLines.join('\n');

    // Compact cards are at most two lines (plus the leading blank separator).
    assert.equal(compactLines.length, 3);
    assert.match(compact, /Tool Bash \$ npm test done/);
    assert.match(compact, /\(31 lines\) row-29 \(Ctrl\+O\)/);
    assert.doesNotMatch(compact, /head-line/);

    assert.equal(toggleAllToolExpansion(state), true);
    const expanded = renderMakaPiTranscript(state, meta(), 120).map(stripAnsi).join('\n');

    assert.match(expanded, /head-line/);
    assert.match(expanded, /row-29/);
  });

  test('summarizes a failing Bash tool with exit code and last stderr line', () => {
    const state = createMakaPiTranscriptState();
    applyMakaSessionEventToTranscript(state, event({
      type: 'tool_start',
      toolUseId: 'tool-1',
      toolName: 'Bash',
      args: { command: 'npm test' },
    }));
    applyMakaSessionEventToTranscript(state, event({
      type: 'tool_result',
      toolUseId: 'tool-1',
      isError: true,
      content: {
        kind: 'terminal',
        cwd: '/repo',
        cmd: 'npm test',
        exitCode: 1,
        stdout: 'some earlier output',
        stderr: 'first error\nfinal error line\n',
      },
    }));

    const lines = renderMakaPiTranscript(state, meta(), 120);
    assert.equal(lines.length, 3);
    const compact = lines.map(stripAnsi).join('\n');
    assert.match(compact, /exit 1 final error line \(Ctrl\+O\)/);
    // The exit code is red.
    assert.match(lines.join('\n'), /\x1b\[31mexit 1\x1b\[39m/);
  });

  test('summarizes a silent successful command as (no output)', () => {
    const state = createMakaPiTranscriptState();
    applyMakaSessionEventToTranscript(state, event({
      type: 'tool_start',
      toolUseId: 'tool-1',
      toolName: 'Bash',
      args: { command: 'true' },
    }));
    applyMakaSessionEventToTranscript(state, event({
      type: 'tool_result',
      toolUseId: 'tool-1',
      isError: false,
      content: { kind: 'terminal', cwd: '/repo', cmd: 'true', exitCode: 0, stdout: '', stderr: '' },
    }));

    const lines = renderMakaPiTranscript(state, meta(), 120).map(stripAnsi);
    assert.equal(lines.length, 3);
    assert.match(lines.join('\n'), /\(no output\)/);
    assert.doesNotMatch(lines.join('\n'), /\(Ctrl\+O\)/);
  });

  test('shows the latest live output line while a tool is running', () => {
    const state = createMakaPiTranscriptState();
    applyMakaSessionEventToTranscript(state, event({
      type: 'tool_start',
      toolUseId: 'tool-1',
      toolName: 'Bash',
      args: { command: 'npm run build' },
    }));
    applyMakaSessionEventToTranscript(state, event({
      type: 'tool_output_delta', toolUseId: 'tool-1', seq: 1, stream: 'stdout', chunk: 'step one\n', redacted: false,
    }));
    applyMakaSessionEventToTranscript(state, event({
      type: 'tool_output_delta', toolUseId: 'tool-1', seq: 2, stream: 'stdout', chunk: 'step two\n', redacted: false,
    }));

    const lines = renderMakaPiTranscript(state, meta(), 120).map(stripAnsi);
    assert.equal(lines.length, 3);
    const compact = lines.join('\n');
    assert.match(compact, /Tool Bash \$ npm run build running/);
    assert.match(compact, /step two \(Ctrl\+O\)/);
    assert.doesNotMatch(compact, /step one/);
  });

  test('summarizes Read results as a line/byte count when compact and shows text expanded', () => {
    const state = createMakaPiTranscriptState();
    const fileText = Array.from({ length: 4 }, (_, i) => `content-line-${i}`).join('\n');

    applyMakaSessionEventToTranscript(state, event({
      type: 'tool_start',
      toolUseId: 'read-1',
      toolName: 'Read',
      args: { path: 'src/app.ts', offset: 10, limit: 20 },
    }));
    applyMakaSessionEventToTranscript(state, event({
      type: 'tool_result',
      toolUseId: 'read-1',
      isError: false,
      content: { kind: 'json', value: { content: fileText } },
    }));

    const compactLines = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi);
    assert.equal(compactLines.length, 3);
    const compact = compactLines.join('\n');
    assert.match(compact, /src\/app\.ts offset 10 limit 20/);
    assert.match(compact, /4 lines, 59 bytes \(Ctrl\+O\)/);
    assert.doesNotMatch(compact, /content-line-0/);

    assert.equal(toggleAllToolExpansion(state), true);
    const expanded = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.match(expanded, /content-line-0/);
  });

  test('summarizes Grep results as a match count and shows matches expanded', () => {
    const state = createMakaPiTranscriptState();
    const matches = Array.from({ length: 12 }, (_, i) => `match-${i}`);

    applyMakaSessionEventToTranscript(state, event({
      type: 'tool_start',
      toolUseId: 'grep-1',
      toolName: 'Grep',
      args: { pattern: 'TODO', path: 'packages', glob: '*.ts' },
    }));
    applyMakaSessionEventToTranscript(state, event({
      type: 'tool_result',
      toolUseId: 'grep-1',
      isError: false,
      content: { kind: 'json', value: { matches } },
    }));

    const compactLines = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi);
    assert.equal(compactLines.length, 3);
    const compact = compactLines.join('\n');
    assert.match(compact, /TODO in packages glob \*\.ts/);
    assert.match(compact, /12 matches \(Ctrl\+O\)/);
    assert.doesNotMatch(compact, /match-0/);

    assert.equal(toggleAllToolExpansion(state), true);
    const expanded = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.match(expanded, /match-0/);
    assert.match(expanded, /match-11/);
  });

  test('summarizes Glob results as a file count and shows the list expanded', () => {
    const state = createMakaPiTranscriptState();
    const files = ['src/a.ts', 'src/b.ts', 'src/c.ts'];

    applyMakaSessionEventToTranscript(state, event({
      type: 'tool_start',
      toolUseId: 'glob-1',
      toolName: 'Glob',
      args: { pattern: '**/*.ts', cwd: 'packages' },
    }));
    applyMakaSessionEventToTranscript(state, event({
      type: 'tool_result',
      toolUseId: 'glob-1',
      isError: false,
      content: { kind: 'json', value: { files } },
    }));

    const compactLines = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi);
    assert.equal(compactLines.length, 3);
    const compact = compactLines.join('\n');
    assert.match(compact, /Tool Glob \*\*\/\*\.ts in packages done/);
    assert.match(compact, /3 files \(Ctrl\+O\)/);
    assert.doesNotMatch(compact, /src\/a\.ts/);

    assert.equal(toggleAllToolExpansion(state), true);
    const expanded = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.match(expanded, /src\/a\.ts/);
    assert.match(expanded, /src\/c\.ts/);
  });

  test('does not fabricate a Grep match count from an error-shaped result', () => {
    const state = createMakaPiTranscriptState();
    applyMakaSessionEventToTranscript(state, event({
      type: 'tool_start', toolUseId: 'grep-1', toolName: 'Grep', args: { pattern: 'TODO' },
    }));
    applyMakaSessionEventToTranscript(state, event({
      type: 'tool_result',
      toolUseId: 'grep-1',
      isError: false,
      content: { kind: 'json', value: { error: 'boom\nsecond line\nthird' } },
    }));

    const compact = renderMakaPiTranscript(state, meta(), 120).map(stripAnsi).join('\n');
    // A 3-line error object must not be reported as "3 matches"; fall back to
    // the generic first-line summary instead.
    assert.doesNotMatch(compact, /\d+ matches/);
    assert.match(compact, /"error":"boom/);
  });

  test('does not fabricate a Grep match count when matches is not an array', () => {
    const state = createMakaPiTranscriptState();
    applyMakaSessionEventToTranscript(state, event({
      type: 'tool_start', toolUseId: 'grep-1', toolName: 'Grep', args: { pattern: 'TODO' },
    }));
    applyMakaSessionEventToTranscript(state, event({
      type: 'tool_result',
      toolUseId: 'grep-1',
      isError: false,
      content: { kind: 'json', value: { matches: 'not-an-array' } },
    }));

    const compact = renderMakaPiTranscript(state, meta(), 120).map(stripAnsi).join('\n');
    assert.doesNotMatch(compact, /\d+ matches/);
  });

  test('does not fabricate a Glob file count when files is null', () => {
    const state = createMakaPiTranscriptState();
    applyMakaSessionEventToTranscript(state, event({
      type: 'tool_start', toolUseId: 'glob-1', toolName: 'Glob', args: { pattern: '**/*.ts' },
    }));
    applyMakaSessionEventToTranscript(state, event({
      type: 'tool_result',
      toolUseId: 'glob-1',
      isError: false,
      content: { kind: 'json', value: { files: null } },
    }));

    const compact = renderMakaPiTranscript(state, meta(), 120).map(stripAnsi).join('\n');
    assert.doesNotMatch(compact, /\d+ files/);
  });

  test('keeps generic JSON input and result summaries on a single line', () => {
    const state = createMakaPiTranscriptState();

    applyMakaSessionEventToTranscript(state, event({
      type: 'tool_start',
      toolUseId: 'tool-1',
      toolName: 'Frobnicate',
      args: { alpha: 1, beta: 'two' },
    }));
    applyMakaSessionEventToTranscript(state, event({
      type: 'tool_result',
      toolUseId: 'tool-1',
      isError: false,
      content: { kind: 'json', value: { gamma: 3, delta: 'four' } },
    }));

    const lines = renderMakaPiTranscript(state, meta(), 200).map(stripAnsi);
    // Never more than two card lines: multi-line JSON must not split the header.
    assert.equal(lines.length, 3);
    assert.match(lines[1] ?? '', /Tool Frobnicate input: \{"alpha":1,"beta":"two"\} done/);
    assert.match(lines[2] ?? '', /\{"gamma":3,"delta":"four"\}/);
  });

  test('summarizes file_diff compactly and colors the expanded diff', () => {
    const state = createMakaPiTranscriptState();
    const diff = ['--- a/file.ts', '+++ b/file.ts', '@@ -1 +1 @@', '-removed line', '+added line'].join('\n');

    applyMakaSessionEventToTranscript(state, event({
      type: 'tool_start',
      toolUseId: 'edit-1',
      toolName: 'Edit',
      args: { path: 'file.ts' },
    }));
    applyMakaSessionEventToTranscript(state, event({
      type: 'tool_result',
      toolUseId: 'edit-1',
      isError: false,
      content: { kind: 'file_diff', paths: ['file.ts'], diff },
    }));

    const compactLines = renderMakaPiTranscript(state, meta(), 100);
    assert.equal(compactLines.length, 3);
    const compactRaw = compactLines.join('\n');
    // Compact: `+1 -1 file.ts` with green add count and red delete count.
    assert.match(compactLines.map(stripAnsi).join('\n'), /\+1 -1 file\.ts \(Ctrl\+O\)/);
    assert.match(compactRaw, /\x1b\[32m\+1\x1b\[39m/);
    assert.match(compactRaw, /\x1b\[31m-1\x1b\[39m/);
    assert.doesNotMatch(compactLines.map(stripAnsi).join('\n'), /added line/);

    assert.equal(toggleAllToolExpansion(state), true);
    const raw = renderMakaPiTranscript(state, meta(), 100).join('\n');
    // Green (32) around the added line, red (31) around the removed line.
    assert.match(raw, /\x1b\[32m\+added line\x1b\[39m/);
    assert.match(raw, /\x1b\[31m-removed line\x1b\[39m/);
  });

  test('renders file_write results as a byte summary', () => {
    const state = createMakaPiTranscriptState();
    applyMakaSessionEventToTranscript(state, event({
      type: 'tool_start',
      toolUseId: 'write-1',
      toolName: 'Write',
      args: { path: 'out.txt' },
    }));
    applyMakaSessionEventToTranscript(state, event({
      type: 'tool_result',
      toolUseId: 'write-1',
      isError: false,
      content: { kind: 'file_write', path: 'out.txt', bytes: 42 },
    }));

    const lines = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi);
    assert.equal(lines.length, 3);
    assert.match(lines.join('\n'), /wrote 42 bytes out\.txt/);
    assert.doesNotMatch(lines.join('\n'), /\(Ctrl\+O\)/);
  });

  test('expands and collapses every tool card with one global toggle', () => {
    const state = createMakaPiTranscriptState();

    applyMakaSessionEventToTranscript(state, event({
      type: 'tool_start', toolUseId: 'tool-a', toolName: 'Read', args: { path: 'a.ts' },
    }));
    applyMakaSessionEventToTranscript(state, event({
      type: 'tool_result',
      toolUseId: 'tool-a',
      isError: false,
      content: { kind: 'json', value: { content: 'alpha-body-line' } },
    }));
    applyMakaSessionEventToTranscript(state, event({
      type: 'tool_start', toolUseId: 'tool-b', toolName: 'Read', args: { path: 'b.ts' },
    }));
    applyMakaSessionEventToTranscript(state, event({
      type: 'tool_result',
      toolUseId: 'tool-b',
      isError: false,
      content: { kind: 'json', value: { content: 'beta-body-line' } },
    }));

    const compact = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.doesNotMatch(compact, /alpha-body-line/);
    assert.doesNotMatch(compact, /beta-body-line/);

    // One press expands every tool card.
    assert.equal(toggleAllToolExpansion(state), true);
    const expanded = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.match(expanded, /alpha-body-line/);
    assert.match(expanded, /beta-body-line/);

    // A second press collapses every tool card again.
    assert.equal(toggleAllToolExpansion(state), true);
    const collapsed = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.doesNotMatch(collapsed, /alpha-body-line/);
    assert.doesNotMatch(collapsed, /beta-body-line/);
  });

  test('expands and collapses every thinking entry with one global toggle', () => {
    const state = createMakaPiTranscriptState();

    applyMakaSessionEventToTranscript(state, event({
      type: 'thinking_delta', messageId: 'message-1', text: 'first thought body',
    }));
    applyMakaSessionEventToTranscript(state, event({
      type: 'text_delta', messageId: 'message-1', text: 'first reply',
    }));
    applyMakaSessionEventToTranscript(state, event({
      type: 'thinking_delta', messageId: 'message-2', text: 'second thought body',
    }));
    applyMakaSessionEventToTranscript(state, event({
      type: 'text_delta', messageId: 'message-2', text: 'second reply',
    }));

    const collapsed = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi);
    assert.equal(collapsed.filter((line) => line.includes('思考（Ctrl+T 展开）')).length, 2);
    assert.equal(collapsed.some((line) => line.includes('thought body')), false);

    // One press expands every thinking entry.
    assert.equal(toggleAllThinkingExpansion(state), true);
    const expanded = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.match(expanded, /first thought body/);
    assert.match(expanded, /second thought body/);

    // A second press collapses every thinking entry again.
    assert.equal(toggleAllThinkingExpansion(state), true);
    const recollapsed = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi);
    assert.equal(recollapsed.filter((line) => line.includes('思考（Ctrl+T 展开）')).length, 2);
    assert.equal(recollapsed.some((line) => line.includes('thought body')), false);
  });

  test('global toggles report false when the transcript has no matching entries', () => {
    const state = createMakaPiTranscriptState();
    appendUserPrompt(state, 'hello');
    assert.equal(toggleAllToolExpansion(state), false);
    assert.equal(toggleAllThinkingExpansion(state), false);
    assert.equal(state.expandAllTools, false);
    assert.equal(state.expandAllThinking, false);
  });

  test('orders and de-dupes tool_output_delta by seq and marks redacted chunks', () => {
    const state = createMakaPiTranscriptState();
    applyMakaSessionEventToTranscript(state, event({
      type: 'tool_start', toolUseId: 'bash-1', toolName: 'Bash', args: { command: 'run' },
    }));
    // Out-of-order + duplicate seq + a redacted chunk.
    applyMakaSessionEventToTranscript(state, event({
      type: 'tool_output_delta', toolUseId: 'bash-1', seq: 2, stream: 'stdout', chunk: 'SECOND', redacted: false,
    }));
    applyMakaSessionEventToTranscript(state, event({
      type: 'tool_output_delta', toolUseId: 'bash-1', seq: 1, stream: 'stdout', chunk: 'FIRST', redacted: false,
    }));
    applyMakaSessionEventToTranscript(state, event({
      type: 'tool_output_delta', toolUseId: 'bash-1', seq: 1, stream: 'stdout', chunk: 'DUPLICATE', redacted: false,
    }));
    applyMakaSessionEventToTranscript(state, event({
      type: 'tool_output_delta', toolUseId: 'bash-1', seq: 3, stream: 'stderr', chunk: 'secret', redacted: true,
    }));

    // Compact: the latest live line is the redaction marker, never the secret.
    const compact = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.match(compact, /\[redacted\]/);
    assert.doesNotMatch(compact, /secret/);

    assert.equal(toggleAllToolExpansion(state), true);
    const rendered = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.ok(rendered.indexOf('FIRST') < rendered.indexOf('SECOND'));
    assert.doesNotMatch(rendered, /DUPLICATE/);
    assert.doesNotMatch(rendered, /secret/);
    assert.match(rendered, /\[redacted\]/);
    assert.match(rendered, /\[stderr\]/);
  });
});

function meta() {
  return {
    title: 'Maka',
    cwd: '/tmp/project',
    model: 'deepseek-v4-flash',
    connectionSlug: 'deepseek',
    permissionMode: 'ask',
  } as const;
}

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
