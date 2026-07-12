/**
 * Connection-setup events & commands.
 *
 * These are NOT SessionEvents. Credential entry, OAuth handshake, and
 * connection-test results have no `turnId` and are not tied to a session.
 * They travel on the desktop bridge's `connections.*` channel, separate
 * from `sessions.*`.
 */

import type { LlmConnection } from './llm-connections.js';

interface BaseConnectionEvent {
  id: string;
  ts: number;
}

export type ConnectionEvent =
  | ConnectionCredentialRequestEvent
  | ConnectionTestResultEvent
  | ConnectionListChangedEvent;

export interface ConnectionCredentialRequestEvent extends BaseConnectionEvent {
  type: 'connection_credential_request';
  requestId: string;
  /** Target connection slug. */
  slug: string;
  scheme: 'bearer' | 'basic' | 'header' | 'query' | 'oauth';
  fields: Array<{ name: string; secret: boolean; description?: string }>;
}

export interface ConnectionTestResultEvent extends BaseConnectionEvent {
  type: 'connection_test_result';
  slug: string;
  success: boolean;
  error?: string;
  modelCount?: number;
}

/** Generic invalidation signal — UI re-fetches connection list. */
export interface ConnectionListChangedEvent extends BaseConnectionEvent {
  type: 'connection_list_changed';
}

export type ConnectionCommand =
  | {
      type: 'credential_response';
      requestId: string;
      values: Record<string, string>;
    }
  | { type: 'oauth_start'; slug: string }
  | { type: 'test'; slug: string }
  | { type: 'save'; slug: string; config: LlmConnection }
  | { type: 'delete'; slug: string };
