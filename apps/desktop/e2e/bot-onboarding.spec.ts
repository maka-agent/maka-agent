import { test, expect } from './fixtures';

test('IM 快捷接入完成真实 QR session、扫码状态和本机凭据落盘', async ({ botSettingsWindow: page }) => {
  const settings = page.getByRole('main', { name: '设置内容' });
  await expect(settings.getByRole('heading', { name: '远程接入' })).toBeVisible();

  await settings.getByRole('button', { name: '接入 钉钉' }).click();
  await expect(settings.getByRole('heading', { name: '接入方式' })).toBeVisible();
  await expect(settings.getByRole('button', { name: '快捷接入（推荐）' })).toHaveAttribute('data-pressed', '');

  await settings.getByRole('button', { name: '手动配置' }).click();
  await expect(settings.getByRole('textbox', { name: '钉钉应用密钥' })).toBeVisible();
  await settings.getByRole('button', { name: '快捷接入（推荐）' }).click();
  await settings.getByRole('button', { name: '使用钉钉扫码接入' }).click();

  const dialog = page.getByRole('dialog', { name: '配置钉钉扫码接入' });
  await expect(dialog).toBeVisible();
  const qr = dialog.getByRole('img', { name: '配置钉钉二维码' });
  await expect(qr).toHaveAttribute('src', /^data:image\/png;base64,/);
  await expect(dialog.getByText('请使用钉钉扫描二维码并确认授权')).toBeVisible();

  const dialogBox = await dialog.boundingBox();
  const qrFrameBox = await dialog.locator('.settingsBotOnboardingQrFrame').boundingBox();
  const qrBox = await qr.boundingBox();
  expect(dialogBox).not.toBeNull();
  expect(qrFrameBox).not.toBeNull();
  expect(qrBox).not.toBeNull();
  const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  expect(dialogBox!.width).toBeLessThanOrEqual(522);
  expect(qrFrameBox!.width).toBe(284);
  expect(qrBox!.width).toBe(qrFrameBox!.width - 2);
  expect(Math.abs((dialogBox!.x + dialogBox!.width / 2) - (qrBox!.x + qrBox!.width / 2))).toBeLessThan(2);
  expect(Math.abs((dialogBox!.y + dialogBox!.height / 2) - viewport.height / 2)).toBeLessThan(2);
  expect(dialogBox!.y).toBeGreaterThan(24);
  expect(dialogBox!.y + dialogBox!.height).toBeLessThan(viewport.height - 24);

  await expect(dialog.getByText('已扫码，请在钉钉中完成确认')).toBeVisible({ timeout: 4_000 });
  await expect(dialog.getByText('钉钉 已连接')).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText('Maka 测试机器人')).toBeVisible();

  const stored = await page.evaluate(() => window.maka.settings.get());
  expect(stored.botChat.channels.dingtalk.appId).toBe('visual-smoke-dingtalk-client');
  expect(stored.botChat.channels.dingtalk.appSecret).not.toBe('visual-smoke-dingtalk-secret');
  expect(JSON.stringify(stored)).not.toContain('visual-smoke-dingtalk-secret');

  await dialog.getByRole('button', { name: '完成' }).click();
  await expect(dialog).toBeHidden();
});

test('关闭扫码弹窗会取消迟到结果，过期二维码可以重新生成', async ({ botSettingsWindow: page }) => {
  const settings = page.getByRole('main', { name: '设置内容' });

  await settings.getByRole('button', { name: '接入 微信' }).click();
  await settings.getByRole('button', { name: '扫码登录' }).click();
  const wechatDialog = page.getByRole('dialog', { name: '扫码登录扫码接入' });
  await expect(wechatDialog.getByRole('img', { name: '扫码登录二维码' })).toBeVisible();
  await page.waitForTimeout(1_150);
  await wechatDialog.getByRole('button', { name: '取消' }).click();
  await expect(wechatDialog).toBeHidden();
  await page.waitForTimeout(1_300);

  const afterCancel = await page.evaluate(() => window.maka.settings.get());
  expect(afterCancel.botChat.channels.wechat.token).toBe('');
  expect(afterCancel.botChat.channels.wechat.enabled).toBe(false);

  await settings.getByRole('button', { name: '返回远程接入' }).click();
  await settings.getByRole('button', { name: '接入 企业微信' }).click();
  await settings.getByRole('button', { name: '开始快捷绑定' }).click();
  const wecomDialog = page.getByRole('dialog', { name: '配置企业微信扫码接入' });
  await expect(wecomDialog.getByRole('img', { name: '配置企业微信二维码' })).toBeVisible();
  await expect(wecomDialog.getByText('二维码已过期，请重新生成')).toBeVisible({ timeout: 4_000 });
  await wecomDialog.getByRole('button', { name: '重新生成' }).click();
  await expect(wecomDialog.getByRole('img', { name: '配置企业微信二维码' })).toBeVisible();
  await wecomDialog.getByRole('button', { name: '取消' }).click();

  await settings.getByRole('button', { name: '返回远程接入' }).click();
  await settings.getByRole('button', { name: '接入 飞书' }).click();
  await settings.getByRole('button', { name: 'Lark' }).click();
  await settings.getByRole('button', { name: '使用 Lark 扫码接入' }).click();
  const larkDialog = page.getByRole('dialog', { name: '配置 Lark 扫码接入' });
  await expect(larkDialog.getByRole('img', { name: '配置 Lark 二维码' })).toBeVisible();
});
