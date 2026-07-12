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
  assert.match(source, /const expectedBlue = Number\(process\.env\.MAKA_CU_E2E_EXPECT_BLUE \?\? 1\)/);
  assert.match(source, /state\?\.blue !== expectedBlue \|\| state\?\.red !== expectedRed/);
  assert.match(source, /layeredComputerUseFixture\.evaluate\(state\)/);
});

test('real computer-use E2E exposes only load_tools and maka_computer to the model', () => {
  assert.match(source, /const runtimeTools = isComputerUseRealE2e\s*\?\s*guardedComputerTools/);
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
  assert.match(source, /evidenceClass: 'real-runtime'/);
});

test('all providers share the Maka Computer function harness', () => {
  assert.match(source, /const makaComputerTools = computerUse\.createTools\(makaComputerHarness\)/);
  assert.match(source, /function computerUseToolsForConnection\(_connection: LlmConnection\): MakaTool\[\] \{\s*return makaComputerTools/);
  assert.doesNotMatch(source, /new OpenAIComputerBackend/);
  assert.doesNotMatch(source, /createAnthropicComputerHarness/);
  assert.doesNotMatch(source, /createKimiComputerHarness/);
  assert.doesNotMatch(source, /createMiniMaxComputerHarness/);
});

test('Maka Computer wires display snapshots without restoring the old owned-target guard', () => {
  assert.match(source, /resolveCuaDisplaySnapshots/);
  assert.match(source, /resolveDisplays:\s*async\s*\(\{\s*screenshotWidthPx,\s*screenshotHeightPx\s*\}\)/);
  assert.doesNotMatch(source, /inspectWindowAt/);
  assert.doesNotMatch(source, /isOwnedComputerUseFixtureTarget\s*\(/);
});

test('Maka Computer preserves native screenshot dimensions and an explicit JPEG MIME type', () => {
  assert.match(source, /toJPEG\(82\)/);
  assert.match(source, /mimeType:\s*'image\/jpeg'/);
  assert.match(source, /coordinates unchanged/);
});
