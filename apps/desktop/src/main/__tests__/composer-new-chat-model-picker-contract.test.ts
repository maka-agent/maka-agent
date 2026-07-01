/**
 * Home / empty-state composer model picker.
 *
 * Regression guard for the bug where the model chip below the home composer
 * showed a chevron (and a "选择模型" label) but was a dead `<span>` — clicking
 * it did nothing because the interactive `ChatModelSwitcher` is bound to a live
 * session and the no-session branch fell back to a static chip. The fix routes
 * the no-session branch to an interactive `NewChatModelPicker` whose pick is
 * forwarded to `sessions.create`, so the next new chat starts on the chosen
 * model. This locks:
 *   - the no-session branch renders the interactive picker (not a dead chip);
 *   - the picker does NOT hand-add a second chevron (SelectTrigger owns it);
 *   - both pickers share one `ModelChoiceOptions` list (no duplicated JSX);
 *   - main.tsx wires the pick and forwards it to sessions.create.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { join } from 'node:path';
import { readRendererShellCombinedSource } from './renderer-shell-source-helpers.js';

const repoRoot = process.cwd().endsWith('apps/desktop')
  ? join(process.cwd(), '..', '..')
  : process.cwd();

async function readRepo(path: string): Promise<string> {
  return readFile(join(repoRoot, path), 'utf8');
}

describe('home composer new-chat model picker', () => {
  it('renders an interactive picker (not a dead chip) on the no-session branch', async () => {
    // The pickers live in `chat-model-switcher.tsx`; the composer renders
    // them from `composer.tsx`. Search the union so the contract holds across
    // the seam.
    const ui =
      (await readRepo('packages/ui/src/composer.tsx')) +
      '\n' +
      (await readRepo('packages/ui/src/chat-model-switcher.tsx'));

    // The no-session branch must route to the interactive picker when a pick
    // handler and choices exist, keeping the static chip only as the
    // no-choices fallback.
    assert.match(
      ui,
      /\) : props\.onPickNewChatModel && \(props\.modelChoices\?\.length \?\? 0\) > 0 \? \(\s*<NewChatModelPicker/,
      'composer no-session branch must render <NewChatModelPicker> when a pick handler + choices are present',
    );

    const picker = ui.match(/function NewChatModelPicker\(props: \{[\s\S]*?\}\) \{[\s\S]*?\n\}/)?.[0] ?? '';
    assert.notEqual(picker, '', 'NewChatModelPicker component must exist');
    // Interactive: built on SelectRoot, fires the pick on value change.
    assert.match(picker, /<SelectRoot<string>/, 'NewChatModelPicker must be a real SelectRoot dropdown');
    assert.match(picker, /props\.onPick\(next\)/, 'NewChatModelPicker must call onPick with the chosen model');
    // No hand-added chevron — SelectTrigger renders its own BaseSelect.Icon.
    assert.doesNotMatch(
      picker,
      /<ChevronDown/,
      'NewChatModelPicker must not hand-add a chevron (SelectTrigger already renders one) — guards the double-chevron regression',
    );
  });

  it('shares one ModelChoiceOptions list between both model pickers', async () => {
    // The pickers live in `chat-model-switcher.tsx`; the composer renders
    // them from `composer.tsx`. Search the union so the contract holds across
    // the seam.
    const ui =
      (await readRepo('packages/ui/src/composer.tsx')) +
      '\n' +
      (await readRepo('packages/ui/src/chat-model-switcher.tsx'));
    assert.match(ui, /function ModelChoiceOptions\(\{\s*groups,/, 'shared ModelChoiceOptions list component must exist');
    const usages = ui.match(/<ModelChoiceOptions groups=\{grouped\} renderProviderMark=\{props\.renderProviderMark\} \/>/g) ?? [];
    assert.equal(
      usages.length,
      2,
      'both ChatModelSwitcher and NewChatModelPicker must render the shared <ModelChoiceOptions> (no duplicated grouped list)',
    );
  });

  it('wires the pick and forwards the chosen model to sessions.create', async () => {
    const renderer = await readRendererShellCombinedSource();

    assert.match(
      renderer,
      /const \[pendingNewChatModel, setPendingNewChatModel\] = useState</,
      'main.tsx must hold the picked new-chat model in state',
    );
    assert.match(
      renderer,
      /onPickNewChatModel=\{\(input\) => setPendingNewChatModel\(input\)\}/,
      'main.tsx must wire the composer pick to setPendingNewChatModel',
    );
    // A pick only stays in effect while it is still an offered choice; once the
    // connection/model is removed the picker must fall back to the default so it
    // never shows — nor sends — a model sessions.create would reject.
    assert.match(
      renderer,
      /const validPendingNewChatModel\s*=[\s\S]*?chatModelChoices\.some\(/,
      'main.tsx must drop a stale pendingNewChatModel that is no longer an offered choice',
    );
    // send() forwards only the *validated* pick to sessions.create; absence
    // keeps the backend default behavior unchanged.
    assert.match(
      renderer,
      /\.\.\.\(validPendingNewChatModel\s*\?\s*\{ llmConnectionSlug: validPendingNewChatModel\.llmConnectionSlug, model: validPendingNewChatModel\.model \}/,
      'send() must forward the validated picked model to sessions.create when one was chosen',
    );
  });

  it('wires the picked new-chat permission mode to one sessions.create call only', async () => {
    const renderer = await readRendererShellCombinedSource();
    const setPermissionModeBlock = renderer.match(/async function setPermissionMode[\s\S]*?async function setSessionModel/)?.[0] ?? '';
    const sendBlock = renderer.match(/async function send\(text: string\): Promise<boolean> \{[\s\S]*?\n  async function importTextFilePrompt/)?.[0] ?? '';

    assert.match(
      renderer,
      /const \[pendingNewChatPermissionMode, setPendingNewChatPermissionMode\] = useState<PermissionMode \| null>\(null\)/,
      'AppShell must keep the picked empty-state permission mode in renderer-only state',
    );
    assert.match(
      setPermissionModeBlock,
      /if \(!sessionId\) \{[\s\S]*setPendingNewChatPermissionMode\(mode\);[\s\S]*return;[\s\S]*\}/,
      'permission-mode picks without an active session must update pendingNewChatPermissionMode instead of calling IPC',
    );
    assert.match(
      sendBlock,
      /permissionMode: pendingNewChatPermissionMode \?\? 'ask'/,
      'new-chat sessions.create must receive the picked pending permission mode',
    );
    assert.match(
      sendBlock,
      /setPendingNewChatPermissionMode\(null\);/,
      'pending new-chat permission mode must be one-shot and reset after creating a session',
    );
  });

  it('does not let stale new-chat send creation steal the active session after navigation', async () => {
    const renderer = await readRendererShellCombinedSource();
    const sendBlock = renderer.match(/async function send\(text: string\): Promise<boolean> \{[\s\S]*?\n  async function importTextFilePrompt/)?.[0] ?? '';

    assert.match(
      renderer,
      /function isNewChatSendSurfaceActive\(owner: ComposerImportOwner\): boolean \{[\s\S]*owner\.sessionId === undefined[\s\S]*navSelectionRef\.current\.section === 'sessions'[\s\S]*activeIdRef\.current === undefined[\s\S]*\}/,
      'new-chat sends must capture the empty-chat surface before async session creation',
    );
    assert.match(
      sendBlock,
      /const newChatOwner = initialSessionId \? null : captureComposerImportOwner\(\);/,
      'send() must capture the no-active-session composer owner before sessions.create()',
    );
    assert.match(sendBlock, /upsertSessionSummary\(session\);/);
    assert.match(
      sendBlock,
      /if \(newChatOwner && isNewChatSendSurfaceActive\(newChatOwner\)\) \{[\s\S]*setNavSelection\(\{ section: 'sessions', filter: 'chats' \}\);[\s\S]*setActiveId\(session\.id\);[\s\S]*showOptimisticUserMessage\(session\.id, turnId, text, \{ replaceCurrentMessages: true \}\);[\s\S]*\}/,
      'newly-created sessions may only become active if the user is still on the original empty new-chat surface',
    );
    assert.match(
      sendBlock,
      /await window\.maka\.sessions\.send\(session\.id, \{ type: 'send', turnId, text \}\);[\s\S]*if \(activeIdRef\.current === session\.id\) \{[\s\S]*await refreshMessagesUntilTurn\(session\.id, turnId\);[\s\S]*\}[\s\S]*await refreshSessions\(\);/,
      'background new-chat sends should continue and refresh the list, but must not poll messages unless the created session is active',
    );
  });
});
