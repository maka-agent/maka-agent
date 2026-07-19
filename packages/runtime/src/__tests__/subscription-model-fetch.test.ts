import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { LlmConnection } from '@maka/core';
import { buildSubscriptionModelFetch } from '../subscription-model-fetch.js';

describe('subscription model fetch', () => {
  test('cloaks Claude subscription requests by default', async () => {
    let observedHeaders = new Headers();
    let observedBody = '';
    const modelFetch = buildSubscriptionModelFetch({
      connection: claudeSubscriptionConnection(),
      sessionId: 'session-123',
      modelId: 'claude-sonnet-4-5',
      fetchFn: async (_url, init) => {
        observedHeaders = new Headers(init?.headers);
        observedBody = String(init?.body ?? '');
        return Response.json({ ok: true });
      },
      claude: {
        deviceId: 'device-123',
        accountUuid: 'account-123',
      },
    });

    assert.ok(modelFetch);
    await modelFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { authorization: 'Bearer token', 'x-api-key': '' },
      body: JSON.stringify({
        stream: false,
        system: 'Use the Maka system prompt.',
        messages: [{ role: 'user', content: 'hello from Maka' }],
      }),
    });

    const body = JSON.parse(observedBody);
    assert.equal(observedHeaders.get('user-agent'), 'claude-cli/2.1.153 (external, cli)');
    assert.equal(observedHeaders.get('x-api-key'), null);
    assert.equal(observedHeaders.get('X-Claude-Code-Session-Id'), 'session-123');
    assert.equal(
      body.metadata.user_id,
      JSON.stringify({
        device_id: 'device-123',
        account_uuid: 'account-123',
        session_id: 'session-123',
      }),
    );
    assert.equal(body.system[0].text.startsWith('x-anthropic-billing-header:'), true);
    assert.equal(body.system[1].text, "You are Claude Code, Anthropic's official CLI for Claude.");
    assert.equal(body.system[2].text, 'Use the Maka system prompt.');
  });

  test('leaves Claude subscription requests untouched when the cloak opt-out is disabled', async () => {
    const modelFetch = buildSubscriptionModelFetch({
      connection: claudeSubscriptionConnection(),
      sessionId: 'session-123',
      modelId: 'claude-sonnet-4-5',
      claude: {
        cloakEnabled: false,
        deviceId: 'device-123',
        accountUuid: 'account-123',
      },
    });

    assert.equal(modelFetch, undefined);
  });

  test('rejects Claude subscription cloaking without complete metadata', () => {
    assert.throws(
      () =>
        buildSubscriptionModelFetch({
          connection: claudeSubscriptionConnection(),
          sessionId: 'session-123',
          modelId: 'claude-sonnet-4-5',
        }),
      /Claude subscription cloaking requires deviceId and accountUuid metadata/,
    );
    assert.throws(
      () =>
        buildSubscriptionModelFetch({
          connection: claudeSubscriptionConnection(),
          sessionId: 'session-123',
          modelId: 'claude-sonnet-4-5',
          claude: {
            deviceId: 'device-123',
            accountUuid: '',
          },
        }),
      /Claude subscription cloaking requires deviceId and accountUuid metadata/,
    );
  });

  test('maps Codex OAuth requests into the ChatGPT backend request shape', async () => {
    let observedHeaders = new Headers();
    let observedBody = '';
    const modelFetch = buildSubscriptionModelFetch({
      connection: openAiCodexConnection(),
      sessionId: 'session-123',
      modelId: 'gpt-5.5',
      fetchFn: async (_url, init) => {
        observedHeaders = new Headers(init?.headers);
        observedBody = String(init?.body ?? '');
        return Response.json({ ok: true });
      },
    });

    assert.ok(modelFetch);
    await modelFetch('https://chatgpt.com/backend-api/codex/responses', {
      method: 'POST',
      headers: { authorization: 'Bearer token' },
      body: JSON.stringify({
        system: 'Use the Maka system prompt.',
        input: [{ role: 'user', content: 'hi' }],
      }),
    });

    const body = JSON.parse(observedBody);
    assert.equal(observedHeaders.get('originator'), 'codex_cli_rs');
    assert.equal(observedHeaders.get('session_id'), 'session-123');
    assert.equal(observedHeaders.get('x-client-request-id'), 'session-123');
    assert.equal(body.instructions, 'Use the Maka system prompt.');
    assert.equal(body.store, false);
    assert.equal(body.parallel_tool_calls, true);
    assert.equal(body.text.verbosity, 'medium');
  });

  test('adds the Copilot compatibility headers and derives the turn initiator without rewriting the body', async () => {
    const observed: Array<{ headers: Headers; body: string }> = [];
    const modelFetch = buildSubscriptionModelFetch({
      connection: githubCopilotConnection(),
      sessionId: 'session-123',
      modelId: 'gpt-5.4',
      fetchFn: async (_url, init) => {
        observed.push({ headers: new Headers(init?.headers), body: String(init?.body ?? '') });
        return Response.json({ ok: true });
      },
    });

    assert.ok(modelFetch);
    const userBody = JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] });
    await modelFetch('https://api.githubcopilot.com/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer short-lived-token' },
      body: userBody,
    });
    const toolBody = JSON.stringify({
      messages: [
        { role: 'assistant', tool_calls: [{ id: 'call-1' }] },
        { role: 'tool', tool_call_id: 'call-1', content: 'done' },
      ],
    });
    await modelFetch('https://api.githubcopilot.com/chat/completions', {
      method: 'POST',
      body: toolBody,
    });
    const responsesBody = JSON.stringify({
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'look' }, { type: 'input_image' }] },
      ],
    });
    await modelFetch('https://api.githubcopilot.com/responses', {
      method: 'POST',
      body: responsesBody,
    });

    assert.equal(observed[0]?.headers.get('user-agent'), 'GitHubCopilotChat/0.35.0');
    assert.equal(observed[0]?.headers.get('editor-version'), 'vscode/1.107.0');
    assert.equal(observed[0]?.headers.get('editor-plugin-version'), 'copilot-chat/0.35.0');
    assert.equal(observed[0]?.headers.get('copilot-integration-id'), 'vscode-chat');
    assert.equal(observed[0]?.headers.get('openai-intent'), 'conversation-edits');
    assert.equal(observed[0]?.headers.get('x-initiator'), 'user');
    assert.equal(observed[0]?.body, userBody);
    assert.equal(observed[1]?.headers.get('x-initiator'), 'agent');
    assert.equal(observed[1]?.body, toolBody);
    assert.equal(observed[2]?.headers.get('x-initiator'), 'user');
    assert.equal(observed[2]?.headers.get('copilot-vision-request'), 'true');
    assert.equal(observed[2]?.body, responsesBody);
  });
});

function claudeSubscriptionConnection(): LlmConnection {
  return {
    slug: 'claude-subscription',
    name: 'Claude OAuth',
    providerType: 'claude-subscription',
    defaultModel: 'claude-sonnet-4-5',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

function openAiCodexConnection(): LlmConnection {
  return {
    slug: 'openai-codex',
    name: 'OpenAI OAuth',
    providerType: 'openai-codex',
    defaultModel: 'gpt-5.5',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

function githubCopilotConnection(): LlmConnection {
  return {
    slug: 'github-copilot',
    name: 'GitHub Copilot',
    providerType: 'github-copilot',
    baseUrl: 'https://api.githubcopilot.com',
    defaultModel: 'gpt-5.4',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}
