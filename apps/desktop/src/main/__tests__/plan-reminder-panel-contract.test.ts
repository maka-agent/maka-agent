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

  it('keeps the 保持系统唤醒 toggle optimistic, revert-on-error, and unmount-safe', async () => {
    const ui = await readFile(resolve(REPO_ROOT, 'packages/ui/src/plan-reminder-panel.tsx'), 'utf8');
    const panelBlock = extractFunctionBlock(ui, 'PlanReminderPanel');
    const toggleBlock = blockBetween(panelBlock, 'async function toggleKeepSystemAwake', 'function openReminderDialog');

    // Pending owner is a ref (sync guard) + React state (disables the switch).
    assert.match(panelBlock, /const \[keepSystemAwakePending, setKeepSystemAwakePending\] = useState\(false\)/);
    assert.match(panelBlock, /const keepSystemAwakePendingRef = useRef\(false\)/);

    // The capability is gated on the host wiring BOTH the value and the setter;
    // otherwise the row hides entirely (fail-soft on an older main / no bridge).
    assert.match(
      panelBlock,
      /const keepSystemAwakeSupported =\s*props\.keepSystemAwake !== undefined && typeof props\.onKeepSystemAwakeChange === 'function';/,
    );
    assert.match(panelBlock, /\{keepSystemAwakeSupported && \(/);

    // The unmount cleanup must also release the keep-awake pending owner so a
    // slow IPC write cannot write state after the panel is gone.
    assert.match(
      panelBlock,
      /refreshPendingRef\.current = false;\s*pendingActionKeysRef\.current = new Set\(\);\s*keepSystemAwakePendingRef\.current = false;/,
      'keep-awake pending owner must be released on unmount alongside the refresh/action owners',
    );

    // Toggle: synchronous duplicate-guard, optimistic flip, revert + Chinese
    // toast on failure, mounted-guarded state writes in finally.
    assert.match(
      toggleBlock,
      /if \(!props\.onKeepSystemAwakeChange \|\| keepSystemAwakePendingRef\.current\) return;\s*keepSystemAwakePendingRef\.current = true;/,
      'keep-awake toggle must synchronously reject a duplicate/absent-handler flip before awaiting the write',
    );
    assert.match(toggleBlock, /setKeepSystemAwakeChecked\(next\); \/\/ optimistic/);
    // Revert + toast on failure (asserted individually so an explanatory
    // comment between the catch and the revert does not brittle-break the pin).
    assert.match(toggleBlock, /catch \(error\) \{/);
    assert.match(
      toggleBlock,
      /if \(planReminderMountedRef\.current\) setKeepSystemAwakeChecked\(!next\);/,
      'a failed write must revert the optimistic switch',
    );
    assert.match(
      toggleBlock,
      /toast\.error\(\s*'无法更新保持系统唤醒',/,
      'a failed write must surface a Chinese error toast',
    );
    assert.match(
      toggleBlock,
      /finally \{\s*keepSystemAwakePendingRef\.current = false;\s*if \(planReminderMountedRef\.current\) setKeepSystemAwakePending\(false\);/,
      'keep-awake toggle owner must release without writing React state after unmount',
    );

    // The switch reflects the optimistic state and disables while a write runs.
    assert.match(panelBlock, /checked=\{keepSystemAwakeChecked\}/);
    assert.match(panelBlock, /disabled=\{keepSystemAwakePending\}/);
    assert.match(panelBlock, /onChange=\{\(next\) => void toggleKeepSystemAwake\(next\)\}/);
  });
});
