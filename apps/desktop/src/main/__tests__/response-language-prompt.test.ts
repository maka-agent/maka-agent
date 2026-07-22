import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { AppSettings } from '@maka/core';
import { createSystemPromptMainService } from '../system-prompt-main.js';

describe('desktop response language prompt', () => {
  test('injects the latest-request language policy into normal and child turns', async () => {
    const service = createSystemPromptMainService({
      settingsStore: {
        get: async () => ({
          personalization: {},
          workspaceInstructions: { enabled: false },
        }) as AppSettings,
      },
      workspaceRoot: '/tmp/does-not-matter',
      localMemory: {
        getState: async () => ({ status: 'ok', agentReadEnabled: false, content: '' }) as never,
        consumePendingPromptUpdates: () => [],
      },
      taskLedger: { list: async () => [] },
    });

    const normal = await service.buildBackendSystemPrompt(
      { labels: [] },
      undefined,
      { memoryFragment: null },
    );
    const child = await service.buildBackendSystemPrompt(
      { labels: [] },
      undefined,
      { childInstruction: 'Inspect the requested files.' },
    );

    for (const prompt of [normal, child]) {
      assert.match(prompt ?? '', /same predominant natural language as the user's latest request/);
      assert.match(prompt ?? '', /progress updates, visible reasoning summaries, questions, and the final answer/);
    }
  });
});
