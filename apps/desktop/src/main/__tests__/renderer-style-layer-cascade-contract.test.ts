import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { readAllRendererCss, readCssTree, RENDERER_STYLES_DIR, stripCssComments, STYLES_FILE } from './css-test-helpers.js';

/**
 * Returns the number of `@layer` blocks enclosing the first occurrence of
 * `selectorLine` in `styles`. 0 means the rule is unlayered.
 *
 * Author rules placed inside `@layer base`/`@layer components` sit BELOW
 * Tailwind v4's `utilities` layer in the cascade, so they lose to any
 * utility class on the same element regardless of specificity.
 */
function enclosingLayerCount(styles: string, selectorLine: string): number {
  const lines = styles.split('\n');
  let depth = 0;
  const layerOpenDepths: number[] = [];
  for (const line of lines) {
    if (line.trim() === selectorLine) return layerOpenDepths.length;
    if (/^\s*@layer\s+[\w, ]+\{/.test(line)) {
      layerOpenDepths.push(depth);
      depth += (line.match(/\{/g)?.length ?? 0) - (line.match(/\}/g)?.length ?? 0);
      continue;
    }
    for (const ch of line) {
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (layerOpenDepths.length > 0 && depth === layerOpenDepths[layerOpenDepths.length - 1]) {
          layerOpenDepths.pop();
        }
      }
    }
  }
  return -1; // selector not found
}

describe('renderer style layer cascade contract', () => {
  it('keeps feature stylesheets unlayered so renderer author CSS has one cascade model', async () => {
    const layeredFiles: string[] = [];
    for (const file of await readCssTree(RENDERER_STYLES_DIR)) {
      const source = stripCssComments(await readFile(file, 'utf8'));
      if (/@layer\b/.test(source)) {
        layeredFiles.push(file);
      }
    }

    assert.deepEqual(
      layeredFiles,
      [],
      'Feature stylesheets under apps/desktop/src/renderer/styles must stay unlayered. Keep Tailwind layer integration in maka-tokens.css instead of mixing local @layer blocks with unlayered override rules.',
    );
  });

  /**
   * Regression guard for #257 / #253 Round A.
   *
   * The sidebar nav rows render as `<UiButton size="nav" className="maka-nav-row">`
   * (packages/ui/src/components.tsx). The cva button base always carries the
   * Tailwind utilities `inline-flex items-center justify-center`, and the
   * `nav` size variant deliberately contributes NO layout utilities so that
   * `.maka-nav-row` (display: grid + grid-template-columns + text-align: left)
   * is the layout source of truth.
   *
   * That only holds while `.maka-nav-row` outranks the utilities. #257 wrapped
   * styles.css into `@layer base`/`@layer components`; because Tailwind v4
   * orders `base, components, utilities`, the layered `.maka-nav-row` lost to
   * `inline-flex justify-center`, collapsing every sidebar button (nav rows,
   * session rows, settings) to flex-centered content. Keep these override
   * rules unlayered (or in a layer declared AFTER utilities) so they win.
  */
  it('keeps .maka-nav-row out of any @layer so it beats Tailwind button utilities', async () => {
    const styles = await readAllRendererCss();
    const layers = enclosingLayerCount(styles, '.maka-nav-row {');
    assert.notEqual(layers, -1, '.maka-nav-row { rule not found in styles.css');
    assert.equal(
      layers,
      0,
      `.maka-nav-row is nested in ${layers} @layer block(s); it must stay unlayered to ` +
        'override the cva button base utilities (inline-flex/justify-center). See #257 regression.',
    );
  });

  it('keeps .settingsHealthRefresh out of any @layer so it can override secondary Button utilities', async () => {
    const styles = await readAllRendererCss();
    const layers = enclosingLayerCount(styles, '.settingsHealthRefresh {');
    assert.notEqual(layers, -1, '.settingsHealthRefresh { rule not found in renderer CSS');
    assert.equal(
      layers,
      0,
      '.settingsHealthRefresh must stay unlayered because it overrides the shared secondary Button utility stack (background/border/padding/color).',
    );
  });

  it('keeps .settingsPermissionRefresh out of any @layer so it can override secondary Button utilities', async () => {
    const styles = await readAllRendererCss();
    const layers = enclosingLayerCount(styles, '.settingsPermissionRefresh {');
    assert.notEqual(layers, -1, '.settingsPermissionRefresh { rule not found in renderer CSS');
    assert.equal(
      layers,
      0,
      '.settingsPermissionRefresh must stay unlayered because it overrides the shared secondary Button utility stack (background/border/padding/color).',
    );
  });

  /**
   * Regression guard for #618 item 1.
   *
   * markdown-link.css decorates <a>/<button>/<span> nodes that render INSIDE
   * the prose layer (`.maka-prose`, imported via layer(components)). Unlayered
   * author rules beat every layer regardless of specificity, so an unlayered
   * `.maka-markdown-link-external { text-decoration: underline }` silently
   * defeats the layered `.maka-prose a { text-decoration: none }` while the
   * layered border-bottom hairline still applies — every external prose link
   * paints two underlines a few px apart. Inside layer(components),
   * `.maka-prose a` (0,1,1) outweighs `.maka-markdown-link-external` (0,1,0)
   * and the prose treatment wins; the internal (<button>) and broken (<span>)
   * variants never matched `.maka-prose a` and keep their own styling.
   */
  it('imports markdown-link.css into layer(components) so .maka-prose a beats the external-link underline', async () => {
    const styles = stripCssComments(await readFile(STYLES_FILE, 'utf8'));
    const importLine = styles.split('\n').find((line) => line.includes('./styles/markdown-link.css'));
    assert.ok(importLine, 'styles.css must import ./styles/markdown-link.css');
    assert.match(
      importLine,
      /@import\s+"\.\/styles\/markdown-link\.css"\s+layer\(components\)\s*;/,
      'markdown-link.css must be imported with layer(components): unlayered, its text-decoration: underline beats the layered .maka-prose a { text-decoration: none } and external prose links paint two underlines (#618 item 1)',
    );
  });

  it('keeps the darwin glass .maka-nav-row color override out of any @layer so it beats quiet Button text utilities', async () => {
    const styles = await readAllRendererCss();
    const layers = enclosingLayerCount(styles, 'html[data-os="darwin"] .maka-nav-row {');
    assert.notEqual(layers, -1, 'darwin .maka-nav-row glass rule not found in renderer CSS');
    assert.equal(
      layers,
      0,
      'html[data-os="darwin"] .maka-nav-row must stay unlayered because the glass theme needs to override shared quiet Button text utilities on the same element.',
    );
  });
});
