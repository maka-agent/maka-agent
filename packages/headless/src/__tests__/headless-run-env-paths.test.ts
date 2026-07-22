import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { envIds, envPath } from '../headless-run-env.js';

describe('envPath', () => {
  test('expands a leading tilde against the home directory', () => {
    assert.equal(envPath('MAKA_TEST_PATH', '~/x/y'), join(homedir(), '/x/y'));
  });

  test('resolves a relative value against the current working directory', () => {
    assert.equal(envPath('MAKA_TEST_PATH', 'relative/dir'), resolve('relative/dir'));
  });

  test('keeps an absolute value as-is (normalized)', () => {
    assert.equal(envPath('MAKA_TEST_PATH', '/tmp/maka-out'), resolve('/tmp/maka-out'));
  });

  test('falls back when the raw value is unset or empty', () => {
    assert.equal(envPath('MAKA_TEST_PATH', undefined, '/tmp/fallback'), resolve('/tmp/fallback'));
    assert.equal(envPath('MAKA_TEST_PATH', '', '/tmp/fallback'), resolve('/tmp/fallback'));
    assert.equal(envPath('MAKA_TEST_PATH', '', '~/fallback'), join(homedir(), '/fallback'));
  });

  test('throws with the env var name when neither value nor fallback is present', () => {
    assert.throws(() => envPath('MAKA_TEST_PATH', undefined), /MAKA_TEST_PATH is required/);
    assert.throws(() => envPath('MAKA_TEST_PATH', ''), /MAKA_TEST_PATH is required/);
  });
});

describe('envIds', () => {
  test('splits on commas, trims entries, and drops empty segments', () => {
    assert.deepEqual(envIds(' task-a , task-b ,, task-c,'), ['task-a', 'task-b', 'task-c']);
  });

  test('preserves duplicates and order for the caller to police', () => {
    assert.deepEqual(envIds('b,a,b'), ['b', 'a', 'b']);
  });

  test('returns undefined for unset, empty, or all-blank input', () => {
    assert.equal(envIds(undefined), undefined);
    assert.equal(envIds(''), undefined);
    assert.equal(envIds(' , , '), undefined);
  });
});
