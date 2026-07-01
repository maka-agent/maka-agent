#!/usr/bin/env node
/**
 * Run the headless Node test suite without inheriting machine-level Git config.
 *
 * Usage:
 *   node scripts/run-headless-tests.mjs
 *   node scripts/run-headless-tests.mjs --help
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), '..');
const headlessDir = join(repoRoot, 'packages', 'headless');
const testPattern = 'dist/**/*.test.js';

const usage = `Usage: node scripts/run-headless-tests.mjs

Runs packages/headless tests with an isolated, empty global Git config.
`;

export function runHeadlessTests(options = {}) {
  const cwd = options.cwd ?? headlessDir;
  const spawn = options.spawnSync ?? spawnSync;
  const tempDir = mkdtempSync(join(tmpdir(), 'maka-headless-git-config-'));
  const globalConfigPath = join(tempDir, 'gitconfig');
  writeFileSync(globalConfigPath, '', { encoding: 'utf8', mode: 0o600 });

  try {
    const result = spawn(process.execPath, ['--test', testPattern], {
      cwd,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: globalConfigPath,
        GIT_CONFIG_NOSYSTEM: '1',
      },
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    return result.status ?? 1;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function main(args) {
  if (args.length === 1 && (args[0] === '-h' || args[0] === '--help')) {
    process.stdout.write(usage);
    return 0;
  }
  if (args.length > 0) {
    process.stderr.write(`${usage}\nUnexpected argument: ${args[0]}\n`);
    return 2;
  }
  return runHeadlessTests();
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  process.exitCode = main(process.argv.slice(2));
}
