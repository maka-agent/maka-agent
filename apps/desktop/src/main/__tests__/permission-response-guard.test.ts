import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('permission prompt response guard', () => {
  it('keeps allow/deny decisions single-flight for a request id', async () => {
    const source = await readFile(join(process.cwd(), '../../packages/ui/src/permission-dialog.tsx'), 'utf8');
    const prompt = source.match(/export function PermissionPrompt[\s\S]*?function renderPermissionSummary/)?.[0] ?? '';
    // PR-PERMISSION-UI-CLEANUP-0: submit() became async + try/finally
    // (was try/catch+throw). The single-flight contract is unchanged;
    // only the reset path moved from catch to finally so the pending
    // state clears on success too — necessary because the parent's
    // `respondToPermission` now swallows IPC errors via toast
    // (PR-STOP-ERROR-SURFACE-0).
    const submit = prompt.match(/async function submit\(decision: PermissionResponse\['decision'\]\) \{[\s\S]*?\n  \}/)?.[0] ?? '';

    assert.match(prompt, /const \[responsePending, setResponsePending\] = useState\(false\);/);
    assert.match(prompt, /const responsePendingRef = useRef\(false\);/);
    assert.match(prompt, /const permissionMountedRef = useRef\(true\);/);
    assert.match(prompt, /const activePermissionRequestIdRef = useRef\(props\.request\.requestId\);/);
    assert.match(
      prompt,
      /useEffect\(\(\) => \{\s*permissionMountedRef\.current = true;\s*return \(\) => \{\s*permissionMountedRef\.current = false;\s*\};\s*\}, \[\]\)/,
      'permission response settlement must not update state after the prompt unmounts',
    );
    assert.match(
      prompt,
      /activePermissionRequestIdRef\.current = props\.request\.requestId;[\s\S]*responsePendingRef\.current = false;[\s\S]*setNow\(Date\.now\(\)\);/,
      'new permission request must become the active owner before clearing stale pending state',
    );
    assert.match(prompt, /responsePendingRef\.current = false;[\s\S]*setNow\(Date\.now\(\)\);/, 'new permission request must clear stale pending state');
    assert.match(submit, /if \(responsePendingRef\.current\) return;/, 'same request must ignore duplicate allow\/deny clicks');
    assert.match(submit, /const requestId = props\.request\.requestId;/, 'submit must capture the request id that owns the pending response');
    assert.match(submit, /responsePendingRef\.current = true;[\s\S]*setResponsePending\(true\);/);
    // submit() now awaits onRespond and resets pending in finally so
    // both success and async rejection paths clear the lock.
    assert.match(submit, /await props\.onRespond\(/);
    assert.match(submit, /requestId,[\s\S]*decision,[\s\S]*rememberForTurn/);
    assert.match(
      submit,
      /\}\s*finally\s*\{[\s\S]*if \(activePermissionRequestIdRef\.current === requestId\) \{[\s\S]*responsePendingRef\.current = false;[\s\S]*if \(permissionMountedRef\.current\) setResponsePending\(false\);[\s\S]*\}/,
      'only the request that owns the pending response may clear the pending lock',
    );
    assert.match(prompt, /disabled=\{responsePending\}[\s\S]*onClick=\{\(\) => submit\('deny'\)\}/);
    assert.match(prompt, /disabled=\{responsePending\}[\s\S]*onClick=\{\(\) => submit\('allow'\)\}/);
    assert.match(prompt, /responsePending \? '正在提交…'/);
  });
});
