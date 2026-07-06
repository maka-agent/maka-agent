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
 * Build the minimal env for an E2E Electron launch. Inheriting `process.env`
 * wholesale would leak the host's provider keys (which auto-bootstrap a
 * connection and break the "true first-run" assertion) and `VITE_DEV_SERVER_URL`
 * (which loads the dev server instead of the built bundle). Deny-list rather
 * than allow-list: Electron relies on undocumented platform env (macOS
 * CoreFoundation / X11 / sandbox session) that an allow-list would silently
 * drop and break the launch.
 */
function buildE2eEnv(userDataDir: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      key === 'VITE_DEV_SERVER_URL' ||
      key === 'MAKA_E2E' ||
      key === 'MAKA_E2E_USER_DATA_DIR' ||
      /_API_KEY$/.test(key) ||
      /_API_TOKEN$/.test(key) ||
      /_API_SECRET$/.test(key)
    ) {
      delete env[key];
    }
  }
  env.MAKA_E2E = '1';
  env.MAKA_E2E_USER_DATA_DIR = userDataDir;
  return env;
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
    env: buildE2eEnv(userDataDir),
  });
  const page = await app.firstWindow();
  // Centralize the cold-start wait so test bodies are flake-free under retries:0.
  await page.waitForSelector(readinessSelector, { timeout: 20_000 });
  return { app, page };
}

/**
 * Own the full launch lifecycle so a failure anywhere — seeding, Electron
 * launch, firstWindow, or the readiness wait — still tears down the Electron
 * process and the throwaway userData dir. The previous shape ran `mkdtemp`
 * and `launchE2eApp` outside the try, so a readiness timeout left a zombie
 * Electron and a leaked `maka-e2e-*` directory.
 */
async function withE2eWindow(
  { seed, readinessSelector }: { seed: boolean; readinessSelector: string },
  use: (page: Page) => Promise<void>,
): Promise<void> {
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'maka-e2e-'));
  let app: ElectronApplication | undefined;
  try {
    const launched = await launchE2eApp(userDataDir, { seed, readinessSelector });
    app = launched.app;
    await use(launched.page);
  } finally {
    await app?.close().catch(() => {});
    await rm(userDataDir, { recursive: true, force: true });
  }
}

export const test = base.extend<{ window: Page; emptyWindow: Page }>({
  // Seeded: a pre-staged connection clears onboarding so the composer is ready.
  // Used by chat / session / settings / attachment specs.
  window: async ({}, use) => {
    await withE2eWindow({ seed: true, readinessSelector: '.maka-onboarding-quickchat-input' }, use);
  },
  // Empty: no connection staged — exercises the true first-run boot path.
  // Used by first-run only.
  emptyWindow: async ({}, use) => {
    await withE2eWindow({ seed: false, readinessSelector: '#root' }, use);
  },
});

export { expect };
