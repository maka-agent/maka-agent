import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SessionEvent, StoredMessage } from '@maka/core';
import { ChatView, type AssistantStreamSlot, type PermissionQueues, type ToolActivityItem } from '@maka/ui';
import {
  applyAssistantComplete,
  clearSettledAssistantStreamSlot,
  drainAssistantStreamSlot,
  markAssistantStreamSlotDraining,
  type AssistantStreamSlots,
} from '@maka/ui/assistant-stream';
import { createAppShellChatActions } from '../../renderer/app-shell-chat-actions.js';
import { createAppShellSessionEventHandlers } from '../../renderer/app-shell-session-events.js';
import type { TurnPhase } from '../../renderer/model-wait-state.js';

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

  it('delays the tool shimmer and lands settled rows without fading replayed history (#646)', () => {
    // A running tool row's sweep rides the ~200ms `animation-delay` (the delayed
    // TextShimmer), so a sub-second tool unmounts inside the window and never
    // visibly sweeps. The model-wait "正在处理…" indicator shimmers immediately
    // (its delay is at the mount level), so only tool rows carry the delayed form.
    const runningMarkup = renderChat({
      messages: [{ type: 'user', id: 'user-1', turnId: 'turn-1', ts: 1, text: 'go' }],
      streamingText: '',
      tools: [{ toolUseId: 't1', toolName: 'bash', intent: '运行一个耗时命令', status: 'running', args: {} }],
    });
    assert.match(
      runningMarkup,
      /maka-text-shimmer_1\.8s_linear_var\(--duration-emphasized\)_infinite/,
      'a running tool row shimmers on a delay',
    );
    assert.doesNotMatch(runningMarkup, /data-settled="true"/, 'a running row is not settled');

    // A completed row rendered fresh IS the replayed-history case (never seen
    // running in this view): it carries data-settled for the visual-smoke
    // endpoint + CSS hook, but must NOT play the one-shot settle fade — a loaded
    // transcript's tool rows stay static, they do not fade in on scroll.
    const settledMarkup = renderChat({
      messages: [
        { type: 'user', id: 'user-1', turnId: 'turn-1', ts: 1, text: 'go' },
        { type: 'assistant', id: 'assistant-1', turnId: 'turn-1', ts: 2, text: 'done', modelId: 'model' },
      ],
      tools: [{ toolUseId: 't1', toolName: 'bash', intent: '运行一个耗时命令', status: 'completed', args: {}, durationMs: 1200 }],
    });
    assert.match(settledMarkup, /data-settled="true"/, 'a completed tool row is marked settled');
    assert.doesNotMatch(settledMarkup, /maka-stream-fade-in/, 'a replayed-history row does not fade in');
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
    // #646: composer Stop is decoupled from the wait indicators and driven off
    // `turnInFlight` (the whole turn, so Stop never blinks out in a mid-turn
    // lull), with `activeStreamingLive` folded in defensively. Both disjuncts are
    // draining-safe — `turnInFlight` is the arm phase (independent of the
    // draining slot) and `activeStreamingLive` excludes draining by construction —
    // so draining still settles the composer. The guard against inlining the raw
    // `activeStreaming.length > 0` (which WOULD keep draining live) stays.
    //
    // #646 review (ChatGPT): `turnInFlight` alone goes stale for a session whose
    // turn completes while backgrounded — the event stream only follows activeId,
    // so its terminal event (and clearTurnActive) never arrives. Returning to that
    // session would then show a stuck Stop that hides Send. The arm is therefore
    // gated on `sessionAwaitingModel` (status === 'running'), which sessions:changed
    // keeps truthful for backgrounded sessions; this must not regress back to a bare
    // `turnInFlight`.
    assert.match(shell, /streaming=\{\(sessionAwaitingModel && turnInFlight\) \|\| activeStreamingLive\}/);
    assert.doesNotMatch(shell, /streaming=\{turnInFlight \|\| activeStreamingLive\}/);
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
        markSessionRunningOptimistic: () => {},
        messageRetryPendingRef: { current: new Set<string>() },
        refreshSessions: async () => [],
        setActiveId: (sessionId) => {
          activeIdRef.current = sessionId;
        },
        setMessageLoadErrorBySession: () => {},
        setMessageRetryPendingBySession: () => {},
        setMessages: (next) => {
          messages = typeof next === 'function' ? next(messages) : next;
        },
        setNavSelection: () => {},
        setTurnActiveBySession: () => {},
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
        setTurnActiveBySession: () => {},
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

describe('model-wait indicator arm/clear wiring (#646)', () => {
  const streamingSlot: AssistantStreamSlot = { text: 'answer', truncated: false, phase: 'streaming', messageId: 'assistant-1' };

  it('clears the turn-active arm when the turn completes for real (end_turn)', () => {
    const windowFixture = installReadMessagesWindow([[]]);
    try {
      const harness = buildEventHarness(streamingSlot);
      assert.equal(harness.getTurnActive()['session-1'], 'waiting', 'harness starts armed at the head');
      harness.handlers.handleEvent('session-1', completeEvent());
      assert.equal(harness.getTurnActive()['session-1'], undefined, 'complete drops the arm');
    } finally {
      windowFixture.restore();
    }
  });

  it('keeps the turn armed on a permission_handoff complete (the turn only pauses)', () => {
    const windowFixture = installReadMessagesWindow([[]]);
    try {
      const harness = buildEventHarness(streamingSlot);
      harness.handlers.handleEvent('session-1', {
        type: 'complete', id: 'event-2', turnId: 'turn-1', ts: 3, stopReason: 'permission_handoff',
      } as SessionEvent);
      assert.ok(harness.getTurnActive()['session-1'] !== undefined, 'a permission pause is not a turn end');
    } finally {
      windowFixture.restore();
    }
  });

  it('clears the arm on error and on abort', () => {
    for (const event of [
      { type: 'error', id: 'event-e', turnId: 'turn-1', ts: 3, message: 'boom' },
      { type: 'abort', id: 'event-a', turnId: 'turn-1', ts: 3 },
    ] as SessionEvent[]) {
      const windowFixture = installReadMessagesWindow([[]]);
      try {
        const harness = buildEventHarness(streamingSlot);
        harness.handlers.handleEvent('session-1', event);
        assert.equal(harness.getTurnActive()['session-1'], undefined, `${event.type} drops the arm`);
      } finally {
        windowFixture.restore();
      }
    }
  });

  it('promotes the phase to streamed on the first content event, without clearing the arm', () => {
    const harness = buildEventHarness({ text: '', truncated: false, phase: 'streaming' });
    assert.equal(harness.getTurnActive()['session-1'], 'waiting', 'starts at the first-token head');
    harness.handlers.handleEvent('session-1', {
      type: 'text_delta', id: 'event-d', turnId: 'turn-1', ts: 2, messageId: 'assistant-1', text: 'hello',
    } as SessionEvent);
    assert.equal(
      harness.getTurnActive()['session-1'],
      'streamed',
      'the arm persists (turn still in flight) but leaves the "正在处理…" head phase',
    );
  });

  it('a multi-step turn never returns to the first-token head phase between steps (#646)', () => {
    // Regression for the real-machine bug: a tool-using turn returned to the
    // "正在处理…" indicator in every step-to-step lull because the phase was a
    // plain boolean. Once streamed, only a terminal event (which clears the arm
    // and starts a fresh 'waiting' next turn) can leave 'streamed'.
    const windowFixture = installReadMessagesWindow([[], [], []]);
    try {
      const harness = buildEventHarness({ text: '', truncated: false, phase: 'streaming' });
      const step = (type: SessionEvent['type'], extra: Record<string, unknown> = {}) =>
        harness.handlers.handleEvent('session-1', {
          type, id: `e-${type}-${extra.toolUseId ?? ''}`, turnId: 'turn-1', ts: 2, ...extra,
        } as SessionEvent);

      step('thinking_delta', { text: 'reasoning step 1' });
      assert.equal(harness.getTurnActive()['session-1'], 'streamed', 'first reasoning leaves the head');
      step('tool_start', { toolUseId: 't1', toolName: 'read' });
      step('tool_result', { toolUseId: 't1', content: 'file body', isError: false });
      // The step-to-step lull: tool settled, nothing streaming. Still 'streamed',
      // so the derivation yields 'continuing' (calm hint), never 'processing'.
      assert.equal(
        harness.getTurnActive()['session-1'],
        'streamed',
        'the lull after a settled tool stays streamed — no "正在处理…" re-trigger',
      );
      step('thinking_delta', { text: 'reasoning step 2' });
      assert.equal(harness.getTurnActive()['session-1'], 'streamed', 'the next step stays streamed');

      harness.handlers.handleEvent('session-1', completeEvent());
      assert.equal(harness.getTurnActive()['session-1'], undefined, 'the turn end clears the arm');
    } finally {
      windowFixture.restore();
    }
  });
});

describe('model-wait indicator rendering (#646)', () => {
  const userTurn: StoredMessage[] = [{ type: 'user', id: 'user-1', turnId: 'turn-1', ts: 1, text: 'go' }];

  it('renders "正在处理…" with a shimmer inside the tail turn when armed with nothing streaming', () => {
    const markup = renderChat({ messages: userTurn, streamingText: '', processingIndicator: true });
    assert.match(markup, /正在处理…/, 'the processing label is shown');
    assert.match(markup, /data-slot="text-shimmer"/, 'the label shimmers (the "working" signal)');
    assert.match(markup, /data-live-streaming="true"/, 'the tail turn stays live so its footer is non-actionable');
    assert.match(markup, /aria-hidden="true" class="mt-0\.5 h-8"/, 'reserved-height placeholder footer, not a clickable one');
  });

  it('shows nothing extra when the indicator is off', () => {
    const markup = renderChat({ messages: userTurn, streamingText: '', processingIndicator: false });
    assert.doesNotMatch(markup, /正在处理…/);
  });

  it('yields to a streaming answer — the indicator never renders alongside content', () => {
    const markup = renderChat({ messages: userTurn, streamingText: 'hello', processingIndicator: true });
    assert.doesNotMatch(markup, /正在处理…/, 'the derivation is exclusive, but the render guards it too');
    assert.match(markup, /maka-bubble-streaming/, 'the streaming answer owns the tail turn instead');
  });

  it('renders the calm "继续中…" hint mid-turn — not "正在处理…", and without a shimmer (#646)', () => {
    const markup = renderChat({ messages: userTurn, streamingText: '', continuingIndicator: true });
    assert.match(markup, /继续中…/, 'the mid-turn lull shows the calm continuation hint');
    assert.doesNotMatch(markup, /正在处理…/, 'the prominent first-token indicator must not re-appear');
    assert.match(markup, /data-live-streaming="true"/, 'the tail turn stays live so its footer is non-actionable');
  });

  it('prefers the first-token indicator when both cues momentarily co-derive', () => {
    const markup = renderChat({
      messages: userTurn,
      streamingText: '',
      processingIndicator: true,
      continuingIndicator: true,
    });
    assert.match(markup, /正在处理…/, 'processing wins the exclusive render guard');
    assert.doesNotMatch(markup, /继续中…/, 'the continuing hint stands down while processing shows');
  });
});

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function renderChat(overrides: Partial<Parameters<typeof ChatView>[0]>): string {
  const props: Parameters<typeof ChatView>[0] = {
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
    messages: [],
    streamingText: '',
    tools: [],
    mode: 'sessions',
    onNew() {},
    ...overrides,
  };
  return renderToStaticMarkup(createElement(ChatView, props));
}

function completeEvent(): SessionEvent {
  return {
    type: 'complete',
    id: 'event-1',
    turnId: 'turn-1',
    ts: 3,
    stopReason: 'end_turn',
  };
}

function createStateSetter<T>(initial: T): (updater: (current: T) => T) => void {
  let current = initial;
  return (updater) => {
    current = updater(current);
  };
}

function installReadMessagesWindow(reads: StoredMessage[][]): {
  readCount(): number;
  restore(): void;
} {
  const globalObject = globalThis as unknown as { window?: unknown };
  const previousWindow = globalObject.window;
  let readIndex = 0;
  globalObject.window = {
    maka: {
      sessions: {
        readMessages: async () => {
          const messages = reads[Math.min(readIndex, reads.length - 1)] ?? [];
          readIndex += 1;
          return messages;
        },
      },
    },
    setTimeout: (callback: () => void) => {
      queueMicrotask(callback);
      return 0;
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
  getTurnActive: () => Record<string, TurnPhase>;
} {
  const activeIdRef = { current: 'session-1' as string | undefined };
  let messages: StoredMessage[] = [];
  let streamingBySession: Record<string, AssistantStreamSlot> = { 'session-1': initialSlot };
  const streamingBySessionRef = { current: streamingBySession };
  let thinkingBySession: Record<string, string> = { ...initialThinking };
  const thinkingBySessionRef = { current: thinkingBySession };
  // The harness represents a turn already in flight at its head, so it starts in
  // the 'waiting' (first-token) phase (#646).
  let turnActiveBySession: Record<string, TurnPhase> = { 'session-1': 'waiting' };

  const chatActions = createAppShellChatActions({
    activeIdRef,
    addPendingSessionAction: () => true,
    captureComposerImportOwner: () => ({ sessionId: 'session-1', navSection: 'sessions' }),
    clearPendingSessionAction: () => {},
    isNewChatSendSurfaceActive: () => false,
    markSessionReadLocally: () => {},
    markSessionRunningOptimistic: () => {},
    messageRetryPendingRef: { current: new Set<string>() },
    refreshSessions: async () => [],
    setActiveId: (sessionId) => {
      activeIdRef.current = sessionId;
    },
    setMessageLoadErrorBySession: () => {},
    setMessageRetryPendingBySession: () => {},
    setMessages: (next) => {
      messages = typeof next === 'function' ? next(messages) : next;
    },
    setNavSelection: () => {},
    setTurnActiveBySession: (updater) => {
      turnActiveBySession = updater(turnActiveBySession);
    },
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
    setThinkingBySession: (updater) => {
      thinkingBySession = updater(thinkingBySession);
      thinkingBySessionRef.current = thinkingBySession;
    },
    setThinkingTruncatedBySession: createStateSetter<Record<string, boolean>>({}),
    setTurnActiveBySession: (updater) => {
      turnActiveBySession = updater(turnActiveBySession);
    },
    showModelSetupToast: () => {},
    streamingBySessionRef,
    thinkingBySessionRef,
    toastApi: { error: () => {} },
  });

  return {
    handlers,
    getMessages: () => messages,
    getStreaming: () => streamingBySession,
    getThinking: () => thinkingBySession,
    getTurnActive: () => turnActiveBySession,
  };
}

describe('send optimistically opens the model-wait window (#646)', () => {
  const globalObject = globalThis as unknown as { window?: unknown };

  function installSendWindow(): { restore(): void } {
    const previousWindow = globalObject.window;
    let lastTurnId: string | undefined;
    globalObject.window = {
      maka: {
        sessions: {
          // Echo the turnId so the readMessages poll below resolves on its first
          // pass — otherwise refreshMessagesUntilTurn spins to its wall-clock
          // deadline and the test stalls for ~1s.
          send: async (_sessionId: string, payload: { turnId: string }) => {
            lastTurnId = payload.turnId;
            return { attachments: [] };
          },
          readMessages: async (): Promise<StoredMessage[]> =>
            lastTurnId ? [{ type: 'user', id: 'u-1', turnId: lastTurnId, ts: 1, text: 'hello' }] : [],
        },
      },
      setTimeout: (callback: () => void) => {
        queueMicrotask(callback);
        return 0;
      },
    };
    return {
      restore: () => {
        if (previousWindow === undefined) delete globalObject.window;
        else globalObject.window = previousWindow;
      },
    };
  }

  function buildChatActions(runningMarks: string[]): {
    chatActions: ReturnType<typeof createAppShellChatActions>;
    getTurnActive: () => Record<string, TurnPhase>;
  } {
    const activeIdRef = { current: 'session-1' as string | undefined };
    let turnActiveBySession: Record<string, TurnPhase> = {};
    const chatActions = createAppShellChatActions({
      activeIdRef,
      addPendingSessionAction: () => true,
      captureComposerImportOwner: () => ({ sessionId: 'session-1', navSection: 'sessions' }),
      clearPendingSessionAction: () => {},
      isNewChatSendSurfaceActive: () => false,
      markSessionReadLocally: () => {},
      markSessionRunningOptimistic: (sessionId) => {
        runningMarks.push(sessionId);
      },
      messageRetryPendingRef: { current: new Set<string>() },
      refreshSessions: async () => [],
      setActiveId: (sessionId) => {
        activeIdRef.current = sessionId;
      },
      setMessageLoadErrorBySession: () => {},
      setMessageRetryPendingBySession: () => {},
      setMessages: () => {},
      setNavSelection: () => {},
      setTurnActiveBySession: (updater) => {
        turnActiveBySession = updater(turnActiveBySession);
      },
      showModelSetupToast: () => {},
      toastApi: { error: () => {} },
      upsertSessionSummary: () => {},
      validPendingNewChatModel: null,
      pendingNewChatThinkingLevel: null,
    });
    return { chatActions, getTurnActive: () => turnActiveBySession };
  }

  it('marks the active session running the moment send() commits — the "正在处理…" gate must not wait for the status round-trip (#646)', async () => {
    const windowFixture = installSendWindow();
    try {
      const runningMarks: string[] = [];
      const { chatActions, getTurnActive } = buildChatActions(runningMarks);
      await chatActions.send('hello');
      // The status nudge that opens the head indicator, and the arm that gives it
      // a 'waiting' phase, both land synchronously at send — not after the IPC
      // status round-trip that used to lose the first-token race.
      assert.deepEqual(runningMarks, ['session-1']);
      assert.equal(getTurnActive()['session-1'], 'waiting');
    } finally {
      windowFixture.restore();
    }
  });
});
