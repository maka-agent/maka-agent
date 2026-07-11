import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('./cu-e2e-full.mjs', import.meta.url), 'utf8');
const launcher = await readFile(new URL('./cu-e2e-launcher.mjs', import.meta.url), 'utf8');
const monitor = await readFile(new URL('./cu-e2e-monitor.swift', import.meta.url), 'utf8');
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

test('computer-use E2E contains no foreground or broad application control', () => {
  assert.doesNotMatch(source, /\bactivate\b/i);
  assert.doesNotMatch(source, /app\.focus\s*\(/);
  assert.doesNotMatch(source, /\bpkill\b/i);
  assert.doesNotMatch(source, /close every document/i);
  assert.doesNotMatch(source, /\bNotes\b/);
});

test('computer-use E2E owns two inactive Electron fixture windows', () => {
  assert.match(source, /new BrowserWindow\(/);
  assert.match(source, /fixture\.showInactive\(\)/);
  assert.match(source, /app\.setActivationPolicy\(['"]accessory['"]\)/);
  assert.match(source, /firstWindow\.id\s*===\s*secondWindow\.id/);
  assert.equal((source.match(/fixtureWindows\.add\(fixture\)/g) ?? []).length, 2);
  assert.doesNotMatch(source, /launch_app|TextEdit|System Events|osascript/);
  assert.match(source, /unverified first background type was refused/);
  assert.match(source, /first document stayed untouched after refused type/);
  assert.match(source, /second document stayed untouched/);
  assert.match(source, /unverified second background type was refused/);
  assert.match(source, /second document stayed untouched after refused type/);
  assert.match(source, /first document remained untouched/);
  assert.match(source, /unverified cmd\+a was refused/);
});

test('computer-use E2E continuously guards foreground and real pointer state', () => {
  assert.match(monitor, /NSWorkspace\.shared\.frontmostApplication/);
  assert.match(monitor, /NSEvent\.mouseLocation/);
  assert.match(monitor, /CGEventSource\.secondsSinceLastEventType\(\.hidSystemState/);
  assert.match(monitor, /Date\(\)\.timeIntervalSince\(stableSince\)\s*<\s*0\.5/);
  assert.match(monitor, /pointerStep\s*>\s*4\.0\s*&&\s*physicalPointerIdle\s*>\s*0\.05/);
  assert.match(monitor, /usleep\(5_000\)/);
  assert.match(source, /app\.setActivationPolicy\(['"]accessory['"]\)/);
  assert.doesNotMatch(source + launcher, /execFileSync|spawnSync/);
  assert.match(monitor, /originalFrontmostPid/);
  assert.match(monitor, /originalPointerPosition/);
  assert.match(monitor, /frontmost PID changed/);
  assert.match(monitor, /real pointer jumped without recent HID input/);
  assert.match(launcher, /cu-e2e-monitor\.swift/);
  assert.match(source, /abortController\.abort\(failureError\)/);
  assert.match(source, /Promise\.race\(/);
  assert.match(source, /safetyMonitor\.guard\(/);
  assert.match(source, /safetyMonitor\.assertStable\(/);

  const monitorReady = launcher.indexOf('const baseline = await waitForBaseline');
  const electronSpawn = launcher.indexOf('electron = spawn(');
  assert.ok(monitorReady >= 0 && monitorReady < electronSpawn, 'safety monitor must be ready before Electron starts');
  assert.match(source, /MAKA_CU_E2E_BASELINE/);
  assert.match(source, /kind === 'ABORT'/);
  assert.match(source, /minHorizontalDistance\s*>=\s*300/);
});

test('computer-use E2E passes run context and tears down only owned windows', () => {
  const backendRunCalls = [...source.matchAll(/\b(?:activeBackend|freshBackend|backend)\.run\s*\(([^;\n]+)\)/g)];
  assert.ok(backendRunCalls.length > 0, 'expected at least one backend.run call');
  for (const [, args] of backendRunCalls) {
    assert.match(args, /,\s*signal\s*,\s*context\s*$/);
  }

  assert.match(source, /const fixtureWindows = new Set\(\)/);
  assert.match(source, /for \(const fixture of fixtureWindows\)/);
  assert.match(source, /fixture\.destroy\(\)/);
  assert.match(source, /finally/);
  assert.match(source, /app\.whenReady\(\)\.then\(run\)/);
  assert.doesNotMatch(source, /await app\.whenReady\(\)/);
  assert.match(source, /app\.exit\(process\.exitCode\s*\?\?\s*0\)/);
  assert.match(source, /process\.exitCode\s*=\s*failed\.length\s*>\s*0\s*\?\s*1\s*:\s*0/);
});

test('root package exposes the manual real-machine Computer Use E2E', () => {
  assert.match(packageJson.scripts?.['e2e:computer-use'] ?? '', /cu-e2e-launcher\.mjs/);
});
