import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { Config } from '../contracts.js';
import { hashSystemPrompt, type TaskRunOutput } from '../fixed-prompt-controller.js';
import {
  compareKimiProtocolSmokeTrace,
  kimiProtocolAbArms,
  recommendKimiProtocolDefault,
  renderKimiProtocolAbMarkdown,
  runKimiProtocolAbComparison,
  summarizeKimiProtocolRequestMetrics,
  validateKimiProtocolRequestTrace,
} from '../kimi-protocol-ab.js';
import type { ProviderRequestTraceAnalysis } from '../provider-request-trace.js';
import { tokenSummary } from './helpers/cell-output-fixtures.js';

describe('Kimi protocol A/B', () => {
  test('compares the same task through only the two explicit protocol env values', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-kimi-protocol-ab-'));
    const systemPromptPath = join(dir, 'system-prompt.md');
    const resultsJsonlPath = join(dir, 'results.jsonl');
    await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');
    await writeFile(join(dir, 'runtime-events.jsonl'), '', 'utf8');
    const seen: Array<{ protocol?: string; keys: string[] }> = [];
    let traceIndex = 0;

    const result = await runKimiProtocolAbComparison({
      runId: 'run-kimi-protocol',
      config: config(),
      systemPromptPath,
      resultsJsonlPath,
      evaluationTasks: [{ id: 'task-a', path: '/bench/task-a' }],
      reps: 1,
      billingMode: 'account-plan',
      taskRunner: async (input) => {
        const protocol = input.agentEnv?.MAKA_MODEL_API_PROTOCOL;
        seen.push({ protocol, keys: Object.keys(input.agentEnv ?? {}).sort() });
        const traceEventsPath = join(dir, `trace-${traceIndex++}.jsonl`);
        await writeTrace(traceEventsPath, protocol);
        return output(input.task.id, traceEventsPath);
      },
      now: monotonicClock(),
      newId: idGenerator(),
    });

    assert.deepEqual(seen, [
      { protocol: 'anthropic-messages', keys: ['MAKA_MODEL_API_PROTOCOL'] },
      { protocol: 'openai-chat', keys: ['MAKA_MODEL_API_PROTOCOL'] },
    ]);
    assert.equal(result.summary.decision, 'diagnostic', JSON.stringify(result.summary, null, 2));
    assert.equal(result.evidence.length, 2);
    assert.equal(result.smokeTrace.onlyIntendedDifferences, true);
    assert.equal(result.smokeTrace.requestCount, 1);
    assert.equal(result.requestMetrics.anthropic.requests, 1);
    assert.equal(result.requestMetrics.openai.requests, 1);
    assert.equal(result.defaultRecommendation, 'keep_anthropic_default');
    assert.deepEqual(
      kimiProtocolAbArms().map((arm) => arm.metadata?.protocol),
      ['anthropic-messages', 'openai-chat'],
    );
    assert.match(renderKimiProtocolAbMarkdown(result), /Raw request telemetry/);
    assert.match(renderKimiProtocolAbMarkdown(result), /trace-anthropic/);
    assert.equal((await readFile(resultsJsonlPath, 'utf8')).trimEnd().split('\n').length, 2);
  });

  test('rejects a host-authority protocol override before running a paid arm', async () => {
    let runnerCalls = 0;

    await assert.rejects(
      runKimiProtocolAbComparison({
        runId: 'run-kimi-protocol',
        config: config(),
        systemPromptPath: '/unused/system-prompt.md',
        resultsJsonlPath: '/unused/results.jsonl',
        evaluationTasks: [{ id: 'task-a', path: '/bench/task-a' }],
        sharedAgentEnv: { MAKA_HOST_MODEL_API_PROTOCOL: 'anthropic-messages' },
        taskRunner: async () => {
          runnerCalls += 1;
          throw new Error('task runner must not be called');
        },
      }),
      /owns MAKA_HOST_MODEL_API_PROTOCOL per arm/,
    );
    assert.equal(runnerCalls, 0);
  });

  test('rejects an inherited host-authority protocol override before running a paid arm', async () => {
    const originalProtocol = process.env.MAKA_HOST_MODEL_API_PROTOCOL;
    let runnerCalls = 0;
    process.env.MAKA_HOST_MODEL_API_PROTOCOL = 'anthropic-messages';

    try {
      await assert.rejects(
        runKimiProtocolAbComparison({
          runId: 'run-kimi-protocol',
          config: config(),
          systemPromptPath: '/unused/system-prompt.md',
          resultsJsonlPath: '/unused/results.jsonl',
          evaluationTasks: [{ id: 'task-a', path: '/bench/task-a' }],
          taskRunner: async () => {
            runnerCalls += 1;
            throw new Error('task runner must not be called');
          },
        }),
        /owns MAKA_HOST_MODEL_API_PROTOCOL per arm/,
      );
      assert.equal(runnerCalls, 0);
    } finally {
      if (originalProtocol === undefined) delete process.env.MAKA_HOST_MODEL_API_PROTOCOL;
      else process.env.MAKA_HOST_MODEL_API_PROTOCOL = originalProtocol;
    }
  });

  test('never retries a full Harbor arm after the runner fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-kimi-protocol-ab-attempt-'));
    const systemPromptPath = join(dir, 'system-prompt.md');
    await writeFile(systemPromptPath, 'fixed prompt\n', 'utf8');
    let runnerCalls = 0;

    await assert.rejects(
      runKimiProtocolAbComparison({
        runId: 'run-kimi-protocol',
        config: config(),
        systemPromptPath,
        resultsJsonlPath: join(dir, 'results.jsonl'),
        evaluationTasks: [{ id: 'task-a', path: '/bench/task-a' }],
        reps: 1,
        taskRunner: async () => {
          runnerCalls += 1;
          throw new Error('provider traffic occurred before Harbor failed');
        },
        now: monotonicClock(),
        newId: idGenerator(),
      }),
      /produced no #1268 request trace/,
    );
    assert.equal(runnerCalls, 1);
  });

  test('fails the smoke trace when a shared prompt/history segment changes', () => {
    const anthropic = trace('anthropic', 'sha256:message');
    const openai = trace('openai', 'sha256:different-message');
    assert.throws(
      () => compareKimiProtocolSmokeTrace(anthropic, openai),
      /shared request segment differs/,
    );
  });

  test('fails the smoke trace when a non-protocol request parameter changes', () => {
    const anthropic = trace('anthropic', 'sha256:message');
    const openai = trace('openai', 'sha256:message');
    Object.assign(anthropic.captures[0]!, {
      requestPayloadWithoutProviderOptionsHash: 'sha256:max-output-131072',
    });
    Object.assign(openai.captures[0]!, {
      requestPayloadWithoutProviderOptionsHash: 'sha256:max-output-missing',
    });

    assert.throws(
      () => compareKimiProtocolSmokeTrace(anthropic, openai),
      /non-protocol request parameters differ/,
    );
  });

  test('fails the smoke trace when full non-protocol request evidence is missing', () => {
    const anthropic = trace('anthropic', 'sha256:message');
    const openai = trace('openai', 'sha256:message');
    Object.assign(anthropic.captures[0]!, { requestPayloadWithoutProviderOptionsHash: undefined });
    Object.assign(openai.captures[0]!, { requestPayloadWithoutProviderOptionsHash: undefined });

    assert.throws(
      () => compareKimiProtocolSmokeTrace(anthropic, openai),
      /missing non-protocol request parameter evidence/,
    );
  });

  test('aggregates request-level usage without filling missing provider values', () => {
    const metrics = summarizeKimiProtocolRequestMetrics([
      trace('anthropic', 'sha256:message'),
      {
        ...trace('anthropic', 'sha256:message'),
        attempts: [
          {
            ...trace('anthropic', 'sha256:message').attempts[0]!,
            attemptId: 'attempt-2',
            inputTokens: undefined,
            cacheReadInputTokens: undefined,
            cacheMissInputTokens: undefined,
            cacheWriteInputTokens: undefined,
            outputTokens: undefined,
            reasoningTokens: undefined,
          },
        ],
      },
    ]);
    assert.equal(metrics.requests, 2);
    assert.equal(metrics.completeUsageRequests, 1);
    assert.equal(metrics.missingUsageRequests, 1);
    assert.equal(metrics.inputTokens, null);
    assert.equal(metrics.cacheWriteInputTokens, null);
    assert.equal(metrics.reasoningTokens, null);
    assert.equal(metrics.totalLatencyMs, 4);
    assert.equal(metrics.meanLatencyMs, 2);
  });

  test('rejects request attempts that do not match their persisted capture', () => {
    const value = trace('anthropic', 'sha256:message');
    value.attempts[0] = { ...value.attempts[0]!, captureId: 'capture-unrelated' };
    assert.throws(
      () => validateKimiProtocolRequestTrace(value, 'anthropic'),
      /does not match its request capture/,
    );
  });

  test('never recommends changing the default when correctness or telemetry differs', () => {
    const fast = summarizeKimiProtocolRequestMetrics([trace('openai', 'sha256:message')]);
    const slow = { ...fast, totalLatencyMs: 3, meanLatencyMs: 3 };
    assert.equal(
      recommendKimiProtocolDefault({
        conclusive: true,
        correctnessUnchanged: true,
        completeTelemetry: true,
        anthropic: slow,
        openai: fast,
      }),
      'openai_candidate',
    );
    assert.equal(
      recommendKimiProtocolDefault({
        conclusive: true,
        correctnessUnchanged: false,
        completeTelemetry: true,
        anthropic: slow,
        openai: fast,
      }),
      'keep_anthropic_default',
    );
    assert.equal(
      recommendKimiProtocolDefault({
        conclusive: true,
        correctnessUnchanged: true,
        completeTelemetry: false,
        anthropic: slow,
        openai: fast,
      }),
      'keep_anthropic_default',
    );
  });

  test('does not treat lower per-request latency as an end-to-end improvement', () => {
    const base = summarizeKimiProtocolRequestMetrics([trace('anthropic', 'sha256:message')]);
    const anthropic = { ...base, requests: 1, totalLatencyMs: 100, meanLatencyMs: 100 };
    const openai = { ...base, requests: 10, totalLatencyMs: 900, meanLatencyMs: 90 };

    assert.equal(
      recommendKimiProtocolDefault({
        conclusive: true,
        correctnessUnchanged: true,
        completeTelemetry: true,
        anthropic,
        openai,
      }),
      'keep_anthropic_default',
    );
  });
});

function config(): Config {
  return {
    id: 'cfg-kimi-protocol',
    backend: 'ai-sdk',
    llmConnectionSlug: 'kimi-coding-plan',
    model: 'k3',
  };
}

function output(taskId: string, traceEventsPath: string): TaskRunOutput {
  return {
    harbor: {
      reward: 1,
      verifier: {
        outcome: 'passed',
        attempts: [{ attempt: 1, classification: 'passed', durationMs: 1, reward: 1 }],
      },
    },
    cell: {
      schemaVersion: 1,
      status: 'completed',
      runtimeEventsPath: join(traceEventsPath, '..', 'runtime-events.jsonl'),
      traceEventsPath,
      promptHash: hashSystemPrompt('fixed prompt\n'),
      tokenSummary: tokenSummary({
        input: 12,
        output: 3,
        reasoning: 2,
        total: 15,
        costUsd: 0,
      }),
      toolSummary: {
        providerVisibleToolCount: 1,
        actualToolCalls: 1,
        actualToolNames: ['Read'],
        actualToolCallCounts: { Read: 1 },
      },
      steps: 1,
      durationMs: 2,
      startedAt: 1,
      finishedAt: 3,
      runtimeRefs: {
        invocationId: `inv-${taskId}`,
        sessionId: `session-${taskId}`,
        runId: `run-${taskId}`,
        turnId: `turn-${taskId}`,
      },
    },
  };
}

async function writeTrace(path: string, protocol: string | undefined): Promise<void> {
  const provider = protocol === 'openai-chat' ? 'openai' : 'anthropic';
  const value = trace(provider, 'sha256:message');
  if (provider === 'openai') {
    value.attempts[0] = {
      ...value.attempts[0]!,
      completedAt: 2,
      latencyMs: 1,
    };
  }
  const events = [
    {
      type: 'provider_request_captured',
      id: value.captures[0]!.captureId,
      runId: 'run-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      ts: 1,
      data: value.captures[0],
    },
    {
      type: 'provider_request_attempt_recorded',
      id: value.attempts[0]!.attemptId,
      runId: 'run-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      ts: 3,
      data: value.attempts[0],
    },
  ];
  await writeFile(path, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8');
}

function trace(provider: string, messageHash: string): ProviderRequestTraceAnalysis {
  const providerOptionHash =
    provider === 'openai' ? 'sha256:openai-options' : 'sha256:anthropic-options';
  return {
    traceId: `trace-${provider}`,
    captures: [
      {
        traceId: `trace-${provider}`,
        captureId: `capture-${provider}`,
        artifactId: `artifact-${provider}`,
        turnId: 'turn-1',
        step: 0,
        providerId: provider,
        modelId: 'k3',
        requestHash: `sha256:request-${provider}`,
        requestPayloadWithoutProviderOptionsHash: 'sha256:shared-request',
        requestBytes: 100,
        segments: [
          {
            kind: 'system_prompt',
            index: 0,
            cacheable: true,
            hash: 'sha256:system',
            bytes: 10,
          },
          {
            kind: 'tool_schema',
            index: 0,
            cacheable: true,
            hash: 'sha256:tools',
            bytes: 20,
          },
          {
            kind: 'message',
            index: 0,
            role: 'user',
            cacheable: true,
            hash: messageHash,
            bytes: 30,
          },
          {
            kind: 'provider_options',
            index: 0,
            cacheable: false,
            hash: providerOptionHash,
            bytes: 15,
          },
        ],
      },
    ],
    attempts: [
      {
        traceId: `trace-${provider}`,
        attemptId: `attempt-${provider}`,
        turnId: 'turn-1',
        step: 0,
        attempt: 1,
        captureId: `capture-${provider}`,
        captureArtifactId: `artifact-${provider}`,
        providerId: provider,
        modelId: 'k3',
        requestHash: `sha256:request-${provider}`,
        requestBytes: 100,
        startedAt: 1,
        completedAt: 3,
        status: 'completed',
        finishReason: 'stop',
        latencyMs: 2,
        timeToFirstTokenMs: 1,
        inputTokens: 12,
        cacheReadInputTokens: 4,
        cacheReadInputSource: 'provider',
        cacheMissInputTokens: 8,
        cacheMissInputSource: 'derived',
        cacheWriteInputTokens: 1,
        cacheWriteInputSource: 'provider',
        outputTokens: 3,
        reasoningTokens: 2,
      },
    ],
  };
}

function idGenerator(): () => string {
  let value = 0;
  return () => `id-${++value}`;
}

function monotonicClock(): () => number {
  let value = 100;
  return () => ++value;
}
