import { _electron as electron, test as base, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

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

export const test = base.extend<{ window: Page }>({
  window: async ({}, use) => {
    const userDataDir = await mkdtemp(path.join(tmpdir(), 'maka-e2e-'));
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
      await use(page);
    } finally {
      await app.close();
      await rm(userDataDir, { recursive: true, force: true });
    }
  },
});

export { expect };
