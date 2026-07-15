import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';

type ComposerChrome = {
  backgroundColor: string;
  borderColor: string;
  gap: number;
  panelBackgroundColor: string;
  paddingTop: string;
  shadow: string;
  shadowLayers: number;
};

async function readComposerChrome(page: Page): Promise<ComposerChrome> {
  return page.evaluate(() => {
    const form = document.querySelector<HTMLElement>('.maka-composer');
    const card = document.querySelector<HTMLElement>('.maka-composer-inner');
    const messages = document.querySelector<HTMLElement>('.messages');
    const panel = document.querySelector<HTMLElement>('.maka-panel-detail');
    if (!form || !card || !messages || !panel) throw new Error('composer chrome is not mounted');

    const cardStyle = getComputedStyle(card);
    const shadow = cardStyle.boxShadow;
    return {
      backgroundColor: cardStyle.backgroundColor,
      borderColor: cardStyle.borderColor,
      gap: card.getBoundingClientRect().top - messages.getBoundingClientRect().bottom,
      panelBackgroundColor: getComputedStyle(panel).backgroundColor,
      paddingTop: getComputedStyle(form).paddingTop,
      shadow,
      shadowLayers: shadow === 'none' ? 0 : shadow.split(',').length,
    };
  });
}

async function blurComposer(page: Page): Promise<void> {
  await page.locator('.maka-composer-textarea').evaluate((element: HTMLTextAreaElement) => element.blur());
}

test('composer chrome resolves correctly across docked themes, focus, and home', async ({ window: page }) => {
  const quickChat = page.locator('.maka-onboarding-quickchat-input');
  await quickChat.fill('composer chrome contract');
  await quickChat.press('Enter');
  await expect(page.getByText(/Fake backend received: composer chrome contract/)).toBeVisible();

  const textarea = page.locator('.maka-composer-textarea');
  const mainColumn = page.locator('.mainColumn');
  await expect(textarea).toBeVisible();
  await expect(mainColumn).not.toHaveAttribute('data-home-surface', 'true');

  await page.evaluate(() => document.documentElement.classList.remove('dark'));
  await blurComposer(page);
  await expect.poll(() => readComposerChrome(page)).toMatchObject({
    gap: 0,
    paddingTop: '0px',
    shadowLayers: 3,
  });

  await textarea.focus();
  await expect.poll(() => readComposerChrome(page)).toMatchObject({
    gap: 0,
    paddingTop: '0px',
    shadowLayers: 1,
  });

  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await blurComposer(page);
  await expect.poll(() => readComposerChrome(page)).toMatchObject({
    borderColor: 'rgba(0, 0, 0, 0)',
    gap: 0,
    paddingTop: '0px',
    shadow: 'none',
    shadowLayers: 0,
  });
  const darkRest = await readComposerChrome(page);
  expect(darkRest.backgroundColor).not.toBe(darkRest.panelBackgroundColor);

  await textarea.focus();
  await expect.poll(() => readComposerChrome(page)).toMatchObject({
    gap: 0,
    paddingTop: '0px',
    shadowLayers: 1,
  });
  expect((await readComposerChrome(page)).borderColor).not.toBe('rgba(0, 0, 0, 0)');

  await page.getByRole('button', { name: '新任务' }).click();
  await expect(mainColumn).toHaveAttribute('data-home-surface', 'true');
  await blurComposer(page);
  await expect.poll(() => readComposerChrome(page)).toMatchObject({
    gap: 8,
    paddingTop: '8px',
    shadowLayers: 1,
  });
  const darkHome = await readComposerChrome(page);
  expect(darkHome.backgroundColor).toBe(darkHome.panelBackgroundColor);
  expect(darkHome.borderColor).not.toBe('rgba(0, 0, 0, 0)');
});
