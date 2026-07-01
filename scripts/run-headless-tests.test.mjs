import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { runHeadlessTests } from './run-headless-tests.mjs';

test('runHeadlessTests isolates Git config and removes its temporary file', () => {
  const cwd = resolve('packages/headless');
  let globalConfigPath;

  const status = runHeadlessTests({
    cwd,
    spawnSync(command, args, options) {
      assert.equal(command, process.execPath);
      assert.deepEqual(args, ['--test', 'dist/**/*.test.js']);
      assert.equal(options.cwd, cwd);
      assert.equal(options.stdio, 'inherit');
      assert.equal(options.env.GIT_CONFIG_NOSYSTEM, '1');
      globalConfigPath = options.env.GIT_CONFIG_GLOBAL;
      assert.equal(readFileSync(globalConfigPath, 'utf8'), '');
      return { error: undefined, signal: null, status: 0 };
    },
  });

  assert.equal(status, 0);
  assert.equal(existsSync(globalConfigPath), false);
});

test('runHeadlessTests propagates a non-zero test status', () => {
  const status = runHeadlessTests({
    spawnSync() {
      return { error: undefined, signal: null, status: 7 };
    },
  });

  assert.equal(status, 7);
});
