/**
 * MARKDOWN-PROSE-CONVERGE-0 (issue #546 PR4): the Markdown prose element
 * layer (.maka-prose) is the single home for assistant-message body
 * typography — p / h* / ul / ol / li / a / code / pre / blockquote / table
 * / th / td / hr. It is split off the .maka-bubble-assistant shell so the
 * same prose rules can be reused by other Markdown consumers (tool-result
 * bodies in #546 PR5) without inheriting bubble geometry (max-width: 72ch,
 * padding, generic first/last-child margin reset) that belongs to the
 * assistant surface specifically.
 *
 * Three invariants:
 *
 * 1. Prose element rules live under .maka-prose, not .maka-bubble-assistant.
 *    The shell keeps only container geometry + the generic first/last-child
 *    margin reset; element-specific typography (margins, font-size, list
 *    style, link/border, code padding, blockquote/table chrome) moves to
 *    .maka-prose.
 *
 * 2. The assistant Bubble variant carries `maka-prose` alongside
 *    `maka-bubble-assistant`, so an assistant message actually renders the
 *    prose layer (the class is what activates the descendant rules).
 *
 * 3. .maka-prose is authored in chat-message.css (the message-body surface
 *    file) — one home, not scattered back into maka-tokens.css.
 *
 * Scope note: this contract locks prose-element *ownership* (which selector
 * scope owns p/h/ul/... rules). The *values* those rules use (font-size,
 * spacing, line-height, radius) are governed by the existing typography /
 * line-height / spacing / radius / border-width converge contracts — this
 * test does not re-scan them.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { REPO_ROOT, stripCssComments } from './css-test-helpers.js';

const CHAT_MESSAGE_CSS = resolve(REPO_ROOT, 'apps', 'desktop', 'src', 'renderer', 'styles', 'chat-message.css');
const TOKENS_CSS = resolve(REPO_ROOT, 'apps', 'desktop', 'src', 'renderer', 'maka-tokens.css');
const CHAT_PRIMITIVE = resolve(REPO_ROOT, 'packages', 'ui', 'src', 'primitives', 'chat.tsx');

/** Markdown block + inline elements whose typography the prose layer owns. */
const PROSE_ELEMENTS = [
  'p', 'h1', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'a',
  'code', 'pre', 'blockquote', 'table', 'th', 'td', 'hr',
] as const;

/**
 * Split CSS into individual leaf selectors (the comma-separated, pre-`{`
 * selector text of every rule block), so a grouped selector list like
 * `.maka-prose h1, .maka-prose h2,` yields two entries.
 *
 * Strips comments first; treats the CSS as flat (chat-message.css has no
 * nesting — only `@media` / `@keyframes` at-rules, whose inner selectors
 * are still extracted, which is fine because none of the prose elements
 * live inside them).
 */
function leafSelectors(css: string): string[] {
  const stripped = stripCssComments(css);
  // Everything between a `}` (or start) and the next `{` is a selector list.
  const selectorLists = stripped
    .split('{')
    .map((chunk, i, arr) => (i < arr.length - 1 ? chunk.split('}').pop()! : ''))
    .filter(Boolean);
  return selectorLists.flatMap((list) => list.split(',').map((s) => s.trim()));
}

describe('MARKDOWN-PROSE-CONVERGE-0 contract (#546 PR4)', () => {
  it('every Markdown prose element has a rule scoped under .maka-prose', async () => {
    const css = await readFile(CHAT_MESSAGE_CSS, 'utf8');
    const selectors = leafSelectors(css);
    const missing: string[] = [];
    for (const el of PROSE_ELEMENTS) {
      const has = selectors.some((sel) => sel.startsWith('.maka-prose') && new RegExp(`\\b${el}\\b`).test(sel));
      if (!has) missing.push(el);
    }
    assert.deepEqual(
      missing,
      [],
      `chat-message.css must scope these prose elements under .maka-prose (found none): ${missing.join(', ')}`,
    );
  });

  it('no prose element rule lingers scoped under .maka-bubble-assistant', async () => {
    const css = await readFile(CHAT_MESSAGE_CSS, 'utf8');
    const lingering: string[] = [];
    for (const el of PROSE_ELEMENTS) {
      // `.maka-bubble-assistant <el>` as a descendant — the old prose form.
      // The shell's own `.maka-bubble-assistant {…}` and its generic
      // `> :first-child` / `> :last-child` / `> :nth-last-child(2)` resets
      // are element-agnostic, so they don't trip this (no bare element type).
      const re = new RegExp(`\\.maka-bubble-assistant\\s+${el}\\b`);
      if (re.test(stripCssComments(css))) lingering.push(el);
    }
    assert.deepEqual(
      lingering,
      [],
      `these prose elements are still scoped under .maka-bubble-assistant — move them to .maka-prose: ${lingering.join(', ')}`,
    );
  });

  it('the assistant Bubble variant carries maka-prose so the prose layer applies', async () => {
    const src = await readFile(CHAT_PRIMITIVE, 'utf8');
    // bubbleVariants assistant emits both the shell and the prose layer.
    assert.match(
      src,
      /assistant:\s*["'`]maka-bubble-assistant\s+maka-prose["'`]/,
      'bubbleVariants assistant must be "maka-bubble-assistant maka-prose" so .maka-prose descendant rules render on assistant messages',
    );
  });

  it('.maka-prose is authored in chat-message.css, not repooled into maka-tokens.css', async () => {
    const tokens = stripCssComments(await readFile(TOKENS_CSS, 'utf8'));
    assert.ok(
      !/\.maka-prose\b/.test(tokens),
      '.maka-prose must live in chat-message.css (the message-body surface), not maka-tokens.css',
    );
  });
});

/**
 * Split a comment-stripped CSS string into [selectorList, decls] block pairs.
 * Flat parser (chat-message.css has no nesting beyond @media/@keyframes, whose
 * inner rules still split cleanly).
 */
function cssBlocks(css: string): Array<{ selectors: string; decls: string }> {
  return css
    .split('}')
    .map((chunk) => chunk.split('{'))
    .filter((parts) => parts.length === 2)
    .map(([selectors, decls]) => ({ selectors: selectors.trim(), decls: (decls ?? '').trim() }));
}

describe('CODE-BLOCK-PRE-FONT-TIER-0 contract (#546 PR5)', () => {
  // The assistant code block <pre> must render at the UI/chrome tier
  // (--font-size-ui), NOT inherit the prose body size. A pre-existing reset
  //   [data-slot="message"] pre { margin: 0; font: inherit }   (specificity 0,1,1)
  // authored LATER in chat-message.css clobbers a bare `.maka-prose pre` rule
  // (same specificity 0,1,1, earlier source → loses). The code-block pre rule
  // must therefore carry an extra class — `.maka-prose .maka-code-block pre`
  // (specificity 0,2,1) — so it outweighs the reset and the token tier holds.
  // The reset itself stays, so non-code-block raw <pre> (user / system) still
  // inherits the message font instead of falling back to the UA monospace.

  it('the code-block pre is scoped to outweigh the [data-slot=message] reset and uses --font-size-ui', async () => {
    const css = stripCssComments(await readFile(CHAT_MESSAGE_CSS, 'utf8'));
    const blocks = cssBlocks(css);
    const cb = blocks.find(({ selectors, decls }) =>
      /\.maka-code-block\s+pre\b/.test(selectors)
      && /font-size:\s*var\(--font-size-ui\)/.test(decls));
    assert.ok(
      cb,
      'expected a rule scoped `.maka-prose .maka-code-block pre { font-size: var(--font-size-ui) }` (specificity 0,2,1) to outweigh the `[data-slot="message"] pre { font: inherit }` reset (0,1,1); a bare `.maka-prose pre` is clobbered by the later reset',
    );
  });

  it('the [data-slot=message] pre reset still exists for non-code-block raw pre', async () => {
    const css = stripCssComments(await readFile(CHAT_MESSAGE_CSS, 'utf8'));
    assert.match(
      css,
      /\[data-slot="message"\]\s+pre\s*\{[^}]*font:\s*inherit/,
      'the [data-slot="message"] pre { font: inherit } reset must remain so non-code-block raw <pre> (user / system) inherits the message font instead of UA monospace',
    );
  });
});
