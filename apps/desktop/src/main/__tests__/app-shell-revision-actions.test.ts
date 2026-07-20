import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SessionSummary, StoredMessage } from '@maka/core';
import {
  createAppShellRevisionActions,
  type TurnRevisionDraft,
} from '../../renderer/app-shell-revision-actions.js';

function session(id: string): SessionSummary {
  return {
    id,
    name: id,
    isFlagged: false,
    isArchived: false,
    labels: [],
    hasUnread: false,
    status: 'active',
    backend: 'fake',
    llmConnectionSlug: 'test',
    connectionLocked: false,
    model: 'test',
    permissionMode: 'ask',
  };
}

function userMessage(overrides: Partial<Extract<StoredMessage, { type: 'user' }>> = {}): Extract<StoredMessage, { type: 'user' }> {
  return {
    type: 'user',
    id: 'message-1',
    turnId: 'turn-1',
    ts: 1,
    text: 'Human-facing prompt',
    ...overrides,
  };
}

function installWindow(branchBeforeTurn: (sessionId: string, input: { sourceTurnId: string }) => Promise<SessionSummary>): () => void {
  const target = globalThis as unknown as { window?: unknown };
  const hadWindow = Object.prototype.hasOwnProperty.call(target, 'window');
  const previousWindow = target.window;
  Object.defineProperty(target, 'window', {
    configurable: true,
    value: { maka: { sessions: { branchBeforeTurn } } },
    writable: true,
  });
  return () => {
    if (hadWindow) {
      Object.defineProperty(target, 'window', {
        configurable: true,
        value: previousWindow,
        writable: true,
      });
    } else {
      delete target.window;
    }
  };
}

function createHarness(options: {
  branchBeforeTurn: (sessionId: string, input: { sourceTurnId: string }) => Promise<SessionSummary>;
  navigateOnOpen?: boolean;
  refreshMessages?: (sessionId: string) => Promise<boolean>;
  messages?: StoredMessage[];
}) {
  const activeIdRef: { current: string | undefined } = { current: 'source' };
  const revisionDraftRef: { current: TurnRevisionDraft | null } = { current: null };
  const composerCalls: string[] = [];
  const opened: string[] = [];
  const revisionWrites: Array<TurnRevisionDraft | null> = [];
  const refreshSessionCalls: string[] = [];
  const refreshListCalls: number[] = [];
  const infoToasts: Array<[string, string | undefined]> = [];
  const pending = new Set<string>();
  const restoreWindow = installWindow(options.branchBeforeTurn);
  const actions = createAppShellRevisionActions({
    uiLocale: 'en',
    activeIdRef,
    composerRef: {
      current: {
        setText: (text) => composerCalls.push(text),
        appendText: () => undefined,
        focus: () => composerCalls.push('<focus>'),
      },
    },
    messages: options.messages ?? [userMessage()],
    addPendingTurnAction: (key) => {
      if (pending.has(key)) return false;
      pending.add(key);
      return true;
    },
    clearPendingTurnAction: (key) => pending.delete(key),
    openSessionInChat: (sessionId) => {
      opened.push(sessionId);
      if (options.navigateOnOpen !== false) activeIdRef.current = sessionId;
    },
    pendingKeyOf: (sessionId, turnId, actionId) => `${sessionId}:${turnId}:${actionId}`,
    refreshMessages: async (sessionId) => {
      refreshSessionCalls.push(sessionId);
      return options.refreshMessages ? options.refreshMessages(sessionId) : true;
    },
    refreshSessions: async () => {
      refreshListCalls.push(1);
      return [];
    },
    setMessages: () => undefined,
    commitRevisionDraft: (draft) => {
      revisionDraftRef.current = draft;
      revisionWrites.push(draft);
    },
    revisionDraftRef,
    toastApi: {
      info: (title, description) => infoToasts.push([title, description]),
      success: () => undefined,
      error: () => undefined,
    },
    upsertSessionSummary: () => undefined,
  });
  return {
    actions,
    activeIdRef,
    composerCalls,
    opened,
    infoToasts,
    refreshListCalls,
    refreshSessionCalls,
    restoreWindow,
    revisionDraftRef,
    revisionWrites,
  };
}

describe('app shell revision actions', () => {
  it('branches before the turn, uses user-facing text, and refills only the active branch', async () => {
    const branch = session('branch');
    const branchCalls: Array<[string, { sourceTurnId: string }]> = [];
    const harness = createHarness({
      branchBeforeTurn: async (sessionId, input) => {
        branchCalls.push([sessionId, input]);
        return branch;
      },
    });

    try {
      await harness.actions.beginEditUserMessage('turn-1');
      assert.deepEqual(branchCalls, [['source', { sourceTurnId: 'turn-1' }]]);
      assert.deepEqual(harness.opened, ['branch']);
      assert.deepEqual(harness.refreshSessionCalls, ['branch']);
      assert.equal(harness.revisionDraftRef.current?.originalText, 'Human-facing prompt');
      assert.deepEqual(harness.composerCalls, [], 'refill waits for the branch session commit');

      harness.actions.refillRevisionComposer();
      assert.deepEqual(harness.composerCalls, ['Human-facing prompt', '<focus>']);

      harness.activeIdRef.current = 'another-session';
      harness.actions.refillRevisionComposer();
      assert.deepEqual(
        harness.composerCalls,
        ['Human-facing prompt', '<focus>'],
        'a stale refill must not write into another session composer',
      );
    } finally {
      harness.restoreWindow();
    }
  });

  it('refuses attachment-bearing history before creating a lossy branch', async () => {
    let branchCalls = 0;
    const harness = createHarness({
      messages: [
        userMessage({
          attachments: [
            {
              kind: 'image',
              name: 'source.png',
              mimeType: 'image/png',
              bytes: 4,
              ref: { kind: 'session_file', sessionId: 'source', relativePath: 'attachment-1' },
            },
          ],
        }),
      ],
      branchBeforeTurn: async () => {
        branchCalls += 1;
        return session('branch');
      },
    });

    try {
      await harness.actions.beginEditUserMessage('turn-1');

      assert.equal(branchCalls, 0);
      assert.deepEqual(harness.opened, []);
      assert.equal(harness.revisionDraftRef.current, null);
      assert.deepEqual(harness.composerCalls, []);
      assert.deepEqual(harness.infoToasts, [[
        'This message cannot be edited yet',
        'Edit & resend does not yet support historical attachments. Copy the text into a new message instead.',
      ]]);
    } finally {
      harness.restoreWindow();
    }
  });

  it('refuses transformed skill prompts before creating a semantically different branch', async () => {
    let branchCalls = 0;
    const harness = createHarness({
      messages: [userMessage({
        text: '<invoked-skill id="research">hidden instructions</invoked-skill>',
        displayText: '/skill:research summarize this',
      })],
      branchBeforeTurn: async () => {
        branchCalls += 1;
        return session('branch');
      },
    });

    try {
      await harness.actions.beginEditUserMessage('turn-1');

      assert.equal(branchCalls, 0);
      assert.deepEqual(harness.opened, []);
      assert.equal(harness.revisionDraftRef.current, null);
      assert.deepEqual(harness.infoToasts, [[
        'This message cannot be edited yet',
        'Edit & resend does not yet support messages sent with an explicit skill. Copy the text and select the skill again instead.',
      ]]);
    } finally {
      harness.restoreWindow();
    }
  });

  it('does not steal focus when the user leaves while branch creation is pending', async () => {
    let resolveBranch: ((value: SessionSummary) => void) | undefined;
    const branchPromise = new Promise<SessionSummary>((resolve) => {
      resolveBranch = resolve;
    });
    const harness = createHarness({ branchBeforeTurn: async () => branchPromise });

    try {
      const pendingEdit = harness.actions.beginEditUserMessage('turn-1');
      await Promise.resolve();
      harness.activeIdRef.current = 'another-session';
      resolveBranch?.(session('branch'));
      await pendingEdit;

      assert.deepEqual(harness.opened, []);
      assert.equal(harness.revisionDraftRef.current, null);
      assert.deepEqual(harness.composerCalls, []);
      assert.equal(harness.refreshListCalls.length, 1, 'the newly created branch still appears in the list');
    } finally {
      harness.restoreWindow();
    }
  });

  it('does not announce a stale revision after cancellation during message refresh', async () => {
    let resolveRefresh: (() => void) | undefined;
    const refreshPromise = new Promise<void>((resolve) => {
      resolveRefresh = resolve;
    });
    const harness = createHarness({
      branchBeforeTurn: async () => session('branch'),
      refreshMessages: async () => {
        await refreshPromise;
        return true;
      },
    });

    try {
      const pendingEdit = harness.actions.beginEditUserMessage('turn-1');
      while (harness.activeIdRef.current !== 'branch') await Promise.resolve();
      harness.actions.cancelRevisionDraft();
      resolveRefresh?.();
      await pendingEdit;

      assert.equal(harness.revisionDraftRef.current, null);
      assert.deepEqual(harness.infoToasts, []);
    } finally {
      harness.restoreWindow();
    }
  });

  it('cancels the active revision in state and clears only its composer', async () => {
    const harness = createHarness({ branchBeforeTurn: async () => session('branch') });

    try {
      await harness.actions.beginEditUserMessage('turn-1');
      harness.actions.refillRevisionComposer();
      harness.actions.cancelRevisionDraft();

      assert.equal(harness.revisionDraftRef.current, null);
      assert.equal(harness.revisionWrites.at(-1), null);
      assert.deepEqual(harness.composerCalls, ['Human-facing prompt', '<focus>', '']);
    } finally {
      harness.restoreWindow();
    }
  });
});
