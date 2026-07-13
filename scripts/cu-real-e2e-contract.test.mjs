import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [packageJson, launcher, harness, monitor] = await Promise.all([
  readFile(new URL('../package.json', import.meta.url), 'utf8'),
  readFile(new URL('./cu-real-e2e-launcher.mjs', import.meta.url), 'utf8'),
  readFile(new URL('./cu-real-e2e.mjs', import.meta.url), 'utf8'),
  readFile(new URL('./cu-real-e2e-monitor.swift', import.meta.url), 'utf8'),
]);

test('real E2E builds the imported workspaces and runs in CI contract tests', () => {
  assert.match(launcher, /@maka\/runtime[\s\S]*runBuilds/);
  assert.match(launcher, /@maka\/computer-use[\s\S]*runBuilds/);
  assert.match(launcher, /check:cua-driver-artifact/);
  assert.match(packageJson, /cu-real-e2e-contract\.test\.mjs/);
});

test('launcher owns bounded cleanup, frontmost restoration, and sleep prevention', () => {
  assert.match(launcher, /const originalFrontmost = await frontmostApplication/);
  assert.match(launcher, /caffeinate', \['-dimsu'\]/);
  assert.match(launcher, /terminateChild\(harness/);
  assert.match(launcher, /SIGKILL/);
  assert.match(launcher, /monitor\?\.stop/);
  assert.match(launcher, /runFixtureScript\('stop\.sh'\)/);
  assert.match(launcher, /restoreFrontmost\(originalFrontmost\)/);
});

test('concurrent mode allows user input without allowing fixture focus takeover', () => {
  assert.match(packageJson, /e2e:computer-use-concurrent/);
  assert.match(launcher, /--concurrent-user/);
  assert.match(launcher, /MAKA_CU_REAL_E2E_MODE/);
  assert.match(launcher, /baseline\.fixturePID = fixturePID/);
  assert.match(launcher, /frontmostBeforeFixtureLaunch/);
  assert.match(launcher, /await activateBundle\('com\.openai\.codex\.cualab'\)/);
  assert.match(launcher, /concurrent-prepared\.json/);
  assert.match(launcher, /concurrent-proceed\.json/);
  assert.match(monitor, /synthetic fixture became frontmost during concurrent E2E/);
  assert.match(monitor, /!concurrentUserMode && displacement > 4/);
  assert.match(monitor, /!concurrentUserMode && receivedPhysicalInput/);
  assert.match(harness, /fail_closed_occluded/);
  assert.match(harness, /fail_closed_hidden/);
  assert.match(harness, /concurrent-coordinate-policy-fail-closed/);
  assert.match(harness, /semantic_background_succeeded/);
  assert.match(harness, /allowCompatibilityInputDispatch: !concurrentUserMode/);
  assert.match(harness, /appId: `pid:\$\{baseline\.fixturePID\}`/);
  assert.match(harness, /invalid concurrent execution baseline/);
});

test('monitor rejects lock, foreground change, pointer movement, and physical input', () => {
  assert.match(monitor, /CGSSessionScreenIsLocked/);
  assert.match(monitor, /screen became locked/);
  assert.match(monitor, /frontmost PID changed/);
  assert.match(monitor, /pointer moved during isolated E2E/);
  assert.match(monitor, /physical user input detected/);
});

test('harness validates exact synthetic provenance before real actions', () => {
  assert.match(harness, /state\.synthetic !== true/);
  assert.match(harness, /state\.bundleIdentifier !== 'com\.openai\.codex\.cualab'/);
  assert.match(harness, /state\.appPath !== expectedAppPath/);
  assert.match(harness, /state\.oop\.hostPID !== fixture\.pid/);
  assert.match(harness, /baseline\.frontmostPID !== fixture\.pid/);
  assert.match(harness, /baseline\.canonicalAppPath !== expectedAppPath/);
});

test('truth claims isolate pixel evidence and keep concurrent dispatch semantic', () => {
  assert.match(harness, /afterClick\.oop\.lastEventTrusted !== true/);
  assert.match(harness, /afterClick\.oop\.webContentPID === afterClick\.oop\.hostPID/);
  assert.match(harness, /dispatch\?\.address !== 'px'/);
  assert.match(harness, /blockedFlow\?\.error !== 'unsupported_action'/);
  assert.match(harness, /concurrent semantic action violated its oracle/);
  assert.match(harness, /duplicateFlow\?\.error !== 'stale_frame'/);
  assert.match(harness, /ambiguous semantic action did not fail closed in backend refetch/);
  assert.match(harness, /stale-missing, process restart, and canonical live-process identity require native or driver follow-up/);
});

test('reports and screenshots use launcher-owned exclusive temporary files', () => {
  assert.match(harness, /MAKA_CU_REAL_E2E_TEMP_DIR/);
  assert.match(harness, /relative\(resolve\(tmpdir\(\)\)/);
  assert.match(harness, /flag: 'wx'/);
  assert.doesNotMatch(harness, /\/tmp\/maka-cu-real-e2e/);
  assert.match(launcher, /rm\(temporaryDirectory, \{ recursive: true, force: true \}\)/);
});
