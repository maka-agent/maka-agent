import { createHash } from 'node:crypto';
import type { RuntimeEvent } from '@maka/core';
import { stableHash } from './request-shape.js';

export type ToolRecoveryMode =
  | 'replay_safe'
  | 'idempotent'
  | 'reconcile'
  | 'reattach'
  | 'never_auto_retry';

export interface ToolPreparedCommit {
  operationId: string;
  journalEventId: string;
  runtimeEvent: RuntimeEvent;
  providerToolCallId: string;
  toolName: string;
  canonicalArgsHash: string;
  recoveryMode: ToolRecoveryMode;
  committedAt: number;
}

export interface ToolOutcomeCommit {
  operationId: string;
  journalEventId: string;
  runtimeEvent: RuntimeEvent;
  committedAt: number;
}

export interface RuntimeCommitResult {
  created: boolean;
  runtimeEventSeq: number;
}

export interface RuntimeCommitSink {
  commitToolPrepared(input: ToolPreparedCommit): Promise<RuntimeCommitResult>;
  commitToolOutcome(input: ToolOutcomeCommit): Promise<RuntimeCommitResult>;
}

export interface ToolOperationIdInput {
  invocationId: string;
  providerToolCallId: string;
}

export function buildToolOperationId(input: ToolOperationIdInput): string {
  if (!input.invocationId || !input.providerToolCallId) {
    throw new Error('Tool operation identity requires invocationId and providerToolCallId');
  }
  const digest = createHash('sha256')
    .update(input.invocationId)
    .update('\0')
    .update(input.providerToolCallId)
    .digest('hex')
    .slice(0, 32);
  return `toolop_${digest}`;
}

export function canonicalToolArgsHash(toolName: string, normalizedArgs: unknown): string {
  if (!toolName) throw new Error('Tool argument identity requires a tool name');
  return stableHash({ toolName, args: normalizedArgs });
}

export async function executeDurableToolBoundary<T>(input: {
  sink: RuntimeCommitSink;
  prepared: ToolPreparedCommit;
  execute: () => Promise<T>;
  buildOutcome: (result: T) => ToolOutcomeCommit;
}): Promise<T> {
  await input.sink.commitToolPrepared(input.prepared);
  const result = await input.execute();
  await input.sink.commitToolOutcome(input.buildOutcome(result));
  return result;
}
