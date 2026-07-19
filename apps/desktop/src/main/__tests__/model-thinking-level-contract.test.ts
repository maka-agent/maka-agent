import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');

async function readModelPickerSources(): Promise<string> {
  const [switcher, picker] = await Promise.all([
    readFile(resolve(REPO_ROOT, 'packages/ui/src/chat-model-switcher.tsx'), 'utf8'),
    readFile(resolve(REPO_ROOT, 'packages/ui/src/model-picker.tsx'), 'utf8'),
  ]);
  return `${switcher}\n${picker}`;
}

async function readModelPickerCss(): Promise<string> {
  const [switcher, settingsSelect] = await Promise.all([
    readFile(resolve(REPO_ROOT, 'apps/desktop/src/renderer/styles/model-switcher.css'), 'utf8'),
    readFile(resolve(REPO_ROOT, 'apps/desktop/src/renderer/styles/settings/select.css'), 'utf8'),
  ]);
  return `${switcher}\n${settingsSelect}`;
}

describe('model thinking-level picker contract', () => {
  it('labels thinking efforts through the locale catalog', async () => {
    const [source, copy] = await Promise.all([
      readModelPickerSources(),
      readFile(resolve(REPO_ROOT, 'packages/ui/src/conversation-copy.ts'), 'utf8'),
    ]);

    assert.match(source, /copy\.level\[level\]/, 'thinking choices must render from the resolved locale catalog');
    assert.match(copy, /minimal:\s*'最小'/, 'minimal reasoning effort should render as 最小');
    assert.match(copy, /low:\s*'低'/, 'low reasoning effort should render as 低');
    assert.match(copy, /medium:\s*'中'/, 'medium reasoning effort should render as 中');
    assert.match(copy, /high:\s*'高'/, 'high reasoning effort should render as 高');
    assert.match(copy, /xhigh:\s*'超高'/, 'xhigh reasoning effort should render as 超高');
    assert.match(copy, /max:\s*'最高'/, 'max reasoning effort should render as 最高');
    assert.match(copy, /minimal:\s*'Minimal'/, 'English catalog must define minimal reasoning effort');
  });

  it('renders model picker popups as a fixed shell, a scrollable model list, and a footer action', async () => {
    const source = await readModelPickerSources();
    const css = await readModelPickerCss();

    assert.match(source, /footer\?\(context: \{ open: boolean; close\(\): void \}\): ReactNode;/, 'ModelPicker must expose a static footer slot');
    assert.match(source, /<BaseCombobox\.List className="modelPickerList">/, 'only the model rows render in the Base UI Combobox list');
    assert.match(source, /props\.footer\?\.\(\{[\s\S]*open,[\s\S]*close: \(\) => \{[\s\S]*setOpen\(false\);[\s\S]*setQuery\(''\);/, 'closing through the footer must clear the search query');
    assert.equal(source.match(/footer=\{\(\{ open, close \}\) => \(/g)?.length, 2, 'both model pickers must render the thinking section through ModelPicker footer');
    assert.doesNotMatch(source, /<SelectPopup className="settingsSelectMenuPopup">/, 'model pickers should not use the generic scrolling select popup directly');
    assert.doesNotMatch(source, /<SelectList>/, 'model pickers should not let the generic SelectList own this popup scroll');

    assert.match(
      css,
      /\.modelPickerPopup \{[\s\S]*?display:\s*flex;[\s\S]*?flex-direction:\s*column;[\s\S]*?overflow:\s*hidden;[\s\S]*?\}/,
      'the model picker popup shell must not scroll; it owns chrome and clips the list',
    );
    assert.match(
      css,
      /\.modelPickerList \{[\s\S]*?flex:\s*1 1 auto;[\s\S]*?min-height:\s*0;[\s\S]*?overflow-y:\s*auto;[\s\S]*?\}/,
      'only the model list should scroll inside the fixed popup shell',
    );
    assert.match(
      css,
      /\.maka-thinking-section \{[\s\S]*?flex:\s*0 0 auto;[\s\S]*?padding:\s*0 var\(--space-2\) var\(--space-2\);[\s\S]*?background:\s*var\(--background\);[\s\S]*?\}/,
      'the thinking section should be a normal footer, not sticky scroll content',
    );
    assert.doesNotMatch(css, /\.maka-thinking-section \{[\s\S]*?position:\s*sticky/, 'the thinking footer must not be sticky content inside the scroll range');
    assert.doesNotMatch(css, /bottom:\s*calc\(-1 \* var\(--space-2\)\)/, 'no negative-bottom padding hack should remain');
  });

  it('renders the side flyout as a Base UI Menu anchored to the row', async () => {
    const source = await readModelPickerSources();

    assert.match(source, /<Menu\s+open=\{open\}\s+onOpenChange=\{setOpen\}>/, 'flyout must be a controlled Base UI Menu');
    assert.match(source, /<MenuTrigger[\s\S]*?render=\{\(triggerProps\) =>/, 'trigger must render-prop the row div');
    assert.match(source, /<MenuPopup[\s\S]*className="maka-thinking-flyout"/, 'flyout popup uses MenuPopup');
    assert.match(
      source,
      /<MenuPopup[\s\S]*className="maka-thinking-flyout"[\s\S]*align="start"[\s\S]*side="inline-end"[\s\S]*sideOffset=\{8\}/,
      'flyout side offset must match the host popup padding so it starts at the popup outer edge, not inside it',
    );
    assert.match(source, /<MenuItem[\s\S]*?onClick=\{\(\) => choose\(/, 'levels render as MenuItems that call choose');
    assert.doesNotMatch(source, /onPointerDownCapture/, 'no pointerdown commit hack — Menu handles dismiss');
    assert.doesNotMatch(source, /THINKING_FLYOUT_VIEWPORT_MARGIN/, 'no hand-rolled viewport clamp — floating-ui positions');
    assert.doesNotMatch(source, /createPortal/, 'no manual portal — MenuPortal does it');
  });

  it('does not swallow ordinary outside presses while protecting clicks inside the portaled thinking flyout', async () => {
    const source = await readModelPickerSources();

    assert.doesNotMatch(
      source,
      /if \(!open && details\.reason === 'outside-press'\) return;/,
      'model pickers must not make every outside press a no-op; ordinary outside clicks should close the picker',
    );
    assert.match(source, /target\.closest\('\[data-model-picker-nested-popup\]'\)/, 'outside-press protection must be target-specific to nested portaled popups');
    assert.match(source, /data-model-picker-nested-popup=""/, 'the thinking flyout marks itself as a nested model-picker popup');
    assert.match(source, /details\.cancel\(\);/, 'guarded flyout presses should cancel Base UI closing instead of ignoring all outside presses');
  });

  it('closes the host model menu after a thinking-level choice commits', async () => {
    const source = await readModelPickerSources();

    assert.match(source, /onCommit\?\(\): void;/, 'ThinkingLevelSection must expose a commit hook');
    assert.match(
      source,
      /const choose = \(level: ThinkingLevel \| undefined\) => \{[\s\S]*props\.onCommit\?\.\(\);[\s\S]*void props\.onChange\?\.\(level\);[\s\S]*\};/,
      'choose commits then dispatches the change; the Menu closes itself via onOpenChange',
    );

    const sections = source.match(/<ThinkingLevelSection[\s\S]*?\/>/g) ?? [];
    assert.equal(sections.length, 2, 'both the session switcher and new-chat picker render ThinkingLevelSection');
    for (const section of sections) {
      assert.match(
        section,
        /onCommit=\{close\}/,
        'each caller closes its owning ModelPicker after a thinking-level choice',
      );
    }
  });

  it('closes the flyout when the host ModelPicker closes', async () => {
    const source = await readModelPickerSources();

    assert.match(
      source,
      /if \(!props\.parentOpen\) setOpen\(false\)/,
      'flyout must close when the host ModelPicker closes so the portaled Menu is not orphaned',
    );
  });
});
