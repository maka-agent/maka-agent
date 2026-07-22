import { requireEntityId, requireExactRecord, requireRecord } from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { defineOperation } from './operation-spec.js';

export const OAUTH_LOGIN_PROVIDERS = ['claude-subscription', 'openai-codex'] as const;
export const OAUTH_LOGIN_PHASES = [
  'awaiting_authorization',
  'exchanging',
  'committing',
  'authenticated',
  'cancelled',
  'failed',
] as const;
export const OAUTH_LOGIN_FAILURE_CODES = [
  'capability_unavailable',
  'authorization_failed',
  'provider_rejected',
  'credential_changed',
  'persistence_failed',
  'internal_failure',
] as const;

const COMMON_ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'invalid_request',
  'internal_failure',
] as const;
const START_ERRORS = [
  ...COMMON_ERRORS,
  'authorization_in_progress',
  'capability_unavailable',
  'not_found',
  'persistence_failed',
] as const;
const ATTEMPT_ERRORS = [...COMMON_ERRORS, 'not_found'] as const;
const REFRESH_ERRORS = [
  ...COMMON_ERRORS,
  'not_found',
  'operation_conflict',
  'persistence_failed',
  'commit_outcome_unknown',
] as const;

export type OAuthLoginProvider = (typeof OAUTH_LOGIN_PROVIDERS)[number];
export type OAuthLoginPhase = (typeof OAUTH_LOGIN_PHASES)[number];
export type OAuthLoginFailureCode = (typeof OAUTH_LOGIN_FAILURE_CODES)[number];

export interface OAuthLoginProjection {
  readonly attemptId: string;
  readonly connectionId: string;
  readonly provider: OAuthLoginProvider;
  readonly phase: OAuthLoginPhase;
  readonly failure?: OAuthLoginFailureCode;
}

export interface OAuthLoginStartInput {
  readonly attemptId: string;
  readonly connectionId: string;
}

export interface OAuthLoginAttemptInput {
  readonly attemptId: string;
}

export interface OAuthCredentialRefreshInput {
  readonly connectionId: string;
}

export type OAuthCredentialRefreshResult =
  | { readonly kind: 'refreshed' }
  | { readonly kind: 'relogin_required' }
  | { readonly kind: 'superseded' };

export const OAUTH_OPERATION_SPECS = {
  'oauth.login.start': defineOperation<
    OAuthLoginStartInput,
    OAuthLoginProjection,
    (typeof START_ERRORS)[number]
  >({
    mode: 'command',
    retry: 'semantic',
    admission: 'ready',
    errors: START_ERRORS,
    decodeInput: decodeOAuthLoginStartInput,
    decodeOutput: decodeOAuthLoginProjection,
  }),
  'oauth.login.query': defineOperation<
    OAuthLoginAttemptInput,
    OAuthLoginProjection,
    (typeof ATTEMPT_ERRORS)[number]
  >({
    mode: 'query',
    retry: 'safe',
    admission: 'ready',
    errors: ATTEMPT_ERRORS,
    decodeInput: decodeOAuthLoginAttemptInput,
    decodeOutput: decodeOAuthLoginProjection,
  }),
  'oauth.login.cancel': defineOperation<
    OAuthLoginAttemptInput,
    OAuthLoginProjection,
    (typeof ATTEMPT_ERRORS)[number]
  >({
    mode: 'control',
    retry: 'semantic',
    admission: 'ready',
    errors: ATTEMPT_ERRORS,
    decodeInput: decodeOAuthLoginAttemptInput,
    decodeOutput: decodeOAuthLoginProjection,
  }),
  'oauth.credential.refresh': defineOperation<
    OAuthCredentialRefreshInput,
    OAuthCredentialRefreshResult,
    (typeof REFRESH_ERRORS)[number]
  >({
    mode: 'command',
    retry: 'none',
    admission: 'ready',
    errors: REFRESH_ERRORS,
    decodeInput: decodeOAuthCredentialRefreshInput,
    decodeOutput: decodeOAuthCredentialRefreshResult,
  }),
} as const;

export function decodeOAuthLoginStartInput(value: unknown): OAuthLoginStartInput {
  const input = requireExactRecord(value, 'OAuth login start input', ['attemptId', 'connectionId']);
  return {
    attemptId: requireEntityId(input.attemptId, 'attemptId'),
    connectionId: requireEntityId(input.connectionId, 'connectionId'),
  };
}

export function decodeOAuthLoginAttemptInput(value: unknown): OAuthLoginAttemptInput {
  const input = requireExactRecord(value, 'OAuth login attempt input', ['attemptId']);
  return { attemptId: requireEntityId(input.attemptId, 'attemptId') };
}

export function decodeOAuthCredentialRefreshInput(value: unknown): OAuthCredentialRefreshInput {
  const input = requireExactRecord(value, 'OAuth credential refresh input', ['connectionId']);
  return { connectionId: requireEntityId(input.connectionId, 'connectionId') };
}

export function decodeOAuthLoginProjection(value: unknown): OAuthLoginProjection {
  const projection = requireRecord(value, 'OAuth login projection');
  const phase = oauthLoginPhase(projection.phase);
  const fields =
    phase === 'failed'
      ? ['attemptId', 'connectionId', 'provider', 'phase', 'failure']
      : ['attemptId', 'connectionId', 'provider', 'phase'];
  const exact = requireExactRecord(projection, 'OAuth login projection', fields);
  return {
    attemptId: requireEntityId(exact.attemptId, 'attemptId'),
    connectionId: requireEntityId(exact.connectionId, 'connectionId'),
    provider: oauthLoginProvider(exact.provider),
    phase,
    ...(phase === 'failed' ? { failure: oauthLoginFailure(exact.failure) } : {}),
  };
}

export function decodeOAuthCredentialRefreshResult(value: unknown): OAuthCredentialRefreshResult {
  const result = requireExactRecord(value, 'OAuth credential refresh result', ['kind']);
  if (
    result.kind !== 'refreshed' &&
    result.kind !== 'relogin_required' &&
    result.kind !== 'superseded'
  ) {
    throw invalidProtocolFrame('Invalid OAuth credential refresh result kind');
  }
  return { kind: result.kind };
}

function oauthLoginProvider(value: unknown): OAuthLoginProvider {
  if (typeof value !== 'string' || !OAUTH_LOGIN_PROVIDERS.includes(value as OAuthLoginProvider)) {
    throw invalidProtocolFrame('Invalid OAuth login provider');
  }
  return value as OAuthLoginProvider;
}

function oauthLoginPhase(value: unknown): OAuthLoginPhase {
  if (typeof value !== 'string' || !OAUTH_LOGIN_PHASES.includes(value as OAuthLoginPhase)) {
    throw invalidProtocolFrame('Invalid OAuth login phase');
  }
  return value as OAuthLoginPhase;
}

function oauthLoginFailure(value: unknown): OAuthLoginFailureCode {
  if (
    typeof value !== 'string' ||
    !OAUTH_LOGIN_FAILURE_CODES.includes(value as OAuthLoginFailureCode)
  ) {
    throw invalidProtocolFrame('Invalid OAuth login failure');
  }
  return value as OAuthLoginFailureCode;
}
