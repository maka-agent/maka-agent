import { test, expect } from './fixtures';

// Locks the structure promised by #1433 (desired outcome 3): the workspace
// topbar collapses its secondary actions behind a single overflow menu
// instead of rendering them as persistent icon buttons. The workbar toggle
// stays direct (it is a layout control, symmetric with the sidebar toggle).
test('workspace topbar folds secondary actions into an overflow menu', async ({ window: page }) => {
  const toolbar = page.getByRole('toolbar', { name: '工作区辅助操作' });
  await expect(toolbar).toBeVisible();

  // Secondary actions no longer render as direct buttons in the toolbar.
  for (const name of ['问题反馈', '打开命令面板', '打开帮助', '打开健康中心']) {
    await expect(toolbar.getByRole('button', { name })).toHaveCount(0);
  }

  // They live behind a single overflow trigger.
  const overflow = toolbar.getByRole('button', { name: '更多操作' });
  await expect(overflow).toBeVisible();

  // Opening the menu surfaces all four entries.
  await overflow.click();
  await expect(page.getByRole('menuitem', { name: '问题反馈' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: '打开命令面板' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: '打开帮助' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: '打开健康中心' })).toBeVisible();
});
