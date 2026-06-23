/**
 * Source contract for active-session message lifecycle.
 *
 * The chat body must not show messages from the previous session while the
 * newly selected session's message read is still in flight. Once a session is
 * already active, transient refresh failures must preserve the visible log
 * instead of blanking the conversation.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const MAIN_RENDERER_SOURCE = join(process.cwd(), 'src', 'renderer', 'main.tsx');

describe('active session message lifecycle contract', () => {
  it('clears stale messages before reading the selected session and guards late reads', async () => {
    const src = await readFile(MAIN_RENDERER_SOURCE, 'utf8');
    const ui = await readFile(join(process.cwd(), '..', '..', 'packages', 'ui', 'src', 'components.tsx'), 'utf8');
    const activeSessionEffect = src.match(/useEffect\(\(\) => \{\s*if \(!activeId\) return;[\s\S]*?readMessages\(activeId\)[\s\S]*?\}, \[activeId\]\);/)?.[0] ?? '';
    const activeReadCatch = activeSessionEffect.match(/readMessages\(activeId\)[\s\S]*?\.catch\(\(error\) => \{[\s\S]*?\n      \}\);/)?.[0] ?? '';
    const refreshMessages = src.match(/async function refreshMessages\(sessionId: string\) \{[\s\S]*?\n  \}/)?.[0] ?? '';
    const retryMessages = src.match(/async function retryMessages\(sessionId: string\) \{[\s\S]*?\n  \}/)?.[0] ?? '';

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
      activeReadCatch,
      /const message = generalizedErrorMessageChinese\(error, '对话内容暂时无法读取，请稍后重试。'\);/,
      'message read failures should use generalized fallback copy instead of raw backend/path details',
    );
    assert.match(
      activeReadCatch,
      /\.catch\(\(error\) => \{[\s\S]*const message = generalizedErrorMessageChinese\(error, '对话内容暂时无法读取，请稍后重试。'\);[\s\S]*setMessageLoadErrorBySession\(\(current\) => \(\{ \.\.\.current, \[activeId\]: message \}\)\);[\s\S]*toastApi\.error\('读取对话失败', message\)/,
      'active-session read failures must set a visible per-session load error after the old chat body has already been cleared',
    );
    assert.doesNotMatch(activeReadCatch, /const message = cleanErrorMessage\(error\)/);
    assert.doesNotMatch(
      activeReadCatch,
      /已保留当前可见内容/,
      'the active read-failure toast must not claim visible content was preserved after the pre-read clear',
    );
    assert.doesNotMatch(
      activeReadCatch,
      /setMessages\(\[\]\)/,
      'the read-failure catch must not perform a second destructive clear; the pre-read clear is the only stale-content boundary',
    );
    assert.match(
      refreshMessages,
      /try \{[\s\S]*readMessages\(sessionId\)[\s\S]*activeIdRef\.current === sessionId[\s\S]*setMessages\(next\)[\s\S]*setMessageLoadErrorBySession[\s\S]*\} catch \(error\) \{[\s\S]*const message = generalizedErrorMessageChinese\(error, '对话内容暂时无法刷新，请稍后重试。'\);[\s\S]*setMessageLoadErrorBySession\(\(current\) => \(\{ \.\.\.current, \[sessionId\]: message \}\)\);[\s\S]*toastApi\.error\('刷新对话失败', message\)/,
      'shared refreshMessages path must surface read failures through the same per-session load error state',
    );
    assert.doesNotMatch(refreshMessages, /const message = cleanErrorMessage\(error\)/);
    assert.doesNotMatch(
      refreshMessages,
      /catch \(error\) \{[\s\S]*setMessages\(\[\]\)/,
      'background message refresh failures must preserve the visible conversation instead of blanking the chat',
    );
    assert.match(
      src,
      /const \[messageRetryPendingBySession, setMessageRetryPendingBySession\] = useState<Record<string, boolean>>\(\{\}\);[\s\S]*const messageRetryPendingRef = useRef<Set<string>>\(new Set\(\)\)/,
      'desktop shell must track message retry pending state outside React render timing',
    );
    assert.match(
      src,
      /function addPendingSessionAction\([\s\S]*pendingRef\.current\.has\(sessionId\)[\s\S]*pendingRef\.current\.add\(sessionId\)[\s\S]*setPendingBySession/,
      'manual message-load retry must use a ref-backed same-frame duplicate guard',
    );
    assert.match(
      retryMessages,
      /if \(!addPendingSessionAction\(sessionId, messageRetryPendingRef, setMessageRetryPendingBySession\)\) return;[\s\S]*await refreshMessages\(sessionId\);[\s\S]*finally \{[\s\S]*clearPendingSessionAction\(sessionId, messageRetryPendingRef, setMessageRetryPendingBySession\)/,
      'manual retry must clear its pending state even when refreshMessages fails',
    );
    assert.match(
      src,
      /messageLoadError=\{activeId \? messageLoadErrorBySession\[activeId\] : undefined\}[\s\S]*messageLoadRetryPending=\{activeId \? messageRetryPendingBySession\[activeId\] === true : false\}[\s\S]*onRetryMessages=\{activeId \? \(\) => void retryMessages\(activeId\) : undefined\}/,
      'desktop shell must pass the active session load error, pending state, and guarded retry action to ChatView',
    );
    assert.doesNotMatch(
      src,
      /onRetryMessages=\{activeId \? \(\) => void refreshMessages\(activeId\) : undefined\}/,
      'manual retry must not call refreshMessages directly because that allows duplicate read IPCs',
    );
    assert.match(
      ui,
      /messageLoadRetryPending\?: boolean/,
      'ChatView must accept explicit message-load retry pending state',
    );
    assert.match(
      ui,
      /props\.messageLoadError \? \([\s\S]*role="alert" aria-busy=\{props\.messageLoadRetryPending \? 'true' : undefined\}[\s\S]*title="对话载入失败"[\s\S]*body=\{props\.messageLoadError\}[\s\S]*label: props\.messageLoadRetryPending \? '载入中…' : '重试载入'[\s\S]*disabled: props\.messageLoadRetryPending/,
      'ChatView must render an explicit load-error state instead of the normal empty chat hero',
    );
  });
});
