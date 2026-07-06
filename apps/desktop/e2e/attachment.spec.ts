import { test, expect } from './fixtures';

/**
 * Attachment upload: enter the chat view, drop a file onto the main composer,
 * and confirm it shows up as a pending attachment card. Uses Playwright's
 * DataTransfer + dispatchEvent because the composer has no <input type=file> —
 * files enter via drag-and-drop (or paste). This covers upload → display; the
 * ingest-on-send path runs through the fake backend and is not asserted here.
 */
test('dropping a file onto the composer shows a pending attachment', async ({ window: page }) => {
  // Enter chat view by sending a first message from the quick-chat entry
  const quickChat = page.locator('.maka-onboarding-quickchat-input');
  await quickChat.fill('attach-test');
  await quickChat.press('Enter');
  await expect(page.getByText(/Fake backend received: attach-test/)).toBeVisible();

  // Drop a file onto the main composer
  const composer = page.locator('.maka-composer');
  await expect(composer).toBeVisible();
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await dataTransfer.evaluate((dt: DataTransfer) => {
    dt.items.add(new File(['hello attachment content'], 'note.txt', { type: 'text/plain' }));
  });
  await composer.dispatchEvent('drop', { dataTransfer });

  // The dropped file appears as a pending attachment card
  await expect(page.getByText('note.txt')).toBeVisible();
});
