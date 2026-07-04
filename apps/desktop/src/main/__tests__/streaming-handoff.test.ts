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
      /refreshMessagesOptions = \{ requiredAssistantMessageId: slot\.messageId \};[\s\S]*void refreshSessions\(\);\s*void refreshMessages\(sessionId, refreshMessagesOptions\);/,
      'complete must refresh committed history for the draining assistant message without making every refresh use settle delays',
    );
  });

  it('committed assistant history clears a matching draining slot on the active session', async () => {
    const { readRendererShellSource } = await import('./renderer-shell-source-helpers.js');
    const shell = await readRendererShellSource('app-shell.tsx');

    assert.match(
      shell,
      /messages\.some\(\(message\) => message\.type === 'assistant' && message\.id === activeStreamingMessageId\)/,
      'active shell should detect when the committed assistant message has arrived',
    );
    assert.match(
      shell,
      /settleAssistantStreaming\(activeId, activeStreamingMessageId\)/,
      'matching committed history should clear the draining streaming slot without requiring a session switch',
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
        pendingNewChatPermissionMode: null,
        setPendingNewChatPermissionMode: () => {},
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
