/**
 * CARD-CONVERGE-0 (issue #520 PR9): the hand-written settings card surfaces
 * migrate onto a shared Card primitive so the container is the primitive (with
 * `data-slot`), not a bare `<div>` carrying a hand-rolled class.
 *
 * - settingsRows (row-list container) + settingsMetricCard (metric tile) +
 *   maka-error-card (crash surface) → Card
 *
 * Card is intentionally thin (`data-slot="card"` + radius-surface): each site
 * keeps its own layout/visual CSS, but the radius now comes from Card and the
 * element carries `data-slot="card"`. maka-error-card stays on Card (not Alert)
 * because it is a large crash surface with shadow-modal + stack <pre>, not a
 * small inline callout.
 *
 * The usage stats table is NOT on a public Table primitive: with only one HTML
 * <table> consumer it was premature abstraction (PR9 review P3), so
 * SimpleStatsTable keeps its styles inline in usage-settings-page. The table
 * a11y semantics (aria-label + scope) are locked in settings-usage-contract.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { REPO_ROOT } from './css-test-helpers.js';

/** Sites whose top-level container becomes <Card>. */
const CARD_SITES = [
  'apps/desktop/src/renderer/settings/settings-rows.tsx',
  // settings-metric-card retired its Card wrapper in convergence R4 — it is
  // a thin alias over the shared StatTile primitive now.
  'apps/desktop/src/renderer/error-boundary.tsx',
];

/** Pages that used <div className="settingsRows"> directly — must route through SettingsRows (Card-backed) now. */
const SETTINGS_ROWS_CONSUMERS = [
  'apps/desktop/src/renderer/settings/daily-review-settings-page.tsx',
  'apps/desktop/src/renderer/settings/web-search-settings-page.tsx',
  'apps/desktop/src/renderer/settings/memory-settings-page.tsx',
];

const CARD_PRIMITIVE = 'packages/ui/src/primitives/card.tsx';

const CARD_IMPORT_RE =
  /import\s+\{[^}]*\bCard\b[^}]*\}\s+from\s+['"][^'"]*(?:@maka\/ui|primitives\/card)['"]/;

describe('card converge (#520 PR9)', () => {
  it('ships Card primitive with data-slot', async () => {
    const card = await readFile(resolve(REPO_ROOT, CARD_PRIMITIVE), 'utf8');
    assert.match(card, /data-slot=["']card["']/, 'Card primitive must carry data-slot="card"');
  });

  it('card sites import Card', async () => {
    for (const rel of CARD_SITES) {
      const src = await readFile(resolve(REPO_ROOT, rel), 'utf8');
      assert.ok(CARD_IMPORT_RE.test(src), `${rel} must import Card from @maka/ui`);
    }
  });

  it('settingsRows consumer pages no longer use a bare <div className="settingsRows">', async () => {
    for (const rel of SETTINGS_ROWS_CONSUMERS) {
      const src = await readFile(resolve(REPO_ROOT, rel), 'utf8');
      assert.ok(
        !/<div\s+className=["'][^"']*\bsettingsRows\b/.test(src),
        `${rel} must route through SettingsRows/Card, not a bare div.settingsRows`,
      );
    }
  });
});