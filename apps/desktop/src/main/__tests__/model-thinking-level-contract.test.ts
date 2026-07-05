import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');

async function readChatModelSwitcherSource(): Promise<string> {
  return readFile(resolve(REPO_ROOT, 'packages/ui/src/chat-model-switcher.tsx'), 'utf8');
}

async function readModelSwitcherCss(): Promise<string> {
  return readFile(resolve(REPO_ROOT, 'apps/desktop/src/renderer/styles/model-switcher.css'), 'utf8');
}

describe('model thinking-level picker contract', () => {
  it('labels thinking efforts in Chinese', async () => {
    const source = await readChatModelSwitcherSource();

    assert.match(source, /minimal:\s*'最小'/, 'minimal reasoning effort should render as 最小');
    assert.match(source, /low:\s*'低'/, 'low reasoning effort should render as 低');
    assert.match(source, /medium:\s*'中'/, 'medium reasoning effort should render as 中');
    assert.match(source, /high:\s*'高'/, 'high reasoning effort should render as 高');
    assert.match(source, /xhigh:\s*'超高'/, 'xhigh reasoning effort should render as 超高');
    assert.match(source, /max:\s*'最高'/, 'max reasoning effort should render as 最高');
  });

  it('renders the side flyout as a Base UI Menu anchored to the row', async () => {
    const source = await readChatModelSwitcherSource();

    // The flyout is a Base UI Menu (not a hand-rolled portaled div): MenuRoot
    // owns open state, MenuTrigger render-props the row so it stays the visible
    // button inside the host Select popup, MenuPopup is the portaled flyout,
    // and levels are MenuItems. floating-ui handles positioning/stacking/dismiss.
    assert.match(source, /<Menu\s+open=\{open\}\s+onOpenChange=\{setOpen\}>/, 'flyout must be a controlled Base UI Menu');
    assert.match(source, /<MenuTrigger[\s\S]*?render=\{\(triggerProps\) =>/, 'trigger must render-prop the row div');
    assert.match(source, /<MenuPopup\s+className="maka-thinking-flyout"/, 'flyout popup uses MenuPopup');
    assert.match(
      source,
      /<MenuPopup\s+className="maka-thinking-flyout"\s+align="start"\s+side="inline-end"\s+sideOffset=\{8\}>/,
      'flyout side offset must match the host popup padding so it starts at the popup outer edge, not inside it',
    );
    assert.match(source, /<MenuItem[\s\S]*?onClick=\{\(\) => choose\(/, 'levels render as MenuItems that call choose');
    // No hand-rolled positioning/commit hacks remain — Menu handles them.
    assert.doesNotMatch(source, /onPointerDownCapture/, 'no pointerdown commit hack — Menu handles dismiss');
    assert.doesNotMatch(source, /THINKING_FLYOUT_VIEWPORT_MARGIN/, 'no hand-rolled viewport clamp — floating-ui positions');
    assert.doesNotMatch(source, /createPortal/, 'no manual portal — MenuPortal does it');
  });

  it('covers the host popup bottom padding while the model list scrolls behind the sticky thinking row', async () => {
    const css = await readModelSwitcherCss();

    assert.match(
      css,
      /\.maka-thinking-section \{[\s\S]*?bottom:\s*calc\(-1 \* var\(--space-2\)\);[\s\S]*?padding-bottom:\s*var\(--space-2\);[\s\S]*?\}/,
      'the sticky thinking section must extend over the popup bottom padding so scrolling model rows cannot show through that 8px strip',
    );
  });

  it('closes the host model menu after a thinking-level choice commits', async () => {
    const source = await readChatModelSwitcherSource();

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
        /onCommit=\{\(\) => setSelectOpen\(false\)\}/,
        'each caller closes its owning SelectRoot after a thinking-level choice',
      );
    }
  });

  it('closes the flyout when the host Select closes', async () => {
    const source = await readChatModelSwitcherSource();

    assert.match(
      source,
      /if \(!props\.parentOpen\) setOpen\(false\)/,
      'flyout must close when the host Select closes so the portaled Menu is not orphaned',
    );
  });
});
