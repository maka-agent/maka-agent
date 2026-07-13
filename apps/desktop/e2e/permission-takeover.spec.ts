import { test, expect } from './fixtures.js';

test('permission request takes over the composer slot without hiding the workspace', async ({ permissionWindow }) => {
  const prompt = permissionWindow.locator('.maka-permission-prompt');
  const slot = permissionWindow.locator('.maka-composer-interaction-slot');
  const composer = permissionWindow.locator('.maka-composer');
  const draft = '保留这段尚未发送的草稿';

  await expect(slot.locator('.maka-permission-prompt')).toHaveCount(1);
  await expect(composer).toHaveCount(1);
  await expect(composer).toBeHidden();
  const textarea = composer.locator('textarea[aria-label="消息输入框"]');
  await textarea.evaluate((element, value) => {
    const input = element as HTMLTextAreaElement;
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, draft);
  await expect(permissionWindow.locator('.maka-dialog-backdrop')).toHaveCount(0);
  await expect(permissionWindow.locator('[role="dialog"]')).toHaveCount(0);
  await expect(permissionWindow.locator('.app')).not.toHaveAttribute('inert', '');

  await expect(prompt.getByRole('button', { name: '停止' })).toBeVisible();
  await expect(prompt.getByRole('button', { name: '拒绝操作' })).toBeFocused();
  await expect(prompt.getByRole('button', { name: '允许操作' })).toBeVisible();
  await expect(prompt.getByText('本轮记住')).toBeVisible();
  await expect(prompt.getByRole('button', { name: '完整参数' })).toHaveCount(0);

  const promptBox = await prompt.boundingBox();
  const panelBox = await permissionWindow.locator('.maka-panel-detail').boundingBox();
  expect(promptBox).not.toBeNull();
  expect(panelBox).not.toBeNull();
  expect(promptBox!.y + promptBox!.height).toBeGreaterThan(panelBox!.y + panelBox!.height * 0.7);

  await permissionWindow.getByRole('button', { name: '展开侧边栏' }).click();
  await expect(composer).toBeHidden();
  await expect(textarea).toHaveValue(draft);
});
