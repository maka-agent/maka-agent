/**
 * Regression contract: SettingsModal must not steal focus back to the
 * settings nav on every re-render.
 *
 * Bug: the modal's focus-on-open effect was keyed on `[props.onClose]`.
 * `onClose` (app-shell.tsx's `closeSettings`) is a plain function
 * recreated on every AppShell render, and AppShell re-renders on every
 * streamed token (`streamingBySession` state, see app-shell.tsx). So while
 * a session was streaming, this effect tore down and re-ran on every
 * token, and each run called `activeNavRef.current?.focus()` -- forcibly
 * yanking DOM focus back to the settings nav button dozens of times a
 * second. Any focus-managed popup opened inside Settings (e.g. the
 * default-permission-mode Menu) would immediately lose focus and close,
 * reading as "clicking inside Settings does nothing" while a session
 * streams.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const SETTINGS_MODAL_TS = resolve(
  import.meta.dirname,
  '../../../../../apps/desktop/src/renderer/settings/SettingsModal.tsx',
);

describe('SettingsModal focus-churn contract', () => {
  it('focuses the modal on mount only, not on every onClose identity change', async () => {
    const src = await readFile(SETTINGS_MODAL_TS, 'utf8');

    assert.match(
      src,
      /useEffect\(\(\) => \{\s*activeNavRef\.current\?\.focus\(\);[\s\S]*?\}, \[\]\);/,
      'the activeNavRef focus must run in its own effect with an EMPTY dependency array (mount-only) -- ' +
        'not keyed on props.onClose, which is recreated every AppShell render while a session streams',
    );

    // The escape-key listener is allowed (and expected) to resubscribe on
    // every onClose identity change -- that's just an addEventListener/
    // removeEventListener pair, not a focus-stealing side effect, and
    // keeping it keyed on onClose ensures Escape always calls the current
    // closure rather than a stale one.
    const escapeEffectMatch = src.match(
      /useEffect\(\(\) => \{\s*function onKey\([\s\S]*?\}, \[props\.onClose\]\);/,
    );
    assert.ok(escapeEffectMatch, 'the Escape-key listener effect must exist, keyed on [props.onClose]');
    assert.doesNotMatch(
      escapeEffectMatch![0],
      /activeNavRef\.current\?\.focus\(\)/,
      'the onClose-keyed effect must NOT also call .focus() -- that would reintroduce the focus-churn bug',
    );
  });
});
