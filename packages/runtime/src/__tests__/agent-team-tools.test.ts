import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import type {
  AgentMailboxListOptions,
  AgentMailboxMessage,
  AgentMailboxSendInput,
  AgentMailboxStore,
  Task,
  TaskAgentOutcome,
  TaskLedgerListOptions,
  TaskLedgerMutationContext,
  TaskLedgerStore,
  TaskOwner,
} from '@maka/core';
import { buildAgentTeamChildTools, buildAgentTeamLeadTools } from '../agent-team-tools.js';
import {
  TEAM_INBOX_TOOL_NAME,
  TEAM_MESSAGE_TOOL_NAME,
  TEAM_TASK_CLAIM_TOOL_NAME,
  TEAM_TASK_LIST_TOOL_NAME,
} from '../agent-team-tool-names.js';
import type { MakaTool, MakaToolContext } from '../tool-runtime.js';

class MemoryMailbox implements AgentMailboxStore {
  sends: Array<{ sessionId: string; input: AgentMailboxSendInput }> = [];
  lists: Array<{ sessionId: string; options: AgentMailboxListOptions }> = [];

  async send(sessionId: string, input: AgentMailboxSendInput) {
    this.sends.push({ sessionId, input });
    const message = {
      schemaVersion: 1,
      id: 'message-1',
      sessionId,
      seq: 1,
      createdAt: 1,
      ...input,
      content: String(input.content),
    } as AgentMailboxMessage;
    return { message, total: this.sends.length };
  }

  async list(sessionId: string, options: AgentMailboxListOptions) {
    this.lists.push({ sessionId, options });
    return { messages: [], nextSeq: options.afterSeq ?? 0, total: 0 };
  }
}

class MemoryTaskLedger implements TaskLedgerStore {
  tasks: Task[] = [];
  claims: Array<{
    sessionId: string;
    id: string;
    owner: TaskOwner;
    scope: { parentRunId: string };
    context?: TaskLedgerMutationContext;
  }> = [];

  async list(_sessionId: string, options?: TaskLedgerListOptions): Promise<Task[]> {
    return this.tasks.filter(
      (task) =>
        options?.includeTerminal !== false ||
        !['completed', 'failed', 'cancelled'].includes(task.status),
    );
  }
  async get(_sessionId: string, id: string): Promise<Task | undefined> {
    return this.tasks.find((task) => task.id === id || task.key === id);
  }
  async create(): Promise<{ created: Task[]; total: number }> {
    return { created: [], total: this.tasks.length };
  }
  async update(): Promise<{ updated: Task; total: number }> {
    throw new Error('not used');
  }
  async claim(): Promise<{ updated: Task; total: number }> {
    throw new Error('not used');
  }
  async claimAvailable(
    sessionId: string,
    id: string,
    owner: TaskOwner,
    scope: { parentRunId: string },
    context?: TaskLedgerMutationContext,
  ) {
    const task = await this.get(sessionId, id);
    if (!task) throw new Error(`No such task: ${id}`);
    this.claims.push({ sessionId, id, owner, scope, context });
    task.status = 'in_progress';
    task.owner = owner;
    return { updated: task, total: this.tasks.length };
  }
  async settleAgentOutcome(
    _sessionId: string,
    _id: string,
    _outcome: TaskAgentOutcome,
  ): Promise<{ updated: Task; total: number }> {
    throw new Error('not used');
  }
  subscribe(): () => void {
    return () => {};
  }
}

function task(id: string, key: string, status: Task['status'], owner?: TaskOwner): Task {
  return { id, key, subject: `subject ${key}`, status, owner, createdAt: 1, updatedAt: 1 };
}

function memberContext(overrides: Partial<MakaToolContext> = {}): MakaToolContext {
  return {
    sessionId: 'session-1',
    runId: 'child-run',
    turnId: 'child-turn',
    cwd: '/tmp',
    toolCallId: 'tool-call',
    abortSignal: new AbortController().signal,
    emitOutput: () => {},
    agentTeam: {
      role: 'member',
      teamId: 'code-review',
      agentId: 'expert:code-review:correctness-reviewer',
      parentRunId: 'lead-run',
    },
    ...overrides,
  };
}

function leadContext(): MakaToolContext {
  return {
    ...memberContext(),
    runId: 'lead-run',
    turnId: 'lead-turn',
    agentTeam: { role: 'lead', teamId: 'code-review', agentId: 'lead' },
  };
}

function findTool(tools: MakaTool[], name: string): MakaTool {
  const found = tools.find((tool) => tool.name === name);
  assert.ok(found, `expected ${name}`);
  return found;
}

describe('agent team collaboration tools', () => {
  test('exposes the narrow lead and child surfaces', () => {
    const deps = { mailbox: new MemoryMailbox(), taskLedger: new MemoryTaskLedger() };
    assert.deepEqual(
      buildAgentTeamLeadTools(deps).map((tool) => tool.name),
      [TEAM_MESSAGE_TOOL_NAME, TEAM_INBOX_TOOL_NAME],
    );
    assert.deepEqual(
      buildAgentTeamChildTools(deps).map((tool) => tool.name),
      [
        TEAM_MESSAGE_TOOL_NAME,
        TEAM_INBOX_TOOL_NAME,
        TEAM_TASK_LIST_TOOL_NAME,
        TEAM_TASK_CLAIM_TOOL_NAME,
      ],
    );
  });

  test('derives sender and recipient identities from trusted team context', async () => {
    const mailbox = new MemoryMailbox();
    const tools = buildAgentTeamChildTools({ mailbox, taskLedger: new MemoryTaskLedger() });
    await findTool(tools, TEAM_MESSAGE_TOOL_NAME).impl(
      {
        type: 'message',
        recipient: 'test-coverage-reviewer',
        content: 'Please cover the ownership race.',
      },
      memberContext(),
    );
    assert.deepEqual(mailbox.sends[0], {
      sessionId: 'session-1',
      input: {
        teamId: 'code-review',
        parentRunId: 'lead-run',
        kind: 'message',
        from: {
          role: 'member',
          agentId: 'expert:code-review:correctness-reviewer',
          runId: 'child-run',
          turnId: 'child-turn',
        },
        to: { role: 'member', agentId: 'expert:code-review:test-coverage-reviewer' },
        content: 'Please cover the ownership race.',
      },
    });
  });

  test('scopes inbox reads to the owning lead run and current agent identity', async () => {
    const mailbox = new MemoryMailbox();
    const tools = buildAgentTeamChildTools({ mailbox, taskLedger: new MemoryTaskLedger() });
    await findTool(tools, TEAM_INBOX_TOOL_NAME).impl({ after_seq: 4, limit: 3 }, memberContext());
    assert.deepEqual(mailbox.lists[0]?.options, {
      teamId: 'code-review',
      parentRunId: 'lead-run',
      recipientAgentId: 'expert:code-review:correctness-reviewer',
      afterSeq: 4,
      limit: 3,
    });
  });

  test('uses one role mailbox with caller-owned cursors across repeated member invocations', async () => {
    const mailbox = new MemoryMailbox();
    const tools = buildAgentTeamChildTools({ mailbox, taskLedger: new MemoryTaskLedger() });
    const inbox = findTool(tools, TEAM_INBOX_TOOL_NAME);

    await inbox.impl(
      { after_seq: 7 },
      memberContext({
        runId: 'child-run-a',
        turnId: 'child-turn-a',
      }),
    );
    await inbox.impl(
      {},
      memberContext({
        runId: 'child-run-b',
        turnId: 'child-turn-b',
      }),
    );

    assert.deepEqual(
      mailbox.lists.map(({ options }) => options),
      [
        {
          teamId: 'code-review',
          parentRunId: 'lead-run',
          recipientAgentId: 'expert:code-review:correctness-reviewer',
          afterSeq: 7,
        },
        {
          teamId: 'code-review',
          parentRunId: 'lead-run',
          recipientAgentId: 'expert:code-review:correctness-reviewer',
        },
      ],
    );
  });

  test('lists only available shared tasks and claims with durable child refs', async () => {
    const taskLedger = new MemoryTaskLedger();
    taskLedger.tasks = [
      task('task-1', 'T1', 'pending', { actor: 'main_agent', runId: 'lead-run' }),
      task('task-2', 'T2', 'blocked', { actor: 'main_agent', runId: 'lead-run' }),
      task('task-3', 'T3', 'in_progress', { actor: 'main_agent', runId: 'lead-run' }),
      task('task-4', 'T4', 'blocked', {
        actor: 'child_agent',
        agentId: 'other',
        turnId: 'other-turn',
      }),
      task('task-5', 'T5', 'completed'),
      task('task-6', 'T6', 'pending', { actor: 'main_agent', runId: 'older-lead-run' }),
    ];
    const tools = buildAgentTeamChildTools({ mailbox: new MemoryMailbox(), taskLedger });
    const listed = (await findTool(tools, TEAM_TASK_LIST_TOOL_NAME).impl({}, memberContext())) as {
      tasks: Task[];
    };
    assert.deepEqual(
      listed.tasks.map((candidate) => candidate.key),
      ['T1', 'T2'],
    );

    await findTool(tools, TEAM_TASK_CLAIM_TOOL_NAME).impl({ task_id: 'T1' }, memberContext());
    assert.deepEqual(taskLedger.claims[0], {
      sessionId: 'session-1',
      id: 'T1',
      owner: {
        actor: 'child_agent',
        agentId: 'expert:code-review:correctness-reviewer',
        runId: 'child-run',
        turnId: 'child-turn',
      },
      scope: { parentRunId: 'lead-run' },
      context: {
        runId: 'child-run',
        turnId: 'child-turn',
        toolCallId: 'tool-call',
        source: 'tool',
        actor: 'child_agent',
        reason: 'self-claimed by expert team member expert:code-review:correctness-reviewer',
      },
    });
  });

  test('fails closed without trusted team/run identity and denies lead self-claim', async () => {
    const tools = buildAgentTeamChildTools({
      mailbox: new MemoryMailbox(),
      taskLedger: new MemoryTaskLedger(),
    });
    await assert.rejects(
      async () =>
        await findTool(tools, TEAM_MESSAGE_TOOL_NAME).impl(
          { type: 'broadcast', content: 'x' },
          memberContext({ agentTeam: undefined }),
        ),
      /unavailable outside an expert-team run/,
    );
    await assert.rejects(
      async () =>
        await findTool(tools, TEAM_TASK_CLAIM_TOOL_NAME).impl({ task_id: 'T1' }, leadContext()),
      /only to expert-team members/,
    );
  });
});
