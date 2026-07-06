import { _electron as electron, test as base, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createConnectionStore, createFileCredentialStore } from '@maka/storage';

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

/**
 * Launch the desktop app against a throwaway userData dir and wait for a
 * readiness selector. MAKA_E2E=1 forces every session onto the deterministic
 * fake backend, so tests run without real provider keys or network. `seed`
 * controls whether a connection is pre-staged: chat/session/settings/attachment
 * need it to clear onboarding; first-run must boot without it.
 */
async function launchE2eApp(
  userDataDir: string,
  { seed, readinessSelector }: { seed: boolean; readinessSelector: string },
): Promise<{ app: ElectronApplication; page: Page }> {
  if (seed) await seedE2eConnection(userDataDir);
  const app = await electron.launch({
    args: ['.'],
    cwd: DESKTOP_ROOT,
    env: {
      ...process.env,
      MAKA_E2E: '1',
      MAKA_E2E_USER_DATA_DIR: userDataDir,
    },
  });
  const page = await app.firstWindow();
  // Centralize the cold-start wait so test bodies are flake-free under retries:0.
  await page.waitForSelector(readinessSelector, { timeout: 20_000 });
  return { app, page };
}

export const test = base.extend<{ window: Page; emptyWindow: Page }>({
  // Seeded: a pre-staged connection clears onboarding so the composer is ready.
  // Used by chat / session / settings / attachment specs.
  window: async ({}, use) => {
    const userDataDir = await mkdtemp(path.join(tmpdir(), 'maka-e2e-'));
    const { app, page } = await launchE2eApp(userDataDir, {
      seed: true,
      readinessSelector: '.maka-onboarding-quickchat-input',
    });
    try {
      await use(page);
    } finally {
      await app.close();
      await rm(userDataDir, { recursive: true, force: true });
    }
  },
  // Empty: no connection staged — exercises the true first-run boot path.
  // Used by first-run only.
  emptyWindow: async ({}, use) => {
    const userDataDir = await mkdtemp(path.join(tmpdir(), 'maka-e2e-'));
    const { app, page } = await launchE2eApp(userDataDir, {
      seed: false,
      readinessSelector: '#root',
    });
    try {
      await use(page);
    } finally {
      await app.close();
      await rm(userDataDir, { recursive: true, force: true });
    }
  },
});

export { expect };
