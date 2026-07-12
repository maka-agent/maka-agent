import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ShellRunSnapshotResult, ShellRunUpdate } from '@maka/core';
import { mergeShellRunUpdates } from '../../renderer/shell-run-update-state.js';

test('ShellRun update state rejects a stale hydration result after a newer notification', () => {
  const current = mergeShellRunUpdates({}, [update(3)]);
  const afterStaleHydration = mergeShellRunUpdates(current, [update(2)]);
  assert.equal(afterStaleHydration, current);
  assert.equal(afterStaleHydration.session?.bash?.result.revision, 3);

  const afterNewerNotification = mergeShellRunUpdates(current, [update(4)]);
  assert.notEqual(afterNewerNotification, current);
  assert.equal(afterNewerNotification.session?.bash?.result.revision, 4);
});

function update(revision: number): ShellRunUpdate {
  return {
    sessionId: 'session',
    sourceTurnId: 'turn',
    sourceToolCallId: 'bash',
    result: shellRun(revision),
  };
}

function shellRun(revision: number): ShellRunSnapshotResult {
  return {
    kind: 'shell_run',
    ref: 'maka://runtime/background-tasks/pty',
    mode: 'pty',
    status: 'running',
    cwd: '/repo',
    cmd: 'job',
    startedAt: 1,
    updatedAt: revision,
    revision,
    output: {
      mode: 'pty',
      screen: 'ready',
      scrollback: '',
      cols: 80,
      rows: 24,
      cursor: { x: 5, y: 0, visible: true },
      alternateScreen: false,
      truncated: false,
      redacted: false,
    },
  };
}
