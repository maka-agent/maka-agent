import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildBackgroundBashTool, buildLocalForegroundBashTool } from '../shell-tools.js';
import type { ShellPlan } from '../shell-detect.js';

const pwshPlan: ShellPlan = { kind: 'pwsh', displayName: 'PowerShell 7 (pwsh)', exe: 'C:\\pf\\pwsh.exe' };

describe('Bash tool description declares the executing shell', () => {
  test('foreground tool tells the model commands run under PowerShell 7', () => {
    const tool = buildLocalForegroundBashTool({ shell: pwshPlan });
    assert.match(tool.description, /PowerShell 7 \(pwsh\)/);
    assert.match(tool.description, /PowerShell syntax/);
    assert.match(tool.description, /git ls-files/);
    assert.match(tool.description, /node_modules/);
    assert.match(tool.description, /Subject to permission policy\.$/);
  });

  test('foreground tool description is unchanged on POSIX', () => {
    const tool = buildLocalForegroundBashTool({ shell: { kind: 'posix', displayName: '/bin/sh' } });
    assert.equal(tool.description, 'Run a shell command in the session cwd. Subject to permission policy.');
  });

  test('background tool tells the model commands run under PowerShell 7', () => {
    const tool = buildBackgroundBashTool(fakeShellRuns(), { shell: pwshPlan });
    assert.match(tool.description, /PowerShell 7 \(pwsh\)/);
    assert.match(tool.description, /git ls-files/);
    assert.match(tool.description, /outlive yield_time_ms/);
  });
});

function fakeShellRuns() {
  return {
    runBash: () => Promise.reject(new Error('not used')),
    readResource: () => Promise.reject(new Error('not used')),
    stopResource: () => Promise.reject(new Error('not used')),
  };
}
