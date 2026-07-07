/**
 * CHAT-TURN-SPACING-0 (issue #546 PR5): the chat surface uses one uniform
 * turn gap — `.maka-chat` (between turns) and `.maka-turn` (within a turn)
 * both at `--space-3` (12px) — instead of the earlier loose-between /
 * tight-within split (24px / 8px). Uniform density reads as a continuous
 * coding-agent stream rather than stacked Q+A blocks; the single token
 * keeps both on the spacing scale so neither drifts to a magic number.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { REPO_ROOT, TOKENS_FILE, stripCssComments } from './css-test-helpers.js';

/** Extract the declaration body of a top-level `selector { … }` rule (no
 *  nested blocks — .maka-chat / .maka-turn are flat declaration lists). */
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