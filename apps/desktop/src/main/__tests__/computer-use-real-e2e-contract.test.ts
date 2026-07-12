import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const source = readFileSync(
  join(import.meta.dirname, '..', '..', '..', 'src', 'main', 'main.ts'),
  'utf8',
);

test('real computer-use E2E isolates userData without selecting FakeBackend', () => {
  assert.match(source, /const isComputerUseRealE2e =[\s\S]*MAKA_CU_REAL_E2E/);
  assert.match(source, /const isE2e = hasIsolatedTestProfile && process\.env\.MAKA_E2E === '1'/);
  assert.match(source, /if \(isE2e\) \{\s*backends\.register\('ai-sdk'/);
  assert.doesNotMatch(source, /if \(isIsolatedTest\) \{\s*backends\.register\('ai-sdk'/);
  assert.doesNotMatch(source, /if \(isComputerUseRealE2e\) \{\s*backends\.register\('ai-sdk'/);
});

test('real computer-use E2E owns a screenshot-visible fixture and verifies its effect', () => {
  assert.match(source, /maybeCreateComputerUseRealE2eFixture/);
  assert.match(source, /Increment blue/);
  assert.match(source, /Do not click red/);
  assert.match(source, /state\?\.blue !== 1 \|\| state\?\.red !== 0/);
});

test('real computer-use E2E exposes only load_tools and computer to the model', () => {
  assert.match(source, /const runtimeTools = isComputerUseRealE2e\s*\?\s*providerComputerTools/);
  assert.match(source, /const runtimeToolAvailability:[\s\S]*isComputerUseRealE2e[\s\S]*id: 'computer_use'/);
  assert.match(source, /tools: runtimeTools/);
  assert.match(source, /toolAvailability: runtimeToolAvailability/);
});

test('real model launcher enables loopback CDP for exact Electron page targeting', () => {
  const launcher = readFileSync(
    join(import.meta.dirname, '..', '..', '..', '..', '..', 'scripts', 'cu-real-model-e2e.mjs'),
    'utf8',
  );
  assert.match(launcher, /reserveLoopbackPort/);
  assert.match(launcher, /--remote-debugging-port=\$\{cdpPort\}/);
  assert.match(launcher, /MAKA_CU_E2E_CDP_PORT: String\(cdpPort\)/);
  assert.match(launcher, /MAKA_CU_REAL_E2E_REPORT: reportPath/);
});

test('providers without a completed native harness do not receive generic desktop computer tools', () => {
  assert.match(source, /case 'moonshot':[\s\S]*case 'openai':[\s\S]*case 'codex-subscription':[\s\S]*case 'google':[\s\S]*return \[\]/);
});
