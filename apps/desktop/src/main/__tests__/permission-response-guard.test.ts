import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('permission dialog response guard', () => {
  it('keeps allow/deny decisions single-flight for a request id', async () => {
    const source = await readFile(join(process.cwd(), '../../packages/ui/src/components.tsx'), 'utf8');
    const dialog = source.match(/export function PermissionDialog[\s\S]*?function renderPermissionSummary/)?.[0] ?? '';
    const submit = dialog.match(/function submit\(decision: PermissionResponse\['decision'\]\) \{[\s\S]*?\n  \}/)?.[0] ?? '';

    assert.match(dialog, /const \[responsePending, setResponsePending\] = useState\(false\);/);
    assert.match(dialog, /const responsePendingRef = useRef\(false\);/);
    assert.match(dialog, /responsePendingRef\.current = false;[\s\S]*setNow\(Date\.now\(\)\);/, 'new permission request must clear stale pending state');
    assert.match(submit, /if \(responsePendingRef\.current\) return;/, 'same request must ignore duplicate allow\/deny clicks');
    assert.match(submit, /responsePendingRef\.current = true;[\s\S]*setResponsePending\(true\);/);
    assert.match(submit, /catch \(error\) \{[\s\S]*responsePendingRef\.current = false;[\s\S]*setResponsePending\(false\);[\s\S]*throw error;[\s\S]*\}/);
    assert.match(dialog, /disabled=\{responsePending\}[\s\S]*onClick=\{\(\) => submit\('deny'\)\}/);
    assert.match(dialog, /disabled=\{responsePending\}[\s\S]*onClick=\{\(\) => submit\('allow'\)\}/);
    assert.match(dialog, /responsePending \? '正在提交…'/);
  });
});
