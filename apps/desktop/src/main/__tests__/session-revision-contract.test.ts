import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { readRendererShellSource } from './renderer-shell-source-helpers.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');

describe('session revision (edit-and-resend) contract', () => {
  it('prepares a before-turn branch and refills the composer from user-facing text', async () => {
    const source = await readRendererShellSource('app-shell-revision-actions.ts');
    assert.match(source, /branchBeforeTurn\(sessionId, \{\s*sourceTurnId: turnId/);
    assert.match(source, /userFacingText\(userMessage\)/);
    assert.match(source, /if \(userMessage\.attachments && userMessage\.attachments\.length > 0\)/);
    assert.match(source, /userMessage\.displayText !== undefined && userMessage\.displayText !== userMessage\.text/);
    assert.match(source, /composerRef\.current\?\.setText\(draft\.originalText\)/);
    assert.match(
      source,
      /if \(!draft \|\| activeIdRef\.current !== draft\.draftSessionId\) return;/,
      'composer refill must be gated to the still-active branch session',
    );
    assert.match(
      source,
      /if \(activeIdRef\.current !== sessionId\) \{[\s\S]*await refreshSessions\(\);[\s\S]*return;/,
      'must not steal focus after the user leaves the source session mid-branch',
    );
  });

  it('wires edit affordance + revision banner through the shell', async () => {
    const shell = await readRendererShellSource('app-shell.tsx');
    assert.match(shell, /onEditUserMessage=\{\(turnId\) => \{ void beginEditUserMessage\(turnId\); \}\}/);
    assert.match(shell, /revisionNotice=\{/);
    assert.match(shell, /queueMicrotask\(refillRevisionComposer\)/);
    assert.match(shell, /cancelRevisionDraft/);
    assert.match(shell, /createAppShellRevisionActions/);
    assert.doesNotMatch(shell, /messagesRef/);
  });

  it('keeps edit disabled for the live tail before terminal state is durable', async () => {
    const turn = await readFile(resolve(REPO_ROOT, 'packages/ui/src/chat-turn.tsx'), 'utf8');
    assert.match(
      turn,
      /editDisabled=\{[\s\S]*turn\.user\.attachments\?\.length[\s\S]*turn\.status === 'running'[\s\S]*!!props\.liveStreaming/,
    );
    assert.match(turn, /aria-disabled=\{props\.editDisabled === true/);
    assert.match(turn, /editMessageDisabledAttachments/);
    assert.match(turn, /editMessageDisabledTransformedText/);
    const view = await readFile(resolve(REPO_ROOT, 'packages/ui/src/chat-view.tsx'), 'utf8');
    assert.match(view, /message\.displayText !== undefined &&[\s\S]*message\.displayText !== message\.text/);
  });

  it('exposes branchBeforeTurn on the preload bridge', async () => {
    const preload = await readFile(resolve(REPO_ROOT, 'apps/desktop/src/preload/preload.ts'), 'utf8');
    const bridge = await readFile(
      resolve(REPO_ROOT, 'apps/desktop/src/preload/bridge-contract.d.ts'),
      'utf8',
    );
    assert.match(preload, /branchBeforeTurn\(sessionId: string, input: BranchFromTurnInput\)/);
    assert.match(preload, /sessions:branchBeforeTurn/);
    assert.match(bridge, /branchBeforeTurn\(sessionId: string, input: BranchFromTurnInput\)/);
  });
});
