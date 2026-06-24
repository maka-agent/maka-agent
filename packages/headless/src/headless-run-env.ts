/**
 * Pure, testable env-string parsers for headless CLI entrypoints. Each parser
 * only turns the raw env string (or undefined) into a typed value and delegates
 * invariants to shared numeric guards, so script wiring cannot accidentally
 * disable a guard with `NaN`.
 */

import {
  assertFinitePositive,
  assertNonNegativeInt,
  assertPositiveInt,
  assertRatio,
} from './numeric-guards.js';

/** Parse a non-negative integer; throw on a non-integer or negative value. */
export function envNonNegativeInt(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  return assertNonNegativeInt(name, Number(raw));
}

/** Parse a positive integer (>= 1); throw on 0, negative, or non-integer.
 * Returns `fallback` (which may be undefined) when unset. */
export function envPositiveInt(
  name: string,
  raw: string | undefined,
  fallback: number | undefined,
): number | undefined {
  if (raw === undefined || raw === '') return fallback;
  return assertPositiveInt(name, assertNonNegativeInt(name, Number(raw)));
}

/**
 * Parse a finite, strictly-positive number; throw on `NaN`, non-finite, or `<= 0`.
 * Returns `fallback` when unset.
 */
export function envFinitePositiveNumber(
  name: string,
  raw: string | undefined,
  fallback: number | undefined,
): number | undefined {
  if (raw === undefined || raw === '') return fallback;
  return assertFinitePositive(name, Number(raw));
}

/** Parse a ratio in `(0, 1]`; throw on `NaN`, non-finite, or out-of-range.
 * Returns `fallback` when unset. */
export function envRatio(
  name: string,
  raw: string | undefined,
  fallback: number | undefined,
): number | undefined {
  if (raw === undefined || raw === '') return fallback;
  return assertRatio(name, Number(raw));
}

/**
 * Resolve a minimum-stable-task floor. An explicit raw count wins (validated as a
 * positive integer). Otherwise the floor scales with the actual requested count.
 */
export function resolveMinStable(
  name: string,
  requested: number,
  explicitRaw: string | undefined,
  ratio: number,
): number {
  if (explicitRaw !== undefined && explicitRaw !== '') {
    const explicit = envNonNegativeInt(name, explicitRaw, 1);
    if (explicit < 1) {
      throw new Error(`${name} must be a positive integer; a floor of 0 disables the stable-task guard (got "${explicitRaw}")`);
    }
    return explicit;
  }
  return Math.max(1, Math.ceil(requested * ratio));
}

/**
 * CLI exit code for a finished run: non-zero when the structural smoke did not
 * pass, so CI and shell callers don't treat a bad run as success.
 */
export function smokeExitCode(smokeStatus: string): number {
  return smokeStatus === 'pass' ? 0 : 1;
}
