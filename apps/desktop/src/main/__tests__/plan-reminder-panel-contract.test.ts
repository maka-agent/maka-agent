import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');

function blockBetween(source: string, start: string, end: string): string {
  return source.match(new RegExp(`${start}[\\s\\S]*?${end}`))?.[0] ?? '';
}

describe('Plan Reminder panel async action contract', () => {
  it('gates form submit and refresh before React commits disabled state', async () => {
    const ui = await readFile(resolve(REPO_ROOT, 'packages/ui/src/components.tsx'), 'utf8');
    const panelBlock = blockBetween(ui, 'function PlanReminderPanel', '\\/\\*\\*');
    const submitBlock = blockBetween(panelBlock, 'async function submit', 'async function runPlanReminderAction');
    const refreshBlock = blockBetween(panelBlock, 'async function refreshFromPanel', 'return \\(');

    assert.match(panelBlock, /const \[submitPending, setSubmitPending\] = useState\(false\)/);
    assert.match(panelBlock, /const \[refreshPending, setRefreshPending\] = useState\(false\)/);
    assert.match(panelBlock, /const submitPendingRef = useRef\(false\)/);
    assert.match(panelBlock, /const refreshPendingRef = useRef\(false\)/);
    assert.match(
      panelBlock,
      /return \(\) => \{\s*planReminderMountedRef\.current = false;\s*submitPendingRef\.current = false;\s*refreshPendingRef\.current = false;\s*pendingActionKeysRef\.current = new Set\(\);/,
      'Plan Reminder pending form/refresh owners must be released when the panel unmounts',
    );

    assert.match(
      panelBlock,
      /function closeReminderDialog\(\) \{\s*if \(submitPendingRef\.current\) return;\s*setFormDialogOpen\(false\);/,
      'The form dialog must not close while a submit is still owned by the panel',
    );
    assert.match(
      submitBlock,
      /event\.preventDefault\(\);\s*if \(submitDisabled \|\| submitPendingRef\.current\) return;\s*submitPendingRef\.current = true;/,
      'Plan Reminder submit must synchronously reject duplicate submits before React disables the submit button',
    );
    assert.match(submitBlock, /setSubmitPending\(true\);/);
    assert.match(
      submitBlock,
      /finally \{\s*submitPendingRef\.current = false;\s*if \(planReminderMountedRef\.current\) setSubmitPending\(false\);/,
      'Plan Reminder submit owner must release without writing React state after unmount',
    );
    assert.match(panelBlock, /const submitDisabled = !canCreate \|\| submitPending;/);
    assert.match(panelBlock, /<form className="maka-plan-form" onSubmit=\{submit\} aria-busy=\{submitPending \? 'true' : undefined\}>/);
    assert.match(panelBlock, /<UiButton className="maka-button maka-plan-submit" type="submit" disabled=\{submitDisabled\}>/);

    assert.match(
      refreshBlock,
      /if \(!props\.onRefresh \|\| refreshPendingRef\.current\) return;\s*refreshPendingRef\.current = true;\s*setRefreshPending\(true\);/,
      'Plan Reminder refresh must synchronously reject duplicate refresh clicks before React disables the icon button',
    );
    assert.match(
      refreshBlock,
      /finally \{\s*refreshPendingRef\.current = false;\s*if \(planReminderMountedRef\.current\) setRefreshPending\(false\);/,
      'Plan Reminder refresh owner must release without writing React state after unmount',
    );
    assert.match(panelBlock, /disabled=\{!props\.onRefresh \|\| refreshPending\}/);
    assert.match(panelBlock, /aria-busy=\{refreshPending \? 'true' : undefined\}/);
  });
});
