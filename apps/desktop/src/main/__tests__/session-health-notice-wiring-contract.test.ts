/**
 * Static-analysis contract for the session-health-notice renderer
 * wiring (#1038 review).
 *
 * The notice's freshness depends on three pieces of glue that no type
 * error would catch if deleted: the connections-revision bump that
 * re-runs the secret probe even when the connection list keeps its
 * identity (credential-only changes don't bump `updatedAt`), the
 * probe effect's dependency on that revision, and the effective
 * `connectionLocked` (summary bit OR a user message in the loaded
 * transcript) that closes the window where storage has not yet
 * self-healed a just-opened legacy session's summary. Pin all three
 * so a future refactor cannot silently break the chain.
 *
 * This is a source-grep contract, not a DOM render — we don't pull
 * React into the desktop test runner.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(process.cwd(), '..', '..');
const SHELL_CONNECTIONS_SOURCE = resolve(REPO_ROOT, 'apps', 'desktop', 'src', 'renderer', 'use-shell-connections.ts');
const SHELL_CHAT_MODEL_SOURCE = resolve(REPO_ROOT, 'apps', 'desktop', 'src', 'renderer', 'use-shell-chat-model.ts');
const APP_SHELL_SOURCE = resolve(REPO_ROOT, 'apps', 'desktop', 'src', 'renderer', 'app-shell.tsx');

describe('session health notice wiring contract (#1038 review)', () => {
  it('bumps connectionsRevision on every successful refresh, past the connectionsEqual dedup', async () => {
    const src = await readFile(SHELL_CONNECTIONS_SOURCE, 'utf8');
    assert.match(
      src,
      /setConnections\(\(prev\) => connectionsEqual\(prev, next\) \? prev : next\);[\s\S]*?setConnectionsRevision\(\(revision\) => revision \+ 1\);/,
      'refreshConnections must bump connectionsRevision even when the list identity is kept — credential-only changes (external credentials.json edits) do not bump updatedAt, so the revision is the only signal that cheap derived probes must re-run',
    );
  });

  it('runs the secret probe effect on connectionsRevision, not just the connection list', async () => {
    const src = await readFile(SHELL_CHAT_MODEL_SOURCE, 'utf8');
    const probeEffect = src.match(/Promise\.all\([\s\S]*?connections\.hasSecret[\s\S]*?\}, \[[^\]]*\]\);/);
    assert.ok(probeEffect, 'the secret probe effect must exist');
    assert.match(
      probeEffect[0],
      /\}, \[connections, connectionsRevision\]\);/,
      'the secret probe must depend on connectionsRevision so credential-only refreshes re-probe instead of serving stale presence',
    );
  });

  it('derives the effective connectionLocked from the summary bit OR the loaded transcript', async () => {
    const src = await readFile(SHELL_CHAT_MODEL_SOURCE, 'utf8');
    assert.match(
      src,
      /connectionLocked: activeSession\.connectionLocked \|\| activeSessionHasUserMessage/,
      'the notice must use the effective lock: storage self-heals connectionLocked only on readHeader/readMessages, so a just-opened legacy session needs the loaded transcript (the same primary evidence) to avoid being treated as rebindable',
    );

    const appShell = await readFile(APP_SHELL_SOURCE, 'utf8');
    assert.match(
      appShell,
      /activeSessionHasUserMessage: !messageLoadPending && messages\.some\(\(message\) => message\.type === 'user'\)/,
      'AppShell must feed the transcript-derived lock only once the active session’s messages finished loading, so a stale or half-loaded list never produces a false lock',
    );
  });
});
