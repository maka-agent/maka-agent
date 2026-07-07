import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildShellSpawnPlan, detectShell } from '../shell-detect.js';

const winEnv = (over: Record<string, string> = {}) => ({
  Path: 'C:\\Windows\\System32;C:\\Users\\u\\bin',
  ProgramFiles: 'C:\\Program Files',
  SystemRoot: 'C:\\Windows',
  ...over,
});

const existsIn = (...paths: string[]) => (p: string) => paths.includes(p);

describe('detectShell', () => {
  test('on win32 picks pwsh from PATH ahead of everything else', () => {
    const plan = detectShell({
      platform: 'win32',
      env: winEnv(),
      fileExists: existsIn(
        'C:\\Users\\u\\bin\\pwsh.exe',
        'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      ),
    });
    assert.equal(plan.kind, 'pwsh');
    assert.equal(plan.exe, 'C:\\Users\\u\\bin\\pwsh.exe');
  });

  test('on win32 finds pwsh at its default install location when not on PATH', () => {
    const plan = detectShell({
      platform: 'win32',
      env: winEnv(),
      fileExists: existsIn('C:\\Program Files\\PowerShell\\7\\pwsh.exe'),
    });
    assert.equal(plan.kind, 'pwsh');
    assert.equal(plan.exe, 'C:\\Program Files\\PowerShell\\7\\pwsh.exe');
  });

  test('on win32 falls back to Windows PowerShell 5.1 when pwsh is absent', () => {
    const plan = detectShell({
      platform: 'win32',
      env: winEnv(),
      fileExists: existsIn('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'),
    });
    assert.equal(plan.kind, 'powershell');
    assert.equal(plan.exe, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  });

  test('on win32 falls back to cmd.exe when no PowerShell exists', () => {
    const plan = detectShell({ platform: 'win32', env: winEnv(), fileExists: () => false });
    assert.deepEqual(plan, { kind: 'cmd', displayName: 'cmd.exe' });
  });

  test('on POSIX platforms keeps the system default shell', () => {
    const plan = detectShell({ platform: 'darwin', env: {}, fileExists: () => false });
    assert.deepEqual(plan, { kind: 'posix', displayName: '/bin/sh' });
  });
});

describe('buildShellSpawnPlan', () => {
  test('spawns PowerShell explicitly with non-interactive flags and the command as one argument', () => {
    const spawnPlan = buildShellSpawnPlan(
      { kind: 'pwsh', displayName: 'PowerShell 7 (pwsh)', exe: 'C:\\Users\\u\\bin\\pwsh.exe' },
      'Get-ChildItem -Name',
    );
    assert.deepEqual(spawnPlan, {
      file: 'C:\\Users\\u\\bin\\pwsh.exe',
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'Get-ChildItem -Name'],
      useShellOption: false,
    });
  });

  test('keeps shell:true for the system default shells (posix and cmd)', () => {
    for (const plan of [
      { kind: 'posix', displayName: '/bin/sh' } as const,
      { kind: 'cmd', displayName: 'cmd.exe' } as const,
    ]) {
      assert.deepEqual(buildShellSpawnPlan(plan, 'echo hi'), {
        file: 'echo hi',
        args: [],
        useShellOption: true,
      });
    }
  });
});
