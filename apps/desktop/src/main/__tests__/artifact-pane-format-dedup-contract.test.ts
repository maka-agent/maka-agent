/**
 * PR-FORMAT-DEDUP-CONTRACT-TEST-0 (round 25/30): lock the round-21
 * and round-22 dedup invariants for artifact-pane's time/size
 * formatting. Background:
 *
 *   PR-FORMAT-BYTES-DEDUP-0 (round 21) — artifact-pane.tsx had a
 *   local `formatBytes` that was a less-robust variant of the one
 *   in @maka/ui components.tsx. Removed; artifact-pane now imports
 *   the shared helper.
 *
 *   PR-FORMAT-RELATIVE-DEDUP-0 (round 22) — artifact-pane.tsx also
 *   had a local `formatRelative` that was a less-feature variant of
 *   @maka/core's `formatRelativeTimestamp`. It missed clock-skew
 *   handling, the 7-day-then-absolute horizon, and the
 *   locale-switching formatter cache. Removed; artifact-pane now
 *   imports the shared helper.
 *
 * Without contract tests, a future refactor could silently
 * reintroduce a local fork of either helper — and the inconsistency
 * would surface as either drift in byte units (artifact card showing
 * "1234 B" while a sibling card shows "1.2 KB") or as clock-skew
 * surprises (artifact times running "in 3 seconds" against a freshly
 * created file when the system clock briefly drifts).
 *
 * This test pins:
 *   1. artifact-pane.tsx does NOT define a local `formatBytes` or
 *      `formatRelative` function.
 *   2. artifact-pane.tsx imports `formatBytes` from `@maka/ui` and
 *      `formatRelativeTimestamp` from `@maka/core`.
 *   3. The shared `formatBytes` is exported from packages/ui so it
 *      remains a public-surface helper, not an accidental internal.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');

describe('PR-FORMAT-DEDUP-CONTRACT-TEST-0', () => {
  it('artifact-pane does not redefine formatBytes locally', async () => {
    const src = await readFile(
      resolve(REPO_ROOT, 'apps/desktop/src/renderer/artifact-pane.tsx'),
      'utf8',
    );

    // Strip block comments — the round-21 tombstone explicitly
    // mentions `formatBytes` and would otherwise trip the check.
    const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '');

    assert.ok(
      !/\bfunction\s+formatBytes\b/.test(stripped),
      'artifact-pane must not define a local formatBytes function',
    );
    assert.ok(
      !/\bconst\s+formatBytes\s*=/.test(stripped),
      'artifact-pane must not assign a local formatBytes',
    );
  });

  it('artifact-pane does not redefine formatRelative locally', async () => {
    const src = await readFile(
      resolve(REPO_ROOT, 'apps/desktop/src/renderer/artifact-pane.tsx'),
      'utf8',
    );

    const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '');

    assert.ok(
      !/\bfunction\s+formatRelative\b/.test(stripped),
      'artifact-pane must not define a local formatRelative function',
    );
    assert.ok(
      !/\bconst\s+formatRelative\s*=/.test(stripped),
      'artifact-pane must not assign a local formatRelative',
    );
    assert.ok(
      !/new Intl\.RelativeTimeFormat\b/.test(stripped),
      'artifact-pane must not construct its own RelativeTimeFormat — use @maka/core formatRelativeTimestamp',
    );
  });

  it('artifact-pane imports the shared format helpers from @maka/ui and @maka/core', async () => {
    const src = await readFile(
      resolve(REPO_ROOT, 'apps/desktop/src/renderer/artifact-pane.tsx'),
      'utf8',
    );

    assert.match(
      src,
      /import \{[\s\S]*?\bformatRelativeTimestamp\b[\s\S]*?\} from '@maka\/core';/,
      'artifact-pane must import formatRelativeTimestamp from @maka/core',
    );
    assert.match(
      src,
      /import \{[\s\S]*?\bformatBytes\b[\s\S]*?\} from '@maka\/ui';/,
      'artifact-pane must import formatBytes from @maka/ui',
    );
  });

  it('shared formatBytes stays an exported helper on @maka/ui', async () => {
    const components = await readFile(
      resolve(REPO_ROOT, 'packages/ui/src/components.tsx'),
      'utf8',
    );
    const toolActivity = await readFile(
      resolve(REPO_ROOT, 'packages/ui/src/tool-activity.tsx'),
      'utf8',
    );
    const previewUtils = await readFile(
      resolve(REPO_ROOT, 'packages/ui/src/tool-activity/preview-utils.ts'),
      'utf8',
    );

    assert.match(
      components,
      /export \{[\s\S]*?\bformatBytes\b[\s\S]*?\} from '\.\/tool-activity\.js';/,
      'formatBytes must remain exported from @maka/ui so callers do not refork it',
    );
    assert.match(
      toolActivity,
      /export \{ formatBytes \} from '\.\/tool-activity\/preview-utils\.js';/,
      'tool-activity must preserve the public formatBytes re-export',
    );
    assert.match(
      previewUtils,
      /export function formatBytes\(bytes: number\): string \{/,
      'formatBytes must remain an exported function so callers do not refork it',
    );
  });
});
