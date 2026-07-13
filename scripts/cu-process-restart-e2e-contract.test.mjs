import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [packageJson, launcher, harness] = await Promise.all([
  readFile(new URL('../package.json', import.meta.url), 'utf8'),
  readFile(new URL('./cu-process-restart-e2e-launcher.mjs', import.meta.url), 'utf8'),
  readFile(new URL('./cu-process-restart-e2e.mjs', import.meta.url), 'utf8'),
]);

test('process restart E2E owns the real fixture lifecycle', () => {
  assert.match(packageJson, /e2e:computer-use-process-restart/);
  assert.match(launcher, /runFixtureScript\('stop\.sh'\)/);
  assert.match(launcher, /runFixtureScript\('launch\.sh', \{/);
  assert.match(launcher, /prepare:cua-driver/);
  assert.doesNotMatch(launcher, /activateFixture/);
  assert.match(launcher, /CUA_LAB_BACKGROUND/);
  assert.match(launcher, /finalFrontmost\?\.bundleIdentifier === FIXTURE_BUNDLE_ID/);
  assert.match(launcher, /waitForRestartedState\([\s\S]*currentPID,[\s\S]*request\.oldWebContentPID/);
  assert.match(launcher, /waitForInitialState\(\)/);
  assert.match(launcher, /pointerBefore/);
  assert.match(launcher, /Concurrent user pointer displacement observed/);
  assert.match(launcher, /Synthetic fixture never became frontmost/);
  assert.match(launcher, /--snapshot/);
  assert.match(launcher, /restart-request-\$\{round\}\.json/);
  assert.match(launcher, /restart-complete-\$\{round\}\.json/);
  assert.match(launcher, /SOAK_ROUNDS = 5/);
  assert.match(launcher, /--deny-frontmost-bundle/);
  assert.match(launcher, /--concurrent-user',[\s\S]*'0'/);
  assert.match(launcher, /for \(let round = 1; round <= SOAK_ROUNDS; round \+= 1\)/);
  assert.match(launcher, /caffeinate', \['-dimsu'\]/);
});

test('old observation is rejected and fresh-process actions succeed or fail occluded', () => {
  assert.match(harness, /old-observation-after-restart/);
  assert.match(harness, /oldRunResult\?\.error !== 'target_missing'/);
  assert.match(harness, /staleAttempt\.modelText/);
  assert.match(harness, /newState\.coordinate\.clickCount !== 0/);
  assert.match(harness, /fresh-process-coordinate-click/);
  assert.match(harness, /observeUntilElement/);
  assert.match(harness, /invalidApp: no visible window matched/);
  assert.match(harness, /CUA Lab Coordinate Target/);
  assert.match(harness, /candidateCount/);
  assert.match(harness, /freshSucceeded/);
  assert.match(harness, /freshOccluded/);
  assert.match(harness, /fail_closed_occluded/);
  assert.match(harness, /background_dispatch_succeeded/);
  assert.match(harness, /currentPID === newPID/);
  assert.match(harness, /currentWebContentPID === newWebContentPID/);
  assert.match(harness, /for \(let round = 1; round <= soakRounds; round \+= 1\)/);
  assert.match(harness, /seenHostPIDs/);
  assert.match(harness, /seenWebContentPIDs/);
  assert.match(harness, /serviceState/);
});

test('restart reports are private launcher-owned temporary files', () => {
  assert.match(harness, /MAKA_CU_RESTART_TEMP_DIR/);
  assert.match(harness, /relative\(resolve\(tmpdir\(\)\)/);
  assert.match(harness, /flag: 'wx'/);
  assert.match(launcher, /rm\(temporaryDirectory, \{ recursive: true, force: true \}\)/);
});
