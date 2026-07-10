import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, test } from 'node:test';
import {
  parseMakaCliArgs,
  formatStartupConnectionError,
  formatMakaCliFatalError,
  resolveMakaCliExitCode,
} from '../cli.js';

const execFileAsync = promisify(execFile);

describe('Maka CLI args', () => {
  test('runs the TUI for a bare command', () => {
    assert.deepEqual(parseMakaCliArgs([], '0.1.0'), { kind: 'run' });
  });

  test('prints help', () => {
    const command = parseMakaCliArgs(['--help'], '0.1.0');
    assert.equal(command.kind, 'help');
    if (command.kind !== 'help') return;
    assert.match(command.text, /Usage: maka/);
    assert.match(command.text, /maka-agent/);
  });

  test('prints version', () => {
    assert.deepEqual(parseMakaCliArgs(['--version'], '0.1.0'), {
      kind: 'version',
      text: '0.1.0',
    });
  });

  test('rejects positional arguments in the first release', () => {
    assert.deepEqual(parseMakaCliArgs(['headless'], '0.1.0'), {
      kind: 'error',
      message: 'Unexpected argument: headless',
      exitCode: 2,
    });
  });

  test('uses the command exit code when no earlier exit reason exists', () => {
    assert.equal(resolveMakaCliExitCode(2, undefined), 2);
  });

  test('preserves an exit code already set by a process signal', () => {
    assert.equal(resolveMakaCliExitCode(0, 143), 143);
  });

  test('formats non-Error fatal reasons as text', () => {
    assert.equal(formatMakaCliFatalError('fatal reason'), 'fatal reason');
  });

  test('preserves the stack for fatal errors', () => {
    const error = new Error('fatal reason');

    assert.equal(formatMakaCliFatalError(error), error.stack);
  });

  test('coordinates repeated exit requests through the shell cleanup grace period', async () => {
    const cliUrl = new URL('../cli.js', import.meta.url).href;
    const childSource = `
      import { completeMakaCliExit } from ${JSON.stringify(cliUrl)};
      setInterval(() => {}, 1_000);
      completeMakaCliExit(0);
      setTimeout(() => completeMakaCliExit(1), 100);
    `;
    const startedAt = Date.now();
    const child = spawn(process.execPath, ['--input-type=module', '-e', childSource], {
      stdio: 'ignore',
    });
    const watchdog = setTimeout(() => child.kill('SIGKILL'), 5_000);
    const [code, signal] = await once(child, 'exit') as [number | null, NodeJS.Signals | null];
    clearTimeout(watchdog);

    assert.equal(signal, null);
    assert.equal(code, 1);
    assert.ok(Date.now() - startedAt >= 2_500);
  });

  test('prints version from the executable entrypoint', async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      new URL('../cli.js', import.meta.url).pathname,
      '--version',
    ]);

    assert.equal(stdout.trim(), '0.1.0');
  });

  test('runs when launched through a bin symlink', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'maka-cli-bin-'));
    try {
      const linkPath = join(tempDir, 'maka');
      await symlink(new URL('../cli.js', import.meta.url).pathname, linkPath);
      const { stdout } = await execFileAsync(linkPath, ['--version']);

      assert.equal(stdout.trim(), '0.1.0');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe('startup connection-error guidance', () => {
  const workspaceRoot = '/tmp/maka-workspace';

  test('translates a missing default connection into actionable first-run help', () => {
    const guidance = formatStartupConnectionError(
      new Error('NO_REAL_CONNECTION:missing_default_connection'),
      workspaceRoot,
    );
    assert.ok(guidance);
    // Reason-specific fix line (shared core copy) — distinct per reason, so this
    // asserts the translation ran, not just the static header/footer.
    assert.match(guidance, /等待配置默认模型/);
    // Static header plus the CLI-only footer that points at the desktop app and
    // the on-disk workspace.
    assert.match(guidance, /还没有可用的模型连接/);
    assert.match(guidance, /设置 · 模型/);
    assert.match(guidance, /Maka 桌面应用/);
    assert.match(guidance, new RegExp(workspaceRoot));
  });

  test('uses the credential-specific copy for a missing API key', () => {
    const guidance = formatStartupConnectionError(
      new Error('NO_REAL_CONNECTION:missing_api_key'),
      workspaceRoot,
    );
    assert.ok(guidance);
    assert.match(guidance, /API key/);
  });

  test('returns null for an unrelated startup error so it propagates unchanged', () => {
    assert.equal(formatStartupConnectionError(new Error('ENOENT: workspace missing'), workspaceRoot), null);
  });
});
