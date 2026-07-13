import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ModelMessage } from 'ai';

import {
  estimateProviderMessagesTokens,
  projectProviderReplayMessages,
  validateProviderMessageShape,
} from '../provider-replay-projection.js';

describe('provider replay projection', () => {
  test('fails with typed diagnostics when provider-native replay shape is invalid', () => {
    const messages = [
      { role: 'user', content: 'Run the check.' },
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'Bash', input: { command: 'make test' } }],
      },
    ] as ModelMessage[];

    const result = projectProviderReplayMessages(messages, {
      maxEstimatedTokens: 10_000,
      minRecentTurns: 0,
      charsPerToken: 1,
    });

    assert.equal(result.ok, false);
    if (result.ok) assert.fail('expected invalid replay projection');
    assert.equal(result.failure.kind, 'maka.provider_replay_projection_failure');
    assert.equal(result.failure.reason, 'provider_shape_invalid');
    assert.equal(result.failure.shapeReasons.includes('tool_result_missing'), true);
    assert.deepEqual(result.messages, messages);
  });

  test('trims oversized fallback history by complete newest turns', () => {
    const oldest = textTurn('oldest', 'A'.repeat(300));
    const middle = textTurn('middle', 'B'.repeat(300));
    const newest = textTurn('newest', 'C'.repeat(80));
    const messages = [...oldest, ...middle, ...newest];
    const newestTokens = estimateProviderMessagesTokens(newest, 1);

    const result = projectProviderReplayMessages(messages, {
      maxEstimatedTokens: newestTokens,
      minRecentTurns: 1,
      charsPerToken: 1,
    });

    if (!result.ok) assert.fail(result.failure.reason);
    assert.equal(result.ok, true);
    assert.deepEqual(result.messages, newest);
    assert.equal(result.trimmed, true);
    assert.equal(result.droppedTurns, 2);
    assert.equal(result.droppedMessages, oldest.length + middle.length);
    assert.ok(result.estimatedTokensAfter <= newestTokens);
  });

  test('returns a typed failure when the protected recent turn cannot fit the hard budget', () => {
    const messages = textTurn('current prior turn', 'X'.repeat(200));
    const requiredTokens = estimateProviderMessagesTokens(messages, 1);

    const result = projectProviderReplayMessages(messages, {
      maxEstimatedTokens: requiredTokens - 1,
      minRecentTurns: 1,
      charsPerToken: 1,
    });

    assert.equal(result.ok, false);
    if (result.ok) assert.fail('expected impossible budget');
    assert.equal(result.failure.reason, 'hard_budget_impossible');
    assert.equal(result.failure.requiredEstimatedTokens, requiredTokens);
    assert.equal(result.failure.maxEstimatedTokens, requiredTokens - 1);
    assert.deepEqual(result.messages, messages);
  });

  test('keeps parallel tool results and signed reasoning in one valid replay turn', () => {
    const old = textTurn('old', 'Z'.repeat(500));
    const current = multiToolTurn();
    const currentTokens = estimateProviderMessagesTokens(current, 1);

    const result = projectProviderReplayMessages([...old, ...current], {
      maxEstimatedTokens: currentTokens,
      minRecentTurns: 1,
      charsPerToken: 1,
    });

    if (!result.ok) assert.fail(result.failure.reason);
    assert.equal(result.ok, true);
    assert.deepEqual(result.messages, current);
    assert.deepEqual(validateProviderMessageShape(result.messages), {
      valid: true,
      reasons: [],
      reasonCounts: {},
    });
  });

  test('reapplying the fallback cap is idempotent', () => {
    const newest = textTurn('newest', 'N'.repeat(80));
    const maxEstimatedTokens = estimateProviderMessagesTokens(newest, 1);
    const first = projectProviderReplayMessages([
      ...textTurn('old', 'O'.repeat(500)),
      ...newest,
    ], {
      maxEstimatedTokens,
      minRecentTurns: 1,
      charsPerToken: 1,
    });
    if (!first.ok) assert.fail(first.failure.reason);
    assert.equal(first.ok, true);

    const second = projectProviderReplayMessages(first.messages, {
      maxEstimatedTokens,
      minRecentTurns: 1,
      charsPerToken: 1,
    });

    if (!second.ok) assert.fail(second.failure.reason);
    assert.equal(second.ok, true);
    assert.deepEqual(second.messages, first.messages);
    assert.equal(second.trimmed, false);
    assert.equal(second.droppedTurns, 0);
    assert.equal(second.estimatedTokensAfter, first.estimatedTokensAfter);
  });

  test('keeps an explicitly selected evidence turn ahead of an unprotected newer turn', () => {
    const selected = multiToolTurn();
    const newer = textTurn('newer', 'newer retained context');
    const messages = [...selected, ...newer];

    const result = projectProviderReplayMessages(messages, {
      maxTurns: 1,
      minRecentTurns: 0,
      charsPerToken: 1,
      messageTurnIds: [
        ...selected.map(() => 'turn-selected'),
        ...newer.map(() => 'turn-newer'),
      ],
      protectedTurnIds: ['turn-selected'],
    });

    if (!result.ok) assert.fail(result.failure.reason);
    assert.equal(result.ok, true);
    assert.deepEqual(result.messages, selected);
    assert.equal(result.droppedTurns, 1);
  });

  test('fails closed when provider messages and source turn identities are misaligned', () => {
    const messages = textTurn('user', 'assistant');
    const result = projectProviderReplayMessages(messages, {
      messageTurnIds: ['turn-only-one-id'],
      protectedTurnIds: ['turn-only-one-id'],
    });

    assert.equal(result.ok, false);
    if (result.ok) assert.fail('expected turn identity mismatch');
    assert.equal(result.failure.reason, 'turn_identity_mismatch');
    assert.deepEqual(result.messages, messages);
  });

  test('rejects content parts that are incompatible with the provider message role', () => {
    const messages = [{
      role: 'user',
      content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'Read', input: {} }],
    }] as unknown as ModelMessage[];

    const result = projectProviderReplayMessages(messages);
    assert.equal(result.ok, false);
    if (result.ok) assert.fail('expected invalid user tool-call content');
    assert.equal(result.failure.reason, 'provider_shape_invalid');
    assert.deepEqual(result.failure.shapeReasons, ['invalid_message_shape']);
  });

  test('rejects provider parts with missing required fields', () => {
    const invalidMessages = [
      [{ role: 'assistant', content: [{ type: 'text' }] }],
      [{ role: 'assistant', content: [{ type: 'reasoning' }] }],
      [{ role: 'assistant', content: [{ type: 'thinking', text: 'unsupported alias' }] }],
      [{ role: 'user', content: [{ type: 'image' }] }],
      [{ role: 'user', content: [{ type: 'file', data: 'x' }] }],
    ] as unknown as ModelMessage[][];

    for (const messages of invalidMessages) {
      const result = projectProviderReplayMessages(messages);
      assert.equal(result.ok, false, JSON.stringify(messages));
      if (!result.ok) assert.equal(result.failure.reason, 'provider_shape_invalid');
    }
  });
});

function textTurn(user: string, assistant: string): ModelMessage[] {
  return [
    { role: 'user', content: user },
    { role: 'assistant', content: assistant },
  ] as ModelMessage[];
}

function multiToolTurn(): ModelMessage[] {
  return [
    { role: 'user', content: 'Inspect both files.' },
    {
      role: 'assistant',
      content: [
        {
          type: 'reasoning',
          text: 'Read both files before answering.',
          providerOptions: { anthropic: { signature: 'signed-thinking' } },
        },
        { type: 'tool-call', toolCallId: 'call-a', toolName: 'Read', input: { path: 'a.txt' } },
        { type: 'tool-call', toolCallId: 'call-b', toolName: 'Read', input: { path: 'b.txt' } },
      ],
    },
    {
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: 'call-a', toolName: 'Read', output: { type: 'text', value: 'A' } }],
    },
    {
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: 'call-b', toolName: 'Read', output: { type: 'text', value: 'B' } }],
    },
    { role: 'assistant', content: 'Both files were read.' },
  ] as ModelMessage[];
}
