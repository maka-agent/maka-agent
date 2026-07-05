import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');

async function readChatModelSwitcherSource(): Promise<string> {
  return readFile(resolve(REPO_ROOT, 'packages/ui/src/chat-model-switcher.tsx'), 'utf8');
}

describe('model thinking-level picker contract', () => {
  it('labels GPT thinking efforts as low/medium/high/xhigh in Chinese', async () => {
    const source = await readChatModelSwitcherSource();

    assert.match(source, /minimal:\s*'最小'/, 'minimal reasoning effort should render as 最小');
    assert.match(source, /low:\s*'低'/, 'low reasoning effort should render as 低');
    assert.match(source, /medium:\s*'中'/, 'medium reasoning effort should render as 中');
    assert.match(source, /high:\s*'高'/, 'high reasoning effort should render as 高');
    assert.match(source, /xhigh:\s*'超高'/, 'xhigh reasoning effort should render as 超高');
    assert.match(source, /max:\s*'最高'/, 'max reasoning effort should render as 最高');
  });

  it('commits flyout choices on pointerdown before the host select can dismiss the portal', async () => {
    const source = await readChatModelSwitcherSource();

    assert.match(source, /function ThinkingFlyoutItem/, 'ThinkingFlyoutItem must remain the flyout choice seam');
    assert.match(
      source,
      /onPointerDownCapture=\{\(event\) => \{[\s\S]*closest<HTMLButtonElement>\('\[data-thinking-level\]'\)[\s\S]*event\.preventDefault\(\);[\s\S]*event\.stopPropagation\(\);[\s\S]*choose\([\s\S]*\);[\s\S]*\}\}/,
      'thinking-level flyout must commit during capture before stopping propagation because the portaled host Select can dismiss the flyout before click fires',
    );
    assert.match(
      source,
      /data-thinking-level=\{props\.level \?\? 'default'\}/,
      'thinking-level flyout items must expose their level to the capture boundary that commits real pointer selections',
    );
    assert.match(
      source,
      /onClick=\{\(event\) => \{[\s\S]*event\.detail === 0[\s\S]*props\.onSelect\(\);[\s\S]*\}\}/,
      'thinking-level flyout items must keep keyboard/screen-reader activation via click without double-firing pointer selections',
    );
    assert.doesNotMatch(
      source,
      /onClick=\{props\.onSelect\}/,
      'thinking-level flyout choices must not depend on a bare click handler; real pointer clicks lose click when the host Select closes first',
    );
  });

  it('closes the host model menu after a thinking-level choice commits', async () => {
    const source = await readChatModelSwitcherSource();

    assert.match(
      source,
      /onCommit\?\(\): void;/,
      'ThinkingLevelSection must expose a commit hook so the host Select can close after a level is chosen',
    );
    assert.match(
      source,
      /const choose = \(level: ThinkingLevel \| undefined\) => \{[\s\S]*setOpen\(false\);[\s\S]*props\.onCommit\?\.\(\);[\s\S]*void props\.onChange\?\.\(level\);[\s\S]*\};/,
      'thinking-level choices must close both the side flyout and the host model Select before dispatching the change',
    );

    const thinkingLevelSections = source.match(/<ThinkingLevelSection[\s\S]*?\/>/g) ?? [];
    assert.equal(thinkingLevelSections.length, 2, 'both the session switcher and new-chat picker should render ThinkingLevelSection');
    for (const section of thinkingLevelSections) {
      assert.match(
        section,
        /onCommit=\{\(\) => setSelectOpen\(false\)\}/,
        'each ThinkingLevelSection caller must close its owning SelectRoot after a thinking-level choice',
      );
    }
  });

  it('keeps the thinking-level flyout inside the viewport when opened near the bottom edge', async () => {
    const source = await readChatModelSwitcherSource();

    assert.match(
      source,
      /const THINKING_FLYOUT_VIEWPORT_MARGIN = 8;/,
      'thinking-level flyout positioning must reserve a viewport edge margin',
    );
    assert.match(
      source,
      /const flyoutRef = useRef<HTMLDivElement>\(null\);/,
      'thinking-level flyout must keep a ref so it can measure its rendered height',
    );
    assert.match(
      source,
      /window\.innerHeight[\s\S]*flyoutRef\.current\?\.offsetHeight[\s\S]*viewportHeight - THINKING_FLYOUT_VIEWPORT_MARGIN - renderedHeight[\s\S]*Math\.min\(row\.top, bottomSafeTop\)/,
      'thinking-level flyout top must be clamped against the measured rendered height and viewport bottom',
    );
    assert.match(
      source,
      /style=\{\{[\s\S]*top: anchor\.top,[\s\S]*maxHeight: anchor\.maxHeight,[\s\S]*overflowY: 'auto'[\s\S]*\}\}/,
      'thinking-level flyout must cap its height and scroll if the viewport cannot fit every level',
    );
  });
});
