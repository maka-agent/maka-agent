import { test, expect } from './fixtures';

test('session tools share one user-controlled workbar', async ({ sessionWorkbarWindow: page }) => {
  const workbar = page.getByRole('complementary', { name: '会话工作栏' });
  const tabs = workbar.getByRole('tablist', { name: '会话工作栏栏目' });

  await expect(tabs.getByRole('tab', { name: /任务/ })).toHaveAttribute('aria-selected', 'true');
  await expect(tabs.getByRole('tab', { name: /浏览器/ })).toBeDisabled();
  await expect(tabs.getByRole('tab', { name: /文件/ })).toBeEnabled();
  await expect(workbar.getByText('完成会话任务台账升级')).toBeVisible();

  await page.getByRole('button', { name: '收起会话工作栏' }).click();
  await expect(workbar).toBeHidden();

  await page.getByRole('button', { name: '展开会话工作栏' }).click();
  await expect(workbar).toBeVisible();
  await tabs.getByRole('tab', { name: /文件/ }).click();
  await expect(workbar.getByText('暂无生成文件')).toBeVisible();
});
