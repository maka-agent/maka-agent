import { test, expect } from './fixtures';

test('adds SiliconFlow from the provider catalog as an in-pane Settings flow', async ({ window: page }) => {
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await page.getByRole('button', { name: '设置' }).click();
  await expect(page.getByLabel('设置内容')).toBeVisible();

  await page.locator('[aria-label="设置分组"]').getByText('模型', { exact: true }).click();
  await page.getByRole('button', { name: '添加服务商' }).click();

  await expect(page.getByPlaceholder('搜索服务商')).toBeVisible();
  await page.getByPlaceholder('搜索服务商').fill('SiliconFlow');
  await page.getByRole('button', { name: /添加模型供应商：SiliconFlow/ }).click();

  await expect(page.getByLabel('模型供应商默认模型')).toHaveValue('moonshotai/Kimi-K2.6');
  await page.getByRole('button', { name: '保存供应商' }).click();

  await expect(page.getByRole('heading', { name: 'SiliconFlow', exact: true }).first()).toBeVisible();
  await expect(page.getByText('moonshotai/Kimi-K2.6', { exact: true }).first()).toBeVisible();
  await expect(page.locator('.providerConfigOverlay')).toHaveCount(0);
});
