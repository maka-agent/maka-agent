import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MockLanguageModelV4 } from 'ai/test';

import { ModelAdapter } from '../model-adapter.js';

function newAdapter(): ModelAdapter {
  return new ModelAdapter({
    connection: { providerType: 'openai' } as never,
    apiKey: 'test',
    modelId: 'mock',
    modelFactory: () => ({}),
    newId: () => 'id',
    now: () => 0,
  });
}

describe('ModelAdapter.startStream onError', () => {
  // streamText's default onError is `console.error(error)`, which dumps the
  // raw error object (stack + request bodies) straight onto the terminal,
  // bypassing the TUI transcript. Stream failures already reach the user via
  // the stream `error` chunk → ErrorEvent path, so nothing may leak to
  // console.error.
  test('a provider stream failure never reaches console.error', async () => {
    const logged: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args);
    };
    try {
      const model = new MockLanguageModelV4({
        doStream: async () => {
          throw new Error(
            'Client network socket disconnected before secure TLS connection was established',
          );
        },
      });
      const result = await newAdapter().startStream({
        model,
        messages: [{ role: 'user', content: 'hi' }],
        tools: {},
        activeTools: [],
        system: 'sys',
        abortSignal: new AbortController().signal,
        repairToolCall: async () => null,
      });
      for await (const chunk of result.stream) {
        if ((chunk as { type?: unknown }).type === 'error') break;
      }
      // Let any post-chunk callback settle before asserting.
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      console.error = original;
    }
    assert.deepEqual(
      logged,
      [],
      'stream errors must surface via the error chunk, not console.error',
    );
  });
});
