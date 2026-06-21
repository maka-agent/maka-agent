/**
 * Contract between the real-window smoke diagnostic (main.ts, injected into
 * the renderer) and the live modal DOM.
 *
 * The diagnostic detects the search modal's backdrop and focus state by
 * querying the renderer. Those selectors silently drifted once the modal
 * migrated to the Base UI `Dialog` primitives: the backdrop stopped carrying
 * `.maka-search-modal-backdrop`, and the focused input lost the
 * `maka-search-modal-input` class to InputGroup's own utility classes — so
 * the `programmatic-search-modal-open` and `programmatic-focus-target` smoke
 * checks failed on a clean tree (reproduced identically on `main`).
 *
 * This gate binds the diagnostic to a STABLE hook so it can't drift again:
 *   - the shared DialogBackdrop carries `maka-dialog-backdrop` (style-free),
 *   - the diagnostic queries that hook (not the dead search-modal-backdrop),
 *   - focus-trap is detected structurally via closest('.maka-search-modal'),
 *     not via a brittle class on the focused element.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { join } from 'node:path';

const MAIN_PATH = join(process.cwd(), 'src', 'main', 'main.ts');
const UI_PATH = join(process.cwd(), '..', '..', 'packages', 'ui', 'src', 'ui.tsx');

describe('real-window smoke diagnostic ↔ modal DOM contract', () => {
  it('the shared dialog backdrop carries the stable maka-dialog-backdrop hook', async () => {
    const ui = await readFile(UI_PATH, 'utf8');
    assert.match(
      ui,
      /maka-dialog-backdrop/,
      'DialogBackdrop must carry the style-free `maka-dialog-backdrop` hook so the smoke diagnostic can select the backdrop. Base UI otherwise renders only drifting Tailwind utility classes.',
    );
  });

  it('the diagnostic queries the live backdrop hook, not the dead search-modal-backdrop class', async () => {
    const main = await readFile(MAIN_PATH, 'utf8');
    assert.match(
      main,
      /querySelector\('\.maka-dialog-backdrop'\)/,
      'the smoke diagnostic must detect the modal backdrop via `.maka-dialog-backdrop`',
    );
    assert.doesNotMatch(
      main,
      /maka-search-modal-backdrop/,
      'the dead `.maka-search-modal-backdrop` selector (no element carries it) must be gone',
    );
  });

  it('the diagnostic reports whether focus is trapped inside the search modal', async () => {
    const main = await readFile(MAIN_PATH, 'utf8');
    assert.match(
      main,
      /activeElementInSearchModal/,
      'the diagnostic must expose `activeElementInSearchModal` so focus-target is checked structurally',
    );
    assert.match(
      main,
      /closest\('\.maka-search-modal'\)/,
      'focus-trap detection must use closest(.maka-search-modal), not a class on the focused element',
    );
  });
});
