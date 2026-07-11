import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

type MarkdownSample = {
  height: number;
  tags: string;
  paragraphTop: number;
};

async function readMarkdownGeometry(page: Page, expectedText: string): Promise<MarkdownSample> {
  return page.evaluate((text) => {
    const roots = document.querySelectorAll<HTMLElement>('.maka-markdown-root');
    const root = [...roots].find((candidate) => candidate.textContent?.includes(text));
    if (!root) throw new Error(`Markdown root containing "${text}" is missing`);
    const paragraph = root.querySelector('p');
    return {
      height: root.getBoundingClientRect().height,
      tags: [...root.children].map((child) => child.tagName).join('/'),
      paragraphTop: paragraph?.getBoundingClientRect().top ?? 0,
    };
  }, expectedText);
}

test('keeps completed Markdown geometry stable after terminal completion', async ({ window: page }) => {
  const composer = page.locator('.maka-onboarding-quickchat-input');

  await composer.fill('warm markdown');
  await composer.press('Enter');
  await expect(page.getByText(/Fake backend received: warm markdown/)).toBeVisible();
  await expect(page.getByRole('button', { name: '停止' })).toHaveCount(0);

  const sessionComposer = page.getByRole('textbox', { name: '消息输入框' });
  await sessionComposer.fill('结论先行。\n\n| 名称 | 状态 |\n| --- | --- |\n| A | 完成 |\n\n后续说明第一段。\n\n后续说明第二段。');
  await sessionComposer.press('Enter');
  await expect(page.getByText('后续说明第二段。')).toBeVisible();
  await expect(page.getByRole('button', { name: '停止' })).toHaveCount(0);
  const terminal = await readMarkdownGeometry(page, '后续说明第二段。');
  await page.waitForTimeout(800);
  const settled = await readMarkdownGeometry(page, '后续说明第二段。');

  expect(terminal.tags).toBe('P/DIV/P/P/P');
  expect(settled.tags).toBe(terminal.tags);
  expect(Math.abs(settled.height - terminal.height)).toBeLessThanOrEqual(1);
  expect(Math.abs(settled.paragraphTop - terminal.paragraphTop)).toBeLessThanOrEqual(1);
});
