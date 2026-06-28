#!/usr/bin/env node
/**
 * Zero-visual proof for the chat `Marker` migration (#332 / PR2 #337) and the
 * tool live-output stream shell migration (#332 / PR3). Feed it a PRE-PR2
 * renderer CSS bundle as `main.css` — both the bespoke `.maka-turn-*` (marker)
 * and `.maka-tool-output-stream-*` (stream) families predate PR2, so a single
 * pre-PR2 baseline greens every row. The `LiveIndicator` pulse DOT is the one
 * element NOT diffed (animated → `getComputedStyle` is phase-dependent); it is
 * pinned by the cascade contract's `@keyframes maka-pulse` frames instead.
 *
 * #332 requires the governance pass to be "locked by computed-style /
 * cascade contract tests + before/after screenshots". The cascade
 * contract tests (apps/desktop/.../chat-marker-cascade-contract.test.ts,
 * packages/ui/.../chat-primitives.test.ts) assert the source strings.
 * This script is the rendered half: a re-runnable before/after check that
 * loads the REAL built renderer CSS from both `main` and the PR branch
 * into a headless window and diffs `getComputedStyle` for the migrated
 * chrome. It is the deterministic equivalent of a before/after screenshot
 * for the resting surface — `scripts/diff-screenshots.mjs` documents why
 * byte/pixel image diffs are too jittery to gate on (font rasterization
 * drifts ~70/88 PNGs between runs); computed style does not.
 *
 * The CSS is INLINED into a `<style>` block of a file:// temp document, NOT
 * linked. An earlier version `<link>`ed the bundle from a `data:`/`file:`
 * page, which silently applied NOTHING (cross-origin subresource): every
 * element read its UA default identically on both sides, so the diff was 0
 * but VACUOUS. Inlining removes the subresource, so the renderer CSS truly
 * applies — verify any future change by spot-checking a real value (e.g.
 * `footer-rest` must read `border-radius: 8px`, not the UA `0px`).
 *
 * What this renders + diffs `main` vs head: the resting box / typography /
 * color / transition style of all 9 marker families and the PR3 stream shell
 * (panel / header / counts + its data-variant pills / body / chunk, resting AND
 * with `data-live="true"` for the accent border + inset ring), plus the footer
 * action across resting / pending / copy-pending / copied / failed —
 * including `main`'s old pending `secondary` variant vs the new always-
 * `quiet` shell, which proves that variant switch was visually inert (the
 * reason this PR drops it). The DOM mirrors `TurnView` nesting (chips in a
 * summary, actions in a footer, badges in a lineage row) so positional
 * pseudo-classes and inheritance resolve as in production — including the
 * `summary-switched` "切换" pill nested in a `data-switched` model chip, the
 * `lineage-row-reverse` container, and the `::before` middot separators on
 * summary chips / failed-recovery (all migrated variants, all real once the
 * CSS is inlined).
 *
 * What is STILL not observable here, and why — locked by the cascade
 * contract's exact source-string literals instead (each a LEAF
 * literalization where source == computed holds by construction):
 *   - `:hover` / `:focus-visible` / `:focus-within`: a headless
 *     (`show: false`) window has no live pointer/focus, and `getComputedStyle`
 *     does NOT reflect a DevTools `CSS.forcePseudoState` force (a known
 *     Chromium behavior — the force drives the inspector, not in-page
 *     computed style; verified resting == forced-"hover" even with the CSS
 *     applied). The rules themselves DO compile into the bundle (greppable:
 *     `…:hover:not(:disabled){background-color:oklch(…/ .05)}`). Their
 *     NON-leaf merge winner is a deterministic specificity fact: the marker's
 *     `[&:hover:not(:disabled)]` (0,3,0) outranks UiButton quiet's
 *     `hover:bg-muted` (0,2,0), exactly as the retired
 *     `.maka-turn-footer-action:hover:not(:disabled)` did on main.
 * So this is a rendered proof of the RESTING surface plus the `::before`
 * middots, with only the interactive pseudo-states pinned by source string.
 *
 * Usage (run from repo root, needs Electron + both built CSS bundles):
 *
 *   # 1. Build THIS branch's renderer CSS:
 *   npm --workspace @maka/desktop run build:renderer
 *   cp apps/desktop/dist/renderer/assets/*.css /tmp/head.css
 *   # 2. Build the @maka/ui dist this script imports the cva tables from:
 *   npm --workspace @maka/ui run build
 *   # 3. Build `main`'s renderer CSS the same way from a clean checkout of
 *   #    the 6 migrated files, save to /tmp/main.css, restore HEAD.
 *   # 4. Diff:
 *   npx electron scripts/check-chat-marker-computed-style.mjs /tmp/main.css /tmp/head.css
 *
 * Exits 0 when every element is identical across both bundles, non-zero
 * (with a per-property diff dump) otherwise.
 */

import { app, BrowserWindow } from 'electron';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const { buttonVariants, cn } = await import(pathToFileURL(resolve(REPO_ROOT, 'packages/ui/dist/ui.js')).href);
const { markerVariants, streamVariants } = await import(pathToFileURL(resolve(REPO_ROOT, 'packages/ui/dist/primitives/chat.js')).href);

const mainCssPath = process.argv[2] && resolve(process.argv[2]);
const headCssPath = process.argv[3] && resolve(process.argv[3]);
if (!mainCssPath || !headCssPath || !existsSync(mainCssPath) || !existsSync(headCssPath)) {
  console.error('usage: npm run check:chat-visual -- <baseline.css> <head.css>');
  console.error('  <baseline.css>  pre-PR2 renderer CSS — still carries the bespoke');
  console.error('                  .maka-turn-* / .maka-tool-output-stream-* rules (build it');
  console.error('                  from a checkout at e033a8c4~1; see this file\'s header).');
  console.error('  <head.css>      this branch\'s built renderer CSS (npm -w @maka/desktop run build:renderer).');
  process.exit(2);
}

const bv = (variant, size) => buttonVariants({ variant, size });
const mv = (v) => markerVariants({ variant: v });
const pair = (m, h) => ({ main: m, head: h });
// `main` class (UiButton sm + bespoke, or pure bespoke) vs head class
// (UiButton nav + marker, or pure marker). The footer action is `quiet` in
// EVERY head state — the inert pending `secondary` branch is dropped — so
// its head column is always `quiet`, matched against `main`'s pending-time
// `secondary` to prove that switch was pixel-equal.
const fa = (variant) => pair(cn(bv(variant, 'sm'), 'maka-turn-footer-action'), cn(bv('quiet', 'nav'), mv('footer-action')));
const lb = pair(cn(bv('quiet', 'sm'), 'maka-turn-lineage-badge'), cn(bv('quiet', 'nav'), mv('lineage-badge')));

// PR3 — the tool live-output stream shell. Resting, non-interactive, and
// non-animated, so the computed-style diff covers it in full (the proof PR2's
// shell got). The pulsing live DOT is the ONLY part NOT diffed here: its
// `getComputedStyle` reads a phase-dependent animation value, so it is pinned by
// the cascade contract's `@keyframes maka-pulse` frames + `LiveIndicator`
// literals instead. `<el>` puts an empty class on the count spans on `main`
// (they were styled by the `.maka-tool-output-stream-counts span` DESCENDANT
// rule, not their own class) and nests them inside the counts element so that
// rule resolves exactly as in production.
const sv = (part) => streamVariants({ part });
// `el` is the side-bound local builder from TREE — passed in so this lives at
// module scope alongside the other shell helpers.
const streamPanel = (el, id, attrs) =>
  el('div', id, pair('maka-tool-output-stream', sv('container')), attrs,
    el('header', `${id}-header`, pair('maka-tool-output-stream-header', sv('header')), '',
      el('span', `${id}-label`, pair('maka-tool-output-stream-label', sv('label')), '', '<span>实时输出</span>')
      + el('span', `${id}-counts`, pair('maka-tool-output-stream-counts', sv('counts')), '',
          el('span', `${id}-count`, pair('', sv('count')), '', 'stdout 1')
          + el('span', `${id}-count-stderr`, pair('', sv('count')), 'data-stream="stderr"', 'stderr 1')
          + el('span', `${id}-count-redacted`, pair('', sv('count')), 'data-redacted="true"', '已脱敏 1')
          + el('span', `${id}-count-truncated`, pair('', sv('count')), 'data-truncated="true"', '已截断')))
    + el('pre', `${id}-body`, pair('maka-tool-output-stream-body', sv('body')), '',
        el('span', `${id}-chunk`, pair('maka-tool-output-stream-chunk', sv('chunk')), '', 'out')
        + el('span', `${id}-chunk-stderr`, pair('maka-tool-output-stream-chunk', sv('chunk')), 'data-stream="stderr"', 'err')
        + el('span', `${id}-chunk-redacted`, pair('maka-tool-output-stream-chunk', sv('chunk')), 'data-redacted="true"',
            'x' + el('span', `${id}-redacted-tag`, pair('maka-tool-output-stream-redacted-tag', sv('redacted-tag')), '', '[已脱敏]'))));

// DOM tree mirroring TurnView nesting.
const TREE = (side) => {
  const C = (p) => p[side];
  const el = (tag, id, p, attrs, kids = '') => `<${tag} id="${id}" class="${C(p)}" ${attrs}>${kids}</${tag}>`;
  const action = (id, p, attrs) => el('button', id, p, `${attrs} type="button"`, '<svg width="11" height="11"></svg><span>复制中…</span>');
  const chip = (id) => el('span', id, pair('maka-turn-summary-chip', mv('summary-chip')), 'data-kind="model"', '<span>x</span>');
  // Every other chip `data-[kind]` (and the in-progress `data-[state]`) gets a
  // row too, so the tools tint / duration+tokens tabular-nums / in-progress
  // accent+semibold are diffed for real, not only pinned as source strings.
  const kindChip = (id, attrs) => el('span', id, pair('maka-turn-summary-chip', mv('summary-chip')), attrs, '<span>x</span>');
  // The "切换" pill nests inside a model chip carrying `data-switched=true`,
  // exactly as TurnSummary renders it — both the switched-model chip path and
  // the pill itself are migrated variants, so each is measured as its own row.
  const switchedChip = (id, pillId) =>
    el('span', id, pair('maka-turn-summary-chip', mv('summary-chip')), 'data-kind="model" data-switched="true"',
      '<code>m</code>' + el('span', pillId, pair('maka-turn-summary-chip-switched', mv('summary-switched')), '', '切换'));
  return [
    el('div', 'summary', pair('maka-turn-summary', mv('summary')), '',
      chip('summary-chip-1') + chip('summary-chip-2')
      + kindChip('summary-chip-tools', 'data-kind="tools"')
      + kindChip('summary-chip-duration', 'data-kind="duration"')
      + kindChip('summary-chip-tokens', 'data-kind="tokens"')
      + kindChip('summary-chip-inprogress', 'data-kind="duration" data-state="in-progress"')
      + switchedChip('summary-chip-switched', 'summary-switched')),
    el('div', 'footer', pair('maka-turn-footer', mv('footer')), 'role="toolbar"',
      action('footer-rest', fa('quiet'), '') +
      action('footer-pending', fa('secondary'), 'data-pending="true" aria-busy="true"') +
      action('footer-copy-pending', fa('secondary'), 'data-pending="true" data-copy-feedback="pending" aria-busy="true" disabled aria-disabled="true"') +
      action('footer-copied', fa('quiet'), 'data-copy-feedback="copied"') +
      action('footer-failed', fa('quiet'), 'data-copy-feedback="failed"')),
    el('div', 'lineage-row', pair('maka-turn-lineage-row', mv('lineage-row')), '',
      action('lineage-fwd', lb, 'data-direction="forward"')),
    // Reverse lineage lives in its own `-reverse` container (margin-top 4px vs
    // the forward row's 2px), a separately migrated container variant.
    el('div', 'lineage-row-reverse', pair('maka-turn-lineage-row maka-turn-lineage-row-reverse', mv('lineage-row-reverse')), '',
      action('lineage-rev', lb, 'data-direction="reverse"')),
    el('div', 'aborted', pair('maka-turn-aborted-marker', mv('aborted')), '', '<span>x</span>'),
    el('div', 'failed-banner', pair('maka-turn-failed-banner', mv('failed-banner')), '',
      '<span>x</span>' + el('span', 'failed-recovery', pair('maka-turn-failed-recovery', mv('failed-recovery')), '', '<span>x</span>')),
    // The live-output stream, resting and (separately) with `data-live="true"`
    // so the accent border + inset ring are diffed too.
    streamPanel(el, 'stream', ''),
    streamPanel(el, 'stream-live', 'data-live="true"'),
  ].join('\n');
};

const PROPS = ['display', 'height', 'minHeight', 'width', 'maxWidth', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'borderTopColor', 'borderBottomColor', 'borderTopStyle', 'borderTopLeftRadius', 'boxShadow', 'overflowX', 'overflowY', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'lineHeight', 'textTransform', 'columnGap', 'color', 'backgroundColor', 'opacity', 'transition', 'justifyContent', 'alignItems', 'flexWrap', 'flexDirection', 'fontVariantNumeric', 'whiteSpace', 'wordBreak', 'textAlign', 'cursor'];
const IDS = ['summary', 'summary-chip-1', 'summary-chip-2', 'summary-chip-tools', 'summary-chip-duration', 'summary-chip-tokens', 'summary-chip-inprogress', 'summary-chip-switched', 'summary-switched', 'footer', 'footer-rest', 'footer-pending', 'footer-copy-pending', 'footer-copied', 'footer-failed', 'lineage-row', 'lineage-fwd', 'lineage-row-reverse', 'lineage-rev', 'aborted', 'failed-banner', 'failed-recovery',
  // PR3 stream shell (resting + live border ring). The pulse dot is excluded
  // (animated → phase-dependent computed style).
  'stream', 'stream-header', 'stream-label', 'stream-counts', 'stream-count', 'stream-count-stderr', 'stream-count-redacted', 'stream-count-truncated', 'stream-body', 'stream-chunk', 'stream-chunk-stderr', 'stream-chunk-redacted', 'stream-redacted-tag', 'stream-live'];
// `::before` middot separators are now diffed for real (they render once the
// CSS is inlined — the old `<link>` build couldn't apply them, masking this).
// summary-chip-2 is a non-first chip (`[&:not(:first-child)]:before:…`);
// failed-recovery carries the always-on `before:content-['·']`.
const PSEUDO_IDS = ['summary-chip-2', 'failed-recovery'];
const PSEUDO_PROPS = ['content', 'marginRight', 'color', 'fontWeight'];

function pageHtml(cssText, side) {
  // INLINE the stylesheet as a <style> block (not a <link href=file://…>): the
  // page is loaded from a file:// temp document, and a file:// page silently
  // refuses to apply a cross-origin file:// <link> subresource — which made an
  // earlier <link>-based version a false green (every element read its UA
  // default identically on both sides, so the diff was 0 but vacuous). Inlining
  // removes the subresource entirely, so the real renderer CSS actually applies.
  return `<!doctype html><html><head><meta charset="utf8"><style>${cssText}</style></head>
<body style="background:#fff"><div data-slot="message" data-role="assistant"><div class="maka-turn" style="width:680px">${TREE(side)}</div></div></body></html>`;
}

async function read(win, cssPath, side) {
  const tmp = join(tmpdir(), `chat-marker-${side}.html`);
  writeFileSync(tmp, pageHtml(readFileSync(cssPath, 'utf8'), side));
  await win.loadFile(tmp);
  return win.webContents.executeJavaScript(`(() => {
    const acc = {};
    for (const id of ${JSON.stringify(IDS)}) {
      const cs = getComputedStyle(document.getElementById(id));
      const o = {}; for (const p of ${JSON.stringify(PROPS)}) o[p] = cs[p];
      acc[id] = o;
    }
    for (const id of ${JSON.stringify(PSEUDO_IDS)}) {
      const cs = getComputedStyle(document.getElementById(id), '::before');
      const o = {}; for (const p of ${JSON.stringify(PSEUDO_PROPS)}) o[p] = cs[p];
      acc[id + '::before'] = o;
    }
    return acc;
  })()`);
}

app.commandLine.appendSwitch('disable-gpu');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { sandbox: false } });
  const main = await read(win, mainCssPath, 'main');
  const head = await read(win, headCssPath, 'head');
  const ROWS = [
    ...IDS.map((id) => [id, PROPS]),
    ...PSEUDO_IDS.map((id) => [`${id}::before`, PSEUDO_PROPS]),
  ];
  let total = 0;
  for (const [key, props] of ROWS) {
    const diffs = props.filter((p) => main[key][p] !== head[key][p]).map((p) => `${p}: main=${JSON.stringify(main[key][p])} head=${JSON.stringify(head[key][p])}`);
    total += diffs.length;
    if (diffs.length === 0) console.log(`  ok ${key}: ${props.length}/${props.length} identical`);
    else { console.log(`  XX ${key}: ${diffs.length} DIFF`); for (const d of diffs) console.log(`       ${d}`); }
  }
  console.log(`\n${IDS.length} resting element/state rows + ${PSEUDO_IDS.length} ::before middots — TOTAL DIFFS: ${total}`);
  app.exit(total === 0 ? 0 : 1);
});
