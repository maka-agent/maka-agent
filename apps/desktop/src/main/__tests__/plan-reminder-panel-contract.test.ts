import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { extractFunctionBlock } from './function-block-helpers.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');

function blockBetween(source: string, start: string, end: string): string {
  return source.match(new RegExp(`${start}[\\s\\S]*?${end}`))?.[0] ?? '';
}

describe('Plan Reminder panel async action contract', () => {
  // Issue #1044: the create/edit form (all field state + the submit owner)
  // moved into PlanReminderFormDialog; the panel keeps list/runs/query state
  // plus the per-action pending + refresh owners. Each invariant below is
  // asserted against the component that now owns it.
  it('gates form submit and refresh before React commits disabled state', async () => {
    const ui = await readFile(resolve(REPO_ROOT, 'packages/ui/src/plan-reminder-panel.tsx'), 'utf8');
    const dialog = await readFile(resolve(REPO_ROOT, 'packages/ui/src/plan-reminder-form-dialog.tsx'), 'utf8');
    const panelBlock = extractFunctionBlock(ui, 'PlanReminderPanel');
    const dialogBlock = extractFunctionBlock(dialog, 'PlanReminderFormDialog');
    const submitBlock = blockBetween(dialogBlock, 'async function submit', 'return \\(');
    const refreshBlock = blockBetween(panelBlock, 'async function refreshFromPanel', 'return \\(');

    assert.match(dialogBlock, /const \[submitPending, setSubmitPending\] = useState\(false\)/);
    assert.match(panelBlock, /const \[refreshPending, setRefreshPending\] = useState\(false\)/);
    assert.match(dialogBlock, /const submitPendingRef = useRef\(false\)/);
    assert.match(panelBlock, /const refreshPendingRef = useRef\(false\)/);
    assert.match(
      dialogBlock,
      /return \(\) => \{\s*submitPendingRef\.current = false;\s*\};\s*\}, \[\]\)/,
      'Plan Reminder pending form owner must be released when the dialog unmounts',
    );
    assert.match(
      panelBlock,
      /return \(\) => \{\s*refreshPendingRef\.current = false;\s*pendingActionKeysRef\.current = new Set\(\);/,
      'Plan Reminder refresh/action pending owners must be released when the panel unmounts',
    );

    assert.match(
      dialogBlock,
      /function closeReminderDialog\(\) \{\s*if \(submitPendingRef\.current\) return;\s*props\.onOpenChange\(false\);/,
      'The form dialog must not close while a submit is still owned by the dialog',
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
    assert.match(dialogBlock, /const submitDisabled = !canCreate \|\| submitPending;/);
    assert.match(dialogBlock, /<form className="maka-plan-form" onSubmit=\{submit\} aria-busy=\{submitPending \? 'true' : undefined\}>/);
    assert.match(dialogBlock, /<UiButton type="submit" disabled=\{submitDisabled\}>/);

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
