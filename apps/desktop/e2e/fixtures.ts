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
function buildE2eEnv(userDataDir: string, visualSmokeScenario?: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      key === 'VITE_DEV_SERVER_URL' ||
      key === 'MAKA_E2E' ||
      key === 'MAKA_E2E_USER_DATA_DIR' ||
      key === 'MAKA_E2E_SHOW_WINDOW' ||
      key === 'MAKA_VISUAL_SMOKE_FIXTURE' ||
      /_API_KEY$/.test(key) ||
      /_API_TOKEN$/.test(key) ||
      /_API_SECRET$/.test(key)
    ) {
      delete env[key];
    }
  }
  env.MAKA_E2E = '1';
  env.MAKA_E2E_USER_DATA_DIR = userDataDir;
  if (visualSmokeScenario) env.MAKA_VISUAL_SMOKE_FIXTURE = visualSmokeScenario;
  // E2E windows launch hidden so local and macOS runs never steal the
  // developer's focus. Linux CI runs under xvfb, where a hidden window's
  // compositor is throttled to ~1fps — content-visibility turns never inflate
  // and frame-paced protocols crawl. Only that isolated display needs a
  // visible window.
  if (process.env.CI && process.platform === 'linux') env.MAKA_E2E_SHOW_WINDOW = '1';
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
  { seed, readinessSelector, visualSmokeScenario }: {
    seed: boolean;
    readinessSelector: string;
    visualSmokeScenario?: string;
  },
): Promise<{ app: ElectronApplication; page: Page }> {
  if (seed) await seedE2eConnection(userDataDir);
  const app = await electron.launch({
    args: ['.'],
    cwd: DESKTOP_ROOT,
    env: buildE2eEnv(userDataDir, visualSmokeScenario),
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
  { seed, readinessSelector, visualSmokeScenario }: {
    seed: boolean;
    readinessSelector: string;
    visualSmokeScenario?: string;
  },
  use: (page: Page) => Promise<void>,
): Promise<void> {
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'maka-e2e-'));
  let app: ElectronApplication | undefined;
  try {
    const launched = await launchE2eApp(userDataDir, { seed, readinessSelector, visualSmokeScenario });
    app = launched.app;
    await use(launched.page);
  } finally {
    await app?.close().catch(() => {});
    await rm(userDataDir, { recursive: true, force: true });
  }
}

export const test = base.extend<{ window: Page; emptyWindow: Page; longTranscriptWindow: Page }>({
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
  // Long transcript: boots the visual-smoke `long-transcript` fixture, which
  // seeds a 24-turn (~1300px each) session and opens it as the active
  // session. Fixture mode seeds its own connections, so no connection is
  // pre-staged here. Readiness = turns on screen: the session is open and
  // above-viewport turns sit at their content-visibility placeholder size.
  // Used by the scroll-geometry spec.
  longTranscriptWindow: async ({}, use) => {
    await withE2eWindow(
      { seed: false, readinessSelector: '.maka-turn', visualSmokeScenario: 'long-transcript' },
      use,
    );
  },
});

export { expect };
