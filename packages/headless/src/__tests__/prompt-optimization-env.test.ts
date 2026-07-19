import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  envFinitePositiveNumber,
  envNonNegativeInt,
  envPositiveInt,
  envRatio,
  resolveMinStable,
  smokeExitCode,
} from '../prompt-optimization-env.js';

describe('envNonNegativeInt', () => {
  test('returns the fallback when unset or empty', () => {
    assert.equal(envNonNegativeInt('N', undefined, 7), 7);
    assert.equal(envNonNegativeInt('N', '', 7), 7);
  });

  test('parses a valid non-negative integer', () => {
    assert.equal(envNonNegativeInt('N', '0', 7), 0);
    assert.equal(envNonNegativeInt('N', '42', 7), 42);
  });

  test('throws on a non-integer or negative value rather than returning NaN', () => {
    assert.throws(() => envNonNegativeInt('N', 'abc', 7), /N must be a non-negative integer/);
    assert.throws(() => envNonNegativeInt('N', '1.5', 7), /N must be a non-negative integer/);
    assert.throws(() => envNonNegativeInt('N', '-1', 7), /N must be a non-negative integer/);
  });
});

describe('envPositiveInt', () => {
  test('returns the fallback (which may be undefined) when unset', () => {
    assert.equal(envPositiveInt('N', undefined, 10), 10);
    assert.equal(envPositiveInt('N', '', 10), 10);
    assert.equal(envPositiveInt('N', undefined, undefined), undefined);
  });

  test('parses a positive integer', () => {
    assert.equal(envPositiveInt('N', '1', 10), 1);
    assert.equal(envPositiveInt('N', '10', 10), 10);
  });

  test('rejects 0 so a baseline-only run cannot trivially pass the smoke', () => {
    assert.throws(() => envPositiveInt('N', '0', 10), /N must be a positive integer/);
  });

  test('rejects negative and non-integer values', () => {
    assert.throws(() => envPositiveInt('N', '-1', 10), /N must be a non-negative integer/);
    assert.throws(() => envPositiveInt('N', '2.5', 10), /N must be a non-negative integer/);
  });
});

describe('envFinitePositiveNumber', () => {
  test('returns the fallback (which may be undefined) when unset', () => {
    assert.equal(envFinitePositiveNumber('N', undefined, 30), 30);
    assert.equal(envFinitePositiveNumber('N', '', 30), 30);
    assert.equal(envFinitePositiveNumber('N', undefined, undefined), undefined);
  });

  test('parses a finite positive number', () => {
    assert.equal(envFinitePositiveNumber('N', '30', undefined), 30);
    assert.equal(envFinitePositiveNumber('N', '0.5', undefined), 0.5);
  });

  test('throws on NaN, non-finite, or non-positive so a guard is never silently disabled', () => {
    assert.throws(
      () => envFinitePositiveNumber('N', 'abc', undefined),
      /N must be a finite positive number/,
    );
    assert.throws(
      () => envFinitePositiveNumber('N', '0', undefined),
      /N must be a finite positive number/,
    );
    assert.throws(
      () => envFinitePositiveNumber('N', '-5', undefined),
      /N must be a finite positive number/,
    );
    assert.throws(
      () => envFinitePositiveNumber('N', 'Infinity', undefined),
      /N must be a finite positive number/,
    );
  });
});

describe('envRatio', () => {
  test('returns the fallback (which may be undefined) when unset', () => {
    assert.equal(envRatio('R', undefined, 0.5), 0.5);
    assert.equal(envRatio('R', '', 0.5), 0.5);
    assert.equal(envRatio('R', undefined, undefined), undefined);
  });

  test('parses a ratio in (0, 1]', () => {
    assert.equal(envRatio('R', '1', 0.5), 1);
    assert.equal(envRatio('R', '0.25', 0.5), 0.25);
  });

  test('throws outside (0, 1] or on NaN', () => {
    assert.throws(() => envRatio('R', '0', 0.5), /R must be a number in \(0, 1\]/);
    assert.throws(() => envRatio('R', '1.5', 0.5), /R must be a number in \(0, 1\]/);
    assert.throws(() => envRatio('R', 'abc', 0.5), /R must be a number in \(0, 1\]/);
  });
});

describe('resolveMinStable', () => {
  test('an explicit raw count wins and is validated as a positive integer', () => {
    assert.equal(resolveMinStable('M', 50, '1', 0.5), 1);
    assert.equal(resolveMinStable('M', 50, '3', 0.5), 3);
    assert.throws(() => resolveMinStable('M', 50, 'abc', 0.5), /M must be a non-negative integer/);
  });

  test('rejects an explicit 0 so the stable-task guard cannot be silently disabled', () => {
    assert.throws(() => resolveMinStable('M', 50, '0', 0.5), /M must be a positive integer/);
  });

  test('without an explicit count, scales with the requested size (ceil, at least 1)', () => {
    assert.equal(resolveMinStable('M', 50, undefined, 0.5), 25);
    assert.equal(resolveMinStable('M', 27, undefined, 0.5), 14); // ceil(13.5)
    assert.equal(resolveMinStable('M', 1, undefined, 0.5), 1); // floor never drops below 1
    assert.equal(resolveMinStable('M', 0, undefined, 0.5), 1);
  });
});

describe('smokeExitCode', () => {
  test('zero only when the smoke passed', () => {
    assert.equal(smokeExitCode('pass'), 0);
    assert.equal(smokeExitCode('fail'), 1);
    assert.equal(smokeExitCode('error'), 1);
    assert.equal(smokeExitCode(''), 1);
  });
});
