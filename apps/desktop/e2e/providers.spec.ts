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

test('adds MiniMax Coding Plan under its independent provider id with an exact snapshot model', async ({ window: page }) => {
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await page.getByRole('button', { name: '设置' }).click();
  await page.locator('[aria-label="设置分组"]').getByText('模型', { exact: true }).click();
  await page.getByRole('button', { name: '添加服务商' }).click();

  await page.getByRole('tab', { name: '模型计划' }).click();
  await page.getByPlaceholder('搜索服务商').fill('MiniMax Coding Plan');
  await expect(
    page.locator('.providerCatalogRow[data-provider="minimax-coding-plan"] .providerLogo img[src*="minimax-logo-only-vertical-color-bg-white-text-"]'),
  ).toBeVisible();
  await page.getByRole('button', { name: /添加模型供应商：MiniMax Coding Plan/ }).click();

  await expect(page.getByLabel('模型供应商连接标识')).toHaveValue('minimax-coding-plan');
  await expect(page.getByLabel('模型供应商服务地址')).toHaveValue('https://api.minimax.io/anthropic');
  await expect(page.getByLabel('模型供应商默认模型')).toHaveValue('MiniMax-M3');
  await page.getByRole('button', { name: '保存供应商' }).click();

  await expect(page.getByRole('heading', { name: 'MiniMax Coding Plan', exact: true }).first()).toBeVisible();
  await expect(
    page.locator('.providerSubpageHeader .providerLogo[data-provider="minimax-coding-plan"] img[src*="minimax-logo-only-vertical-color-bg-white-text-"]'),
  ).toBeVisible();
  await expect(page.getByText('MiniMax-M3', { exact: true }).first()).toBeVisible();
});

test('adds xAI with its exact snapshot model and API-key credential field', async ({ window: page }) => {
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await page.getByRole('button', { name: '设置' }).click();
  await page.locator('[aria-label="设置分组"]').getByText('模型', { exact: true }).click();
  await page.getByRole('button', { name: '添加服务商' }).click();

  await page.getByRole('tab', { name: 'API', exact: true }).click();
  await page.getByPlaceholder('搜索服务商').fill('xAI');
  const catalogMark = page.locator('.providerCatalogRow[data-provider="xai"] .providerLogo .xaiProviderMark');
  await expect(catalogMark).toBeVisible();
  expect(await catalogMark.evaluate(maskRenderContract)).toEqual({ usesAssetMask: true, followsForeground: true });
  await page.getByRole('button', { name: /添加模型供应商：xAI/ }).click();
  await expect(page.getByLabel('模型供应商默认模型')).toHaveValue('grok-4.5');
  await page.getByRole('button', { name: '保存供应商' }).click();

  await expect(page.getByRole('heading', { name: 'xAI', exact: true }).first()).toBeVisible();
  const detailMark = page.locator('.providerSubpageHeader .providerLogo[data-provider="xai"] .xaiProviderMark');
  await expect(detailMark).toBeVisible();
  expect(await detailMark.evaluate(maskRenderContract)).toEqual({ usesAssetMask: true, followsForeground: true });
  await expect(page.getByText('grok-4.5', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('textbox', { name: '模型密钥' })).toBeVisible();
});

function maskRenderContract(element: Element): { usesAssetMask: boolean; followsForeground: boolean } {
  const style = getComputedStyle(element);
  return {
    usesAssetMask: style.maskImage.includes('data:image/svg+xml'),
    followsForeground: style.backgroundColor === style.color,
  };
}

test('restores keyboard focus across provider child pages', async ({ window: page }) => {
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await page.getByRole('button', { name: '设置' }).click();
  await page.locator('[aria-label="设置分组"]').getByText('模型', { exact: true }).click();

  const addProvider = page.getByRole('button', { name: '添加服务商' });
  await addProvider.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: '返回模型连接' })).toBeFocused();

  await page.getByPlaceholder('搜索服务商').fill('SiliconFlow');
  const siliconFlow = page.getByRole('button', { name: /添加模型供应商：SiliconFlow/ });
  await siliconFlow.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: '返回模型连接' })).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(siliconFlow).toBeFocused();

  const catalogBack = page.getByRole('button', { name: '返回模型连接' });
  await catalogBack.focus();
  await page.keyboard.press('Enter');
  await expect(addProvider).toBeFocused();

  const existingConnection = page.getByRole('button', { name: /模型连接：E2E/ });
  await existingConnection.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: '返回模型连接' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(existingConnection).toBeFocused();
});
