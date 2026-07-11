import { test, expect } from './fixtures';

type MarkdownSample = {
  height: number;
  tags: string;
  rootId: number;
  paragraphId: number;
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
    const ids = new WeakMap<Node, number>();
    let nextId = 1;
    const idFor = (node: Node | null): number => {
      if (!node) return 0;
      const known = ids.get(node);
      if (known) return known;
      const id = nextId++;
      ids.set(node, id);
      return id;
    };
    const samples: MarkdownSample[] = [];
    const read = () => {
      const bubbles = document.querySelectorAll<HTMLElement>('.maka-bubble-streaming');
      const bubble = bubbles.item(bubbles.length - 1);
      const root = bubble?.querySelector<HTMLElement>('.maka-markdown-root') ?? null;
      const paragraph = root?.querySelector('p') ?? null;
      const stopVisible = [...document.querySelectorAll('button')]
        .some((button) => button.textContent?.trim() === '停止');
      if (bubble && root) {
        samples.push({
          height: root.getBoundingClientRect().height,
          tags: [...root.children].map((child) => child.tagName).join('/'),
          rootId: idFor(root),
          paragraphId: idFor(paragraph),
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
  const latestRootId = samples.at(-1)?.rootId;
  expect(samples.some((sample) => (
    sample.rootId === latestRootId
    && sample.stopVisible
    && sample.tags === 'P/DIV/P/P/P'
  ))).toBe(true);
  const afterTerminal = samples.filter((sample) => (
    sample.rootId === latestRootId && !sample.stopVisible
  ));
  expect(afterTerminal.length).toBeGreaterThan(1);
  expect(new Set(afterTerminal.map((sample) => sample.tags))).toEqual(
    new Set(['P/DIV/P/P/P']),
  );
  expect(new Set(afterTerminal.map((sample) => sample.paragraphId)).size).toBe(1);
  const heights = afterTerminal.map((sample) => sample.height);
  expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(1);
  const paragraphTops = afterTerminal.map((sample) => sample.paragraphTop);
  expect(Math.max(...paragraphTops) - Math.min(...paragraphTops)).toBeLessThanOrEqual(1);
});
