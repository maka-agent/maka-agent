import { test, expect } from './fixtures';
import type { Locator } from '@playwright/test';

async function expectPaletteHeaderGeometry(dialog: Locator): Promise<void> {
  const searchInput = dialog.getByRole('combobox', { name: '搜索命令、设置项或会话' });
  const closeButton = dialog.getByRole('button', { name: '关闭命令面板' });
  const [inputBox, closeBox, paddingLeft] = await Promise.all([
    searchInput.boundingBox(),
    closeButton.boundingBox(),
    searchInput.evaluate((element) => Number.parseFloat(getComputedStyle(element).paddingLeft)),
  ]);
  if (!inputBox || !closeBox) throw new Error('Command palette header controls must have rendered bounds');

  const gap = closeBox.x - (inputBox.x + inputBox.width);
  expect(gap).toBeGreaterThanOrEqual(8);
  expect(paddingLeft).toBeGreaterThanOrEqual(10);
}

test('command palette header geometry and dismissal stay intact', async ({ window: page }) => {
  const openButton = page.getByRole('button', { name: '打开命令面板' });
  const dialog = page.getByRole('dialog', { name: '命令面板' });

  await openButton.click();
  await expect(dialog).toBeVisible();
  await expectPaletteHeaderGeometry(dialog);

  await page.setViewportSize({ width: 520, height: 700 });
  await expect(dialog).toBeVisible();
  await expectPaletteHeaderGeometry(dialog);

  await dialog.getByRole('button', { name: '关闭命令面板' }).click();
  await expect(dialog).toBeHidden();

  await openButton.click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});
