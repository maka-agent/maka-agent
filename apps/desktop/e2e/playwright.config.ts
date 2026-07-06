import { defineConfig } from '@playwright/test';

/**
 * Playwright config for the desktop Electron E2E suite.
 *
 * Workers are pinned to 1: each test launches a real Electron window backed
 * by the deterministic fake backend (MAKA_E2E=1). Parallel windows would share
 * the host and fight over the same screen/IPC without adding signal.
 *
 * Run from apps/desktop via `npm run e2e`, which builds the app first.
 */
export default defineConfig({
  testDir: '.',
  fullyParallel: false,
  workers: 1,
  // No retries: flakes should fail loudly. The fixture waits for the composer
  // to mount (the cold-start convergence point — connection seed, onboarding
  // clear, renderer hydrated), so cold-start variance never reaches the test.
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  outputDir: 'test-results',
  use: {
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
