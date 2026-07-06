import { _electron as electron, test as base, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createConnectionStore, createFileCredentialStore } from '@maka/storage';

/**
 * Launch helper for desktop E2E.
 *
 * Each test gets its own throwaway userData dir (MAKA_E2E_USER_DATA_DIR) so
 * sessions, settings, and credentials never leak between tests or pollute the
 * real user data. MAKA_E2E=1 forces every session onto the deterministic fake
 * backend (see resolveSessionBackend in src/main), so tests run without real
 * provider keys or network.
 *
 * `npm run e2e` runs from apps/desktop, so process.cwd() is the desktop root
 * and `electron .` picks up package.json#main (dist/main/main.js).
 */
const DESKTOP_ROOT = process.cwd();

/**
 * Pre-seed a real-looking connection into the throwaway workspace so onboarding
 * clears and the composer is enabled. Actual sessions still run on the fake
 * backend (BackendRegistry override in main); this only satisfies the UI
 * readiness gates. Kept in the fixture so test data stays out of production main.
 */
async function seedE2eConnection(userDataDir: string): Promise<void> {
  const workspaceRoot = path.join(userDataDir, 'workspaces', 'default');
  const connections = createConnectionStore(workspaceRoot);
  const credentials = createFileCredentialStore(workspaceRoot);
  await connections.create({
    slug: 'e2e',
    name: 'E2E',
    providerType: 'anthropic',
    defaultModel: 'claude-sonnet-4-5-20250929',
  });
  await credentials.setSecret('e2e', 'api_key', 'e2e-placeholder');
  await connections.setDefault('e2e');
}

export const test = base.extend<{ window: Page }>({
  window: async ({}, use) => {
    const userDataDir = await mkdtemp(path.join(tmpdir(), 'maka-e2e-'));
    await seedE2eConnection(userDataDir);
    const app = await electron.launch({
      args: ['.'],
      cwd: DESKTOP_ROOT,
      env: {
        ...process.env,
        MAKA_E2E: '1',
        MAKA_E2E_USER_DATA_DIR: userDataDir,
      },
    });
    try {
      const page = await app.firstWindow();
      // Wait for onboarding to render its quickchat input — the cold-start
      // convergence point (renderer hydrated, seeded connection applied).
      // Centralizing it here keeps test bodies free of cold-start waits and
      // makes retries:0 safe.
      await page.waitForSelector('.maka-onboarding-quickchat-input', { timeout: 20_000 });
      await use(page);
    } finally {
      await app.close();
      await rm(userDataDir, { recursive: true, force: true });
    }
  },
});

export { expect };
