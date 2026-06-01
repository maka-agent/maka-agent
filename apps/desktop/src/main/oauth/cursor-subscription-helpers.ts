/**
 * Pure helpers for the Cursor subscription OAuth service. Split
 * out from `cursor-subscription-service.ts` so unit tests can
 * import them without dragging in the `electron` ESM module.
 *
 * Endpoint constants live here too; the service module re-exports
 * them so there is exactly one source of truth.
 */

import { createHash } from 'node:crypto';
import { base64urlEncode } from '@maka/core';

// =============================================================
// Endpoints — pinned to the cursor-auth plugin pattern.
// =============================================================
export const CURSOR_OAUTH_CONFIG = {
  loginUrl: 'https://cursor.com/loginDeepControl',
  pollUrl: 'https://api2.cursor.sh/auth/poll',
  refreshUrl: 'https://api2.cursor.sh/auth/exchange_user_api_key',
  pollMaxAttempts: 150,
  pollBaseDelayMs: 1000,
  pollMaxDelayMs: 10_000,
  pollBackoffMultiplier: 1.2,
  pollMaxConsecutiveErrors: 10,
} as const;

// =============================================================
// Pure helpers.
// =============================================================

export interface CursorLoginConfig {
  loginUrl: string;
  challenge: string;
  uuid: string;
}

export function buildCursorLoginUrl(config: CursorLoginConfig): string {
  const params = new URLSearchParams({
    challenge: config.challenge,
    uuid: config.uuid,
    mode: 'login',
    redirectTarget: 'cli',
  });
  return `${config.loginUrl}?${params.toString()}`;
}

export function pkceChallengeFromVerifier(verifier: string): string {
  const digest = createHash('sha256').update(verifier, 'utf8').digest();
  return base64urlEncode(new Uint8Array(digest));
}

/**
 * Read JWT exp claim and convert to expiry epoch ms with a 5-minute
 * safety margin. Falls back to "now + 1 hour" if the token can't
 * be parsed; matches the cursor-auth plugin helper exactly.
 */
export function getTokenExpiry(token: string, nowMs: number): number {
  try {
    const parts = token.split('.');
    if (parts.length !== 3 || !parts[1]) return nowMs + 3600 * 1000;
    const padded = parts[1] + '='.repeat((4 - (parts[1].length % 4)) % 4);
    const standard = padded.replace(/-/g, '+').replace(/_/g, '/');
    const decoded = JSON.parse(Buffer.from(standard, 'base64').toString('utf8')) as {
      exp?: number;
    };
    if (decoded && typeof decoded.exp === 'number') {
      return decoded.exp * 1000 - 5 * 60 * 1000;
    }
  } catch {
    // ignore
  }
  return nowMs + 3600 * 1000;
}

/**
 * Whether the Cursor subscription card is enabled at all in this
 * build. Same opt-out shape as the other subscription services.
 */
export function isCursorSubscriptionExperimentalEnabled(): boolean {
  return process.env.MAKA_CURSOR_SUBSCRIPTION_EXPERIMENTAL !== '0';
}
