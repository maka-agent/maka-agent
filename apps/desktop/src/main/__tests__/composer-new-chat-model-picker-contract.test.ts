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

const repoRoot = process.cwd().endsWith('apps/desktop')
  ? join(process.cwd(), '..', '..')
  : process.cwd();

async function readRepo(path: string): Promise<string> {
  return readFile(join(repoRoot, path), 'utf8');
}

describe('home composer new-chat model picker', () => {
  it('renders an interactive picker (not a dead chip) on the no-session branch', async () => {
    const ui = await readRepo('packages/ui/src/components.tsx');

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
    const ui = await readRepo('packages/ui/src/components.tsx');
    assert.match(ui, /function ModelChoiceOptions\(\{ groups \}/, 'shared ModelChoiceOptions list component must exist');
    const usages = ui.match(/<ModelChoiceOptions groups=\{grouped\} \/>/g) ?? [];
    assert.equal(
      usages.length,
      2,
      'both ChatModelSwitcher and NewChatModelPicker must render the shared <ModelChoiceOptions> (no duplicated grouped list)',
    );
  });

  it('wires the pick and forwards the chosen model to sessions.create', async () => {
    const renderer = await readRepo('apps/desktop/src/renderer/main.tsx');

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
});
