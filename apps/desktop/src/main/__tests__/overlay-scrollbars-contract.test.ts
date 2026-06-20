import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(process.cwd(), '..', '..');

function repoFile(path: string): Promise<string> {
  return readFile(resolve(REPO_ROOT, path), 'utf8');
}

describe('OverlayScrollbars integration contract', () => {
  it('keeps KingSora OverlayScrollbars as a shared UI dependency', async () => {
    const uiPackage = JSON.parse(await repoFile('packages/ui/package.json')) as {
      dependencies?: Record<string, string>;
    };
    const desktopPackage = JSON.parse(await repoFile('apps/desktop/package.json')) as {
      dependencies?: Record<string, string>;
    };
    const lockfile = await repoFile('package-lock.json');

    assert.ok(
      uiPackage.dependencies?.overlayscrollbars,
      '@maka/ui must own overlayscrollbars because it exports the scroll primitive',
    );
    assert.equal(
      desktopPackage.dependencies?.overlayscrollbars,
      undefined,
      '@maka/desktop should consume the @maka/ui primitive instead of owning a second direct dependency',
    );
    assert.match(lockfile, /"node_modules\/overlayscrollbars"/, 'lockfile must include the installed OverlayScrollbars package');
  });

  it('wraps the vendor library in a viewport-ref preserving React primitive', async () => {
    const src = await repoFile('packages/ui/src/overlay-scroll-area.tsx');

    assert.match(src, /from 'overlayscrollbars'/, 'OverlayScrollArea must import the real OverlayScrollbars package');
    assert.match(src, /theme:\s*'os-theme-maka'/, 'OverlayScrollArea must use the Maka scrollbar theme');
    assert.match(src, /autoHide:\s*'move'/, 'OverlayScrollArea should use target-layout like overlay scrollbars that appear on pointer motion');
    assert.match(src, /useImperativeHandle\(forwardedRef,[\s\S]*viewportRef\.current/, 'forwarded refs must point at the viewport for scrollTop/onScroll callers');
    assert.match(src, /elements:\s*\{[\s\S]*viewport,[\s\S]*content,[\s\S]*\}/, 'OverlayScrollbars must mount with explicit viewport/content elements');
  });

  it('backs shared primitive ScrollArea with OverlayScrollbars instead of Base UI scrollbars', async () => {
    const primitiveScrollArea = await repoFile('packages/ui/src/primitives/scroll-area.tsx');

    assert.match(primitiveScrollArea, /OverlayScrollArea/, 'shared primitive ScrollArea must render the shared OverlayScrollArea primitive');
    assert.doesNotMatch(primitiveScrollArea, /@base-ui\/react\/scroll-area/, 'shared primitive ScrollArea must not reintroduce Base UI ScrollArea');
  });

  it('loads vendor CSS and defines the Maka theme tokens', async () => {
    const styles = await repoFile('apps/desktop/src/renderer/styles.css');
    const tokens = await repoFile('apps/desktop/src/renderer/maka-tokens.css');

    assert.match(styles, /@import "overlayscrollbars\/overlayscrollbars\.css";/, 'renderer CSS must load OverlayScrollbars vendor styles');
    assert.match(styles, /\.os-theme-maka\s*\{[\s\S]*--os-size:\s*8px/, 'Maka theme must define compact 8px overlay scrollbars');
    assert.match(styles, /\.os-theme-maka\s*\{[\s\S]*--os-handle-bg:\s*var\(--border\)/, 'Maka theme must bind the handle to existing design tokens');
    assert.match(tokens, /Native fallback[\s\S]*OverlayScrollbars/, 'native scrollbar rules must be documented as fallback, not the primary app scroller');
  });

  it('migrates the primary app scroll surfaces onto OverlayScrollArea', async () => {
    const components = await repoFile('packages/ui/src/components.tsx');
    const settings = await repoFile('apps/desktop/src/renderer/settings/SettingsModal.tsx');

    assert.match(components, /import \{ OverlayScrollArea \} from '\.\/overlay-scroll-area\.js';/, 'main UI components must import OverlayScrollArea');
    assert.match(components, /<OverlayScrollArea[\s\S]*className="maka-list-stack"[\s\S]*contentClassName="maka-list-stackContent"/, 'sidebar session list must use OverlayScrollArea');
    assert.match(components, /<OverlayScrollArea[\s\S]*ref=\{scrollRef\}[\s\S]*className="maka-chat messages"[\s\S]*onScroll=\{onScroll\}/, 'active chat message list must keep its onScroll viewport handler on OverlayScrollArea');
    assert.match(settings, /OverlayScrollArea/, 'Settings content pane must use OverlayScrollArea');
    assert.match(settings, /<OverlayScrollArea[\s\S]*className="settingsPageContent"[\s\S]*contentClassName="settingsPageContentInner"/, 'Settings content pane must preserve its layout classes through OverlayScrollArea');
  });
});
