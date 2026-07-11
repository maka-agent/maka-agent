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
 * (panel / header / flags + their data-variant pills / body / chunk, resting AND
 * with `data-live="true"` for the accent border + inset ring), plus the footer
 * action across resting / pending / copy-pending / copied / failed —
 * including `main`'s old pending `secondary` variant vs the new always-
 * `quiet` shell, which proves that variant switch was visually inert (the
 * reason this PR drops it). The DOM mirrors `TurnView` nesting (actions in a
 * footer, badges in a lineage row) so positional pseudo-classes and
 * inheritance resolve as in production — including the `lineage-row-reverse`
 * container and the `::before` middot separator on failed-recovery (all
 * migrated variants, all real once the CSS is inlined).
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
 *     `…:hover:not([aria-disabled=true]){background-color:oklch(…/ .05)}`).
 *     Their NON-leaf merge winner is a deterministic specificity fact: the
 *     marker's `[&:hover:not([aria-disabled=true])]` (0,3,0) outranks UiButton
 *     quiet's `hover:bg-muted` (0,2,0). Footer actions use `aria-disabled`
 *     (not a real `disabled` attr) so tooltips can show on disabled actions.
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
const { markerVariants, toolVariants } = await import(pathToFileURL(resolve(REPO_ROOT, 'packages/ui/dist/primitives/chat.js')).href);
const {
  TOOL_OUTPUT_PANEL_CLASS,
  TOOL_OUTPUT_BODY_CLASS,
  TOOL_OUTPUT_COMMAND_CLASS,
} = await import(pathToFileURL(resolve(REPO_ROOT, 'packages/ui/dist/tool-activity/tool-result-preview.js')).href);
const { Alert, AlertTitle, AlertDescription, AlertAction } = await import(pathToFileURL(resolve(REPO_ROOT, 'packages/ui/dist/primitives/alert.js')).href);

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

// Quiet tool-output panel (production shell after streamVariants retirement).
// Both sides use the same production classes — this pins layout invariants
// (max-height, mono, panel surface) rather than a retired stream migration pair.
const toolOutputPanel = (el, id) =>
  el('div', id, pair(TOOL_OUTPUT_PANEL_CLASS, TOOL_OUTPUT_PANEL_CLASS), 'data-slot="tool-output"',
    el('code', `${id}-cmd`, pair(TOOL_OUTPUT_COMMAND_CLASS, TOOL_OUTPUT_COMMAND_CLASS), '', 'npm test')
    + el('pre', `${id}-body`, pair(TOOL_OUTPUT_BODY_CLASS, TOOL_OUTPUT_BODY_CLASS), '', 'out\nerr'));

// PR3b — the `ToolActivity` card shell. The only part NOT diffed is the RUNNING
// status dot (its `maka-tool-pulse` ring is animated → phase-dependent
// `getComputedStyle`), pinned by the cascade contract's keyframe frames +
// chat.tsx literal instead. Every other surface — the inline section + count, all
// six `[data-status]` card containers (border / bg / opacity swaps), the summary
// header grid, the static dot colors, name / meta / duration / status-label /
// body / intent, and the args `<pre>` override over the shared `.maka-code` base
// — is static and diffed in full.
//
// Each card carries the production disclosure default: waiting_permission /
// errored render OPEN; ordinary pending / running / completed / interrupted
// states render COLLAPSED. The rich inner parts ride the open `errored` card,
// and a collapsed `completed` card is diffed too. The non-vacuous collapsed
// signal is the summary's
// border-bottom: 1px on the open card, 0px on the collapsed one (the `[open]`
// gate), so the rows genuinely exercise both states. (The body is hidden via
// Chromium's `::details-content` pseudo, so its child `display` stays `block`
// either way — the collapsed body row still diffs its box / typography parity.)
const tv = (part) => toolVariants({ part });
const openByDefault = (s) => s === 'waiting_permission' || s === 'errored';
// The SINGLE source of truth for the tool-card fixture: every production
// `ToolActivityItem['status']` (the keys of components.tsx's STATUS_LABEL). The
// cards, the header count, and the diffed IDS all derive from this one list, so
// they can't drift apart; the cascade contract asserts it stays complete, so a
// new status can't silently escape the zero-visual proof. `pending` has NO
// `data-[status=pending]` branch in toolVariants, so it falls back to the base
// card border + gray dot; it renders collapsed by default.
const STAT = ['pending', 'waiting_permission', 'running', 'completed', 'errored', 'interrupted'];
const toolCardSection = (el) => {
  const item = pair('maka-tool toolItem', tv('item'));
  const hdr = pair('maka-tool-header', tv('header'));
  const dot = pair('maka-tool-status-dot', tv('dot'));
  const body = pair('maka-tool-body', tv('body'));
  const dotEl = (s, id) => el('span', id, dot, `data-status="${s}" aria-hidden="true"`);
  // The status-invariant inner parts (name / meta / duration / status-label /
  // body / intent / args) ride the OPEN `errored` card so they're each measured
  // once in their visible state — including the `[open]>summary` divider.
  const erroredInner =
    el('summary', 'tool-summary', hdr, '',
        dotEl('errored', 'tool-dot-errored')
        + el('span', 'tool-name', pair('maka-tool-name', tv('name')), '', 'Bash')
        + el('span', 'tool-meta', pair('maka-tool-meta', tv('meta')), '',
            el('span', 'tool-duration', pair('maka-tool-duration', tv('duration')), '', '1.2s')
            + el('span', 'tool-statuslabel', pair('maka-tool-status-label', tv('status-label')), '', '失败')))
      + el('div', 'tool-body', body, '',
          el('p', 'tool-intent', pair('maka-tool-intent', tv('intent')), '', 'run a command')
          + el('pre', 'tool-args', pair('maka-code toolArgs', cn('maka-code', tv('args'))), '', '{ "cmd": "ls" }'));
  // The COLLAPSED `completed` card — the default history state. The summary loses
  // its `[open]>summary` divider (border-bottom 0px vs the open card's 1px — the
  // non-vacuous proof the collapsed branch is really exercised); the body's box /
  // typography parity is diffed too. Both read identical across main/head.
  const completedInner =
    el('summary', 'tool-summary-collapsed', hdr, '',
        dotEl('completed', 'tool-dot-completed')
        + el('span', 'tool-name-collapsed', pair('maka-tool-name', tv('name')), '', 'Read'))
      + el('div', 'tool-body-collapsed', body, '', 'hidden while collapsed');
  const inner = (s) =>
    s === 'errored' ? erroredInner
    : s === 'completed' ? completedInner
    // running dot excluded from IDS (animated); other open/collapsed dots diffed.
    : el('summary', `tool-sum-${s}`, hdr, '', dotEl(s, `tool-dot-${s}`));
  const card = (s) =>
    el('details', `tool-item-${s}`, item, `data-slot="tool" data-status="${s}" ${openByDefault(s) ? 'open' : ''}`, inner(s));
  return el('section', 'tool-section', pair('toolInline', tv('container')), 'aria-label="工具调用记录"',
    el('header', 'tool-section-header', pair('', tv('container-header')), '',
      '<strong>工具调用</strong>'
      + el('span', 'tool-count', pair('maka-tool-count', tv('count')), '', String(STAT.length)))
    + STAT.map(card).join('\n'));
};

// PR3c — the tool-error banner CONTAINER. The ONE thing this harness uniquely proves
// is that the retired `.maka-tool-error` CONTAINER declarations were INERT:
// `.maka-tool-error*` sat in `@layer components` while Alert's slot utilities sit in
// `@layer utilities` (which win regardless of specificity), so its bespoke 18px grid /
// 10px radius / padding / border / background never rendered. The main side (real Alert
// error class + `.maka-tool-error`) and the head side (same Alert class + `mb-[10px]`)
// must therefore compute identically; a wrongly-surviving `.maka-tool-error`
// declaration would surface as a real DIFF here, not a false green. The Alert slot
// classes come from CALLING the real primitive components — single source of truth, no
// hand-copy, no production-API change (a function component is a plain function, so
// `.props.className` is exactly what it renders). The description / copy-button LEAF
// utilities are NOT re-diffed here: they are arbitrary-value Tailwind (source ==
// computed by construction) pinned by visible-copy-hygiene-contract instead.
const ALERT_ERR = Alert({ variant: 'error' }).props.className;
const ALERT_DESC = AlertDescription({}).props.className;
const ALERT_ACTION = AlertAction({}).props.className;
const ALERT_TITLE = AlertTitle({}).props.className;
const errorBanner = (el) => {
  const cont = pair(cn(ALERT_ERR, 'maka-tool-error'), cn(ALERT_ERR, 'mb-[10px]'));
  // The svg + title / description / action slot children carry their real Alert slot
  // classes only so Alert's `has-[>svg]:has-data-[slot=alert-action]` 3-col grid
  // resolves on the container exactly as in production; only `err-banner` is diffed.
  return el('div', 'err-banner', cont, 'data-slot="alert" role="alert"',
      '<svg width="16" height="16" aria-hidden="true"></svg>'
      + el('div', 'err-title', pair(ALERT_TITLE, ALERT_TITLE), 'data-slot="alert-title"', '工具调用失败')
      + el('div', 'err-text', pair(ALERT_DESC, ALERT_DESC), 'data-slot="alert-description"', 'boom: command not found')
      + el('div', 'err-action', pair(ALERT_ACTION, ALERT_ACTION), 'data-slot="alert-action"',
          el('button', 'err-copy', pair(bv('ghost', 'sm'), bv('ghost', 'sm')), 'type="button"', '<svg width="11" height="11"></svg><span>复制</span>')));
};

// DOM tree mirroring TurnView nesting.
const TREE = (side) => {
  const C = (p) => p[side];
  const el = (tag, id, p, attrs, kids = '') => `<${tag} id="${id}" class="${C(p)}" ${attrs}>${kids}</${tag}>`;
  const action = (id, p, attrs) => el('button', id, p, `${attrs} type="button"`, '<svg width="11" height="11"></svg><span>复制中…</span>');
  return [
    el('div', 'footer', pair('maka-turn-footer', mv('footer')), 'role="toolbar"',
      action('footer-rest', fa('quiet'), '') +
      action('footer-pending', fa('secondary'), 'data-pending="true" aria-busy="true"') +
      action('footer-copy-pending', fa('secondary'), 'data-pending="true" data-copy-feedback="pending" aria-busy="true" aria-disabled="true"') +
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
    // Quiet tool-output panel (command + body) used by ToolCardBody / TerminalPreview.
    toolOutputPanel(el, 'tool-output'),
    // The PR3b tool-activity card shell.
    toolCardSection(el),
    // The PR3c tool-error banner (Alert primitive).
    errorBanner(el),
  ].join('\n');
};

const PROPS = ['display', 'height', 'minHeight', 'width', 'maxWidth', 'maxHeight', 'minWidth', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'borderTopColor', 'borderBottomColor', 'borderTopStyle', 'borderTopLeftRadius', 'boxShadow', 'overflowX', 'overflowY', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'lineHeight', 'textTransform', 'gridTemplateColumns', 'columnGap', 'color', 'backgroundColor', 'opacity', 'transition', 'justifyContent', 'alignItems', 'flexWrap', 'flexDirection', 'fontVariantNumeric', 'whiteSpace', 'wordBreak', 'textOverflow', 'textAlign', 'cursor'];
const IDS = ['footer', 'footer-rest', 'footer-pending', 'footer-copy-pending', 'footer-copied', 'footer-failed', 'lineage-row', 'lineage-fwd', 'lineage-row-reverse', 'lineage-rev', 'aborted', 'failed-banner', 'failed-recovery',
  // Quiet tool-output panel (panel + command + body).
  'tool-output', 'tool-output-cmd', 'tool-output-body',
  // PR3b tool-card shell: section + count, all six `[data-status]` card
  // containers at their production default open/collapsed state, the summary header
  // grid, the static dot colors (running dot excluded — animated ring), the
  // status-invariant inner parts (on the open `errored` card), and the COLLAPSED
  // `completed` default — its summary (no `[open]` divider) + UA-hidden body.
  'tool-section', 'tool-section-header', 'tool-count',
  // Derived from the same STAT as the cards (no second hand-kept list to drift):
  // every status' `[data-status]` container is diffed…
  ...STAT.map((s) => `tool-item-${s}`),
  'tool-summary', 'tool-name', 'tool-meta', 'tool-duration', 'tool-statuslabel', 'tool-body', 'tool-intent', 'tool-args',
  'tool-summary-collapsed', 'tool-name-collapsed', 'tool-body-collapsed',
  // …and every static dot, EXCEPT running's (its `maka-tool-pulse` ring is
  // animated → phase-dependent `getComputedStyle`; pinned by the keyframe contract).
  ...STAT.filter((s) => s !== 'running').map((s) => `tool-dot-${s}`),
  // PR3c tool-error banner: the CONTAINER box only — proves `.maka-tool-error` was
  // inert (shadowed by Alert's `@layer utilities`). The description / copy-button leaf
  // utilities are arbitrary-value (source == computed) and pinned by
  // visible-copy-hygiene-contract, so they are not re-diffed here.
  'err-banner'];
// `::before` middot separators are now diffed for real (they render once the
// CSS is inlined — the old `<link>` build couldn't apply them, masking this).
// failed-recovery carries the always-on `before:content-['·']`.
const PSEUDO_IDS = ['failed-recovery'];
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
