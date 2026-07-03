/**
 * P-4PT spacing ratchet (design-refinement-roadmap-2026-07 §1.4, owner
 * decision D1: converge on a 4pt spacing grid, migrating incrementally).
 *
 * Every padding/gap/margin px value in renderer CSS should be a multiple
 * of 4 (0 allowed; 1px and 2px exempt as hairline/optical nudges). The
 * legacy drift (442 values at baseline) is FROZEN per file below and may
 * only go DOWN:
 *
 *  - touching a file and reducing its count → update the baseline DOWN
 *  - adding a new off-grid value anywhere → this test fails
 *  - new CSS files must be born clean (no entry = zero tolerance)
 *
 * This is a ratchet, not an allowlist of specific lines, so refactors
 * inside a file stay cheap while the global trend is monotonic.
 */

import { strict as assert } from 'node:assert';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { describe, it } from 'node:test';

const DESKTOP_ROOT = process.cwd().endsWith(join('apps', 'desktop'))
  ? process.cwd()
  : resolve(process.cwd(), 'apps', 'desktop');
const RENDERER_ROOT = resolve(DESKTOP_ROOT, 'src', 'renderer');

/** Frozen per-file baseline (2026-07-03). Only decrease these numbers. */
const BASELINE: ReadonlyMap<string, number> = new Map([
  ['src/renderer/maka-tokens.css', 23],
  ['src/renderer/styles/chat-header.css', 26],
  ['src/renderer/styles/chat-message.css', 4],
  ['src/renderer/styles/composer.css', 12],
  ['src/renderer/styles/daily-review.css', 17],
  ['src/renderer/styles/health-center.css', 11],
  ['src/renderer/styles/module-pages.css', 76],
  ['src/renderer/styles/onboarding.css', 29],
  ['src/renderer/styles/permission-center.css', 28],
  ['src/renderer/styles/reasoning-panel.css', 3],
  ['src/renderer/styles/settings/bot.css', 23],
  ['src/renderer/styles/settings/connection.css', 9],
  ['src/renderer/styles/settings/form.css', 7],
  ['src/renderer/styles/settings/models.css', 31],
  ['src/renderer/styles/settings/nav-sidebar.css', 21],
  ['src/renderer/styles/settings/provider-editor.css', 20],
  ['src/renderer/styles/settings/theme-preview.css', 23],
  ['src/renderer/styles/sidebar.css', 36],
  ['src/renderer/styles/tool-output.css', 8],
  ['src/renderer/styles/tool-stream.css', 35],
]);

const DECL_RE =
  /(?:^|;|\{)\s*(padding|gap|margin|row-gap|column-gap|padding-(?:top|right|bottom|left|inline|block)|margin-(?:top|right|bottom|left|inline|block))\s*:\s*([^;}]+)/gm;
const PX_RE = /(?<![\w.-])(\d+(?:\.\d+)?)px/g;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '');
}

function countOffGrid(css: string): number {
  const stripped = stripComments(css);
  let count = 0;
  for (const decl of stripped.matchAll(DECL_RE)) {
    for (const px of (decl[2] ?? '').matchAll(PX_RE)) {
      const value = Number(px[1]);
      if (value !== 0 && value % 4 !== 0 && value !== 1 && value !== 2) count += 1;
    }
  }
  return count;
}

async function collectCssFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await collectCssFiles(full)));
    else if (entry.name.endsWith('.css')) out.push(full);
  }
  return out;
}

describe('P-4PT spacing ratchet', () => {
  it('padding/gap/margin px values stay on the 4pt grid (frozen legacy may only shrink)', async () => {
    const files = await collectCssFiles(RENDERER_ROOT);
    const failures: string[] = [];
    for (const file of files.sort()) {
      const rel = relative(DESKTOP_ROOT, file).split('\\').join('/');
      const count = countOffGrid(await readFile(file, 'utf8'));
      const allowed = BASELINE.get(rel) ?? 0;
      if (count > allowed) {
        failures.push(`${rel}: ${count} off-grid spacing values (baseline ${allowed})`);
      }
    }
    assert.deepEqual(
      failures,
      [],
      `off-grid spacing crept in — use 4/8/12/16/24/32 (1px/2px hairlines exempt), or shrink the file below its frozen baseline:\n${failures.join('\n')}`,
    );
  });

  it('baseline entries stay honest (no stale higher-than-actual counts)', async () => {
    // Guard against the ratchet rusting: if a file improves but the
    // baseline is not updated, the slack could hide future regressions.
    // Tolerate up to 3 slack per file before requiring a baseline update.
    const stale: string[] = [];
    for (const [rel, allowed] of BASELINE) {
      const count = countOffGrid(await readFile(resolve(DESKTOP_ROOT, rel), 'utf8'));
      if (allowed - count > 3) {
        stale.push(`${rel}: baseline ${allowed} but actual ${count} — lower the baseline`);
      }
    }
    assert.deepEqual(stale, [], stale.join('\n'));
  });
});
