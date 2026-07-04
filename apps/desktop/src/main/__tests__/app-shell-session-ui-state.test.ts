import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PermissionRequestEvent } from '@maka/core';
import {
  appShellSessionUiStateReducer,
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

describe('app shell session UI state reducer', () => {
  it('clears one session from every per-session UI map without touching other sessions', () => {
    const next = appShellSessionUiStateReducer(seededState(), {
      type: 'clear-session',
      sessionId: 'drop',
    });

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
    const state = createInitialAppShellSessionUiState();
    const noop = appShellSessionUiStateReducer(state, {
      type: 'update-map',
      key: 'messageLoadErrorBySession',
      updater: (current) => current,
    });
    assert.equal(noop, state);

    const next = appShellSessionUiStateReducer(state, {
      type: 'update-map',
      key: 'messageLoadErrorBySession',
      updater: (current) => ({ ...current, session: 'failed' }),
    });

    assert.notEqual(next, state);
    assert.deepEqual(next.messageLoadErrorBySession, { session: 'failed' });
    assert.equal(next.stopPendingBySession, state.stopPendingBySession);
    assert.equal(next.streamingBySession, state.streamingBySession);
  });
});
