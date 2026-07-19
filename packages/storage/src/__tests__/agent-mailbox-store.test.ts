import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentMailboxStore } from '../agent-mailbox-store.js';

const SESSION_ID = 'session-1';
const TEAM_ID = 'code-review';
const PARENT_RUN_ID = 'parent-run';

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'maka-agent-mailbox-'));
}

function member(agentId: string, runId: string, turnId: string) {
  return { role: 'member' as const, agentId, runId, turnId };
}

describe('AgentMailboxStore', () => {
  test('persists direct and broadcast messages with a monotonic scope cursor', async () => {
    const root = await tempRoot();
    let id = 0;
    const store = createAgentMailboxStore(root, {
      newId: () => `message-${++id}`,
      now: () => 100 + id,
    });
    const correctness = member('expert:code-review:correctness-reviewer', 'run-a', 'turn-a');
    const tests = member('expert:code-review:test-coverage-reviewer', 'run-b', 'turn-b');

    const first = await store.send(SESSION_ID, {
      teamId: TEAM_ID,
      parentRunId: PARENT_RUN_ID,
      kind: 'message',
      from: correctness,
      to: { role: 'member', agentId: tests.agentId },
      content: 'Please verify the race.',
    });
    const second = await store.send(SESSION_ID, {
      teamId: TEAM_ID,
      parentRunId: PARENT_RUN_ID,
      kind: 'broadcast',
      from: correctness,
      content: 'The ownership invariant is in task-ledger-store.ts.',
    });
    assert.equal(first.message.seq, 1);
    assert.equal(second.message.seq, 2);
    assert.equal(second.total, 2);

    const inbox = await createAgentMailboxStore(root).list(SESSION_ID, {
      teamId: TEAM_ID,
      parentRunId: PARENT_RUN_ID,
      recipientAgentId: tests.agentId,
    });
    assert.deepEqual(
      inbox.messages.map((message) => message.seq),
      [1, 2],
    );
    assert.equal(inbox.nextSeq, 2);
    assert.equal(inbox.total, 2);
  });

  test('isolates team runs and supports bounded cursor reads', async () => {
    const root = await tempRoot();
    let id = 0;
    const store = createAgentMailboxStore(root, { newId: () => `m-${++id}`, now: () => id });
    const sender = member('expert:code-review:correctness-reviewer', 'run-a', 'turn-a');
    const recipient = 'expert:code-review:test-coverage-reviewer';
    for (const content of ['one', 'two', 'three']) {
      await store.send(SESSION_ID, {
        teamId: TEAM_ID,
        parentRunId: PARENT_RUN_ID,
        kind: 'message',
        from: sender,
        to: { role: 'member', agentId: recipient },
        content,
      });
    }
    await store.send(SESSION_ID, {
      teamId: TEAM_ID,
      parentRunId: 'another-parent-run',
      kind: 'message',
      from: sender,
      to: { role: 'member', agentId: recipient },
      content: 'other run',
    });
    const page = await store.list(SESSION_ID, {
      teamId: TEAM_ID,
      parentRunId: PARENT_RUN_ID,
      recipientAgentId: recipient,
      afterSeq: 1,
      limit: 1,
    });
    assert.deepEqual(
      page.messages.map((message) => message.content),
      ['two'],
    );
    assert.equal(page.nextSeq, 2);
    assert.equal(page.total, 3);
  });

  test('shares direct-message history by role while each invocation owns its cursor', async () => {
    const root = await tempRoot();
    let id = 0;
    const store = createAgentMailboxStore(root, { newId: () => `m-${++id}`, now: () => id });
    const sender = member('expert:code-review:correctness-reviewer', 'sender-run', 'sender-turn');
    const recipientAgentId = 'expert:code-review:test-coverage-reviewer';
    const options = {
      teamId: TEAM_ID,
      parentRunId: PARENT_RUN_ID,
      recipientAgentId,
    };

    await store.send(SESSION_ID, {
      teamId: TEAM_ID,
      parentRunId: PARENT_RUN_ID,
      kind: 'message',
      from: sender,
      to: { role: 'member', agentId: recipientAgentId },
      content: 'first role message',
    });
    const [firstInvocation, concurrentInvocation] = await Promise.all([
      store.list(SESSION_ID, options),
      store.list(SESSION_ID, options),
    ]);
    assert.deepEqual(
      firstInvocation.messages.map((message) => message.content),
      ['first role message'],
    );
    assert.deepEqual(
      concurrentInvocation.messages.map((message) => message.content),
      ['first role message'],
    );

    await store.send(SESSION_ID, {
      teamId: TEAM_ID,
      parentRunId: PARENT_RUN_ID,
      kind: 'message',
      from: sender,
      to: { role: 'member', agentId: recipientAgentId },
      content: 'second role message',
    });
    const resumedInvocation = await store.list(SESSION_ID, {
      ...options,
      afterSeq: firstInvocation.nextSeq,
    });
    const freshInvocation = await store.list(SESSION_ID, options);
    assert.deepEqual(
      resumedInvocation.messages.map((message) => message.content),
      ['second role message'],
    );
    assert.deepEqual(
      freshInvocation.messages.map((message) => message.content),
      ['first role message', 'second role message'],
    );
  });

  test('serializes concurrent sends without duplicate sequence numbers', async () => {
    const root = await tempRoot();
    let id = 0;
    const store = createAgentMailboxStore(root, { newId: () => `m-${++id}`, now: () => id });
    const sender = member('expert:code-review:correctness-reviewer', 'run-a', 'turn-a');
    const recipient = 'expert:code-review:test-coverage-reviewer';
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.send(SESSION_ID, {
          teamId: TEAM_ID,
          parentRunId: PARENT_RUN_ID,
          kind: 'message',
          from: sender,
          to: { role: 'member', agentId: recipient },
          content: `message ${index}`,
        }),
      ),
    );
    const inbox = await store.list(SESSION_ID, {
      teamId: TEAM_ID,
      parentRunId: PARENT_RUN_ID,
      recipientAgentId: recipient,
      limit: 50,
    });
    assert.deepEqual(
      inbox.messages.map((message) => message.seq),
      Array.from({ length: 20 }, (_, index) => index + 1),
    );
  });

  test('fails closed over corrupt durable data instead of appending a new history', async () => {
    const root = await tempRoot();
    const directory = join(root, 'sessions', SESSION_ID);
    await mkdir(directory, { recursive: true });
    const path = join(directory, 'agent-mailbox.jsonl');
    await writeFile(path, '{not-json}\n', 'utf8');
    const before = await readFile(path, 'utf8');
    const store = createAgentMailboxStore(root);
    await assert.rejects(
      () =>
        store.send(SESSION_ID, {
          teamId: TEAM_ID,
          parentRunId: PARENT_RUN_ID,
          kind: 'broadcast',
          from: member('expert:code-review:correctness-reviewer', 'run-a', 'turn-a'),
          content: 'new',
        }),
      /Invalid agent mailbox JSONL/,
    );
    assert.equal(await readFile(path, 'utf8'), before);
  });

  test('rejects replay histories with duplicate message identities', async () => {
    const root = await tempRoot();
    let id = 0;
    const store = createAgentMailboxStore(root, { newId: () => `message-${++id}`, now: () => id });
    const sender = member('expert:code-review:correctness-reviewer', 'run-a', 'turn-a');
    const recipient = 'expert:code-review:test-coverage-reviewer';
    const { message } = await store.send(SESSION_ID, {
      teamId: TEAM_ID,
      parentRunId: PARENT_RUN_ID,
      kind: 'message',
      from: sender,
      to: { role: 'member', agentId: recipient },
      content: 'first',
    });
    const path = join(root, 'sessions', SESSION_ID, 'agent-mailbox.jsonl');
    await writeFile(
      path,
      `${JSON.stringify(message)}\n${JSON.stringify({ ...message, seq: 2, content: 'duplicate' })}\n`,
      'utf8',
    );
    await assert.rejects(
      () =>
        createAgentMailboxStore(root).list(SESSION_ID, {
          teamId: TEAM_ID,
          parentRunId: PARENT_RUN_ID,
          recipientAgentId: recipient,
        }),
      /duplicate message id/,
    );
  });
});
