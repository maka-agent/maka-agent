import { redactSecrets } from './redaction.js';

export const AGENT_MAILBOX_SCHEMA_VERSION = 1 as const;
export const AGENT_MAILBOX_CONTENT_MAX_CHARS = 2_000;
export const AGENT_MAILBOX_MAX_MESSAGES_PER_TEAM_RUN = 500;
export const AGENT_MAILBOX_LIST_MAX = 50;

export type AgentMailboxRole = 'lead' | 'member';
export type AgentMailboxMessageKind = 'message' | 'broadcast';

export interface AgentMailboxParticipantRef {
  role: AgentMailboxRole;
  agentId: string;
  runId: string;
  turnId: string;
}

export interface AgentMailboxMessage {
  schemaVersion: typeof AGENT_MAILBOX_SCHEMA_VERSION;
  id: string;
  sessionId: string;
  teamId: string;
  parentRunId: string;
  seq: number;
  kind: AgentMailboxMessageKind;
  from: AgentMailboxParticipantRef;
  /** Stable role address within one parent lead run; it does not identify a child invocation. */
  to?: { role: AgentMailboxRole; agentId: string };
  content: string;
  createdAt: number;
}

export interface AgentMailboxSendInput {
  teamId: string;
  parentRunId: string;
  kind: AgentMailboxMessageKind;
  from: AgentMailboxParticipantRef;
  /** Stable role address within one parent lead run; it does not identify a child invocation. */
  to?: { role: AgentMailboxRole; agentId: string };
  content: unknown;
}

export interface AgentMailboxListOptions {
  teamId: string;
  parentRunId: string;
  /** Stable role address shared by repeated or concurrent invocations of that member. */
  recipientAgentId: string;
  /** Caller-owned role-mailbox cursor; the store does not persist a cursor per invocation. */
  afterSeq?: number;
  limit?: number;
}

export interface AgentMailboxStore {
  send(
    sessionId: string,
    input: AgentMailboxSendInput,
  ): Promise<{ message: AgentMailboxMessage; total: number }>;
  list(
    sessionId: string,
    options: AgentMailboxListOptions,
  ): Promise<{ messages: AgentMailboxMessage[]; nextSeq: number; total: number }>;
}

export type AgentMailboxNormalizeResult<T> =
  | { ok: true; value: T }
  | { ok: false; message: string };

export function isSafeAgentMailboxToken(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) &&
    redactSecrets(value) === value
  );
}

export function isAgentTeamId(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
  );
}

export function normalizeAgentMailboxContent(input: unknown): AgentMailboxNormalizeResult<string> {
  if (typeof input !== 'string')
    return { ok: false, message: 'Agent mailbox content must be a string' };
  const value = redactSecrets(input.normalize('NFC').replace(/\r\n?/g, '\n')).trim();
  if (value.length === 0) return { ok: false, message: 'Agent mailbox content cannot be empty' };
  if (Array.from(value).length > AGENT_MAILBOX_CONTENT_MAX_CHARS) {
    return {
      ok: false,
      message: `Agent mailbox content must be ${AGENT_MAILBOX_CONTENT_MAX_CHARS} characters or fewer`,
    };
  }
  return { ok: true, value };
}

export function isAgentMailboxParticipantRef(value: unknown): value is AgentMailboxParticipantRef {
  if (!isRecord(value)) return false;
  return (
    (value.role === 'lead' || value.role === 'member') &&
    isAgentMailboxAddress(value) &&
    isSafeAgentMailboxToken(value.runId) &&
    isSafeAgentMailboxToken(value.turnId)
  );
}

export function isAgentMailboxMessage(value: unknown): value is AgentMailboxMessage {
  if (!isRecord(value)) return false;
  if (
    value.schemaVersion !== AGENT_MAILBOX_SCHEMA_VERSION ||
    !isSafeAgentMailboxToken(value.id) ||
    !isSafeAgentMailboxToken(value.sessionId) ||
    !isAgentTeamId(value.teamId) ||
    !isSafeAgentMailboxToken(value.parentRunId) ||
    !Number.isSafeInteger(value.seq) ||
    (value.seq as number) < 1 ||
    (value.kind !== 'message' && value.kind !== 'broadcast') ||
    !isAgentMailboxParticipantRef(value.from) ||
    typeof value.createdAt !== 'number' ||
    !Number.isFinite(value.createdAt)
  )
    return false;
  if (value.from.role === 'lead' && value.from.runId !== value.parentRunId) return false;
  const content = normalizeAgentMailboxContent(value.content);
  if (!content.ok || content.value !== value.content) return false;
  if (value.kind === 'broadcast') return value.to === undefined;
  return (
    isRecord(value.to) && isAgentMailboxAddress(value.to) && value.to.agentId !== value.from.agentId
  );
}

function isAgentMailboxAddress(value: Record<string, unknown>): boolean {
  return (
    (value.role === 'lead' || value.role === 'member') &&
    isSafeAgentMailboxToken(value.agentId) &&
    (value.role === 'lead' ? value.agentId === 'lead' : value.agentId !== 'lead')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
