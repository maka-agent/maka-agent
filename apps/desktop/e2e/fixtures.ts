import { _electron as electron, test as base, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createConnectionStore, createFileCredentialStore, createSettingsStore } from '@maka/storage';
import { closeElectronApplication } from './electron-lifecycle.js';

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

async function seedE2eLocale(userDataDir: string, locale: 'zh' | 'en'): Promise<void> {
  const workspaceRoot = path.join(userDataDir, 'workspaces', 'default');
  await createSettingsStore(workspaceRoot).update({
    personalization: { uiLocale: locale },
  });
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
function buildE2eEnv(userDataDir: string, e2eFixtureScenario?: string, locale?: 'zh' | 'en'): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      key === 'VITE_DEV_SERVER_URL' ||
      key === 'MAKA_E2E' ||
      key === 'MAKA_E2E_USER_DATA_DIR' ||
      key === 'MAKA_E2E_SHOW_WINDOW' ||
      key === 'MAKA_E2E_FIXTURE' ||
      key === 'MAKA_E2E_FIXTURE_LOCALE' ||
      /_API_KEY$/.test(key) ||
      /_API_TOKEN$/.test(key) ||
      /_API_SECRET$/.test(key)
    ) {
      delete env[key];
    }
  }
  env.MAKA_E2E = '1';
  env.MAKA_E2E_USER_DATA_DIR = userDataDir;
  if (e2eFixtureScenario) env.MAKA_E2E_FIXTURE = e2eFixtureScenario;
  if (locale) env.MAKA_E2E_FIXTURE_LOCALE = locale;
  // E2E windows launch hidden so local and macOS runs never steal the
  // developer's focus. Linux CI runs under xvfb, where a hidden window's
  // compositor is throttled to ~1fps — content-visibility turns never inflate
  // and frame-paced protocols crawl. Only that isolated display needs a
  // visible window.
  if (process.env.CI && process.platform === 'linux') env.MAKA_E2E_SHOW_WINDOW = '1';
  return env;
}

/**
 * Own the full launch lifecycle so a failure anywhere — seeding, Electron
 * launch, firstWindow, or the readiness wait — still tears down the Electron
 * process and the throwaway userData dir. The previous shape ran `mkdtemp`
 * and `launchE2eApp` outside the try, so a readiness timeout left a zombie
 * Electron and a leaked `maka-e2e-*` directory.
 */
async function withE2eWindow(
  { seed, readinessSelector, e2eFixtureScenario, locale }: {
    seed: boolean;
    readinessSelector: string;
    e2eFixtureScenario?: string;
    locale?: 'zh' | 'en';
  },
  use: (page: Page) => Promise<void>,
): Promise<void> {
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'maka-e2e-'));
  let app: ElectronApplication | undefined;
  const mainLogs: string[] = [];
  const rendererLogs: string[] = [];
  try {
    if (seed) await seedE2eConnection(userDataDir);
    // Legacy E2E specs assert Chinese labels and should not inherit the CI
    // host locale. E2e-fixture workspaces use the explicit renderer override.
    if (locale && !e2eFixtureScenario) await seedE2eLocale(userDataDir, locale);
    app = await electron.launch({
      args: ['.'],
      cwd: DESKTOP_ROOT,
      env: buildE2eEnv(userDataDir, e2eFixtureScenario, locale),
    });
    app.on('console', (message) => {
      mainLogs.push(message.text());
      if (mainLogs.length > 20) mainLogs.shift();
    });
    let page: Page;
    try {
      page = await app.firstWindow();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const logs = mainLogs.length > 0 ? `\nElectron main console:\n${mainLogs.join('\n')}` : '';
      throw new Error(`${detail}${logs}`, { cause: error });
    }
    page.on('console', (message) => {
      rendererLogs.push(`[console:${message.type()}] ${message.text()}`);
      if (rendererLogs.length > 30) rendererLogs.shift();
    });
    page.on('pageerror', (error) => {
      rendererLogs.push(`[pageerror] ${error.stack ?? error.message}`);
      if (rendererLogs.length > 30) rendererLogs.shift();
    });
    // Centralize the cold-start wait so test bodies are flake-free under retries:0.
    try {
      await page.waitForSelector(readinessSelector, { timeout: 20_000 });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const mainDetail = mainLogs.length > 0 ? `\nElectron main console:\n${mainLogs.join('\n')}` : '';
      const rendererDetail = rendererLogs.length > 0 ? `\nRenderer console:\n${rendererLogs.join('\n')}` : '';
      throw new Error(`${detail}${mainDetail}${rendererDetail}`, { cause: error });
    }
    await use(page);
  } finally {
    try {
      if (app) await closeElectronApplication(app, 5_000);
    } finally {
      await rm(userDataDir, { recursive: true, force: true });
    }
  }
}

export const test = base.extend<{
  window: Page;
  emptyWindow: Page;
  longTranscriptWindow: Page;
  sidebarLongSessionsWindow: Page;
  permissionWindow: Page;
  staleSessionsWindow: Page;
  sessionWorkbarWindow: Page;
  botSettingsWindow: Page;
  zhLocaleWindow: Page;
  enLocaleWindow: Page;
  localeSwitchWindow: Page;
}>({
  // Seeded: a pre-staged connection clears onboarding so the composer is ready.
  // Used by chat / session / settings / attachment specs.
  window: async ({}, use) => {
    await withE2eWindow({ seed: true, readinessSelector: '.maka-onboarding-quickchat-input', locale: 'zh' }, use);
  },
  // Empty: no connection staged — exercises the true first-run boot path.
  // Used by first-run only.
  emptyWindow: async ({}, use) => {
    await withE2eWindow({ seed: false, readinessSelector: '#root', locale: 'zh' }, use);
  },
  // Long transcript: boots the e2e-fixture `long-transcript` fixture, which
  // seeds a 24-turn (~1300px each) session and opens it as the active
  // session. Fixture mode seeds its own connections, so no connection is
  // pre-staged here. Readiness = turns on screen: the session is open and
  // above-viewport turns sit at their content-visibility placeholder size.
  // Used by the scroll-geometry spec.
  longTranscriptWindow: async ({}, use) => {
    await withE2eWindow(
      { seed: false, readinessSelector: '.maka-turn', e2eFixtureScenario: 'long-transcript', locale: 'zh' },
      use,
    );
  },
  // Long sidebar sessions: boots the e2e-fixture `sidebar-long-sessions`
  // fixture, which seeds 60 active sessions and opens the newest one
  // (`...-00`) with the sidebar expanded. Fixture mode seeds its own
  // connections, so no connection is pre-staged here. Readiness = a session
  // row on screen: the panel grid has mounted, the session list has loaded
  // from IPC, and the footer sits below the constrained list row. Used by the
  // sidebar-geometry spec.
  sidebarLongSessionsWindow: async ({}, use) => {
    await withE2eWindow(
      { seed: false, readinessSelector: '.maka-list-row', e2eFixtureScenario: 'sidebar-long-sessions', locale: 'zh' },
      use,
    );
  },
  // Permission takeover: boots a deterministic destructive request in the
  // real desktop shell so the composer-slot placement and non-modal behavior
  // are covered without a provider or test-only renderer state path.
  permissionWindow: async ({}, use) => {
    await withE2eWindow(
      { seed: false, readinessSelector: '.maka-permission-prompt', e2eFixtureScenario: 'permission-destructive', locale: 'zh' },
      use,
    );
  },
  // Stale sessions: boots the e2e-fixture `stale-sessions` fixture — one
  // healthy session (zai-live, secret seeded), one unlocked fake session
  // (opened active), and one locked legacy session whose connection is
  // gone. Exercises the #1038 health-notice authority against real IPC
  // (connection list, hasSecret probe, connectionLocked summaries).
  // Readiness = turns on screen: the fake session is open.
  staleSessionsWindow: async ({}, use) => {
    await withE2eWindow(
      { seed: false, readinessSelector: '.maka-turn', e2eFixtureScenario: 'stale-sessions', locale: 'zh' },
      use,
    );
  },
  // Session workbar: seeds a task tree and opens the unified auxiliary
  // workspace so its shell controls and peer tabs run against real IPC data.
  sessionWorkbarWindow: async ({}, use) => {
    await withE2eWindow(
      { seed: false, readinessSelector: 'aside[aria-label="会话工作栏"]', e2eFixtureScenario: 'task-ledger', locale: 'zh' },
      use,
    );
  },
  // Remote access: uses the e2e-fixture workspace so Settings opens on the
  // channel catalog and main injects deterministic IM onboarding adapters.
  // The renderer still talks through the real preload/IPC/session authority.
  botSettingsWindow: async ({}, use) => {
    await withE2eWindow(
      { seed: false, readinessSelector: '[aria-label="设置内容"]', e2eFixtureScenario: 'settings-bots', locale: 'zh' },
      use,
    );
  },
  // Representative e2e-fixture renderer launches in both supported locales.
  // These use the same production LocaleProvider override path as screenshot capture.
  zhLocaleWindow: async ({}, use) => {
    await withE2eWindow(
      { seed: false, readinessSelector: '.appFrame', e2eFixtureScenario: 'all', locale: 'zh' },
      use,
    );
  },
  enLocaleWindow: async ({}, use) => {
    await withE2eWindow(
      { seed: false, readinessSelector: '.appFrame', e2eFixtureScenario: 'all', locale: 'en' },
      use,
    );
  },
  // Keep this fixture unpinned so the Follow system assertion observes the
  // actual host language while the legacy fixtures remain deterministic.
  localeSwitchWindow: async ({}, use) => {
    await withE2eWindow({ seed: true, readinessSelector: '.maka-onboarding-quickchat-input' }, use);
  },
});

export { expect };
