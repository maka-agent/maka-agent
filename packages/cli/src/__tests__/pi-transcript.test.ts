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
  windowTranscriptLines,
} from '../pi-transcript.js';

describe('Maka Pi TUI transcript', () => {
  test('greets on a fresh empty session and drops the welcome once a prompt lands', () => {
    const state = createMakaPiTranscriptState();

    const welcome = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.match(welcome, /maka/);
    assert.match(welcome, /\/help/);
    // The welcome orients with the active model/connection/folder.
    assert.match(welcome, /deepseek-v4-flash/);
    assert.ok(welcome.includes('输入消息开始对话'));

    // Once a turn exists the transcript takes over — the welcome never returns.
    appendUserPrompt(state, 'hello world');
    const afterPrompt = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.equal(afterPrompt.includes('/help'), false);
    assert.ok(afterPrompt.includes('hello world'));
  });

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

  test('summarizes Read results as a line/byte count and never replays file content', () => {
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

    // A successful Read pulled the file into the model's context; expanding the
    // card confirms the read but must not dump the file into the transcript.
    assert.equal(toggleAllToolExpansion(state), true);
    const expanded = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.doesNotMatch(expanded, /content-line-0/);
    assert.match(expanded, /Read 4 lines, 59 bytes/);
  });

  test('counts a Read summary without the file trailing newline', () => {
    const state = createMakaPiTranscriptState();
    applyMakaSessionEventToTranscript(state, event({
      type: 'tool_start', toolUseId: 'read-nl', toolName: 'Read', args: { path: 'one.txt' },
    }));
    applyMakaSessionEventToTranscript(state, event({
      type: 'tool_result', toolUseId: 'read-nl', isError: false,
      content: { kind: 'json', value: { content: 'only-line\n' } },
    }));

    assert.equal(toggleAllToolExpansion(state), true);
    const expanded = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.match(expanded, /Read 1 line, 10 bytes/);
  });

  test('shows maka://runtime resource Read output in full, never summarized or capped', () => {
    const state = createMakaPiTranscriptState();
    // A runtime resource read returns live state (background-task metadata +
    // output) that only lives in the transcript. Its body opens with several
    // metadata lines, so it must be neither summarized nor head/tail-capped.
    const body = [
      'ref: maka://runtime/background-tasks/abc',
      'status: running',
      'cwd: /repo',
      'command: npm test',
      'started: 1',
      'updated: 2',
      '',
      'stdout:',
      'first-output-line',
      'middle-output-line',
      'last-output-line',
    ].join('\n');
    applyMakaSessionEventToTranscript(state, event({
      type: 'tool_start', toolUseId: 'read-rt', toolName: 'Read',
      args: { path: 'maka://runtime/background-tasks/abc' },
    }));
    applyMakaSessionEventToTranscript(state, event({
      type: 'tool_result', toolUseId: 'read-rt', isError: false, content: { kind: 'text', text: body },
    }));

    assert.equal(toggleAllToolExpansion(state), true);
    const expanded = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.match(expanded, /command: npm test/); // a mid-body line a cap would hide
    assert.match(expanded, /stdout:/);
    assert.match(expanded, /middle-output-line/);
    assert.doesNotMatch(expanded, /lines hidden/);
    assert.doesNotMatch(expanded, /Read \d+ lines,/);
  });

  test('keeps an archived Read placeholder status visible instead of a line count', () => {
    const state = createMakaPiTranscriptState();
    // Compaction can replace a completed filesystem Read's result with an archive
    // placeholder; its not_loaded/missing status must stay visible, not be read as
    // a one-line file body.
    applyMakaSessionEventToTranscript(state, event({
      type: 'tool_start', toolUseId: 'read-arch', toolName: 'Read', args: { path: 'README.md' },
    }));
    applyMakaSessionEventToTranscript(state, event({
      type: 'tool_result', toolUseId: 'read-arch', isError: false,
      content: { kind: 'archived_tool_result', status: 'not_loaded' },
    }));

    assert.equal(toggleAllToolExpansion(state), true);
    const expanded = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.match(expanded, /Archived tool result: not_loaded/);
    assert.doesNotMatch(expanded, /Read \d+ lines,/);
  });

  test('reports the same Read line count collapsed and expanded for a trailing-newline file', () => {
    const state = createMakaPiTranscriptState();
    applyMakaSessionEventToTranscript(state, event({
      type: 'tool_start', toolUseId: 'read-count', toolName: 'Read', args: { path: 'three.txt' },
    }));
    applyMakaSessionEventToTranscript(state, event({
      type: 'tool_result', toolUseId: 'read-count', isError: false,
      content: { kind: 'json', value: { content: 'a\nb\nc\n' } },
    }));

    // Collapsed and expanded must agree: both drop the trailing newline, so the
    // same card cannot flip from "4 lines" to "3 lines" when toggled with Ctrl+O.
    const compact = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.match(compact, /3 lines, 6 bytes/);
    assert.equal(toggleAllToolExpansion(state), true);
    const expanded = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.match(expanded, /Read 3 lines, 6 bytes/);
  });

  test('preserves a real trailing blank line in the Read line count', () => {
    const state = createMakaPiTranscriptState();
    // Only the single conventional EOF newline is dropped: `a\n\n` keeps its
    // trailing blank line (two lines), and a lone `\n` is one blank line.
    applyMakaSessionEventToTranscript(state, event({
      type: 'tool_start', toolUseId: 'read-blank', toolName: 'Read', args: { path: 'blank.txt' },
    }));
    applyMakaSessionEventToTranscript(state, event({
      type: 'tool_result', toolUseId: 'read-blank', isError: false,
      content: { kind: 'json', value: { content: 'a\n\n' } },
    }));
    assert.equal(toggleAllToolExpansion(state), true);
    const expanded = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.match(expanded, /Read 2 lines, 3 bytes/);
  });

  test('keeps shell_run status and exit visible while capping its stream body', () => {
    const state = createMakaPiTranscriptState();
    // A background command's status/exit is the whole point of expanding the
    // card; a bare head/tail cap would keep only `$ cmd` + the last stdout lines
    // and hide whether the process failed or timed out.
    const stdout = Array.from({ length: 10 }, (_, i) => `out-line-${i}`).join('\n');
    applyMakaSessionEventToTranscript(state, event({
      type: 'tool_start', toolUseId: 'shell-1', toolName: 'StopBackgroundTask',
      args: { ref: 'bg-42' },
    }));
    applyMakaSessionEventToTranscript(state, event({
      type: 'tool_result', toolUseId: 'shell-1', isError: false,
      content: {
        kind: 'shell_run', ref: 'bg-42', status: 'failed', cwd: '/repo',
        cmd: 'npm run watch', startedAt: 1, updatedAt: 2, exitCode: 137,
        failureMessage: 'killed by signal',
        stdout, stderr: 'boom-stderr',
        stdoutTruncated: false, stderrTruncated: false,
      },
    }));

    assert.equal(toggleAllToolExpansion(state), true);
    const expanded = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    // Failure metadata a bare head/tail cap would bury stays visible.
    assert.match(expanded, /failed/);
    assert.match(expanded, /exit 137/);
    assert.match(expanded, /killed by signal/);
    assert.match(expanded, /bg-42/);
    // The command/cwd live on the result, not the ref-only input, so the
    // expanded card must repeat them to say which process this was.
    assert.match(expanded, /npm run watch/);
    // The stream body is still capped, and stderr keeps its label.
    assert.match(expanded, /lines hidden/);
    assert.match(expanded, /\[stderr\]/);
    assert.match(expanded, /boom-stderr/);
  });

  test('does not repeat the command when a Bash yield already shows it', () => {
    const state = createMakaPiTranscriptState();
    // A Bash background yield carries the command on both the input and the
    // shell_run result; the expanded card must print `$ cmd` once, not twice.
    applyMakaSessionEventToTranscript(state, event({
      type: 'tool_start', toolUseId: 'bash-bg', toolName: 'Bash', args: { command: 'npm run watch' },
    }));
    applyMakaSessionEventToTranscript(state, event({
      type: 'tool_result', toolUseId: 'bash-bg', isError: false,
      content: {
        kind: 'shell_run', ref: 'bg-9', status: 'running', cwd: '/repo',
        cmd: 'npm run watch', startedAt: 1, updatedAt: 2,
        stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false,
      },
    }));

    assert.equal(toggleAllToolExpansion(state), true);
    const expanded = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    const occurrences = expanded.split('$ npm run watch').length - 1;
    assert.equal(occurrences, 1);
    assert.match(expanded, /cwd: \/repo/); // cwd is not in the input summary, so shown once here
  });

  test('renders the full command for a multiline background Bash yield', () => {
    const state = createMakaPiTranscriptState();
    // The Bash input summary shows only the first line, so a multiline command
    // must be rendered in full by the result or the rest is lost.
    const command = 'npm run build \\\n  --watch \\\n  --verbose';
    applyMakaSessionEventToTranscript(state, event({
      type: 'tool_start', toolUseId: 'bash-ml', toolName: 'Bash', args: { command },
    }));
    applyMakaSessionEventToTranscript(state, event({
      type: 'tool_result', toolUseId: 'bash-ml', isError: false,
      content: {
        kind: 'shell_run', ref: 'bg-ml', status: 'running', cwd: '/repo',
        cmd: command, startedAt: 1, updatedAt: 2,
        stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false,
      },
    }));

    assert.equal(toggleAllToolExpansion(state), true);
    const expanded = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.match(expanded, /--watch/);
    assert.match(expanded, /--verbose/);
  });

  test('renders a report-style result in full instead of head/tail capping it', () => {
    const state = createMakaPiTranscriptState();
    // Report-style kinds (agent reports, summaries) are content the user expands
    // to read in full; unlike a raw command dump they must not be capped.
    const report = Array.from({ length: 12 }, (_, i) => `report-line-${i}`).join('\n');
    applyMakaSessionEventToTranscript(state, event({
      type: 'tool_start', toolUseId: 'sum-1', toolName: 'Task', args: {},
    }));
    applyMakaSessionEventToTranscript(state, event({
      type: 'tool_result', toolUseId: 'sum-1', isError: false,
      content: { kind: 'summary', original: 'x', summarized: report, reason: 'too_large' },
    }));

    assert.equal(toggleAllToolExpansion(state), true);
    const expanded = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.match(expanded, /report-line-0/);
    assert.match(expanded, /report-line-6/); // a mid-body line a head/tail cap would hide
    assert.match(expanded, /report-line-11/);
    assert.doesNotMatch(expanded, /lines hidden/);
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

    // Expanding a Grep card shows every match — a structured list the user
    // opened the card to scan, not a raw dump to head/tail cap. All 12 rows,
    // including the middle ones, must survive and there is no hidden-count marker.
    assert.equal(toggleAllToolExpansion(state), true);
    const expanded = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    for (let i = 0; i < 12; i += 1) assert.match(expanded, new RegExp(`match-${i}\\b`));
    assert.doesNotMatch(expanded, /lines hidden/);
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

  test('caps long terminal output to head and tail lines when expanded', () => {
    const state = createMakaPiTranscriptState();
    const stdout = Array.from({ length: 20 }, (_, i) => `out-${i}`).join('\n');

    applyMakaSessionEventToTranscript(state, event({
      type: 'tool_start', toolUseId: 'bash-1', toolName: 'Bash', args: { command: 'seq 20' },
    }));
    applyMakaSessionEventToTranscript(state, event({
      type: 'tool_result', toolUseId: 'bash-1', isError: false, content: terminalResult(stdout),
    }));

    assert.equal(toggleAllToolExpansion(state), true);
    const expanded = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    // First three and last three lines survive; the middle collapses to a marker.
    assert.match(expanded, /out-0\n/);
    assert.match(expanded, /out-2\n/);
    assert.match(expanded, /out-17\n/);
    assert.match(expanded, /out-19/);
    assert.doesNotMatch(expanded, /out-10\b/);
    assert.match(expanded, /⋯ 14 lines hidden ⋯/);
  });

  test('ignores a trailing newline when counting terminal output for the cap', () => {
    const state = createMakaPiTranscriptState();
    // Real command output ends in a newline. The seven content lines are within
    // the cap, so a trailing newline must not push the count to eight and cap it.
    const stdout = `${Array.from({ length: 7 }, (_, i) => `row-${i}`).join('\n')}\n`;
    applyMakaSessionEventToTranscript(state, event({
      type: 'tool_start', toolUseId: 'bash-nl', toolName: 'Bash', args: { command: 'seq 7' },
    }));
    applyMakaSessionEventToTranscript(state, event({
      type: 'tool_result', toolUseId: 'bash-nl', isError: false, content: terminalResult(stdout),
    }));

    assert.equal(toggleAllToolExpansion(state), true);
    const expanded = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.match(expanded, /row-0\b/);
    assert.match(expanded, /row-3\b/);
    assert.match(expanded, /row-6\b/);
    assert.doesNotMatch(expanded, /lines hidden/);
  });

  test('counts real tail lines past a trailing newline when capping', () => {
    const state = createMakaPiTranscriptState();
    // Ten real lines plus a trailing newline: the tail must be the last three
    // real lines (not two plus a blank), and the hidden count must be four.
    const stdout = `${Array.from({ length: 10 }, (_, i) => `row-${i}`).join('\n')}\n`;
    applyMakaSessionEventToTranscript(state, event({
      type: 'tool_start', toolUseId: 'bash-nl2', toolName: 'Bash', args: { command: 'seq 10' },
    }));
    applyMakaSessionEventToTranscript(state, event({
      type: 'tool_result', toolUseId: 'bash-nl2', isError: false, content: terminalResult(stdout),
    }));

    assert.equal(toggleAllToolExpansion(state), true);
    const expanded = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.match(expanded, /row-7\b/);
    assert.match(expanded, /row-9\b/);
    assert.doesNotMatch(expanded, /row-5\b/);
    assert.match(expanded, /⋯ 4 lines hidden ⋯/);
  });

  test('shows a long diff in full when expanded — diffs are the head/tail exception', () => {
    const state = createMakaPiTranscriptState();
    const diff = [
      '--- a/file.ts',
      '+++ b/file.ts',
      '@@ -1 +20 @@',
      ...Array.from({ length: 20 }, (_, i) => `+line-${i}`),
    ].join('\n');

    applyMakaSessionEventToTranscript(state, event({
      type: 'tool_start', toolUseId: 'edit-2', toolName: 'Edit', args: { path: 'file.ts' },
    }));
    applyMakaSessionEventToTranscript(state, event({
      type: 'tool_result', toolUseId: 'edit-2', isError: false,
      content: { kind: 'file_diff', paths: ['file.ts'], diff },
    }));

    assert.equal(toggleAllToolExpansion(state), true);
    const expanded = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    // Every added line is present and no lines are hidden.
    assert.match(expanded, /\+line-0\b/);
    assert.match(expanded, /\+line-10\b/);
    assert.match(expanded, /\+line-19\b/);
    assert.doesNotMatch(expanded, /lines hidden/);
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
      type: 'tool_start', toolUseId: 'tool-a', toolName: 'Bash', args: { command: 'echo a' },
    }));
    applyMakaSessionEventToTranscript(state, event({
      type: 'tool_result',
      toolUseId: 'tool-a',
      isError: false,
      // The body is the first stdout line, so the compact tail summary hides it
      // while expansion reveals it.
      content: terminalResult('alpha-body-line\ntail-a'),
    }));
    applyMakaSessionEventToTranscript(state, event({
      type: 'tool_start', toolUseId: 'tool-b', toolName: 'Bash', args: { command: 'echo b' },
    }));
    applyMakaSessionEventToTranscript(state, event({
      type: 'tool_result',
      toolUseId: 'tool-b',
      isError: false,
      content: terminalResult('beta-body-line\ntail-b'),
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

  test('caps a long live stream group in the expanded card', () => {
    const state = createMakaPiTranscriptState();
    applyMakaSessionEventToTranscript(state, event({
      type: 'tool_start', toolUseId: 'bash-stream', toolName: 'Bash', args: { command: 'seq 20' },
    }));
    // Ten single-line stdout chunks form one stream group; the expanded card
    // head/tail caps the group body just like a finished command dump.
    for (let i = 0; i < 10; i += 1) {
      applyMakaSessionEventToTranscript(state, event({
        type: 'tool_output_delta', toolUseId: 'bash-stream', seq: i, stream: 'stdout',
        chunk: `${i === 0 ? '' : '\n'}stream-line-${i}`, redacted: false,
      }));
    }

    assert.equal(toggleAllToolExpansion(state), true);
    const expanded = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.match(expanded, /stream-line-0/);
    assert.match(expanded, /stream-line-9/);
    assert.match(expanded, /lines hidden/);
    assert.doesNotMatch(expanded, /stream-line-5/); // a middle line the cap hides
  });
});

describe('transcript viewport windowing', () => {
  const lines = Array.from({ length: 50 }, (_, i) => `line-${i}`);

  test('returns every line unchanged when the transcript fits', () => {
    const short = lines.slice(0, 5);
    const win = windowTranscriptLines(short, 24, 0, 80);
    assert.deepEqual(win.lines, short);
    assert.equal(win.scrollable, false);
    assert.equal(win.scrollOffset, 0);
    assert.equal(win.hiddenAbove, 0);
    assert.equal(win.hiddenBelow, 0);
  });

  test('follows the tail at offset 0, reserving a row for the scroll indicator', () => {
    const win = windowTranscriptLines(lines, 10, 0, 80);
    assert.equal(win.scrollable, true);
    assert.equal(win.lines.length, 10);
    // Nine content rows (10 minus the indicator) ending at the last line.
    assert.equal(stripAnsi(win.lines[0]!), 'line-41');
    assert.equal(stripAnsi(win.lines[8]!), 'line-49');
    assert.equal(win.hiddenAbove, 41);
    assert.equal(win.hiddenBelow, 0);
    assert.match(stripAnsi(win.lines[9]!), /↑ 41 more/);
  });

  test('reveals older lines and reports the split when scrolled up', () => {
    const win = windowTranscriptLines(lines, 10, 9, 80);
    assert.equal(win.scrollOffset, 9);
    assert.equal(stripAnsi(win.lines[0]!), 'line-32');
    assert.equal(stripAnsi(win.lines[8]!), 'line-40');
    assert.equal(win.hiddenAbove, 32);
    assert.equal(win.hiddenBelow, 9);
    assert.match(stripAnsi(win.lines[9]!), /↑ 32 more.*↓ 9 more/);
  });

  test('clamps an over-scroll to the top of the transcript', () => {
    const win = windowTranscriptLines(lines, 10, 9_999, 80);
    // contentRows = 9, so the deepest offset lands the window on the first lines.
    assert.equal(stripAnsi(win.lines[0]!), 'line-0');
    assert.equal(win.hiddenAbove, 0);
    assert.equal(win.scrollOffset, lines.length - 9);
    assert.match(stripAnsi(win.lines[9]!), /↓ \d+ more/);
  });

  test('truncates the indicator to the viewport width', () => {
    const win = windowTranscriptLines(lines, 10, 5, 12);
    assert.ok(win.lines.every((line) => visibleWidth(line) <= 12));
  });

  test('never exceeds a one-row viewport (drops the indicator)', () => {
    const win = windowTranscriptLines(lines, 1, 0, 80);
    // A one-row viewport holds a content line OR the indicator, not both; the
    // content wins so the layout budget of exactly one row is kept.
    assert.equal(win.lines.length, 1);
    assert.equal(stripAnsi(win.lines[0]!), 'line-49');
    assert.equal(win.scrollable, true);
  });
});

describe('transcript entry render memoization', () => {
  test('reuses the rendered lines of an unchanged entry across renders', () => {
    const state = createMakaPiTranscriptState();
    applyMakaSessionEventToTranscript(state, event({
      type: 'text_delta',
      messageId: 'message-1',
      text: 'stable answer',
    }));
    applyMakaSessionEventToTranscript(state, event({ type: 'complete', stopReason: 'end_turn' }));

    const first = renderMakaPiTranscript(state, meta(), 80);
    const second = renderMakaPiTranscript(state, meta(), 80);
    assert.deepEqual(second, first);

    // A width change must bust the cache and re-wrap.
    const narrow = renderMakaPiTranscript(state, meta(), 20);
    assert.notDeepEqual(narrow, first);
  });

  test('re-renders a tool entry when Ctrl+O expansion is toggled', () => {
    const state = createMakaPiTranscriptState();
    // A Grep (not a filesystem Read, which now renders only a summary) so
    // expansion genuinely changes the rendered block and its body is shown.
    applyMakaSessionEventToTranscript(state, event({
      type: 'tool_start',
      toolUseId: 'tool-1',
      toolName: 'Grep',
      args: { pattern: 'beta' },
    }));
    applyMakaSessionEventToTranscript(state, event({
      type: 'tool_result',
      toolUseId: 'tool-1',
      isError: false,
      content: { kind: 'text', text: 'alpha\nbeta\ngamma' },
    }));

    const collapsed = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.equal(toggleAllToolExpansion(state), true);
    const expanded = renderMakaPiTranscript(state, meta(), 100).map(stripAnsi).join('\n');
    assert.notEqual(expanded, collapsed);
    assert.match(expanded, /beta/);
  });

  test('re-renders thinking when a same-length final replaces the streamed text', () => {
    const state = createMakaPiTranscriptState();
    applyMakaSessionEventToTranscript(state, event({
      type: 'thinking_delta', messageId: 'message-1', text: 'AAAA',
    }));
    assert.equal(toggleAllThinkingExpansion(state), true);
    const streamed = renderMakaPiTranscript(state, meta(), 80).map(stripAnsi).join('\n');
    assert.match(streamed, /AAAA/);

    // thinking_complete replaces the text in place; same length must still bust
    // the render cache so the final reasoning is shown, not the streamed draft.
    applyMakaSessionEventToTranscript(state, event({
      type: 'thinking_complete', messageId: 'message-1', text: 'BBBB',
    }));
    const finalized = renderMakaPiTranscript(state, meta(), 80).map(stripAnsi).join('\n');
    assert.match(finalized, /BBBB/);
    assert.doesNotMatch(finalized, /AAAA/);
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

function terminalResult(stdout: string, stderr = '') {
  return {
    kind: 'terminal',
    cwd: '/repo',
    cmd: 'echo',
    status: 'completed',
    exitCode: 0,
    stdout,
    stderr,
    stdoutTruncated: false,
    stderrTruncated: false,
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
