import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [launcher, harness, probe] = await Promise.all([
  readFile(new URL('./cu-real-ax-model-e2e-launcher.mjs', import.meta.url), 'utf8'),
  readFile(new URL('./cu-real-ax-model-e2e.mjs', import.meta.url), 'utf8'),
  readFile(new URL('./cu-physical-input-age.swift', import.meta.url), 'utf8'),
]);

test('real AX model E2E owns fixture lifecycle and never activates it', () => {
  assert.match(launcher, /CUA_LAB_BACKGROUND/);
  assert.doesNotMatch(launcher, /activateBundle|tell application id/);
  assert.match(launcher, /--concurrent-user/);
  assert.match(launcher, /caffeinate', \['-dimsu'\]/);
  assert.match(launcher, /runFixtureScript\('stop\.sh'\)/);
});

test('real AX model E2E uses production Runtime and backend with an enforced semantic budget', () => {
  assert.match(harness, /new AiSdkBackend/);
  assert.match(harness, /createCuaDriverBackend/);
  assert.match(harness, /getAIModel/);
  assert.match(harness, /MAKA_CU_MODEL_PROVIDER/);
  assert.match(harness, /claude-sonnet-4-6/);
  assert.match(harness, /allowCompatibilityInputDispatch: false/);
  assert.match(harness, /new Set\(\['list_apps', 'observe', 'set_value', 'wait'\]\)/);
  assert.match(harness, /scenario === 'observe-only'/);
  assert.match(harness, /scenario === 'intervention-recovery'/);
  assert.match(harness, /scenario === 'restart-recovery'/);
  assert.match(harness, /scenario === 'ax-click'/);
  assert.match(harness, /scenario === 'ax-multi-step'/);
  assert.match(harness, /scenario === 'ambiguity'/);
  assert.match(harness, /error: 'user_intervened'/);
  assert.match(harness, /target_missing/);
  assert.match(harness, /ambiguousRecoveryObserved/);
  assert.match(harness, /observe again before retrying/);
  assert.match(launcher, /restart-request\.json/);
  assert.match(launcher, /restart-complete\.json/);
  assert.match(harness, /action budget exceeded/);
  assert.match(harness, /address === 'ax'/);
  assert.match(harness, /address === 'px'/);
  assert.match(harness, /policyMode: 'enforced'/);
  assert.match(harness, /sanitizeCuDirectReport/);
  assert.match(harness, /trace\.toolCallId !== 'fixture-mutate-ambiguity'/);
});

test('physical input probe is read-only', () => {
  assert.match(probe, /secondsSinceLastEventType/);
  assert.doesNotMatch(probe, /mouseEventSource|event\.post|pulse/);
});
