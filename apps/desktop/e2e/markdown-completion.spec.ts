import { test, expect } from './fixtures';

type MarkdownSample = {
  height: number;
  tags: string;
  paragraphTop: number;
  stopVisible: boolean;
};

test('keeps completed Markdown geometry stable after terminal completion', async ({ window: page }) => {
  const composer = page.locator('.maka-onboarding-quickchat-input');

  await composer.fill('warm markdown');
  await composer.press('Enter');
  await expect(page.getByText(/Fake backend received: warm markdown/)).toBeVisible();
  await expect(page.getByRole('button', { name: '停止' })).toHaveCount(0);

  await page.evaluate(() => {
    const samples: MarkdownSample[] = [];
    const read = () => {
      const roots = document.querySelectorAll<HTMLElement>('.maka-markdown-root');
      const root = roots[roots.length - 1] ?? null;
      const paragraph = root?.querySelector('p') ?? null;
      const stopVisible = [...document.querySelectorAll('button')]
        .some((button) => button.textContent?.trim() === '停止');
      if (root) {
        samples.push({
          height: root.getBoundingClientRect().height,
          tags: [...root.children].map((child) => child.tagName).join('/'),
          paragraphTop: paragraph?.getBoundingClientRect().top ?? 0,
          stopVisible,
        });
      }
      requestAnimationFrame(read);
    };
    (window as Window & { __markdown731Samples?: MarkdownSample[] }).__markdown731Samples = samples;
    requestAnimationFrame(read);
  });

  const sessionComposer = page.getByRole('textbox', { name: '消息输入框' });
  await sessionComposer.fill('结论先行。\n\n| 名称 | 状态 |\n| --- | --- |\n| A | 完成 |\n\n后续说明第一段。\n\n后续说明第二段。');
  await sessionComposer.press('Enter');
  await expect(page.getByText('后续说明第二段。')).toBeVisible();
  await expect(page.getByRole('button', { name: '停止' })).toHaveCount(0);
  await page.waitForTimeout(800);

  const samples = await page.evaluate<MarkdownSample[]>(() => (
    (window as Window & { __markdown731Samples?: MarkdownSample[] }).__markdown731Samples ?? []
  ));
  expect(samples.length).toBeGreaterThan(0);
  const lastStreamingIndex = samples.findLastIndex((sample) => sample.stopVisible);
  expect(lastStreamingIndex).toBeGreaterThan(-1);
  const afterTerminal = samples.slice(lastStreamingIndex + 1);
  expect(afterTerminal.length).toBeGreaterThan(1);
  expect(new Set(afterTerminal.map((sample) => sample.tags))).toEqual(
    new Set(['P/DIV/P/P/P']),
  );
  const heights = afterTerminal.map((sample) => sample.height);
  expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(1);
  const paragraphTops = afterTerminal.map((sample) => sample.paragraphTop);
  expect(Math.max(...paragraphTops) - Math.min(...paragraphTops)).toBeLessThanOrEqual(1);
});
