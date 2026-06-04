import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('composer send guard', () => {
  it('keeps follow-up submits single-flight until the current send settles', async () => {
    const source = await readFile(join(process.cwd(), '../../packages/ui/src/components.tsx'), 'utf8');
    const sendCurrent = source.match(/async function sendCurrent\(\) \{[\s\S]*?\n  \}/)?.[0] ?? '';
    const toolbar = source.match(/<div className="maka-composer-toolbar[\s\S]*?<\/div>\n        <\/div>/)?.[0] ?? '';

    assert.match(sendCurrent, /sendPendingRef\.current/, 'composer must use a ref guard for same-tick duplicate submits');
    assert.match(sendCurrent, /if \(props\.disabled \|\| sendPendingRef\.current\) return;/);
    assert.match(sendCurrent, /sendPendingRef\.current = true;[\s\S]*setSendPending\(true\);/);
    assert.match(sendCurrent, /finally \{[\s\S]*sendPendingRef\.current = false;[\s\S]*setSendPending\(false\);[\s\S]*\}/);
    assert.match(toolbar, /sendPending \? \(\s*copy\.sending\s*\)/, 'toolbar must surface the transient sending state');
    assert.match(source, /const \[hasDraftText, setHasDraftText\] = useState\(false\);/);
    assert.match(
      source,
      /rememberComposerDraft\(draftStoreRef\.current, activeDraftKeyRef\.current, nextValue\);[\s\S]*setHasDraftText\(Boolean\(nextValue\.trim\(\)\)\);/,
      'draft text state must follow the actual textarea draft value',
    );
    assert.match(source, /const sendDisabled = props\.disabled \|\| sendPending \|\| !hasDraftText;/);
    assert.match(toolbar, /disabled=\{sendDisabled\}/, 'send button must be disabled while empty or submit is in flight');
    assert.match(source, /zh: \{ sendLabel: '发送', stopLabel: '停止' \}/, 'Chinese UI must not keep English Send/Stop button copy');
  });

  it('clears the submitted draft key when first send switches into a new session', async () => {
    const source = await readFile(join(process.cwd(), '../../packages/ui/src/components.tsx'), 'utf8');
    const sendCurrent = source.match(/async function sendCurrent\(\) \{[\s\S]*?\n  \}/)?.[0] ?? '';

    assert.match(
      sendCurrent,
      /const submittedDraftKey = activeDraftKeyRef\.current;[\s\S]*sent = await props\.onSend\(text\);[\s\S]*if \(sent === false\) return;[\s\S]*rememberComposerDraft\(draftStoreRef\.current, submittedDraftKey, ''\);[\s\S]*saveCurrentDraft\(''\);/,
      'successful sends must clear both the original draft key and the current key after a new-session send changes draftKey',
    );
  });
});
