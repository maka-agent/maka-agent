/**
 * PR-STYLE-HOOK-CONVENTION-0 (issue #520 PR5 item 23, 2026-07-05):
 * every Base UI wrapper in `packages/ui/src/ui.tsx` exposes a `data-slot`
 * attribute so CSS can target `[data-slot="..."]` (a stable hook that
 * survives className drift), matching the `./primitives/` wrappers that
 * already do this (accordion / alert / badge / …). New wrappers
 * (Collapsible / Tooltip / NumberField / …) follow the same rule.
 *
 * Boolean state hooks adopt Base UI's native attribute-presence form
 * (`[data-active]` / `[data-open]` / `[data-checked]` / `[data-selected]` /
 * `[data-pressed]` / `[data-highlighted]` / `[data-disabled]`), NOT the
 * attribute-value form (`[data-active="true"]`). Maka's renderer CSS has
 * zero state-attribute selectors today, so adopting Base UI's form breaks
 * nothing and avoids an override layer. The per-component hook map lives in
 * the doc comment at the top of ui.tsx.
 *
 * This contract locks the data-slot rule: a wrapper that forwards props to a
 * `Base*` Base UI component must carry `data-slot`. It does NOT lock the
 * state-attribute decision (that is a "don't override" rule, enforced by the
 * absence of `[data-active="true"]`-style overrides, which the existing
 * CSS-scan contracts already cover indirectly).
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { REPO_ROOT } from './css-test-helpers.js';

const UI_FILE = resolve(REPO_ROOT, 'packages/ui/src/ui.tsx');

/** A top-level wrapper declaration: `export const X = forwardRef...` /
 *  `const X = forwardRef...` / `export function X(...)` at column 0. */
const WRAPPER_DECL_RE = /^(?:export (?:const|function)|const) [A-Z][A-Za-z0-9]*\b/gm;

/** A Base UI component JSX tag: `<BaseButton`, `<BaseCheckbox.Root`, etc. */
const BASE_TAG_RE = /<Base[A-Z][A-Za-z]*\b/;

/** Split ui.tsx into wrapper blocks (each starts at a top-level wrapper
 *  declaration and runs until the next one). Returns the block text + the
 *  leading declaration name for labeling. */
function wrapperBlocks(source: string): Array<{ name: string; body: string }> {
  const matches = [...source.matchAll(WRAPPER_DECL_RE)];
  const blocks: Array<{ name: string; body: string }> = [];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index;
    const end = i + 1 < matches.length ? matches[i + 1].index : source.length;
    const body = source.slice(start, end);
    const name = matches[i][0].replace(/^(?:export )?(?:const|function) /, '');
    blocks.push({ name, body });
  }
  return blocks;
}

describe('PR-STYLE-HOOK-CONVENTION-0 contract', () => {
  it('every ui.tsx wrapper that forwards to a Base* component carries data-slot', async () => {
    const source = await readFile(UI_FILE, 'utf8');
    const blocks = wrapperBlocks(source);
    const offenders: string[] = [];
    for (const { name, body } of blocks) {
      // Only wrappers that render a `<Base*>` Base UI component are in scope.
      // Hand-written native elements (the legacy Input / Textarea <input> /
      // <textarea>, and Badge <span>) are out of the rule until they retire
      // onto a Base UI primitive.
      if (!BASE_TAG_RE.test(body)) continue;
      // The wrapper must carry at least one data-slot on the Base root it
      // forwards to. (Sub-parts like BaseSwitch.Thumb / BaseCheckbox.Indicator
      // are not required here — only the root wrapper.)
      if (!/data-slot=/.test(body)) {
        offenders.push(`${name}: forwards to a Base UI component but has no data-slot — add data-slot="<name>" to the Base root`);
      }
    }
    assert.deepEqual(offenders, [], `Offenders:\n  ${offenders.join('\n  ')}`);
  });

  it('ui.tsx documents the style-hook convention (state-attribute form + hook map + data-slot rule)', async () => {
    const source = await readFile(UI_FILE, 'utf8');
    // The convention doc comment at the top of ui.tsx. Pinning the heading
    // keeps the decision from being silently deleted.
    assert.match(source, /Base UI style-hook convention/, 'ui.tsx must document the style-hook convention');
    assert.match(source, /attribute-presence form/, 'the doc must state the state-attribute form decision');
    assert.match(source, /data-active/, 'the doc must list the per-component hook map');
  });
});

describe('style-hook convention negative cases', () => {
  it('wrapperBlocks splits on top-level wrapper declarations', () => {
    const src = 'export const Button = forwardRef(function Button() { return <BaseButton data-slot="button" />; });\nexport const Badge = function Badge() { return <span />; }';
    const blocks = wrapperBlocks(src);
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].name, 'Button');
    assert.equal(blocks[1].name, 'Badge');
    assert.ok(BASE_TAG_RE.test(blocks[0].body), 'Button block has a Base tag');
    assert.ok(!BASE_TAG_RE.test(blocks[1].body), 'Badge block has no Base tag');
  });

  it('a Base wrapper without data-slot is flagged, a native wrapper is spared', () => {
    const src = 'export const Good = forwardRef(function Good() { return <BaseX data-slot="x" {...props} />; });\nexport const Bad = forwardRef(function Bad() { return <BaseY {...props} />; });\nexport const Native = function Native() { return <input />; }';
    const blocks = wrapperBlocks(src);
    const offenders: string[] = [];
    for (const { name, body } of blocks) {
      if (!BASE_TAG_RE.test(body)) continue;
      if (!/data-slot=/.test(body)) offenders.push(name);
    }
    assert.deepEqual(offenders, ['Bad'], 'Bad (Base, no data-slot) flagged; Good (Base, data-slot) and Native (no Base) spared');
  });
});