/**
 * CHAT-TURN-SPACING-0 (issue #546 PR5): the chat surface uses one uniform
 * turn gap — `.maka-chat` (between turns) and `.maka-turn` (within a turn)
 * both at `--space-3` (12px) — instead of the earlier loose-between /
 * tight-within split (24px / 8px). Uniform density reads as a continuous
 * coding-agent stream rather than stacked Q+A blocks; the single token
 * keeps both on the spacing scale so neither drifts to a magic number.
 *
 * CHAT-MESSAGE-TIME-0 (issue #546 PR5): the inline message timestamp
 * (`.maka-message-time-inline`) aligns to the caption tier
 * (`--font-size-caption`, 11px) at normal weight (`--font-weight-normal`,
 * 400) in muted color, so it reads as quiet meta — the same tier the
 * footer-action cva already uses via `text-xs` (the caption alias). It
 * was previously the UI tier (13px / medium 500), one step louder than
 * the surrounding chrome.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { REPO_ROOT, TOKENS_FILE, stripCssComments } from './css-test-helpers.js';

const CHAT_MESSAGE_CSS = resolve(REPO_ROOT, 'apps', 'desktop', 'src', 'renderer', 'styles', 'chat-message.css');

/** Extract the declaration body of a top-level `selector { … }` rule (no
 *  nested blocks — the rules asserted here are flat declaration lists). */
function ruleBody(css: string, selector: string): string | null {
  const pattern = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}';
  return css.match(new RegExp(pattern, 'm'))?.[1] ?? null;
}

describe('CHAT-TURN-SPACING-0 contract (#546 PR5)', () => {
  it('.maka-chat and .maka-turn both use gap: var(--space-3) (uniform 12/12)', async () => {
    const css = stripCssComments(await readFile(TOKENS_FILE, 'utf8'));
    const chat = ruleBody(css, '.maka-chat');
    const turn = ruleBody(css, '.maka-turn');
    assert.ok(chat, '.maka-chat rule must exist in maka-tokens.css');
    assert.ok(turn, '.maka-turn rule must exist in maka-tokens.css');
    assert.match(
      chat,
      /gap:\s*var\(--space-3\)/,
      '.maka-chat gap must be var(--space-3) (12px), uniform with .maka-turn — the between-turn gap',
    );
    assert.match(
      turn,
      /gap:\s*var\(--space-3\)/,
      '.maka-turn gap must be var(--space-3) (12px), uniform with .maka-chat — the within-turn gap',
    );
  });
});

describe('CHAT-MESSAGE-TIME-0 contract (#546 PR5)', () => {
  it('.maka-message-time-inline uses the caption tier at normal weight in muted color', async () => {
    const css = stripCssComments(await readFile(CHAT_MESSAGE_CSS, 'utf8'));
    const block = ruleBody(css, '.maka-message-time-inline');
    assert.ok(block, '.maka-message-time-inline rule must exist in chat-message.css');
    assert.match(
      block,
      /font-size:\s*var\(--font-size-caption\)/,
      '.maka-message-time-inline font-size must be var(--font-size-caption) (11px caption tier), not --font-size-ui (13px)',
    );
    assert.match(
      block,
      /font-weight:\s*var\(--font-weight-normal\)/,
      '.maka-message-time-inline font-weight must be var(--font-weight-normal) (400), not --font-weight-medium (500) — quiet meta',
    );
    assert.match(
      block,
      /color:\s*var\(--muted-foreground\)/,
      '.maka-message-time-inline color must stay var(--muted-foreground) (muted)',
    );
  });
});