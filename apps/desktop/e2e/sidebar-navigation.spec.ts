import type { Page } from '@playwright/test';
import { test, expect } from './fixtures.js';

async function expandedSidebar(page: Page) {
  const expand = page.getByRole('button', { name: '展开侧边栏' });
  if (await expand.count()) await expand.click();
  return page.getByRole('complementary', { name: '对话列表' });
}

test('session grouping menu applies and retains the selected mode', async ({ window: page }) => {
  const sidebar = await expandedSidebar(page);
  const grouping = sidebar.getByRole('button', { name: '会话分组方式' });

  await grouping.click();
  const byStatus = page.getByRole('menuitemradio', { name: '按状态' });
  const byProject = page.getByRole('menuitemradio', { name: '按项目' });
  await expect(byStatus).toHaveAttribute('aria-checked', 'true');
  await byProject.click();

  await grouping.click();
  await expect(page.getByRole('menuitemradio', { name: '按项目' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('menuitemradio', { name: '按状态' })).toHaveAttribute('aria-checked', 'false');
});

test('scheduled-task hub restores the last selected child module', async ({ window: page }) => {
  const sidebar = await expandedSidebar(page);
  const scheduledTasks = sidebar.getByRole('button', { name: '定时任务', exact: true });
  await scheduledTasks.click();

  const selector = page.locator('.maka-module-hub-selector-trigger');
  await expect(selector).toHaveAccessibleName('定时任务内容：计划提醒');
  await selector.click();
  await page.getByRole('menuitemradio', { name: '每日回顾' }).click();
  await expect(selector).toHaveAccessibleName('定时任务内容：每日回顾');

  await sidebar.getByRole('button', { name: '扩展', exact: true }).click();
  await scheduledTasks.click();
  await expect(selector).toHaveAccessibleName('定时任务内容：每日回顾');
});
