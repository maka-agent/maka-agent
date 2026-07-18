import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { join } from 'node:path';

const repoRoot = process.cwd().endsWith('apps/desktop')
  ? join(process.cwd(), '..', '..')
  : process.cwd();

async function readRepo(path: string): Promise<string> {
  return readFile(join(repoRoot, path), 'utf8');
}

// Renderer modules are vite-bundled, not tsc'd into dist/main, so their
// notification wiring is guarded here with source-text assertions (the
// repo idiom for renderer contracts). Locks in the three review fixes on
// PR #617 against regression.
describe('run-complete notification renderer wiring contract', () => {
  it('notifies "completed" only for genuine successful stop reasons (PR #617 finding P2)', async () => {
    const source = await readRepo('apps/desktop/src/renderer/app-shell-session-events.ts');

    // The success notification must be behind an allowlist of terminal
    // stop reasons. A denylist like `!== 'permission_handoff'` would
    // double-fire a misleading success banner after `complete('error')`.
    assert.match(
      source,
      /stopReason === 'end_turn'[\s\S]{0,80}stopReason === 'max_tokens'[\s\S]{0,160}notifyRunEnded\?\.\(\{ kind: 'completed'/,
      'completed notification must be gated on an end_turn/max_tokens allowlist',
    );
    assert.doesNotMatch(
      source,
      /stopReason !== 'permission_handoff'[\s\S]{0,120}notifyRunEnded\?\.\(\{ kind: 'completed'/,
      'completed notification must not fire on any non-handoff complete (incl. error/user_stop)',
    );

    // The error path fires the error notification.
    assert.match(
      source,
      /notifyRunEnded\?\.\(\{ kind: 'errored', sessionId, body: sessionEventErrorMessage\(event, uiLocale\) \}\)/,
      'the error notification must use the same safe, reason-aware presentation as the toast',
    );
  });

  it('handles rejection on the fire-and-forget IPC call (PR #617 finding P3)', async () => {
    const source = await readRepo('apps/desktop/src/renderer/app-shell.tsx');
    assert.match(
      source,
      /window\.maka\.notifications\.runEnded\([\s\S]*?\)\.catch\(\(\) => \{\}\)/,
      'notifications.runEnded must attach a catch handler',
    );
  });
});
