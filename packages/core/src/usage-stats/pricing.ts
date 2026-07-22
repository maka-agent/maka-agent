/**
 * PR-UI-IPC-3 (@kenji msg 9033abdf): pricing override shape +
 * range normalization at the IPC store boundary.
 *
 * `usage:pricing:put` and `usage:pricing:reset` previously
 * accepted whatever the renderer sent and persisted raw to the
 * telemetry repo. A bad payload would land on disk and corrupt
 * the Usage dashboard:
 *   - negative rate → "credit / refund" misread in cost display
 *   - `NaN` rate    → math propagates `NaN`, dashboard shows garbage
 *   - `Infinity`    → math propagates `Infinity`, dashboard breaks
 *   - non-string `modelKey` → `localeCompare` crashes the sort
 *   - empty `modelKey`     → orphan entry; match-by-key fails
 *   - non-object pricing   → TypeError accessing fields
 *
 * Maka doesn't bill users, so this is UX correctness, not financial
 * liability. But a user who types `-5` instead of `5` should NOT
 * see a "you saved $50" dashboard.
 *
 * Scope (intentionally narrow per @kenji msg 9033abdf):
 *   - shape + range validation only
 *   - NOT a pricing product change — no upper cap on rates
 *     (enterprise / local-cost accounting could legitimately
 *     configure unusual rates)
 *   - `0` is legitimate (free tier / Ollama / self-hosted)
 *   - extra fields stripped (canonical return)
 *
 * Pair: `normalizePricingConfig` for `usage:pricing:put`,
 * `normalizePricingModelKey` for `usage:pricing:reset`. Both
 * gate the same model-key contract so reset can't crash via a
 * non-string key while put would reject the same input.
 */

import type { PricingConfig } from './types.js';

export type NormalizePricingResult =
  | { ok: true; value: PricingConfig }
  | { ok: false; error: string };

export type NormalizePricingModelKeyResult =
  | { ok: true; value: string }
  | { ok: false; error: string };

/** Maximum UTF-8 size of a canonical pricing model key. */
export const PRICING_MODEL_KEY_MAX_BYTES = 2048;

/**
 * Validate + canonicalize a pricing `modelKey`.
 *
 *   - typeof guard: non-string → reject (IPC payload runtime safety)
 *   - C0 control characters and DEL → reject
 *   - trim
 *   - empty after trim → reject
 *   - > 2048 UTF-8 bytes → reject
 *
 * Used by `usage:pricing:put` (for the embedded modelKey) AND
 * `usage:pricing:reset` (the standalone arg). Both call sites
 * must share the same gate so reset can't bypass key validation.
 */
export function normalizePricingModelKey(input: unknown): NormalizePricingModelKeyResult {
  if (typeof input !== 'string') {
    return { ok: false, error: 'modelKey must be a string' };
  }
  for (let index = 0; index < input.length; index += 1) {
    const codeUnit = input.charCodeAt(index);
    if (codeUnit <= 0x1f || codeUnit === 0x7f) {
      return { ok: false, error: 'modelKey cannot contain control characters' };
    }
  }
  const trimmed = input.trim();
  if (trimmed === '') {
    return { ok: false, error: 'modelKey cannot be empty' };
  }
  if (new TextEncoder().encode(trimmed).byteLength > PRICING_MODEL_KEY_MAX_BYTES) {
    return {
      ok: false,
      error: `modelKey must be ${PRICING_MODEL_KEY_MAX_BYTES} UTF-8 bytes or fewer`,
    };
  }
  return { ok: true, value: trimmed };
}

/**
 * Validate + canonicalize a full `PricingConfig`.
 *
 * Pipeline:
 *   1. typeof object guard (also reject `null`, array, function,
 *      primitive). IPC payloads cross a process boundary; the
 *      `PricingConfig` TS type is compile-time only.
 *   2. modelKey via `normalizePricingModelKey` (same gate
 *      `usage:pricing:reset` uses).
 *   3. inputUsdPer1M + outputUsdPer1M (required):
 *      typeof number + `Number.isFinite` (rejects NaN / Infinity)
 *      + `>= 0` (0 is legitimate for free tier).
 *   4. cacheReadUsdPer1M + cacheWriteUsdPer1M (optional):
 *      undefined → omit from canonical output. Present invalid →
 *      reject.
 *   5. Extra fields stripped — canonical return contains ONLY
 *      `modelKey` + required rates + present-valid optional
 *      cache rates. Matches the IPC-1 / IPC-2 normalize-and-
 *      strip pattern.
 *
 * Returns the canonical `PricingConfig` (the only shape allowed
 * to reach `telemetryRepo.upsertPricing`).
 */
export function normalizePricingConfig(input: unknown): NormalizePricingResult {
  // L1: object guard (also rejects null / array / primitive / function).
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, error: 'pricing must be an object' };
  }
  const record = input as Record<string, unknown>;

  // L2: modelKey via shared helper.
  const keyResult = normalizePricingModelKey(record.modelKey);
  if (!keyResult.ok) {
    return { ok: false, error: keyResult.error };
  }

  // L3: required rates.
  const inputResult = validateRate(record.inputUsdPer1M, 'inputUsdPer1M');
  if (!inputResult.ok) return { ok: false, error: inputResult.error };
  const outputResult = validateRate(record.outputUsdPer1M, 'outputUsdPer1M');
  if (!outputResult.ok) return { ok: false, error: outputResult.error };

  // L4: optional cache rates. undefined → omit; present invalid → reject.
  let cacheRead: number | undefined;
  if (record.cacheReadUsdPer1M !== undefined) {
    const cacheReadResult = validateRate(record.cacheReadUsdPer1M, 'cacheReadUsdPer1M');
    if (!cacheReadResult.ok) return { ok: false, error: cacheReadResult.error };
    cacheRead = cacheReadResult.value;
  }
  let cacheWrite: number | undefined;
  if (record.cacheWriteUsdPer1M !== undefined) {
    const cacheWriteResult = validateRate(record.cacheWriteUsdPer1M, 'cacheWriteUsdPer1M');
    if (!cacheWriteResult.ok) return { ok: false, error: cacheWriteResult.error };
    cacheWrite = cacheWriteResult.value;
  }

  // L5: canonical return — strip extra fields. Only required +
  // present-valid optional rates land in the persisted shape.
  const canonical: PricingConfig = {
    modelKey: keyResult.value,
    inputUsdPer1M: inputResult.value,
    outputUsdPer1M: outputResult.value,
    ...(cacheRead !== undefined ? { cacheReadUsdPer1M: cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWriteUsdPer1M: cacheWrite } : {}),
  };
  return { ok: true, value: canonical };
}

/**
 * Validate a single rate field. Per @kenji msg 9033abdf:
 *   - typeof number
 *   - `Number.isFinite` (rejects NaN, +Infinity, -Infinity)
 *   - `>= 0` (0 is legitimate for free tier; Maka doesn't impose
 *     an upper cap because enterprise/local cost accounting can
 *     have unusual rates)
 */
function validateRate(
  value: unknown,
  fieldName: string,
): { ok: true; value: number } | { ok: false; error: string } {
  if (typeof value !== 'number') {
    return { ok: false, error: `${fieldName} must be a number` };
  }
  if (!Number.isFinite(value)) {
    return { ok: false, error: `${fieldName} must be a finite number (NaN / Infinity rejected)` };
  }
  if (value < 0) {
    return { ok: false, error: `${fieldName} must be >= 0` };
  }
  return { ok: true, value };
}
