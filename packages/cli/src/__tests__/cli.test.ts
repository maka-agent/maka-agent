import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, test } from 'node:test';
import { parseMakaCliArgs } from '../cli.js';

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
