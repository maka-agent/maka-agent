import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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
const cliPath = new URL('../cli.js', import.meta.url).pathname;
const legacyCliPath = new URL('../../../headless/dist/cli.js', import.meta.url).pathname;

function runCliProcess(
  entrypoint: string,
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entrypoint, ...args]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end();
  });
}

describe('Maka CLI args', () => {
  test('runs the TUI for a bare command', () => {
    assert.deepEqual(parseMakaCliArgs([], '0.1.0'), { kind: 'tui' });
  });

  test('routes eval subcommands without changing their arguments', () => {
    assert.deepEqual(parseMakaCliArgs(['eval', 'task-run', 'inspect', 'run-1'], '0.1.0'), {
      kind: 'eval',
      args: ['task-run', 'inspect', 'run-1'],
    });
  });

  test('routes maka run and maka -p through the exact same command shape', () => {
    assert.deepEqual(parseMakaCliArgs(['run', 'hello', '--max-steps', '3'], '0.1.0'), {
      kind: 'run',
      args: ['hello', '--max-steps', '3'],
    });
    assert.deepEqual(parseMakaCliArgs(['-p', 'hello', '--max-steps', '3'], '0.1.0'), {
      kind: 'run',
      args: ['hello', '--max-steps', '3'],
    });
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

  test('rejects unknown positional arguments', () => {
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

  test('establishes the fatal exit before reporting can throw', async () => {
    const cliUrl = new URL('../cli.js', import.meta.url).href;
    const childSource = `
      import { handleMakaCliProcessExit } from ${JSON.stringify(cliUrl)};
      try {
        handleMakaCliProcessExit(1, new Error('fatal'), () => { throw new Error('writer failed'); });
      } catch {}
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', childSource], {
      stdio: 'ignore',
    });
    const [code, signal] = await once(child, 'exit') as [number | null, NodeJS.Signals | null];

    assert.equal(signal, null);
    assert.equal(code, 1);
  });

  test('coordinates repeated exit requests through the shell cleanup grace period', async () => {
    const cliUrl = new URL('../cli.js', import.meta.url).href;
    const childSource = `
      import { beginMakaCliExit } from ${JSON.stringify(cliUrl)};
      setInterval(() => {}, 1_000);
      beginMakaCliExit(0);
      setTimeout(() => beginMakaCliExit(1), 100);
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
      cliPath,
      '--version',
    ]);

    assert.equal(stdout.trim(), '0.1.0');
  });

  test('runs a fake evaluation through the unified executable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-unified-eval-'));
    try {
      await mkdir(join(dir, 'fixture'), { recursive: true });
      await writeFile(join(dir, 'fixture', 'marker.txt'), 'ok', 'utf8');
      const specPath = join(dir, 'spec.json');
      const outDir = join(dir, 'out');
      await writeFile(specPath, JSON.stringify({
        configs: [{ id: 'fake-cfg', backend: 'fake', llmConnectionSlug: 'fake', model: 'fake-model' }],
        tasks: [{
          id: 't-pass',
          instruction: 'go',
          workspaceDir: 'fixture',
          verification: { command: 'test -f marker.txt', protectedPaths: [] },
        }],
      }), 'utf8');

      const result = await runCliProcess(cliPath, ['eval', 'run', specPath, '--out', outDir]);

      assert.equal(result.code, 0, result.stderr);
      assert.doesNotMatch(result.stderr, /deprecated/);
      assert.match(result.stdout, /t-pass/);
      assert.match(await readFile(join(outDir, 'comparison.md'), 'utf8'), /t-pass/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('exposes identical run help through maka run and maka -p', async () => {
    const run = await runCliProcess(cliPath, ['run', '--help']);
    const alias = await runCliProcess(cliPath, ['-p', '--help']);

    assert.equal(run.code, 0, run.stderr);
    assert.equal(alias.code, 0, alias.stderr);
    assert.equal(alias.stdout, run.stdout);
    assert.match(run.stdout, /Usage: maka run/);
  });

  test('returns exit 2 for missing non-interactive input before configuration startup', async () => {
    const result = await runCliProcess(cliPath, ['run']);

    assert.equal(result.code, 2);
    assert.match(result.stderr, /missing prompt input/);
    assert.equal(result.stdout, '');
  });

  test('keeps all five legacy command families on the unified router exit contract', async () => {
    const pairs = [
      { unified: ['eval', 'run'], legacy: ['eval'] },
      { unified: ['eval', 'compare'], legacy: ['compare'] },
      { unified: ['eval', 'task-run'], legacy: ['task'] },
      { unified: ['eval', 'harbor'], legacy: ['harbor'] },
      { unified: ['eval', 'ahe'], legacy: ['ahe'] },
    ];
    for (const pair of pairs) {
      const unified = await runCliProcess(cliPath, pair.unified);
      const legacy = await runCliProcess(legacyCliPath, pair.legacy);
      assert.equal(legacy.code, unified.code, pair.unified.join(' '));
      assert.equal(legacy.stdout, unified.stdout, pair.unified.join(' '));
      assert.match(legacy.stderr, /maka-headless is deprecated/);
      assert.doesNotMatch(unified.stderr, /maka-headless is deprecated/);
    }
  });

  test('runs when launched through a bin symlink', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'maka-cli-bin-'));
    try {
      const linkPath = join(tempDir, 'maka');
      await symlink(cliPath, linkPath);
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
