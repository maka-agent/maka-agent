import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { LlmConnection, SessionHeader } from '@maka/core';
import type { SessionEvent } from '@maka/core/events';
import type { ToolResultMessage } from '@maka/core/session';
import {
  AiSdkBackend,
  INVALID_TOOL_NAME,
  TOOL_ERROR_RESULT_MAX_CHARS,
  formatSyntheticToolErrorText,
  repairMakaToolCall,
} from '../ai-sdk-backend.js';
import { PermissionEngine } from '../permission-engine.js';

describe('AiSdkBackend error surfaces', () => {
  test('generalizes model setup errors before emitting renderer events', async () => {
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-live-secret-token-value',
      modelId: 'claude-sonnet-4-5-20250929',
      permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
      modelFactory: () => {
        throw new Error('401 Authorization: Bearer sk-live-secret-token-value');
      },
      tools: [],
      newId: idGenerator(),
      now: () => 1,
    });

    const events: SessionEvent[] = [];
    for await (const event of backend.send({ turnId: 'turn-1', text: 'hi', context: [] })) {
      events.push(event);
    }

    const error = events.find((event): event is Extract<SessionEvent, { type: 'error' }> => event.type === 'error');
    assert.equal(error?.message, 'Authentication failed');
    assert.equal(JSON.stringify(events).includes('sk-live-secret-token-value'), false);
  });

  test('redacts and caps synthetic tool error text before storage and model return', () => {
    const raw = `provider exploded: Authorization: Bearer sk-live-secret-token-value ${'x'.repeat(5000)}`;
    const text = formatSyntheticToolErrorText(new Error(raw));

    assert.equal(text.includes('sk-live-secret-token-value'), false);
    assert.ok(text.includes('[redacted]'));
    assert.equal(text.length, TOOL_ERROR_RESULT_MAX_CHARS);
    assert.equal(text.endsWith('…'), true);
  });

  test('writeSyntheticToolResult never persists raw secret-shaped errors', async () => {
    const messages: ToolResultMessage[] = [];
    const events: SessionEvent[] = [];
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async (message) => {
        if (message.type === 'tool_result') messages.push(message);
      },
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'claude-sonnet-4-5-20250929',
      permissionEngine: new PermissionEngine({ newId: () => 'permission-id', now: () => 1 }),
      modelFactory: () => ({}),
      tools: [],
      newId: idGenerator(),
      now: () => 1,
    });

    await (backend as unknown as {
      writeSyntheticToolResult(
        toolUseId: string,
        turnId: string,
        text: string,
        queue: { push(event: SessionEvent): void },
      ): Promise<void>;
    }).writeSyntheticToolResult(
      'tool-1',
      'turn-1',
      'failed with api_key=sk-live-secret-token-value',
      { push: (event) => events.push(event) },
    );

    assert.equal(JSON.stringify(messages).includes('sk-live-secret-token-value'), false);
    assert.equal(JSON.stringify(events).includes('sk-live-secret-token-value'), false);
    assert.deepEqual(messages[0]?.content, events.find((event) => event.type === 'tool_result')?.content);
  });
});

describe('AiSdkBackend stop', () => {
  test('rejects parked permission requests for the active turn', async () => {
    const permissionEngine = new PermissionEngine({ newId: () => 'permission-id', now: () => 1 });
    permissionEngine.beginTurn('turn-1');
    const verdict = permissionEngine.evaluate({
      sessionId: 'session-1',
      turnId: 'turn-1',
      toolUseId: 'tool-1',
      toolName: 'Write',
      args: { path: 'notes.md', content: 'hello' },
      mode: 'ask',
    });
    assert.equal(verdict.kind, 'prompt');
    assert.equal(permissionEngine.pendingCount('turn-1'), 1);
    const parked = verdict.kind === 'prompt'
      ? verdict.parked.then(
          () => 'resolved',
          (error: Error) => error.message,
        )
      : Promise.resolve('not-prompt');
    const backend = new AiSdkBackend({
      sessionId: 'session-1',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'claude-sonnet-4-5-20250929',
      permissionEngine,
      modelFactory: () => ({}),
      tools: [],
      newId: idGenerator(),
      now: () => 1,
    });

    (backend as unknown as { currentTurnId: string }).currentTurnId = 'turn-1';
    await backend.stop('user_stop');

    assert.match(await parked, /Turn turn-1 aborted before permission request permission-id was answered/);
    assert.equal(permissionEngine.pendingCount('turn-1'), 0);
  });
});

describe('AiSdkBackend tool-call repair', () => {
  test('repairs provider tool-name case drift to the canonical Maka tool name', () => {
    const repaired = repairMakaToolCall({
      toolCall: {
        toolCallId: 'tool-1',
        toolName: 'bash',
        input: '{"command":"pwd"}',
      },
      availableToolNames: ['Bash', 'Read'],
      error: new Error('No such tool'),
    });

    assert.equal(repaired?.toolName, 'Bash');
    assert.equal(repaired?.input, '{"command":"pwd"}');
  });

  test('routes unrepairable tool calls into the structured invalid tool', () => {
    const repaired = repairMakaToolCall({
      toolCall: {
        toolCallId: 'tool-1',
        toolName: 'DeleteEverything',
        input: '{"path":"/"}',
      },
      availableToolNames: ['Bash', 'Read'],
      error: new Error('No such tool: Authorization: Bearer sk-live-secret-token-value'),
    });

    assert.equal(repaired?.toolName, INVALID_TOOL_NAME);
    const input = JSON.parse(repaired?.input ?? '{}') as { tool?: string; error?: string };
    assert.equal(input.tool, 'DeleteEverything');
    assert.match(input.error ?? '', /No such tool/);
    assert.equal((input.error ?? '').includes('sk-live-secret-token-value'), false);
  });

  test('does not recursively repair the internal invalid tool', () => {
    const repaired = repairMakaToolCall({
      toolCall: {
        toolCallId: 'tool-1',
        toolName: INVALID_TOOL_NAME,
        input: '{}',
      },
      availableToolNames: ['Bash', 'Read'],
      error: new Error('Invalid tool failed'),
    });

    assert.equal(repaired, null);
  });
});

function header(): SessionHeader {
  return {
    id: 'session-1',
    workspaceRoot: '/tmp/maka',
    cwd: '/tmp/maka',
    createdAt: 1,
    lastUsedAt: 1,
    name: 'Test',
    isFlagged: false,
    labels: [],
    isArchived: false,
    status: 'active',
    statusUpdatedAt: 1,
    hasUnread: false,
    backend: 'ai-sdk',
    llmConnectionSlug: 'anthropic-main',
    connectionLocked: true,
    model: 'claude-sonnet-4-5-20250929',
    permissionMode: 'ask',
    schemaVersion: 1,
  };
}

function connection(): LlmConnection {
  return {
    slug: 'anthropic-main',
    name: 'Anthropic',
    providerType: 'anthropic',
    defaultModel: 'claude-sonnet-4-5-20250929',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

function idGenerator(): () => string {
  let index = 0;
  return () => `id-${++index}`;
}
