/**
 * Source contract for active-session message lifecycle.
 *
 * The chat body must not show messages from the previous session while the
 * newly selected session's message read is still in flight or has failed.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const MAIN_RENDERER_SOURCE = join(process.cwd(), 'src', 'renderer', 'main.tsx');

describe('active session message lifecycle contract', () => {
  it('clears stale messages before reading the selected session and guards late reads', async () => {
    const src = await readFile(MAIN_RENDERER_SOURCE, 'utf8');
    const activeSessionEffect = src.match(/useEffect\(\(\) => \{[\s\S]*?readMessages\(activeId\)[\s\S]*?\}, \[activeId\]\);/)?.[0] ?? '';
    const refreshMessages = src.match(/async function refreshMessages\(sessionId: string\) \{[\s\S]*?\n  \}/)?.[0] ?? '';

    assert.match(
      activeSessionEffect,
      /const subscribedAt = Date\.now\(\);[\s\S]*setMessages\(\[\]\);[\s\S]*readMessages\(activeId\)/,
      'selecting a new active session must clear the old chat body before async message read resolves',
    );
    assert.match(
      activeSessionEffect,
      /if \(!disposed && activeIdRef\.current === activeId\) setMessages\(next\)/,
      'late active-session reads may set messages only while the same session is still active',
    );
    assert.match(
      activeSessionEffect,
      /\.catch\(\(\) => \{[\s\S]*if \(!disposed && activeIdRef\.current === activeId\) setMessages\(\[\]\);[\s\S]*\}\)/,
      'active-session read failures must clear stale messages instead of leaving old content visible',
    );
    assert.match(
      refreshMessages,
      /try \{[\s\S]*readMessages\(sessionId\)[\s\S]*activeIdRef\.current === sessionId[\s\S]*setMessages\(next\)[\s\S]*\} catch \{[\s\S]*activeIdRef\.current === sessionId[\s\S]*setMessages\(\[\]\)/,
      'shared refreshMessages path must catch read failures and clear only the active session',
    );
  });
});
