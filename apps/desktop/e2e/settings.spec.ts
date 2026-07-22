import { test, expect } from './fixtures';

test('settings switches keep the compact shared control geometry', async ({ window: page }) => {
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await page.getByRole('button', { name: '设置' }).click();
  await page.getByRole('main', { name: '设置内容' }).getByRole('button', { name: '通用', exact: true }).click();

  const privacySwitch = page.getByRole('switch', { name: '启用隐身模式' });
  await expect(privacySwitch).toBeVisible();
  const box = await privacySwitch.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBe(32);
  expect(box!.height).toBe(18);
  await expect.poll(
    () => privacySwitch.evaluate((element) => getComputedStyle(element).boxShadow),
  ).toBe('none');
});

/**
 * Settings take effect: open settings, switch the theme to dark, and confirm
 * the <html> root picks up the `dark` class (theme.ts applies it via
 * classList.toggle). This exercises the settings open → navigate → mutate →
 * apply path without depending on pixel colors.
 */
test('changing the theme in settings applies to the UI', async ({ window: page }) => {
  // The sidebar starts collapsed on a fresh workspace; expand it to reach
  // the settings entry in the sidebar footer.
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await page.getByRole('button', { name: '设置' }).click();
  await expect(page.getByLabel('设置内容')).toBeVisible();

  await page.locator('[aria-label="设置分组"]').getByText('外观').click();
  await page.getByRole('radio', { name: '深色 始终使用深色界面。' }).click();

  await expect.poll(
    async () => page.evaluate(() => document.documentElement.classList.contains('dark')),
  ).toBe(true);
});

test('settings textarea grows with content and scrolls only at its shared cap', async ({ window: page }) => {
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await page.getByRole('button', { name: '设置' }).click();
  await page.getByRole('main', { name: '设置内容' }).getByRole('button', { name: '通用', exact: true }).click();

  const textarea = page.getByRole('textbox', { name: '助手语气偏好' });
  await expect(textarea).toBeVisible();
  await expect(textarea).toHaveCSS('resize', 'none');
  await expect(textarea).toHaveCSS('field-sizing', 'content');

  const initialHeight = await textarea.evaluate((element) => element.getBoundingClientRect().height);
  await textarea.fill(Array.from({ length: 7 }, (_, index) => `偏好 ${index + 1}`).join('\n'));
  const grownHeight = await textarea.evaluate((element) => element.getBoundingClientRect().height);
  expect(grownHeight).toBeGreaterThan(initialHeight);

  await textarea.fill(Array.from({ length: 30 }, (_, index) => `偏好 ${index + 1}`).join('\n'));
  const capped = await textarea.evaluate((element) => ({
    height: element.getBoundingClientRect().height,
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(capped.height).toBeLessThanOrEqual(320);
  expect(capped.scrollHeight).toBeGreaterThan(capped.clientHeight);

  await page.getByRole('main', { name: '设置内容' }).getByRole('button', { name: '记忆', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '记忆内容' })).toHaveCSS('resize', 'none');
  await expect(page.getByRole('textbox', { name: 'MEMORY.md 内容' })).toHaveCSS('resize', 'none');
});

test('shared settings input owns its desktop focus chrome', async ({ window: page }) => {
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await page.getByRole('button', { name: '设置' }).click();
  await page.getByRole('main', { name: '设置内容' }).getByRole('button', { name: '通用', exact: true }).click();

  const displayName = page.getByRole('textbox', { name: '显示名称' });
  await expect(displayName).toHaveCSS('box-shadow', 'none');
  await displayName.focus();
  const focusShadow = await displayName.evaluate((element) => getComputedStyle(element).boxShadow);
  expect(focusShadow).not.toBe('none');
  expect(focusShadow).not.toContain('inset');
});

test('open gateway metric values stay contained for long addresses', async ({ window: page }) => {
  await page.setViewportSize({ width: 900, height: 820 });
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await page.getByRole('button', { name: '设置' }).click();

  const settings = page.getByRole('main', { name: '设置内容' });
  await settings.getByRole('button', { name: '开放网关' }).click();
  await expect(settings.getByRole('heading', { name: '开放网关' })).toBeVisible();

  const addressValue = settings
    .locator('[data-slot="stat-tile-value"]')
    .filter({ hasText: 'http://127.0.0.1:3939' });
  await expect(addressValue).toBeVisible();
  await expect(addressValue).toHaveCSS('overflow-wrap', 'anywhere');
  await expect.poll(
    () =>
      addressValue.evaluate((element) => ({
        contained: element.scrollWidth <= element.clientWidth,
        value: element.textContent,
      })),
  ).toEqual({ contained: true, value: 'http://127.0.0.1:3939' });
});

test('remote access opens a channel detail from the overview and returns', async ({ window: page }) => {
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await page.getByRole('button', { name: '设置' }).click();

  const settings = page.getByRole('main', { name: '设置内容' });
  await settings.getByRole('button', { name: '远程接入' }).click();

  await expect(settings.getByRole('heading', { name: '远程接入' })).toBeVisible();
  await expect(settings.getByRole('heading', { name: '接入更多渠道' })).toBeVisible();

  const telegramRow = settings.getByRole('button', { name: /接入 Telegram/ });
  await expect.poll(
    () => telegramRow.evaluate((element) => getComputedStyle(element).boxShadow),
  ).toBe('none');

  await telegramRow.focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  await expect.poll(
    () => telegramRow.evaluate((element) => getComputedStyle(element).boxShadow),
  ).not.toBe('none');

  await telegramRow.click();
  await expect(settings.getByRole('heading', { name: /Telegram/ })).toBeVisible();
  await expect(settings.getByRole('button', { name: '返回远程接入' })).toBeVisible();
  await expect(settings.getByRole('heading', { name: '连接配置' })).toBeVisible();
  await expect(settings.getByLabel('Telegram Bot Token')).toBeVisible();

  const detailHeadings = await settings.getByRole('heading').allTextContents();
  expect(detailHeadings.indexOf('待配置')).toBeLessThan(detailHeadings.indexOf('连接配置'));

  const identityValue = settings.getByLabel('Telegram运行状态').locator('dd').first();
  await expect(identityValue).toHaveCSS('white-space', 'normal');
  await expect(identityValue).toHaveCSS('overflow-wrap', 'anywhere');

  await settings.getByRole('button', { name: '返回远程接入' }).click();
  await expect(settings.getByRole('heading', { name: '接入更多渠道' })).toBeVisible();
});

test('remote access prioritizes a configured channel that needs attention', async ({ window: page }) => {
  const runtimeError = 'runtime-diagnostic-'.repeat(10);
  await page.setViewportSize({ width: 990, height: 820 });
  await page.evaluate(async (lastError) => {
    await window.maka.settings.update({
      botChat: {
        channels: {
          telegram: {
            connected: true,
            readiness: 'operational',
            token: 'e2e-telegram-placeholder',
          },
          discord: {
            connected: true,
            readiness: 'degraded',
            token: 'e2e-discord-placeholder',
            lastError,
          },
        },
      },
    });
  }, runtimeError);
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await page.getByRole('button', { name: '设置' }).click();
  const settings = page.getByRole('main', { name: '设置内容' });
  await settings.getByRole('button', { name: '远程接入' }).click();

  const activeChannels = page.getByRole('region', { name: '正在使用' }).getByRole('button');
  await expect(activeChannels).toHaveCount(2);
  await expect(activeChannels.nth(0)).toHaveAccessibleName(/管理 Discord/);
  await expect(activeChannels.nth(0)).toHaveAccessibleDescription(runtimeError);
  await expect(activeChannels.nth(1)).toHaveAccessibleName(/管理 Telegram/);

  await activeChannels.nth(0).click();
  const recentFailure = settings.getByRole('alert').filter({ hasText: '最近一次失败' });
  await expect(recentFailure).toContainText(runtimeError);
  await expect(recentFailure.getByText(runtimeError)).toHaveCSS('overflow-wrap', 'anywhere');
  await expect.poll(
    () => settings.evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
});
