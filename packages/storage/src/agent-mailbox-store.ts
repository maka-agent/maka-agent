import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  AGENT_MAILBOX_LIST_MAX,
  AGENT_MAILBOX_MAX_MESSAGES_PER_TEAM_RUN,
  AGENT_MAILBOX_SCHEMA_VERSION,
  isAgentMailboxMessage,
  isAgentMailboxParticipantRef,
  isAgentTeamId,
  isSafeAgentMailboxToken,
  normalizeAgentMailboxContent,
  type AgentMailboxListOptions,
  type AgentMailboxMessage,
  type AgentMailboxSendInput,
  type AgentMailboxStore,
} from '@maka/core/agent-mailbox';
import { assertSafeSessionId } from './session-store.js';
import { chainWrite } from './write-queue.js';

export interface AgentMailboxStoreDeps {
  newId?: () => string;
  now?: () => number;
}

export function createAgentMailboxStore(
  workspaceRoot: string,
  deps: AgentMailboxStoreDeps = {},
): AgentMailboxStore {
  return new FileAgentMailboxStore(workspaceRoot, deps);
}

class FileAgentMailboxStore implements AgentMailboxStore {
  private readonly sessionsRoot: string;
  private readonly writeQueues = new Map<string, Promise<void>>();
  private readonly newId: () => string;
  private readonly now: () => number;

  constructor(workspaceRoot: string, deps: AgentMailboxStoreDeps) {
    this.sessionsRoot = join(workspaceRoot, 'sessions');
    this.newId = deps.newId ?? randomUUID;
    this.now = deps.now ?? Date.now;
  }

  async send(
    sessionId: string,
    input: AgentMailboxSendInput,
  ): Promise<{ message: AgentMailboxMessage; total: number }> {
    assertSafeSessionId(sessionId);
    validateSendInput(input);
    const normalized = normalizeAgentMailboxContent(input.content);
    if (!normalized.ok) throw new Error(normalized.message);

    let message: AgentMailboxMessage | undefined;
    let total = 0;
    await chainWrite(this.writeQueues, sessionId, async () => {
      const messages = await this.readAll(sessionId);
      const scope = messages.filter(
        (candidate) =>
          candidate.teamId === input.teamId && candidate.parentRunId === input.parentRunId,
      );
      if (scope.length >= AGENT_MAILBOX_MAX_MESSAGES_PER_TEAM_RUN) {
        throw new Error(
          `Agent mailbox is limited to ${AGENT_MAILBOX_MAX_MESSAGES_PER_TEAM_RUN} messages per team run`,
        );
      }
      const seq = scope.reduce((max, candidate) => Math.max(max, candidate.seq), 0) + 1;
      const id = this.newId();
      if (messages.some((candidate) => candidate.id === id)) {
        throw new Error('Generated agent mailbox message id already exists');
      }
      message = {
        schemaVersion: AGENT_MAILBOX_SCHEMA_VERSION,
        id,
        sessionId,
        teamId: input.teamId,
        parentRunId: input.parentRunId,
        seq,
        kind: input.kind,
        from: input.from,
        ...(input.to ? { to: input.to } : {}),
        content: normalized.value,
        createdAt: this.now(),
      };
      if (!isAgentMailboxMessage(message))
        throw new Error('Generated agent mailbox message is invalid');
      const path = this.filePath(sessionId);
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, `${JSON.stringify(message)}\n`, 'utf8');
      total = scope.length + 1;
    });
    if (!message) throw new Error('Agent mailbox write did not produce a message');
    return { message, total };
  }

  async list(
    sessionId: string,
    options: AgentMailboxListOptions,
  ): Promise<{ messages: AgentMailboxMessage[]; nextSeq: number; total: number }> {
    assertSafeSessionId(sessionId);
    validateListOptions(options);
    const afterSeq = options.afterSeq ?? 0;
    const limit = options.limit ?? AGENT_MAILBOX_LIST_MAX;
    const addressed = (await this.readAll(sessionId)).filter(
      (message) =>
        message.teamId === options.teamId &&
        message.parentRunId === options.parentRunId &&
        ((message.kind === 'message' && message.to?.agentId === options.recipientAgentId) ||
          (message.kind === 'broadcast' && message.from.agentId !== options.recipientAgentId)),
    );
    const messages = addressed.filter((message) => message.seq > afterSeq).slice(0, limit);
    return {
      messages,
      nextSeq: messages.at(-1)?.seq ?? afterSeq,
      total: addressed.length,
    };
  }

  private filePath(sessionId: string): string {
    return join(this.sessionsRoot, sessionId, 'agent-mailbox.jsonl');
  }

  private async readAll(sessionId: string): Promise<AgentMailboxMessage[]> {
    let text: string;
    try {
      text = await readFile(this.filePath(sessionId), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const messages: AgentMailboxMessage[] = [];
    const seenMessageIds = new Set<string>();
    const lastSeqByScope = new Map<string, number>();
    for (const [index, line] of text.split(/\n/).entries()) {
      if (line.trim().length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid agent mailbox JSONL line ${index + 1}: ${String(error)}`);
      }
      if (!isAgentMailboxMessage(parsed) || parsed.sessionId !== sessionId) {
        throw new Error(`Invalid agent mailbox JSONL line ${index + 1}: unexpected message shape`);
      }
      if (seenMessageIds.has(parsed.id)) {
        throw new Error(`Invalid agent mailbox JSONL line ${index + 1}: duplicate message id`);
      }
      seenMessageIds.add(parsed.id);
      const scope = `${parsed.teamId}\u0000${parsed.parentRunId}`;
      const prior = lastSeqByScope.get(scope) ?? 0;
      if (parsed.seq <= prior) {
        throw new Error(`Invalid agent mailbox JSONL line ${index + 1}: non-monotonic sequence`);
      }
      lastSeqByScope.set(scope, parsed.seq);
      messages.push(parsed);
    }
    return messages;
  }
}

function validateSendInput(input: AgentMailboxSendInput): void {
  if (!isAgentTeamId(input.teamId)) throw new Error('Invalid agent team id');
  if (!isSafeAgentMailboxToken(input.parentRunId)) throw new Error('Invalid parent AgentRun id');
  if (!isAgentMailboxParticipantRef(input.from)) throw new Error('Invalid agent mailbox sender');
  if (input.from.role === 'lead' && input.from.runId !== input.parentRunId) {
    throw new Error('Lead mailbox messages must be scoped to the lead AgentRun');
  }
  if (input.kind === 'broadcast') {
    if (input.to !== undefined)
      throw new Error('Broadcast messages cannot have a direct recipient');
    return;
  }
  if (
    input.kind !== 'message' ||
    !input.to ||
    (input.to.role !== 'lead' && input.to.role !== 'member') ||
    !isSafeAgentMailboxToken(input.to.agentId)
  )
    throw new Error('Direct agent mailbox messages require a valid recipient');
  if (input.to.agentId === input.from.agentId)
    throw new Error('Agent mailbox messages cannot target the sender');
}

function validateListOptions(options: AgentMailboxListOptions): void {
  if (!isAgentTeamId(options.teamId)) throw new Error('Invalid agent team id');
  if (!isSafeAgentMailboxToken(options.parentRunId)) throw new Error('Invalid parent AgentRun id');
  if (!isSafeAgentMailboxToken(options.recipientAgentId))
    throw new Error('Invalid recipient agent id');
  if (
    options.afterSeq !== undefined &&
    (!Number.isSafeInteger(options.afterSeq) || options.afterSeq < 0)
  ) {
    throw new Error('afterSeq must be a non-negative safe integer');
  }
  if (
    options.limit !== undefined &&
    (!Number.isSafeInteger(options.limit) ||
      options.limit < 1 ||
      options.limit > AGENT_MAILBOX_LIST_MAX)
  ) {
    throw new Error(`Agent mailbox list limit must be between 1 and ${AGENT_MAILBOX_LIST_MAX}`);
  }
}
