/**
 * Pure helpers for the Antigravity (Google / Gemini) subscription
 * OAuth service. Split out so unit tests can import them without
 * dragging in the `electron` ESM module.
 *
 * Antigravity is currently a `preview` placeholder: the upstream
 * antigravity-auth plugin source is not available, so we ship the
 * loopback shape with an empty client_id. The service module
 * checks `hasClientId` before issuing any URL.
 */

import { createHash } from 'node:crypto';
import { base64urlEncode } from '@maka/core';

// =============================================================
// Preview status marker. The renderer reads this through the IPC
// `get-account-state` handler and the source-grep contract test
// pins it. When the Google client_id question is resolved, flip
// STATUS to 'ready' and fill in GOOGLE_CLIENT_ID below.
// =============================================================
export const STATUS = 'preview' as const;

// =============================================================
// Endpoints — canonical Google OAuth2 values. The service remains
// preview-only because the required client id is not bundled.
// =============================================================
const GOOGLE_AUTHORIZE_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const ANTIGRAVITY_CALLBACK_PORT = 51121;
const ANTIGRAVITY_REDIRECT_URI = `http://localhost:${ANTIGRAVITY_CALLBACK_PORT}/callback`;
const ANTIGRAVITY_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/cloud-platform',
].join(' ');

// PLACEHOLDER: real client_id is not in any source we have. The
// service refuses to issue an authorize URL until this is set.
// Empty string is the explicit not-configured sentinel.
export const GOOGLE_CLIENT_ID = '';

export const ANTIGRAVITY_OAUTH_CONFIG = {
  authUrl: GOOGLE_AUTHORIZE_ENDPOINT,
  tokenUrl: GOOGLE_TOKEN_ENDPOINT,
  redirectUri: ANTIGRAVITY_REDIRECT_URI,
  scopes: ANTIGRAVITY_SCOPES,
  callbackPort: ANTIGRAVITY_CALLBACK_PORT,
  callbackHost: '127.0.0.1',
  status: STATUS,
  hasClientId: GOOGLE_CLIENT_ID.length > 0,
} as const;

// =============================================================
// Pure helpers.
// =============================================================

export interface AntigravityAuthorizationConfig {
  clientId: string;
  authorizeEndpoint: string;
  redirectUri: string;
  scope: string;
  state: string;
  challenge: string;
}

export function buildAntigravityAuthorizationUrl(config: AntigravityAuthorizationConfig): string {
  const url = new URL(config.authorizeEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('scope', config.scope);
  url.searchParams.set('code_challenge', config.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', config.state);
  // Google-specific: ask for offline_access (refresh tokens) and
  // prompt=consent so we definitely receive a refresh token on
  // re-auth. spec-only assumption based on standard Google
  // OAuth practice.
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  return url.toString();
}

export function pkceChallengeFromVerifier(verifier: string): string {
  const digest = createHash('sha256').update(verifier, 'utf8').digest();
  return base64urlEncode(new Uint8Array(digest));
}

export function isAntigravitySubscriptionExperimentalEnabled(): boolean {
  return process.env.MAKA_ANTIGRAVITY_SUBSCRIPTION_EXPERIMENTAL !== '0';
}

/**
 * The "needs client_id" failure envelope. Exposed as a pure value
 * so both the service (returned from `getAuthorizationUrl`) and
 * the contract test (pinning the user-visible copy) reference the
 * same string.
 */
export const ANTIGRAVITY_MISSING_CLIENT_ID_ENVELOPE = {
  ok: false as const,
  reason: 'unknown' as const,
  message:
    '需要 Google client_id 才能启用 Antigravity 登录；当前为预览占位卡片，等待 antigravity-auth 插件的客户端配置。',
};
