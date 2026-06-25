import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const REPO_ROOT = resolve(process.cwd(), '..', '..');
const STYLES_PATH = resolve(REPO_ROOT, 'apps', 'desktop', 'src', 'renderer', 'styles.css');

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
    const styles = await readFile(STYLES_PATH, 'utf8');
    const layers = enclosingLayerCount(styles, '.maka-nav-row {');
    assert.notEqual(layers, -1, '.maka-nav-row { rule not found in styles.css');
    assert.equal(
      layers,
      0,
      `.maka-nav-row is nested in ${layers} @layer block(s); it must stay unlayered to ` +
        'override the cva button base utilities (inline-flex/justify-center). See #257 regression.',
    );
  });
});
