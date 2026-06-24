/**
 * Pure, fail-loud numeric invariant guards. These are the single source of truth
 * for what a valid count / budget / ratio is, shared by the prompt-optimization
 * public API (loop + controller) and the CLI env parsers. The core API owns the
 * invariants so a direct caller cannot slip a `NaN`, fraction, or `0` past a
 * `value < 1` or `cost >= ceiling` comparison and silently disable a guard or
 * change loop semantics; the CLI parsers (`headless-run-env`) just turn an
 * env string into a number and delegate the validation here. Each guard returns
 * the value so it can wrap an assignment.
 */

/** Throw unless `value` is an integer >= 1. */
export function assertPositiveInt(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer (got ${value})`);
  }
  return value;
}

/** Throw unless `value` is an integer >= 0. */
export function assertNonNegativeInt(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer (got ${value})`);
  }
  return value;
}

/** Throw unless `value` is finite and > 0. */
export function assertFinitePositive(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a finite positive number (got ${value})`);
  }
  return value;
}

/** Throw unless `value` is a finite number in `(0, 1]`. */
export function assertRatio(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error(`${name} must be a number in (0, 1] (got ${value})`);
  }
  return value;
}
