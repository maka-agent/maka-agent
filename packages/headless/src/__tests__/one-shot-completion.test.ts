import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { LlmConnection } from '@maka/core';
import { runOneShotCompletion } from '../one-shot-completion.js';

describe('runOneShotCompletion provider registry path', () => {
  test('runs a SiliconFlow completion through the shared runtime adapter', async () => {
    let url = '';
    let body: Record<string, unknown> | undefined;
    const connection: LlmConnection = {
      slug: 'siliconflow',
      name: 'SiliconFlow',
      providerType: 'siliconflow',
      defaultModel: 'moonshotai/Kimi-K2.6',
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    };

    const text = await runOneShotCompletion({
      connection,
      apiKey: 'sf-test-key',
      modelId: 'moonshotai/Kimi-K2.6',
      prompt: 'Reply OK.',
      fetch: async (input, init) => {
        url = String(input);
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({
          id: 'chatcmpl-headless',
          object: 'chat.completion',
          created: 1,
          model: 'moonshotai/Kimi-K2.6',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'OK' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
        });
      },
    });

    assert.equal(url, 'https://api.siliconflow.com/v1/chat/completions');
    assert.equal(body?.model, 'moonshotai/Kimi-K2.6');
    assert.equal(text, 'OK');
  });
});
