import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const launcher = await readFile(
  new URL('./cu-real-model-launcher.mjs', import.meta.url),
  'utf8',
);
const main = await readFile(
  new URL('../apps/desktop/src/main/main.ts', import.meta.url),
  'utf8',
);

test('real-model launcher uses an isolated profile and the production Desktop IPC path', () => {
  assert.match(launcher, /mkdtemp\(join\(tmpdir\(\), 'maka-cu-real-model-'\)\)/);
  assert.match(launcher, /MAKA_CU_REAL_MODEL_E2E: '1'/);
  assert.doesNotMatch(launcher, /MAKA_E2E:\s*'1'/);
  assert.match(launcher, /window\.maka\.sessions\.create/);
  assert.match(launcher, /backend: 'ai-sdk'/);
  assert.match(launcher, /window\.maka\.sessions\.send/);
  assert.match(launcher, /MAKA_CU_REAL_MODEL_POLICY/);
  assert.match(launcher, /Use the maka_computer tool/);
  assert.match(launcher, /MAKA_CU_KEEP_PROFILE/);
  assert.match(launcher, /MAKA_CU_PROVIDER/);
  assert.match(launcher, /createConnectionStore/);
});

test('real-model launcher owns a synthetic fixture and emits only sanitized evidence', () => {
  assert.match(launcher, /cu-real-model-fixture\.mjs/);
  assert.match(launcher, /sanitizeCuActionRecord/);
  assert.match(launcher, /sanitizeCuReport/);
  assert.match(launcher, /sanitizeCuTrace/);
  assert.match(launcher, /evaluateCuE2eScenarioState/);
  assert.match(launcher, /createAgentRunStore/);
  assert.match(launcher, /safeFailureMetadata\(runHeader\.failureMessage\)/);
  assert.doesNotMatch(launcher, /failureMessage:\s*runHeader\.failureMessage/);
  assert.match(launcher, /minimumActionsPassed/);
  assert.match(launcher, /terminalPassed/);
  assert.match(launcher, /stopReason === 'end_turn'/);
  assert.match(launcher, /actionsWithinBudget/);
  assert.match(launcher, /dispatchPathPassed/);
  assert.match(launcher, /targetOwned === true/);
  assert.match(launcher, /scenario\.runner/);
  assert.match(launcher, /requiresExecutionCapabilities/);
  assert.match(launcher, /status: qualified/);
  assert.match(launcher, /evidenceClass: 'real-runtime'/);
  assert.doesNotMatch(launcher, /readMessages\(/);
});

test('Desktop isolation gate does not enable FakeBackend', () => {
  assert.match(main, /const isComputerUseRealModelE2e =[\s\S]*MAKA_CU_REAL_MODEL_E2E/);
  assert.match(main, /const isE2e = hasIsolatedE2eProfile && process\.env\.MAKA_E2E === '1'/);
  assert.match(main, /const isIsolatedE2e = isE2e \|\| isComputerUseRealModelE2e/);
  assert.match(main, /isComputerUseRealModelE2e[\s\S]*\? computerUseTools/);
  assert.match(main, /isComputerUseRealModelE2e[\s\S]*\? \{ economy: false, groups: \[\] \}/);
  assert.doesNotMatch(main, /if \(isComputerUseRealModelE2e\) \{[\s\S]*backends\.register\('fake'/);
});
