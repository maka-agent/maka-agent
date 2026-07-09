/**
 * Icon + typography governance contract.
 *
 * The sidebar's competitor comparison surfaced three fault lines:
 *   1. Icon semantics were wrong (Sparkles for 技能 means nothing).
 *   2. Icons read as different families — call sites had accumulated a
 *      dozen different `strokeWidth` values, so the glyphs fragmented.
 *   3. The lucide funnel could drift if a call site imported lucide-react
 *      directly instead of through the @maka/ui/icons seam.
 *
 * This contract pins the outcome of the governance round:
 *   a) No `strokeWidth={...}` prop survives on lucide icon call sites under
 *      apps/desktop/src/renderer or packages/ui/src (brand-asset files
 *      excepted) — icons ride the single governed stroke instead.
 *   b) session-sidebar-nav.tsx imports exactly the decided semantic set
 *      (Plus / CalendarCheck / Blocks / Timer / Settings) from ./icons.js.
 *   c) icons.tsx stays the ONLY packages/ui/src file importing lucide-react
 *      (funnel integrity).
 */

import { strict as assert } from 'node:assert';
import { readdir, readFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { describe, it } from 'node:test';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');
const ICONS_FILE = resolve(REPO_ROOT, 'packages/ui/src/icons.tsx');
const SIDEBAR_NAV_FILE = resolve(REPO_ROOT, 'packages/ui/src/session-sidebar-nav.tsx');

// Fixed brand assets, not generic UI icons — their hand-authored SVGs keep
// their own stroke weight and are exempt from the call-site stroke sweep.
const STROKE_EXCEPTION_FILES = new Set([
  resolve(REPO_ROOT, 'packages/ui/src/bot-brand-logo.tsx'),
  resolve(REPO_ROOT, 'apps/desktop/src/renderer/settings/provider-brand-marks.tsx'),
]);

async function walkTsx(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '__tests__') continue;
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walkTsx(full)));
    } else if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const rel = (file: string): string => relative(REPO_ROOT, file).split(sep).join('/');

describe('icon + typography governance contract', () => {
  it('rides lucide\'s single governed stroke — no per-call-site strokeWidth props', async () => {
    const dirs = [
      resolve(REPO_ROOT, 'apps/desktop/src/renderer'),
      resolve(REPO_ROOT, 'packages/ui/src'),
    ];
    const offenders: string[] = [];
    for (const dir of dirs) {
      for (const file of await walkTsx(dir)) {
        if (STROKE_EXCEPTION_FILES.has(file)) continue;
        const src = await readFile(file, 'utf8');
        // The brace form is what lucide icon call sites use. Raw inline
        // <svg> primitives use the string form (strokeWidth="2") and are
        // not lucide glyphs, so they are outside this rule.
        if (/strokeWidth=\{/.test(src)) offenders.push(rel(file));
      }
    }
    assert.deepEqual(
      offenders,
      [],
      'icons ride lucide\'s default stroke — per-callsite strokeWidth fragments the family. '
        + `Delete the strokeWidth={...} props in:\n  ${offenders.join('\n  ')}`,
    );
  });

  it('session-sidebar-nav imports exactly the decided semantic icon set from ./icons.js', async () => {
    const src = await readFile(SIDEBAR_NAV_FILE, 'utf8');
    const importMatch = src.match(/import\s*\{([^}]*)\}\s*from\s*'\.\/icons\.js'/);
    assert.ok(importMatch, 'session-sidebar-nav.tsx must import its icons from ./icons.js');
    const imported = importMatch![1]
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean)
      .sort();
    // Decided semantic mapping: 新任务 → Plus, 每日回顾 → CalendarCheck,
    // 技能 → Blocks, 定时任务 → Timer, 设置 → Settings.
    const expected = ['Blocks', 'CalendarCheck', 'Plus', 'Settings', 'Timer'];
    assert.deepEqual(
      imported,
      expected,
      `session-sidebar-nav.tsx must import exactly ${expected.join('/')} from ./icons.js (the semantic mapping)`,
    );
  });

  it('routes every packages/ui/src lucide import through the icons.tsx funnel', async () => {
    const files = await walkTsx(resolve(REPO_ROOT, 'packages/ui/src'));
    const offenders: string[] = [];
    for (const file of files) {
      if (file === ICONS_FILE) continue;
      const stripped = (await readFile(file, 'utf8'))
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
      if (/['"]lucide-react['"]/.test(stripped)) offenders.push(rel(file));
    }
    assert.deepEqual(
      offenders,
      [],
      'icons.tsx is the only lucide-react seam in packages/ui/src (funnel integrity). '
        + `Route these through @maka/ui/icons named exports:\n  ${offenders.join('\n  ')}`,
    );
  });
});
