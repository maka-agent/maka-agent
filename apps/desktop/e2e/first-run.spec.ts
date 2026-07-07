import { test, expect } from './fixtures';

/**
 * First-run flow: a brand-new workspace (empty userData) must boot to the main
 * window with the renderer mounted. This is the cheapest end-to-end proof that
 * the launch → main → preload → renderer chain is intact, and it exercises the
 * E2E isolation seam (MAKA_E2E_USER_DATA_DIR) and the fake-backend switch
 * (MAKA_E2E) that the rest of the suite depends on.
 */
test('boots to the main window on a fresh workspace', async ({ emptyWindow: page }) => {
  await expect(page).toHaveTitle('Maka');
  await expect(page.locator('#root')).not.toBeEmpty();
});
