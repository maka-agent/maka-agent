import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildBackgroundBashTool, buildLocalForegroundBashTool } from '../shell-tools.js';
import type { ShellPlan } from '../shell-detect.js';

const pwshPlan: ShellPlan = { kind: 'pwsh', displayName: 'PowerShell 7 (pwsh)', exe: 'C:\\pf\\pwsh.exe' };

describe('Bash tool description declares the executing shell', () => {
  test('foreground and background variants declare command activity', () => {
    assert.equal(buildLocalForegroundBashTool().activityKind, 'command');
    assert.equal(buildBackgroundBashTool(fakeShellRuns()).activityKind, 'command');
  });

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

describe('Bash tool shell is threaded through to execution, not just the description', () => {
  test('foreground tool executes with the same shell it declares', async () => {
    // /bin/echo stands in for pwsh.exe: if the tool's shell reaches the
    // spawn, stdout echoes the PowerShell flags back. A shell that only
    // reached the description would run via the default POSIX shell and
    // print a bare 'wired-marker'.
    const tool = buildLocalForegroundBashTool({
      shell: { kind: 'pwsh', displayName: 'PowerShell 7 (pwsh)', exe: '/bin/echo' },
    });
    const result = await tool.impl({ command: 'echo wired-marker' }, fakeToolContext()) as { stdout: string };
    assert.ok(
      result.stdout.startsWith('-NoLogo -NoProfile -NonInteractive -Command echo wired-marker\n'),
      `expected declared shell to execute, got: ${result.stdout}`,
    );
  });

  test('background tool forwards its shell to the shell-run controller', async () => {
    const captured: unknown[] = [];
    const controller = {
      runBash: (input: unknown) => {
        captured.push(input);
        return Promise.resolve({ kind: 'terminal', cwd: '.', cmd: '', status: 'completed', exitCode: 0, stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false } as never);
      },
      readResource: () => Promise.reject(new Error('not used')),
      stopResource: () => Promise.reject(new Error('not used')),
    };
    const tool = buildBackgroundBashTool(controller, { shell: pwshPlan });
    await tool.impl({ command: 'echo hi' }, fakeToolContext());
    assert.deepEqual((captured[0] as { shell?: unknown }).shell, pwshPlan);
  });
});

function fakeToolContext() {
  return {
    sessionId: 'session-1',
    turnId: 'turn-1',
    toolCallId: 'tool-1',
    cwd: process.cwd(),
    abortSignal: new AbortController().signal,
    emitOutput: () => {},
  };
}

function fakeShellRuns() {
  return {
    runBash: () => Promise.reject(new Error('not used')),
    readResource: () => Promise.reject(new Error('not used')),
    stopResource: () => Promise.reject(new Error('not used')),
  };
}
