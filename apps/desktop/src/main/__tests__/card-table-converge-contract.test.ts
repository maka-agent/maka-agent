/**
 * CARD-TABLE-CONVERGE-0 (issue #520 PR9): the four hand-written card/table
 * surfaces migrate onto shared Card/Table primitives so the container is the
 * primitive (with `data-slot`), not a bare `<div>`/`<table>` carrying a
 * hand-rolled class.
 *
 * - settingsRows (row-list container) + settingsMetricCard (metric tile) +
 *   maka-error-card (crash surface) → Card
 * - settingsStatsTable (usage stats) → Table (shadcn-style family)
 *
 * Card is intentionally thin (`data-slot="card"` + radius-surface): each site
 * keeps its own layout/visual CSS, but the radius now comes from Card and the
 * element carries `data-slot="card"`. maka-error-card stays on Card (not Alert)
 * because it is a large crash surface with shadow-modal + stack <pre>, not a
 * small inline callout.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { REPO_ROOT } from './css-test-helpers.js';

/** Sites whose top-level container becomes <Card>. */
const CARD_SITES = [
  'apps/desktop/src/renderer/settings/settings-rows.tsx',
  'apps/desktop/src/renderer/settings/settings-metric-card.tsx',
  'apps/desktop/src/renderer/error-boundary.tsx',
];

/** Pages that used <div className="settingsRows"> directly — must route through SettingsRows (Card-backed) now. */
const SETTINGS_ROWS_CONSUMERS = [
  'apps/desktop/src/renderer/settings/daily-review-settings-page.tsx',
  'apps/desktop/src/renderer/settings/web-search-settings-page.tsx',
  'apps/desktop/src/renderer/settings/memory-settings-page.tsx',
];

/** Site whose table becomes the Table family. */
const TABLE_SITES = ['apps/desktop/src/renderer/settings/usage-settings-page.tsx'];

const CARD_PRIMITIVE = 'packages/ui/src/primitives/card.tsx';
const TABLE_PRIMITIVE = 'packages/ui/src/primitives/table.tsx';

const CARD_IMPORT_RE =
  /import\s+\{[^}]*\bCard\b[^}]*\}\s+from\s+['"][^'"]*(?:@maka\/ui|primitives\/card)['"]/;
const TABLE_IMPORT_RE =
  /import\s+\{[^}]*\bTable\w*\b[^}]*\}\s+from\s+['"][^'"]*(?:@maka\/ui|primitives\/table)['"]/;

describe('card/table converge (#520 PR9)', () => {
  it('ships Card and Table primitives with data-slot', async () => {
    const card = await readFile(resolve(REPO_ROOT, CARD_PRIMITIVE), 'utf8');
    assert.match(card, /data-slot=["']card["']/, 'Card primitive must carry data-slot="card"');

    const table = await readFile(resolve(REPO_ROOT, TABLE_PRIMITIVE), 'utf8');
    assert.match(table, /data-slot=["']table["']/, 'Table primitive must carry data-slot="table"');
    assert.match(table, /TableHeader|TableBody|TableRow|TableHead|TableCell/, 'Table family must ship subcomponents');
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

  it('table sites import Table and drop the bare <table className="settingsStatsTable">', async () => {
    for (const rel of TABLE_SITES) {
      const src = await readFile(resolve(REPO_ROOT, rel), 'utf8');
      assert.ok(TABLE_IMPORT_RE.test(src), `${rel} must import Table from @maka/ui`);
      assert.ok(
        !/<table\s+className=["'][^"']*\bsettingsStatsTable\b/.test(src),
        `${rel} must use the Table family, not a bare table.settingsStatsTable`,
      );
    }
  });
});
