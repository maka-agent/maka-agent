import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import {
  AGENT_MAILBOX_CONTENT_MAX_CHARS,
  isAgentMailboxMessage,
  isSafeAgentMailboxToken,
  normalizeAgentMailboxContent,
} from '../agent-mailbox.js';

describe('agent mailbox contract', () => {
  test('normalizes bounded content and redacts secrets before persistence', () => {
    assert.deepEqual(normalizeAgentMailboxContent('  first\r\nsecond  '), {
      ok: true,
      value: 'first\nsecond',
    });
    const redacted = normalizeAgentMailboxContent('token ghp_abcdefghijklmnopqrstuvwxyz1234567890');
    assert.equal(redacted.ok, true);
    assert.match(redacted.ok ? redacted.value : '', /\[redacted\]/);
  });

  test('rejects empty and overlong mailbox content', () => {
    assert.equal(normalizeAgentMailboxContent('  ').ok, false);
    assert.equal(
      normalizeAgentMailboxContent('x'.repeat(AGENT_MAILBOX_CONTENT_MAX_CHARS + 1)).ok,
      false,
    );
  });

  test('uses redaction-stable bounded tokens for durable identities', () => {
    assert.equal(isSafeAgentMailboxToken('expert:code-review:correctness-reviewer'), true);
    assert.equal(isSafeAgentMailboxToken('bad id'), false);
    assert.equal(isSafeAgentMailboxToken('ghp_abcdefghijklmnopqrstuvwxyz1234567890'), false);
  });

  test('validates direct and broadcast persisted messages', () => {
    const base = {
      schemaVersion: 1,
      id: 'message-1',
      sessionId: 'session-1',
      teamId: 'code-review',
      parentRunId: 'parent-run',
      seq: 1,
      from: {
        role: 'member',
        agentId: 'expert:code-review:correctness-reviewer',
        runId: 'run-1',
        turnId: 'turn-1',
      },
      content: 'Found an invariant violation.',
      createdAt: 123,
    } as const;
    assert.equal(
      isAgentMailboxMessage({ ...base, kind: 'message', to: { role: 'lead', agentId: 'lead' } }),
      true,
    );
    assert.equal(isAgentMailboxMessage({ ...base, kind: 'broadcast' }), true);
    assert.equal(isAgentMailboxMessage({ ...base, kind: 'message' }), false);
    assert.equal(
      isAgentMailboxMessage({ ...base, kind: 'broadcast', to: { role: 'lead', agentId: 'lead' } }),
      false,
    );
    assert.equal(
      isAgentMailboxMessage({
        ...base,
        kind: 'message',
        to: { role: 'member', agentId: base.from.agentId },
      }),
      false,
    );
    assert.equal(
      isAgentMailboxMessage({ ...base, kind: 'message', to: { role: 'member', agentId: 'lead' } }),
      false,
    );
    assert.equal(
      isAgentMailboxMessage({
        ...base,
        kind: 'broadcast',
        from: { role: 'lead', agentId: 'lead', runId: 'another-parent-run', turnId: 'lead-turn' },
      }),
      false,
    );
  });
});
