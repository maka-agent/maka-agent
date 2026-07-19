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
      throw new Error(
        `${name} must be a positive integer; a floor of 0 disables the stable-task guard (got "${explicitRaw}")`,
      );
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

/**
 * A raw environment bag: the Harbor cell and its helpers read strings from
 * `process.env` (or an injected clone), so the shared shape is a plain
 * name → value record. This is the single home for the type so the Harbor cell
 * split and its sink files (`harbor-cell-context-budget-env`,
 * `harbor-cell-tool-executor`, `provider-env`) share one definition instead of
 * each re-declaring it.
 */
export type RunHarborCellEnv = Record<string, string | undefined>;

/**
 * Parse a non-negative finite number; returns `undefined` for unset/blank or any
 * value that is not a finite `>= 0` number. Lenient by design (never throws): a
 * malformed value falls back to the caller's default. Shared by the Harbor cell
 * context-budget env compiler, tool executor, and pricing override.
 */
export function numericEnv(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Parse a positive integer (>= 1) from a raw env string; throws with `name` on a
 * non-positive-integer value so a typo fails loudly instead of silently
 * disabling a budget. Returns `undefined` when unset/blank.
 */
export function positiveIntEnv(raw: string | undefined, name: string): number | undefined {
  const value = raw?.trim();
  if (value === undefined || value === '') return undefined;
  if (!/^[1-9]\d*$/.test(value))
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  return Number(value);
}

/**
 * Lenient positive-integer parse: returns `undefined` for unset, malformed, or
 * non-positive values instead of throwing. Kept lenient because the Harbor
 * Python adapter recovers from a malformed `MAKA_CELL_TIMEOUT_SEC`
 * (`maka_agent.py` `_cell_timeout_sec`: "a malformed value falls back to the
 * default") and the TS runner must not fail loudly where the adapter would
 * recover. Accepted syntax is a decimal positive integer literal (`"1800"`)
 * only — the same `[1-9]\d*` form the Python adapter enforces, so `"1e3"`,
 * `"1.0"`, `"+1800"`, `"01800"`, and non-numeric forms are all a parse miss on
 * both sides. Values are capped at `Number.isSafeInteger`, so an over-long
 * digit string (which `Number()` would coerce to `Infinity`) still falls back
 * rather than slipping through. New TS-only env vars should use the throwing
 * `positiveIntEnv` instead.
 */
export function lenientPositiveIntEnv(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (!/^[1-9]\d*$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/**
 * Parse a boolean flag from a raw env string; throws with `name` on an
 * unrecognized value. Returns `undefined` when unset/blank so callers can apply
 * their own default.
 */
export function booleanEnv(raw: string | undefined, name: string): boolean | undefined {
  const value = raw?.trim().toLowerCase();
  if (value === undefined || value === '') return undefined;
  switch (value) {
    case '1':
    case 'true':
    case 'yes':
    case 'on':
    case 'enabled':
      return true;
    case '0':
    case 'false':
    case 'no':
    case 'off':
    case 'disabled':
      return false;
    default:
      throw new Error(`${name} must be a boolean, got ${JSON.stringify(raw)}`);
  }
}
