import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { LlmConnection } from '@maka/core';
import {
  createAiSdkMetaAgent,
  createAiSdkMetaAgentCompletion,
  extractJsonObject,
} from '../meta-agent-completion.js';
import { parseMetaAgentResult } from '../prompt-candidate-loop.js';

const connection: LlmConnection = {
  slug: 'deepseek',
  name: 'DeepSeek',
  providerType: 'deepseek',
  baseUrl: 'https://api.deepseek.com',
  defaultModel: 'deepseek-v4-flash',
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
};

const base = { connection, apiKey: 'unused', modelId: 'deepseek-v4-flash' } as const;
const candidateRationale = {
  editedSurface: 'system_prompt',
  failurePattern: 'coverage_regression',
  evidenceRefs: [],
  hypothesis: 'coverage fell after the previous prompt change',
  targetedFix: 'keep the completion criteria explicit and conservative',
  predictedFixes: [],
  riskTasks: [],
} as const;

describe('extractJsonObject', () => {
  test('strips a ```json fence', () => {
    const raw = '```json\n{"systemPrompt":"X","summary":"Y"}\n```';
    assert.equal(extractJsonObject(raw), '{"systemPrompt":"X","summary":"Y"}');
  });

  test('strips a bare ``` fence', () => {
    assert.equal(extractJsonObject('```\n{"a":1}\n```'), '{"a":1}');
  });

  test('extracts JSON surrounded by prose', () => {
    const raw = 'Here is the improved prompt:\n{"systemPrompt":"X","summary":"Y"}\nDone.';
    assert.equal(extractJsonObject(raw), '{"systemPrompt":"X","summary":"Y"}');
  });

  test('passes clean JSON through unchanged', () => {
    assert.equal(extractJsonObject('{"a":1}'), '{"a":1}');
  });
});

describe('createAiSdkMetaAgentCompletion', () => {
  test('cleans fenced JSON so parseMetaAgentResult accepts it', async () => {
    const complete = createAiSdkMetaAgentCompletion({
      ...base,
      generate: async () => `\`\`\`json\n${JSON.stringify({ systemPrompt: 'NEW PROMPT', summary: 'tightened rules', candidateRationale })}\n\`\`\``,
    });
    const raw = await complete({ prompt: 'render' });
    assert.deepEqual(parseMetaAgentResult(raw), {
      systemPrompt: 'NEW PROMPT',
      summary: 'tightened rules',
      candidateRationale,
    });
  });

  test('forwards the JSON-only system instruction to the generator', async () => {
    let seenSystem: string | undefined;
    const complete = createAiSdkMetaAgentCompletion({
      ...base,
      generate: async ({ system }) => {
        seenSystem = system;
        return '{"systemPrompt":"P","summary":"S"}';
      },
    });
    await complete({ prompt: 'render' });
    assert.match(seenSystem ?? '', /JSON object/);
    assert.match(seenSystem ?? '', /"editedSurface":"system_prompt"/);
    assert.match(seenSystem ?? '', /"evidenceRefs":/);
    assert.match(seenSystem ?? '', /failurePattern only as a coarse fallback/);
  });
});

describe('createAiSdkMetaAgent', () => {
  test('renders, completes, and parses into a MetaAgentPromptResult', async () => {
    const agent = createAiSdkMetaAgent({
      ...base,
      generate: async ({ prompt }) => {
        assert.match(prompt, /Current System Prompt/);
        return JSON.stringify({ systemPrompt: 'IMPROVED', summary: 'removed redundant step', candidateRationale });
      },
    });
    const result = await agent({
      runId: 'r',
      roundId: 'round',
      program: 'optimize',
      currentSystemPrompt: 'old prompt',
      resultsTsv: 'task_id\tpassed\nt1\ttrue\n',
      heldInDigests: [],
    });
    assert.equal(result.systemPrompt, 'IMPROVED');
    assert.equal(result.summary, 'removed redundant step');
    assert.deepEqual(result.candidateRationale, candidateRationale);
  });
});
