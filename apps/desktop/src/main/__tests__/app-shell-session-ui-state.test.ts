import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PermissionRequestEvent } from '@maka/core';
import { applyThinkingComplete, applyThinkingDelta } from '@maka/ui';
import {
  clearAppShellSessionUiStateForSession,
  createAppShellSessionUiStateController,
  createInitialAppShellSessionUiState,
  type AppShellSessionUiState,
} from '../../renderer/app-shell-session-ui-state.js';

function permissionRequest(requestId: string): PermissionRequestEvent {
  return {
    type: 'permission_request',
    id: `event-${requestId}`,
    ts: 1,
    requestId,
    toolUseId: `tool-${requestId}`,
    toolName: 'shell',
  } as unknown as PermissionRequestEvent;
}

function seededState(): AppShellSessionUiState {
  return {
    ...createInitialAppShellSessionUiState(),
    messageLoadErrorBySession: { drop: 'failed', keep: 'still failed' },
    messageRetryPendingBySession: { drop: true, keep: true },
    stopPendingBySession: { drop: true, keep: true },
    streamingBySession: {
      drop: { text: 'drop stream', truncated: false, phase: 'streaming' },
      keep: { text: 'keep stream', truncated: true, phase: 'draining', messageId: 'm-keep' },
    },
    thinkingBySession: { drop: 'drop thinking', keep: 'keep thinking' },
    thinkingTruncatedBySession: { drop: true, keep: true },
    liveToolsBySession: {
      drop: [{ toolUseId: 'tool-drop', toolName: 'Shell', status: 'running', args: {} }],
      keep: [{ toolUseId: 'tool-keep', toolName: 'Shell', status: 'pending', args: {} }],
    },
    permissionBySession: {
      drop: [permissionRequest('drop')],
      keep: [permissionRequest('keep')],
    },
    sessionEventHealthBySession: {
      drop: { sessionId: 'drop', status: 'connected', subscribedAt: 1, checkedAt: 1 },
      keep: { sessionId: 'keep', status: 'stale', subscribedAt: 1, checkedAt: 2, staleSince: 2 },
    },
    pendingPermissionModeBySession: { drop: true, keep: true },
    pendingSessionModelBySession: { drop: true, keep: true },
  };
}

describe('app shell session UI state controller', () => {
  it('clears one session from every per-session UI map without touching other sessions', () => {
    const next = clearAppShellSessionUiStateForSession(seededState(), 'drop');

    assert.deepEqual(Object.keys(next.messageLoadErrorBySession), ['keep']);
    assert.deepEqual(Object.keys(next.messageRetryPendingBySession), ['keep']);
    assert.deepEqual(Object.keys(next.stopPendingBySession), ['keep']);
    assert.deepEqual(Object.keys(next.streamingBySession), ['keep']);
    assert.deepEqual(Object.keys(next.thinkingBySession), ['keep']);
    assert.deepEqual(Object.keys(next.thinkingTruncatedBySession), ['keep']);
    assert.deepEqual(Object.keys(next.liveToolsBySession), ['keep']);
    assert.deepEqual(Object.keys(next.permissionBySession), ['keep']);
    assert.deepEqual(Object.keys(next.sessionEventHealthBySession), ['keep']);
    assert.deepEqual(Object.keys(next.pendingPermissionModeBySession), ['keep']);
    assert.deepEqual(Object.keys(next.pendingSessionModelBySession), ['keep']);
  });

  it('keeps state identity for no-op map updates and only replaces the selected map', () => {
    const controller = createAppShellSessionUiStateController();
    const state = controller.getState();
    controller.setMessageLoadErrorBySession((current) => current);
    assert.equal(controller.getState(), state);

    controller.setMessageLoadErrorBySession((current) => ({ ...current, session: 'failed' }));
    const next = controller.getState();

    assert.notEqual(next, state);
    assert.deepEqual(next.messageLoadErrorBySession, { session: 'failed' });
    assert.equal(next.stopPendingBySession, state.stopPendingBySession);
    assert.equal(next.streamingBySession, state.streamingBySession);
  });

  it('preserves nested thinking flag updates from thinking delta and complete events', () => {
    const sessionId = 'thinking-session';
    const controller = createAppShellSessionUiStateController();

    controller.setThinkingBySession((current) => {
      const applied = applyThinkingDelta(current[sessionId] ?? '', 'x'.repeat(5 * 1024));
      if (applied.truncated) {
        controller.setThinkingTruncatedBySession((flags) =>
          flags[sessionId] ? flags : { ...flags, [sessionId]: true },
        );
      }
      return { ...current, [sessionId]: applied.text };
    });

    const afterDelta = controller.getState();
    assert.match(afterDelta.thinkingBySession[sessionId], /单条 delta 已截断/);
    assert.equal(afterDelta.thinkingTruncatedBySession[sessionId], true);

    controller.setThinkingBySession((current) => {
      const applied = applyThinkingComplete('final thinking');
      controller.setThinkingTruncatedBySession((flags) => {
        if ((flags[sessionId] === true) === applied.truncated) return flags;
        if (applied.truncated) return { ...flags, [sessionId]: true };
        const next = { ...flags };
        delete next[sessionId];
        return next;
      });
      return { ...current, [sessionId]: applied.text };
    });

    const afterComplete = controller.getState();
    assert.equal(afterComplete.thinkingBySession[sessionId], 'final thinking');
    assert.equal(afterComplete.thinkingTruncatedBySession[sessionId], undefined);
  });
});
