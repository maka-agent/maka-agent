import type { BackendKind } from '@maka/core';

/**
 * Decides which backend a new session uses.
 *
 * In E2E mode (`MAKA_E2E=1`) every session is forced onto the deterministic
 * `fake` backend regardless of what the renderer asks for, so end-to-end tests
 * run without real provider keys or network. Otherwise the requested backend
 * wins, defaulting to `ai-sdk`.
 */
export function resolveSessionBackend(
  input: { backend?: BackendKind } | undefined,
  env: Record<string, string | undefined>,
): BackendKind {
  if (env.MAKA_E2E === '1') return 'fake';
  return input?.backend ?? 'ai-sdk';
}
