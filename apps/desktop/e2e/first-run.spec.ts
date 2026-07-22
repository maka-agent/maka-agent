import { test, expect } from './fixtures';
import { PROVIDER_REGISTRY, RECOMMENDED_PROVIDER_TYPES, type ProviderType } from '@maka/core';
import { PROVIDER_DISPLAY_COPY } from '../src/renderer/settings/provider-display-copy';

function providerDisplayName(type: ProviderType): string {
  return PROVIDER_DISPLAY_COPY[type]?.zh.name ?? PROVIDER_REGISTRY[type].label;
}

/**
 * First-run flow: a brand-new workspace (empty userData) must boot to the main
 * window with the renderer mounted. This is the cheapest end-to-end proof that
 * the launch → main → preload → renderer chain is intact, and it exercises the
 * E2E isolation seam (MAKA_E2E_USER_DATA_DIR) and the fake-backend switch
 * (MAKA_E2E) that the rest of the suite depends on.
 */
test('boots to registry recommendations and browses the shared provider catalog', async ({ emptyWindow: page }) => {
  await expect(page).toHaveTitle('Maka');
  await expect(page.locator('#root')).not.toBeEmpty();

  const providerRows = page.locator('.maka-firstrun-row');
  await expect(providerRows).toHaveCount(RECOMMENDED_PROVIDER_TYPES.length);
  await expect(providerRows).toContainText(
    RECOMMENDED_PROVIDER_TYPES.map((type) => providerDisplayName(type)),
  );

  await page.getByRole('button', { name: '浏览全部服务商' }).click();

  await expect(page.getByLabel('设置内容')).toBeVisible();
  await expect(page.getByRole('heading', { name: '已连接' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '添加新连接' })).toBeVisible();
  await expect(page.getByRole('tablist', { name: '模型供应商分类' })).toBeVisible();
  await expect(page.getByPlaceholder('搜索服务商')).toBeVisible();
  await expect(page.getByText('还没有模型连接')).toBeVisible();

  const settingsNav = page.locator('[aria-label="设置分组"]');
  await settingsNav.getByText('外观', { exact: true }).click();
  await settingsNav.getByText('模型', { exact: true }).click();

  await expect(page.getByRole('heading', { name: '添加新连接' })).toBeVisible();
  await expect(page.getByPlaceholder('搜索服务商')).toBeVisible();
});
