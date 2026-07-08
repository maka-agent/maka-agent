import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SessionEvent } from '@maka/core';
import {
  armLiveTurn,
  ChatView,
  type LiveTurnProjection,
  type PermissionQueues,
} from '@maka/ui';
import { createAppShellSessionEventHandlers } from '../../renderer/app-shell-session-events.js';

function createStateSetter<T>(initial: T): {
  get(): T;
  set(updater: (current: T) => T): void;
} {
  let value = initial;
  return {
    get: () => value,
    set: (updater) => {
      value = updater(value);
    },
  };
}

describe('assistant streaming handoff', () => {
  it('keeps a draining assistant answer as the single visible owner before committed handoff', () => {
    const finalText = '12345678';
    const markup = renderToStaticMarkup(createElement(ChatView, {
      activeSession: {
        id: 'session-1',
        name: 'handoff',
        lastMessageAt: 1,
        status: 'active',
        backend: 'ai-sdk',
        labels: [],
        isFlagged: false,
        isArchived: false,
        hasUnread: false,
        llmConnectionSlug: 'conn',
        model: 'model',
        permissionMode: 'ask',
      },
      messages: [
        { type: 'user', id: 'user-1', turnId: 'turn-1', ts: 1, text: 'go' },
        { type: 'assistant', id: 'assistant-1', turnId: 'turn-1', ts: 2, text: finalText, modelId: 'model' },
      ],
      streamingText: finalText,
      streamingComplete: true,
      streamingMessageId: 'assistant-1',
      tools: [],
      mode: 'sessions',
      onNew() {},
    } satisfies Parameters<typeof ChatView>[0]));

    assert.match(markup, /maka-bubble-streaming/, 'draining output should remain in the streaming bubble');
    assert.equal(
      countOccurrences(markup, finalText),
      1,
      'draining output must not render both the committed message and the streaming bubble',
    );
  });

  it('renders the streaming answer inside the tail turn, not a separate section (#642)', () => {
    const markup = renderChat({
      messages: [{ type: 'user', id: 'user-1', turnId: 'turn-1', ts: 1, text: 'go' }],
      streamingText: 'hello',
      streamingComplete: false,
    });
    assert.doesNotMatch(markup, /maka-turn-streaming/, 'the separate streaming section is gone');
    assert.match(markup, /data-turn-id="turn-1"/);
    assert.match(markup, /data-live-streaming="true"/, 'the tail turn is flagged live for content-visibility');
    assert.match(markup, /maka-bubble-streaming/, 'the live answer rides the tail turn');
    assert.equal(
      countOccurrences(markup, 'data-turn-id='),
      1,
      'exactly one turn node owns the whole streaming exchange (user bubble + live answer)',
    );
  });

  it('suppresses the actionable footer while the tail turn streams (#642 R1)', () => {
    const markup = renderChat({
      messages: [{ type: 'user', id: 'user-1', turnId: 'turn-1', ts: 1, text: 'go' }],
      streamingText: 'hello',
      streamingComplete: false,
      // Even when footer actions exist for the turn, a live tail must not render
      // a clickable regenerate/branch — its derived status is `completed`.
      turnFooterActionsByTurn: { 'turn-1': [{ id: 'regenerate', label: '重新生成', enabled: true }] },
    });
    assert.doesNotMatch(markup, /aria-label="本轮回答操作"/, 'no footer toolbar while live');
    assert.doesNotMatch(markup, /重新生成/, 'no clickable regenerate on a still-streaming turn');
    assert.match(markup, /aria-hidden="true" class="mt-0\.5 h-8"/, 'reserved-height footer placeholder instead');
  });

  it('renders the hover-gated footer once the turn has settled (#642)', () => {
    const markup = renderChat({
      messages: [
        { type: 'user', id: 'user-1', turnId: 'turn-1', ts: 1, text: 'go' },
        { type: 'assistant', id: 'assistant-1', turnId: 'turn-1', ts: 2, text: 'done', modelId: 'model' },
      ],
      turnFooterActionsByTurn: { 'turn-1': [{ id: 'regenerate', label: '重新生成', enabled: true }] },
    });
    assert.match(markup, /aria-label="本轮回答操作"/, 'settled turn renders the real footer toolbar');
    assert.match(markup, /group-hover\/answer:opacity-100/, 'the footer is revealed on hover of the answer block');
    assert.match(markup, /重新生成/, 'the settled footer carries its actions');
  });

  it('renders committed steps and the live step in one tail-turn section (#642 multi-step)', () => {
    const markup = renderChat({
      messages: [
        { type: 'user', id: 'user-1', turnId: 'turn-1', ts: 1, text: 'go' },
        { type: 'assistant', id: 'assistant-1', turnId: 'turn-1', ts: 2, text: 'step one', modelId: 'model' },
      ],
      streamingText: 'step two',
      streamingComplete: false,
    });
    assert.match(markup, /step one/, 'the committed earlier step renders from the timeline');
    assert.match(markup, /maka-bubble-streaming/, 'the in-flight step rides the same tail turn');
    assert.equal(countOccurrences(markup, 'data-turn-id='), 1, 'committed + live steps share one turn node');
  });

  it('attaches the live answer to the last turn only (#642 tail selection)', () => {
    const markup = renderChat({
      messages: [
        { type: 'user', id: 'user-1', turnId: 'turn-1', ts: 1, text: 'first ask' },
        { type: 'assistant', id: 'assistant-1', turnId: 'turn-1', ts: 2, text: 'first answer', modelId: 'model' },
        { type: 'user', id: 'user-2', turnId: 'turn-2', ts: 3, text: 'second ask' },
      ],
      streamingText: 'second answer',
      streamingComplete: false,
    });
    assert.equal(countOccurrences(markup, 'maka-bubble-streaming'), 1, 'only the tail turn streams');
    assert.equal(countOccurrences(markup, 'data-live-streaming="true"'), 1, 'exactly one live turn node');
    assert.equal(countOccurrences(markup, 'data-turn-id='), 2, 'both turns still render');
  });

  it('shimmers an in-flight tool trow so the user can tell a tool is running (#642 issue 3)', () => {
    // A live tool rides the tail turn's timeline (materializeTurns appends
    // live-only tools to the last turn). Its trow summary must render the
    // TextShimmer sweep — the SAME "working" light-band the 深度思考 title uses
    // — for the whole run window. `running` covers pending too, since many
    // non-streaming tools (read/edit/grep) never leave `pending` before their
    // tool_result lands. A settled (completed) tool must NOT shimmer.
    const runningMarkup = renderChat({
      messages: [{ type: 'user', id: 'user-1', turnId: 'turn-1', ts: 1, text: 'go' }],
      streamingText: '',
      tools: [{ toolUseId: 't1', toolName: 'bash', intent: '运行一个耗时命令', status: 'running', args: {} }],
    });
    assert.equal(countOccurrences(runningMarkup, 'data-slot="text-shimmer"'), 1, 'a running tool trow shimmers');

    const pendingMarkup = renderChat({
      messages: [{ type: 'user', id: 'user-1', turnId: 'turn-1', ts: 1, text: 'go' }],
      streamingText: '',
      tools: [{ toolUseId: 't1', toolName: 'read', intent: '读取文件', status: 'pending', args: {} }],
    });
    assert.equal(countOccurrences(pendingMarkup, 'data-slot="text-shimmer"'), 1, 'a pending tool trow shimmers too');

    const settledMarkup = renderChat({
      messages: [
        { type: 'user', id: 'user-1', turnId: 'turn-1', ts: 1, text: 'go' },
        { type: 'assistant', id: 'assistant-1', turnId: 'turn-1', ts: 2, text: 'done', modelId: 'model' },
      ],
      tools: [{ toolUseId: 't1', toolName: 'bash', intent: '运行一个耗时命令', status: 'completed', args: {}, durationMs: 1200 }],
    });
    assert.equal(countOccurrences(settledMarkup, 'data-slot="text-shimmer"'), 0, 'a completed tool trow does not shimmer');
  });

  it('suppresses the actionable footer while only a tool is running, with no answer text (#642 review P2-B)', () => {
    // A tool step can start (tool_start / running) before any answer text or
    // thinking streams. The tail turn must still count as live so its footer is
    // the reserved placeholder, NOT an actionable regenerate/branch on a
    // still-running answer (whose derived status defaults to `completed`).
    const running = renderChat({
      messages: [{ type: 'user', id: 'user-1', turnId: 'turn-1', ts: 1, text: 'go' }],
      streamingText: '',
      tools: [{ toolUseId: 't1', toolName: 'bash', intent: '运行命令', status: 'running', args: {} }],
      turnFooterActionsByTurn: { 'turn-1': [{ id: 'regenerate', label: '重新生成', enabled: true }] },
    });
    assert.equal(countOccurrences(running, 'data-live-streaming="true"'), 1, 'the tool-only tail turn is still marked live');
    assert.doesNotMatch(running, /aria-label="本轮回答操作"/, 'no actionable footer toolbar while a tool runs');
    assert.doesNotMatch(running, /重新生成/, 'regenerate must not be clickable on a still-running answer');

    // Once the tool settles and the answer commits, the real footer returns —
    // the guard must not over-suppress the footer on a genuinely finished turn.
    const settled = renderChat({
      messages: [
        { type: 'user', id: 'user-1', turnId: 'turn-1', ts: 1, text: 'go' },
        { type: 'assistant', id: 'assistant-1', turnId: 'turn-1', ts: 2, text: 'done', modelId: 'model' },
      ],
      streamingText: '',
      tools: [{ toolUseId: 't1', toolName: 'bash', intent: '运行命令', status: 'completed', args: {}, durationMs: 100 }],
      turnFooterActionsByTurn: { 'turn-1': [{ id: 'regenerate', label: '重新生成', enabled: true }] },
    });
    assert.match(settled, /aria-label="本轮回答操作"/, 'a settled turn with a completed tool shows the real footer');
    assert.equal(countOccurrences(settled, 'data-live-streaming="true"'), 0, 'a settled turn is not marked live');
  });

  it('text_complete replaces the live slot with the final draining text', () => {
    const current: AssistantStreamSlots = {
      'session-1': { text: 'part', truncated: true, phase: 'streaming', messageId: 'assistant-1' },
    };

    const next = drainAssistantStreamSlot(current, 'session-1', applyAssistantComplete('final answer'), 'assistant-1');

    assert.equal(next['session-1']?.text, 'final answer');
    assert.equal(next['session-1']?.truncated, false);
    assert.equal(next['session-1']?.phase, 'draining');
    assert.equal(next['session-1']?.messageId, 'assistant-1');
  });

  it('complete marks the current streamed text as draining without replacing it', () => {
    const current: AssistantStreamSlots = {
      'session-1': { text: 'delta accumulated text', truncated: false, phase: 'streaming', messageId: 'assistant-1' },
    };

    const next = markAssistantStreamSlotDraining(current, 'session-1');

    assert.equal(next['session-1']?.text, 'delta accumulated text');
    assert.equal(next['session-1']?.phase, 'draining');
    assert.equal(next['session-1']?.messageId, 'assistant-1');
  });

  it('renderer treats draining assistant text as settled for live-only chrome', async () => {
    const { readRendererShellSource } = await import('./renderer-shell-source-helpers.js');
    const shell = await readRendererShellSource('app-shell.tsx');

    assert.match(
      shell,
      /const activeStreamingLive = activeStreaming\.length > 0 && activeStreamingSlot\?\.phase === 'streaming';/,
    );
    assert.match(
      shell,
      /slot\.text && slot\.phase === 'streaming'/,
      'sidebar streaming pulse should ignore final text that is only draining into history',
    );
    assert.match(shell, /streaming=\{activeStreamingLive\}/);
    assert.doesNotMatch(shell, /streaming=\{activeStreaming\.length > 0/);
  });

  it('complete refreshes committed messages even while the streaming bubble drains', async () => {
    const { readRendererShellSource } = await import('./renderer-shell-source-helpers.js');
    const events = await readRendererShellSource('app-shell-session-events.ts');
    const completeCase = events.match(/case 'complete':[\s\S]*?break;/)?.[0] ?? '';

    assert.match(completeCase, /markAssistantStreamSlotDraining\(current, sessionId\)/);
    assert.doesNotMatch(completeCase, /if \(!deferMessageRefresh\) \{[\s\S]*refreshMessages\(sessionId\)/);
    assert.match(
      completeCase,
      /refreshMessagesOptions = \{ requiredAssistantMessageId: slot\.messageId \};[\s\S]*void refreshSessions\(\);\s*\{\s*const refreshed = refreshMessages\(sessionId, refreshMessagesOptions\);/,
      'complete must refresh committed history for the draining assistant message without making every refresh use settle delays',
    );
    // #642: a textless / thinking-only completion holds the live buffer until
    // that same refresh resolves (refresh-before-clear), so the tail turn's
    // answer block never unmounts before the committed message lands. The
    // deferred clear is identity-guarded (review P2-A) so a newer turn started
    // during the refresh isn't wiped.
    assert.match(
      completeCase,
      /heldTextless = \{[\s\S]*if \(heldTextless\) \{[\s\S]*void refreshed\.finally\(\(\) => clearStreamingIfCurrent\(sessionId, held\)\);/,
      'textless complete must defer an identity-guarded clear until after the committed refresh',
    );
  });

  it('committed assistant history clears a matching draining slot on the active session (delayed fallback only)', async () => {
    const { readRendererShellSource } = await import('./renderer-shell-source-helpers.js');
    const shell = await readRendererShellSource('app-shell.tsx');

    assert.match(
      shell,
      /messages\.some\(\(message\) => message\.type === 'assistant' && message\.id === activeStreamingMessageId\)/,
      'active shell should detect when the committed assistant message has arrived',
    );
    // Streaming-settle polish: the PRIMARY handoff signal is the bubble's
    // onStreamingSettled (fires when catchingUp === false, i.e. the final
    // text has been fully displayed). The committed-history path is a
    // FALLBACK that must wait out a grace period past the smoother's 600ms
    // completion drain budget — settling immediately used to cut the visible
    // tail mid-typewriter and snap the last characters in with the swap.
    assert.match(
      shell,
      /const timer = window\.setTimeout\(\(\) => \{\s*void settleAssistantStreaming\(activeId, activeStreamingMessageId\);\s*\}, SETTLE_FALLBACK_GRACE_MS\)/,
      'the committed-history settle must be a delayed fallback, never an immediate mid-drain cut',
    );
    assert.match(
      shell,
      /return \(\) => window\.clearTimeout\(timer\)/,
      'the fallback timer must be cleaned up when the effect re-runs',
    );
    assert.match(
      shell,
      /const SETTLE_FALLBACK_GRACE_MS = 1000/,
      'grace period must stay comfortably past the 600ms completion drain budget',
    );
    assert.match(
      shell,
      /onStreamingSettled=\{activeId \? \(\) => settleAssistantStreaming\(activeId, activeStreamingMessageId\) : undefined\}/,
      'onStreamingSettled stays wired as the primary settle signal',
    );
  });

  it('settled slot reducer clears after refresh failure because the clear no longer depends on refresh success', () => {
    const settledSlot = { text: 'final answer', truncated: false, phase: 'draining' as const, messageId: 'assistant-1' };
    const slots: AssistantStreamSlots = {
      'session-1': settledSlot,
    };

    const next = clearSettledAssistantStreamSlot(slots, 'session-1', settledSlot, 'assistant-1');

    assert.deepEqual(next['session-1'], { text: '', truncated: false, phase: 'streaming' });
  });

  it('waits for the committed assistant message when complete fires before storage settles', async () => {
    const staleMessages: StoredMessage[] = [
      { type: 'user', id: 'user-1', turnId: 'turn-1', ts: 1, text: 'go' },
    ];
    const committedMessages: StoredMessage[] = [
      ...staleMessages,
      { type: 'assistant', id: 'assistant-1', turnId: 'turn-1', ts: 2, text: 'final answer', modelId: 'model' },
    ];
    const windowFixture = installReadMessagesWindow([staleMessages, committedMessages, committedMessages]);
    try {
      const activeIdRef = { current: 'session-1' as string | undefined };
      let messages: StoredMessage[] = [];
      let streamingBySession: Record<string, AssistantStreamSlot> = {
        'session-1': { text: 'final answer', truncated: false, phase: 'streaming', messageId: 'assistant-1' },
      };
      const streamingBySessionRef = { current: streamingBySession };

      const chatActions = createAppShellChatActions({
        activeIdRef,
        addPendingSessionAction: () => true,
        captureComposerImportOwner: () => ({ sessionId: 'session-1', navSection: 'sessions' }),
        clearPendingSessionAction: () => {},
        isNewChatSendSurfaceActive: () => false,
        markSessionReadLocally: () => {},
        messageRetryPendingRef: { current: new Set<string>() },
        refreshSessions: async () => [],
        getActiveSessionStatus: () => undefined,
        setActiveId: (sessionId) => {
          activeIdRef.current = sessionId;
        },
        setMessageLoadErrorBySession: () => {},
        setMessageRetryPendingBySession: () => {},
        setMessages: (next) => {
          messages = typeof next === 'function' ? next(messages) : next;
        },
        setNavSelection: () => {},
        showModelSetupToast: () => {},
        toastApi: { error: () => {} },
        upsertSessionSummary: () => {},
        validPendingNewChatModel: null,
        pendingNewChatThinkingLevel: null,
      });

      const handlers = createAppShellSessionEventHandlers({
        activeIdRef,
        refreshMessages: chatActions.refreshMessages,
        refreshSessions: async () => [],
        setLiveToolsBySession: createStateSetter<Record<string, ToolActivityItem[]>>({}),
        setPermissionBySession: createStateSetter<PermissionQueues>({}),
        setStreamingBySession: (updater) => {
          streamingBySession = updater(streamingBySession);
          streamingBySessionRef.current = streamingBySession;
        },
        setThinkingBySession: createStateSetter<Record<string, string>>({}),
        setThinkingTruncatedBySession: createStateSetter<Record<string, boolean>>({}),
        showModelSetupToast: () => {},
        streamingBySessionRef,
        thinkingBySessionRef: { current: {} as Record<string, string> },
        toastApi: { error: () => {} },
      });

      handlers.handleEvent('session-1', completeEvent());
      await flushAsyncWork();

      assert.ok(
        messages.some((message) => message.type === 'assistant' && message.id === 'assistant-1'),
        'complete refresh should wait for the committed assistant message, not keep the stale read',
      );
      assert.equal(windowFixture.readCount(), 2);

      await handlers.settleAssistantStreaming('session-1', 'assistant-1');

      assert.deepEqual(streamingBySession['session-1'], { text: '', truncated: false, phase: 'streaming' });
    } finally {
      windowFixture.restore();
    }
  });

  it('holds a textless completion until the committed message lands, then clears (#642)', async () => {
    // Thinking-only / textless turn: the tail turn's live 深度思考 must stay
    // mounted until the committed (empty-text) assistant message is refreshed
    // in, so the answer block never unmounts before it lands.
    const staleMessages: StoredMessage[] = [
      { type: 'user', id: 'user-1', turnId: 'turn-1', ts: 1, text: 'go' },
    ];
    const committedMessages: StoredMessage[] = [
      ...staleMessages,
      { type: 'assistant', id: 'assistant-1', turnId: 'turn-1', ts: 2, text: '', modelId: 'model' },
    ];
    const windowFixture = installReadMessagesWindow([staleMessages, committedMessages, committedMessages]);
    try {
      const harness = buildEventHarness({ text: '', truncated: false, phase: 'streaming', messageId: 'assistant-1' });
      harness.handlers.handleEvent('session-1', {
        type: 'text_complete', id: 'tc-1', turnId: 'turn-1', ts: 3, messageId: 'assistant-1', text: '',
      } as SessionEvent);
      await flushAsyncWork();

      assert.ok(
        harness.getMessages().some((message) => message.type === 'assistant' && message.id === 'assistant-1'),
        'the committed message is refreshed in before the live buffer clears',
      );
      assert.equal(windowFixture.readCount(), 2, 'the refresh waited for the committed message');
      assert.equal(
        harness.getStreaming()['session-1']?.text,
        '',
        'the live buffer is cleared only after the committed refresh (refresh-before-clear)',
      );
    } finally {
      windowFixture.restore();
    }
  });

  it('deferred textless clear does not wipe a newer turn that took over the slot (#642 review P2-A)', async () => {
    // Turn-1 is thinking-only: its text_complete schedules a refresh-before-clear.
    // Before that async refresh resolves, the user sends turn-2 whose first
    // text_delta takes over the session's live slot with a new messageId. The
    // deferred clear must recognise the slot is no longer turn-1's and leave
    // turn-2's answer intact (the pre-P2-A unguarded clearStreaming blanked it).
    const committedMessages: StoredMessage[] = [
      { type: 'user', id: 'user-1', turnId: 'turn-1', ts: 1, text: 'go' },
      { type: 'assistant', id: 'assistant-1', turnId: 'turn-1', ts: 2, text: '', modelId: 'model' },
    ];
    const windowFixture = installReadMessagesWindow([committedMessages, committedMessages, committedMessages]);
    try {
      const harness = buildEventHarness(
        { text: '', truncated: false, phase: 'streaming', messageId: 'assistant-1' },
        { 'session-1': 'turn-1 reasoning' },
      );
      harness.handlers.handleEvent('session-1', {
        type: 'text_complete', id: 'tc-1', turnId: 'turn-1', ts: 3, messageId: 'assistant-1', text: '',
      } as SessionEvent);
      // turn-2 starts before the refresh resolves — a new step's messageId.
      harness.handlers.handleEvent('session-1', {
        type: 'text_delta', id: 'td-2', turnId: 'turn-2', ts: 4, messageId: 'assistant-2', text: 'turn-2 answer',
      } as SessionEvent);
      await flushAsyncWork();

      assert.equal(harness.getStreaming()['session-1']?.text, 'turn-2 answer', 'the newer turn answer survives');
      assert.equal(harness.getStreaming()['session-1']?.messageId, 'assistant-2', 'the newer slot identity is untouched');
    } finally {
      windowFixture.restore();
    }
  });

  it('deferred textless clear does not wipe a newer turn thinking (#642 review P2-A)', async () => {
    const committedMessages: StoredMessage[] = [
      { type: 'user', id: 'user-1', turnId: 'turn-1', ts: 1, text: 'go' },
      { type: 'assistant', id: 'assistant-1', turnId: 'turn-1', ts: 2, text: '', modelId: 'model' },
    ];
    const windowFixture = installReadMessagesWindow([committedMessages, committedMessages, committedMessages]);
    try {
      const harness = buildEventHarness(
        { text: '', truncated: false, phase: 'streaming', messageId: 'assistant-1' },
        { 'session-1': 'turn-1 reasoning' },
      );
      harness.handlers.handleEvent('session-1', {
        type: 'text_complete', id: 'tc-1', turnId: 'turn-1', ts: 3, messageId: 'assistant-1', text: '',
      } as SessionEvent);
      // turn-2 is thinking-only: its reasoning must not be clobbered by clearThinking.
      harness.handlers.handleEvent('session-1', {
        type: 'thinking_delta', id: 'th-2', turnId: 'turn-2', ts: 4, text: 'turn-2 reasoning',
      } as SessionEvent);
      await flushAsyncWork();

      assert.match(harness.getThinking()['session-1'] ?? '', /turn-2 reasoning/, 'the newer turn reasoning survives');
    } finally {
      windowFixture.restore();
    }
  });

  it('deferred textless clear still clears the turn buffer when no newer turn raced in (#642 review P2-A control)', async () => {
    // Positive control: the identity guard must NOT break the normal path — with
    // no racing turn-2, the held snapshot still matches, so the live thinking is
    // cleared after the committed message lands (no stale reasoning left behind).
    const committedMessages: StoredMessage[] = [
      { type: 'user', id: 'user-1', turnId: 'turn-1', ts: 1, text: 'go' },
      { type: 'assistant', id: 'assistant-1', turnId: 'turn-1', ts: 2, text: '', modelId: 'model' },
    ];
    const windowFixture = installReadMessagesWindow([committedMessages, committedMessages, committedMessages]);
    try {
      const harness = buildEventHarness(
        { text: '', truncated: false, phase: 'streaming', messageId: 'assistant-1' },
        { 'session-1': 'turn-1 reasoning' },
      );
      harness.handlers.handleEvent('session-1', {
        type: 'text_complete', id: 'tc-1', turnId: 'turn-1', ts: 3, messageId: 'assistant-1', text: '',
      } as SessionEvent);
      await flushAsyncWork();

      assert.equal(harness.getThinking()['session-1'], '', 'turn-1 reasoning is cleared once its committed message lands');
    } finally {
      windowFixture.restore();
    }
  });

  it('settled slot reducer keeps refresh-before-clear callers race-safe for a newer stream slot', () => {
    const settledSlot = { text: 'old final', truncated: false, phase: 'draining' as const, messageId: 'assistant-old' };
    const slots: AssistantStreamSlots = {
      'session-1': { text: 'new answer', truncated: false, phase: 'streaming', messageId: 'assistant-new' },
    };

    const next = clearSettledAssistantStreamSlot(slots, 'session-1', settledSlot, 'assistant-old');

    assert.equal(next, slots);
  });

  it('settled slot reducer clears a replayed equivalent draining slot after refresh', () => {
    const settledSlot = { text: 'final answer', truncated: false, phase: 'draining' as const, messageId: 'assistant-1' };
    const slots: AssistantStreamSlots = {
      'session-1': { text: 'final answer', truncated: false, phase: 'draining', messageId: 'assistant-1' },
    };

    const next = clearSettledAssistantStreamSlot(slots, 'session-1', settledSlot, 'assistant-1');

    assert.deepEqual(next['session-1'], { text: '', truncated: false, phase: 'streaming' });
  });

  it('settled slot reducer does not clear a newer stream slot that replaces the settled one during refresh', () => {
    const settledSlot = { text: 'old final', truncated: false, phase: 'draining' as const, messageId: 'assistant-old' };
    const slots: AssistantStreamSlots = {
      'session-1': { text: 'new answer', truncated: false, phase: 'streaming', messageId: 'assistant-new' },
    };

    const next = clearSettledAssistantStreamSlot(slots, 'session-1', settledSlot, 'assistant-old');

    assert.deepEqual(next['session-1'], {
      text: 'new answer',
      truncated: false,
      phase: 'streaming',
      messageId: 'assistant-new',
    });
  });

  it('settled slot reducer does not clear a replaced draining slot only because the message id still matches', () => {
    const settledSlot = { text: 'old final', truncated: false, phase: 'draining' as const, messageId: 'assistant-1' };
    const slots: AssistantStreamSlots = {
      'session-1': { text: 'replacement final', truncated: false, phase: 'draining', messageId: 'assistant-1' },
    };

    const next = clearSettledAssistantStreamSlot(slots, 'session-1', settledSlot, 'assistant-1');

    assert.deepEqual(next['session-1'], {
      text: 'replacement final',
      truncated: false,
      phase: 'draining',
      messageId: 'assistant-1',
    });
  });
});

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function completeEvent(): SessionEvent {
  return { type: 'complete', id: 'event-1', turnId: 'turn-1', ts: 3, stopReason: 'end_turn' };
}

/**
 * Override `window.__maka.readMessages` to return one of the pre-built
 * arrays in sequence, so tests can simulate a stale read followed by
 * a committed read.
 */
function installReadMessagesWindow(sequence: StoredMessage[][]): { readCount(): number; restore(): void } {
  let readIndex = 0;
  const globalObject = globalThis as typeof globalThis & { window?: unknown };
  const previousWindow = globalObject.window;
  globalObject.window = {
    __maka: {
      readMessages: async () => sequence[Math.min(readIndex++, sequence.length - 1)]!,
    },
  };
  return {
    readCount: () => readIndex,
    restore: () => {
      if (previousWindow === undefined) {
        delete globalObject.window;
      } else {
        globalObject.window = previousWindow;
      }
    },
  };
}

async function flushAsyncWork(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

function buildEventHarness(
  initialSlot: AssistantStreamSlot,
  initialThinking: Record<string, string> = {},
): {
  handlers: ReturnType<typeof createAppShellSessionEventHandlers>;
  getMessages: () => StoredMessage[];
  getStreaming: () => Record<string, AssistantStreamSlot>;
  getThinking: () => Record<string, string>;
} {
  const activeIdRef = { current: 'session-1' as string | undefined };
  let messages: StoredMessage[] = [];
  let streamingBySession: Record<string, AssistantStreamSlot> = { 'session-1': initialSlot };
  const streamingBySessionRef = { current: streamingBySession };
  let thinkingBySession: Record<string, string> = { ...initialThinking };
  const thinkingBySessionRef = { current: thinkingBySession };

  const chatActions = createAppShellChatActions({
    activeIdRef,
    addPendingSessionAction: () => true,
    captureComposerImportOwner: () => ({ sessionId: 'session-1', navSection: 'sessions' }),
    clearPendingSessionAction: () => {},
    isNewChatSendSurfaceActive: () => false,
    markSessionReadLocally: () => {},
    messageRetryPendingRef: { current: new Set<string>() },
    refreshSessions: async () => [],
    getActiveSessionStatus: () => (streamingBySession['session-1'] ? 'running' : 'active'),
    setActiveId: (sessionId) => {
      activeIdRef.current = sessionId;
    },
    setMessageLoadErrorBySession: () => {},
    setMessageRetryPendingBySession: () => {},
    setMessages: (next) => {
      messages = typeof next === 'function' ? next(messages) : next;
    },
    setNavSelection: () => {},
    showModelSetupToast: () => {},
    toastApi: { error: () => {} },
    upsertSessionSummary: () => {},
    validPendingNewChatModel: null,
    pendingNewChatThinkingLevel: null,
  });
}

function renderLiveTurn(liveTurn: LiveTurnProjection): string {
  return renderToStaticMarkup(createElement(ChatView, {
    activeSession: {
      id: 'session-1',
      name: 'streaming',
      lastMessageAt: 1,
      status: 'active',
      backend: 'ai-sdk',
      labels: [],
      isFlagged: false,
      isArchived: false,
      hasUnread: false,
      llmConnectionSlug: 'conn',
      model: 'model',
      permissionMode: 'ask',
    },
    messages: [{ type: 'user', id: 'user-1', turnId: liveTurn.turnId, ts: 1, text: 'go' }],
    liveTurn,
    mode: 'sessions',
    onNew() {},
  } satisfies Parameters<typeof ChatView>[0]));
}

describe('single live-turn handoff', () => {
  it('renders one ordered timeline: thinking before its tool and answer', () => {
    const markup = renderLiveTurn({
      turnId: 'turn-1',
      phase: 'streamed',
      steps: [{
        stepId: 'assistant-1',
        thinking: { text: '先检查', truncated: false, complete: true },
        text: { text: '最终答案', truncated: false, complete: false },
        tools: [{
          toolUseId: 'tool-1',
          toolName: 'Bash',
          stepId: 'assistant-1',
          status: 'completed',
          args: {},
          result: { kind: 'text', text: 'ok' },
        }],
      }],
    });

    assert.ok(markup.indexOf('先检查') < markup.indexOf('data-trow="group"'));
    assert.match(markup, /最终答案/);
    assert.equal((markup.match(/data-turn-id=/g) ?? []).length, 1);
  });

  it('keeps a completed live answer as the only visible owner until settle', () => {
    const finalText = 'one visible answer';
    const markup = renderToStaticMarkup(createElement(ChatView, {
      activeSession: {
        id: 'session-1', name: 'streaming', lastMessageAt: 1, status: 'active', backend: 'ai-sdk',
        labels: [], isFlagged: false, isArchived: false, hasUnread: false,
        llmConnectionSlug: 'conn', model: 'model', permissionMode: 'ask',
      },
      messages: [
        { type: 'user', id: 'user-1', turnId: 'turn-1', ts: 1, text: 'go' },
        { type: 'assistant', id: 'assistant-1', turnId: 'turn-1', ts: 2, text: finalText, modelId: 'model' },
      ],
      liveTurn: {
        turnId: 'turn-1',
        phase: 'streamed',
        terminal: true,
        steps: [{
          stepId: 'assistant-1',
          text: { text: finalText, truncated: false, complete: true },
          tools: [],
        }],
      },
      mode: 'sessions',
      onNew() {},
    } satisfies Parameters<typeof ChatView>[0]));

    assert.match(markup, /maka-bubble-streaming/);
    assert.equal(markup.split(finalText).length - 1, 1);
  });

  it('keeps an incomplete live answer as the only owner after early persistence', () => {
    const text = 'persisted before a slow tool finishes';
    const markup = renderToStaticMarkup(createElement(ChatView, {
      activeSession: {
        id: 'session-1', name: 'streaming', lastMessageAt: 1, status: 'running', backend: 'pi-agent',
        labels: [], isFlagged: false, isArchived: false, hasUnread: false,
        llmConnectionSlug: 'conn', model: 'model', permissionMode: 'ask',
      },
      messages: [
        { type: 'user', id: 'user-1', turnId: 'turn-1', ts: 1, text: 'go' },
        { type: 'assistant', id: 'assistant-1', turnId: 'turn-1', ts: 2, text, modelId: 'model' },
      ],
      liveTurn: {
        turnId: 'turn-1',
        phase: 'streamed',
        steps: [{
          stepId: 'assistant-1',
          text: { text, truncated: false, complete: false },
          tools: [{ toolUseId: 'tool-1', toolName: 'Bash', stepId: 'assistant-1', status: 'running', args: {} }],
        }],
      },
      mode: 'sessions',
      onNew() {},
    } satisfies Parameters<typeof ChatView>[0]));

    assert.equal(markup.split(text).length - 1, 1);
  });

  it('reduces events into the projection and settles only after committed history refreshes', async () => {
    const liveTurns = createStateSetter<Record<string, LiveTurnProjection>>({
      'session-1': armLiveTurn('turn-1'),
    });
    const liveTurnBySessionRef = { current: liveTurns.get() };
    const permissions = createStateSetter<PermissionQueues>({});
    const refreshes: Array<{ sessionId: string; required?: string }> = [];
    const setLiveTurnBySession = (updater: (current: Record<string, LiveTurnProjection>) => Record<string, LiveTurnProjection>) => {
      liveTurns.set(updater);
      liveTurnBySessionRef.current = liveTurns.get();
    };
    const handlers = createAppShellSessionEventHandlers({
      activeIdRef: { current: 'session-1' },
      liveTurnBySessionRef,
      refreshMessages: async (sessionId, options) => {
        refreshes.push({ sessionId, required: options?.requiredAssistantMessageId });
        return true;
      },
      refreshSessions: async () => [],
      setLiveTurnBySession,
      setPermissionBySession: permissions.set,
      showModelSetupToast: () => {},
      toastApi: { error: () => {} },
    });

    const emit = (event: SessionEvent) => handlers.handleEvent('session-1', event);
    emit({
      type: 'thinking_delta', id: 'e1', turnId: 'turn-1', messageId: 'assistant-1', ts: 1, text: '思考',
    });
    emit({
      type: 'tool_start', id: 'e2', turnId: 'turn-1', stepId: 'assistant-1', ts: 2,
      toolUseId: 'tool-1', toolName: 'Bash', args: {},
    });
    emit({
      type: 'text_complete', id: 'e3', turnId: 'turn-1', messageId: 'assistant-1', ts: 3, text: '答案',
    });
    emit({ type: 'complete', id: 'e4', turnId: 'turn-1', ts: 4, stopReason: 'end_turn' });

    const terminal = liveTurns.get()['session-1'];
    assert.equal(terminal?.terminal, true);
    assert.deepEqual(terminal?.steps[0]?.thinking?.text, '思考');
    assert.equal(terminal?.steps[0]?.tools[0]?.toolUseId, 'tool-1');
    assert.equal(terminal?.steps[0]?.text?.text, '答案');

    await handlers.settleAssistantStreaming('session-1', 'assistant-1');
    assert.equal(liveTurns.get()['session-1'], undefined);
    assert.ok(refreshes.some((call) => call.required === 'assistant-1'));
  });

  it('keeps permission handoff in the same live tool and does not end the turn', () => {
    const liveTurns = createStateSetter<Record<string, LiveTurnProjection>>({
      'session-1': armLiveTurn('turn-1'),
    });
    const ref = { current: liveTurns.get() };
    const permissions = createStateSetter<PermissionQueues>({});
    const setLiveTurnBySession = (updater: (current: Record<string, LiveTurnProjection>) => Record<string, LiveTurnProjection>) => {
      liveTurns.set(updater);
      ref.current = liveTurns.get();
    };
    const handlers = createAppShellSessionEventHandlers({
      activeIdRef: { current: 'session-1' },
      liveTurnBySessionRef: ref,
      refreshMessages: async () => true,
      refreshSessions: async () => [],
      setLiveTurnBySession,
      setPermissionBySession: permissions.set,
      showModelSetupToast: () => {},
      toastApi: { error: () => {} },
    });

    handlers.handleEvent('session-1', {
      type: 'permission_request', id: 'e1', turnId: 'turn-1', ts: 1,
      requestId: 'request-1', toolUseId: 'tool-1', toolName: 'Bash',
      category: 'shell_unsafe', reason: 'shell_dangerous', args: {},
    });
    handlers.handleEvent('session-1', {
      type: 'complete', id: 'e2', turnId: 'turn-1', ts: 2, stopReason: 'permission_handoff',
    });

    assert.equal(liveTurns.get()['session-1']?.terminal, undefined);
    assert.equal(liveTurns.get()['session-1']?.steps[0]?.tools[0]?.status, 'waiting_permission');
    assert.equal(permissions.get()['session-1']?.[0]?.requestId, 'request-1');
  });

  it('hands an aborted projection over only after persisted messages cover it', async () => {
    const liveTurns = createStateSetter<Record<string, LiveTurnProjection>>({
      'session-1': {
        turnId: 'turn-1',
        phase: 'streamed',
        steps: [{
          stepId: 'step-1',
          tools: [{
            toolUseId: 'tool-1',
            toolName: 'Bash',
            status: 'running',
            args: {},
          }],
        }],
      },
    });
    const ref = { current: liveTurns.get() };
    const permissions = createStateSetter<PermissionQueues>({});
    const setLiveTurnBySession = (updater: (current: Record<string, LiveTurnProjection>) => Record<string, LiveTurnProjection>) => {
      liveTurns.set(updater);
      ref.current = liveTurns.get();
    };
    let resolveRefresh!: (value: boolean) => void;
    const refresh = new Promise<boolean>((resolve) => {
      resolveRefresh = resolve;
    });
    const handlers = createAppShellSessionEventHandlers({
      activeIdRef: { current: 'session-1' },
      liveTurnBySessionRef: ref,
      refreshMessages: async () => refresh,
      refreshSessions: async () => [],
      setLiveTurnBySession,
      setPermissionBySession: permissions.set,
      showModelSetupToast: () => {},
      toastApi: { error: () => {} },
    });

    handlers.handleEvent('session-1', {
      type: 'abort', id: 'event-1', turnId: 'turn-1', ts: 1, reason: 'user_stop',
    });

    assert.equal(liveTurns.get()['session-1']?.terminal, true);
    assert.equal(liveTurns.get()['session-1']?.steps[0]?.tools[0]?.status, 'interrupted');

    resolveRefresh(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(liveTurns.get()['session-1']?.terminal, true);
    handlers.reconcilePersistedMessages('session-1', [
      { type: 'tool_call', id: 'tool-1', turnId: 'turn-1', stepId: 'step-1', ts: 2, toolName: 'Bash', args: {} },
    ]);
    assert.equal(liveTurns.get()['session-1'], undefined);
  });

  it('retains errored live evidence when persistence cannot be confirmed', async () => {
    const projection: LiveTurnProjection = {
      turnId: 'turn-1',
      phase: 'streamed',
      steps: [{
        stepId: 'step-1',
        tools: [{
          toolUseId: 'tool-1', toolName: 'Bash', status: 'running', args: {},
          outputChunks: [{
            seq: 0, stream: 'stdout', text: 'partial output', redacted: false, createdAt: 1,
          }],
        }],
      }],
    };
    const liveTurns = createStateSetter<Record<string, LiveTurnProjection>>({ 'session-1': projection });
    const ref = { current: liveTurns.get() };
    const permissions = createStateSetter<PermissionQueues>({});
    const handlers = createAppShellSessionEventHandlers({
      activeIdRef: { current: 'session-1' },
      liveTurnBySessionRef: ref,
      refreshMessages: async () => false,
      refreshSessions: async () => [],
      setLiveTurnBySession: (updater) => {
        liveTurns.set(updater);
        ref.current = liveTurns.get();
      },
      setPermissionBySession: permissions.set,
      showModelSetupToast: () => {},
      toastApi: { error: () => {} },
    });

    handlers.handleEvent('session-1', {
      type: 'error', id: 'event-1', turnId: 'turn-1', ts: 2,
      code: 'TOOL_FAILED', reason: 'tool_failed', message: 'failed', recoverable: false,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(liveTurns.get()['session-1']?.terminal, true);
    assert.equal(liveTurns.get()['session-1']?.steps[0]?.tools[0]?.status, 'interrupted');
    assert.equal(liveTurns.get()['session-1']?.steps[0]?.tools[0]?.outputChunks?.[0]?.text, 'partial output');

    handlers.reconcilePersistedMessages('session-1', [
      { type: 'tool_call', id: 'tool-1', turnId: 'turn-1', stepId: 'step-1', ts: 3, toolName: 'Bash', args: {} },
    ]);
    assert.equal(liveTurns.get()['session-1']?.steps[0]?.tools[0]?.outputChunks?.[0]?.text, 'partial output');
    handlers.reconcilePersistedMessages('session-1', [
      { type: 'tool_call', id: 'tool-1', turnId: 'turn-1', stepId: 'step-1', ts: 3, toolName: 'Bash', args: {} },
      { type: 'tool_result', id: 'result-1', turnId: 'turn-1', ts: 4, toolUseId: 'tool-1', isError: true, content: { kind: 'text', text: 'partial output' } },
    ]);
    assert.equal(liveTurns.get()['session-1'], undefined);
  });

  it('reconciles persisted stream evidence while the next tool batch is running', () => {
    const projection: LiveTurnProjection = {
      turnId: 'turn-1',
      phase: 'streamed',
      steps: [
        {
          stepId: 'step-1',
          tools: [{
            toolUseId: 'old-tool', toolName: 'Bash', status: 'completed', args: {},
            outputChunks: [{ seq: 0, stream: 'stdout', text: 'old\n', redacted: false, createdAt: 1 }],
          }],
          contentOrder: ['tools'],
        },
        {
          stepId: 'step-2',
          tools: [{ toolUseId: 'new-tool', toolName: 'Bash', status: 'running', args: {} }],
          contentOrder: ['tools'],
        },
      ],
    };
    const liveTurns = createStateSetter<Record<string, LiveTurnProjection>>({ 'session-1': projection });
    const ref = { current: liveTurns.get() };
    const permissions = createStateSetter<PermissionQueues>({});
    const handlers = createAppShellSessionEventHandlers({
      activeIdRef: { current: 'session-1' },
      liveTurnBySessionRef: ref,
      refreshMessages: async () => true,
      refreshSessions: async () => [],
      setLiveTurnBySession: (updater) => {
        liveTurns.set(updater);
        ref.current = liveTurns.get();
      },
      setPermissionBySession: permissions.set,
      showModelSetupToast: () => {},
      toastApi: { error: () => {} },
    });

    handlers.reconcilePersistedMessages('session-1', [
      { type: 'tool_call', id: 'old-tool', turnId: 'turn-1', stepId: 'step-1', ts: 1, toolName: 'Bash', args: {} },
      { type: 'tool_result', id: 'old-result', turnId: 'turn-1', ts: 2, toolUseId: 'old-tool', isError: false, content: { kind: 'text', text: 'old\n' } },
    ]);

    assert.deepEqual(liveTurns.get()['session-1']?.steps, [projection.steps[1]]);
  });

  it('settles a tool-only terminal projection after persisted history refreshes', async () => {
    const liveTurns = createStateSetter<Record<string, LiveTurnProjection>>({
      'session-1': {
        turnId: 'turn-1',
        phase: 'streamed',
        steps: [{
          stepId: 'tool:tool-1',
          tools: [{ toolUseId: 'tool-1', toolName: 'Bash', status: 'completed', args: {} }],
        }],
      },
    });
    const ref = { current: liveTurns.get() };
    const permissions = createStateSetter<PermissionQueues>({});
    let resolveRefresh!: (value: boolean) => void;
    const refresh = new Promise<boolean>((resolve) => {
      resolveRefresh = resolve;
    });
    const handlers = createAppShellSessionEventHandlers({
      activeIdRef: { current: 'session-1' },
      liveTurnBySessionRef: ref,
      refreshMessages: async () => refresh,
      refreshSessions: async () => [],
      setLiveTurnBySession: (updater) => {
        liveTurns.set(updater);
        ref.current = liveTurns.get();
      },
      setPermissionBySession: permissions.set,
      showModelSetupToast: () => {},
      toastApi: { error: () => {} },
    });

    handlers.handleEvent('session-1', {
      type: 'complete', id: 'event-1', turnId: 'turn-1', ts: 2, stopReason: 'end_turn',
    });
    assert.equal(liveTurns.get()['session-1']?.terminal, true);

    resolveRefresh(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    handlers.reconcilePersistedMessages('session-1', [
      { type: 'tool_call', id: 'tool-1', turnId: 'turn-1', stepId: 'tool:tool-1', ts: 2, toolName: 'Bash', args: {} },
      { type: 'tool_result', id: 'result-1', turnId: 'turn-1', ts: 3, toolUseId: 'tool-1', isError: false, content: { kind: 'text', text: 'ok' } },
    ]);
    assert.equal(liveTurns.get()['session-1'], undefined);
  });
});
