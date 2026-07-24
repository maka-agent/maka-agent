import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as traceAnalysis from '../provider-request-trace.js';

test('derives the first changed cacheable segment from the existing AgentRun trace', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-provider-trace-'));
  const traceEventsPath = join(dir, 'events.jsonl');
  const base = {
    type: 'provider_request_captured',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 1,
  };
  const capture = (id: string, step: number, messageHashes: string[]): Record<string, unknown> => ({
    ...base,
    id,
    ts: step + 1,
    data: {
      schemaVersion: 1,
      traceId: 'provider-trace-1',
      captureId: id,
      artifactId: `artifact-${id}`,
      step,
      providerId: 'openai',
      modelId: 'gpt-test',
      requestHash: `sha256:request-${step}`,
      requestPayloadWithoutProviderOptionsHash: `sha256:shared-request-${step}`,
      requestBytes: 100 + step,
      segments: [
        {
          kind: 'system_prompt',
          index: 0,
          cacheable: true,
          hash: 'sha256:system',
          bytes: 10,
        },
        ...messageHashes.map((hash, index) => ({
          kind: 'message',
          index,
          role: index === 0 ? 'user' : 'assistant',
          cacheable: true,
          hash,
          bytes: 10,
        })),
      ],
    },
  });
  const attempt = {
    ...base,
    type: 'provider_request_attempt_recorded',
    id: 'attempt-1',
    ts: 4,
    data: {
      traceId: 'provider-trace-1',
      attemptId: 'attempt-1',
      turnId: 'turn-1',
      step: 0,
      attempt: 1,
      captureId: 'capture-1',
      captureArtifactId: 'artifact-capture-1',
      providerId: 'openai',
      modelId: 'gpt-test',
      requestHash: 'sha256:request-0',
      requestBytes: 100,
      segments: [],
      startedAt: 2,
      completedAt: 4,
      status: 'completed',
      finishReason: 'stop',
      latencyMs: 2,
      timeToFirstTokenMs: 1,
      inputTokens: 12,
      cacheReadInputTokens: 4,
      cacheReadInputSource: 'provider',
      cacheMissInputTokens: 8,
      cacheMissInputSource: 'derived',
      outputTokens: 3,
      reasoningTokens: 2,
    },
  };
  await writeFile(
    traceEventsPath,
    `${[
      capture('capture-1', 0, ['sha256:user']),
      capture('capture-2', 1, ['sha256:user', 'sha256:assistant']),
      attempt,
    ]
      .map((event) => JSON.stringify(event))
      .join('\n')}\n`,
  );

  const result = await traceAnalysis.readProviderRequestTrace(traceEventsPath);

  assert.equal(result.traceId, 'provider-trace-1');
  assert.equal(result.captures.length, 2);
  assert.deepEqual(result.captures[1]?.firstChangedCacheableSegment, {
    kind: 'message',
    index: 1,
    role: 'assistant',
  });
  assert.deepEqual(result.attempts, [
    {
      traceId: 'provider-trace-1',
      attemptId: 'attempt-1',
      turnId: 'turn-1',
      step: 0,
      attempt: 1,
      captureId: 'capture-1',
      captureArtifactId: 'artifact-capture-1',
      providerId: 'openai',
      modelId: 'gpt-test',
      requestHash: 'sha256:request-0',
      requestBytes: 100,
      startedAt: 2,
      completedAt: 4,
      status: 'completed',
      finishReason: 'stop',
      latencyMs: 2,
      timeToFirstTokenMs: 1,
      inputTokens: 12,
      cacheReadInputTokens: 4,
      cacheReadInputSource: 'provider',
      cacheMissInputTokens: 8,
      cacheMissInputSource: 'derived',
      outputTokens: 3,
      reasoningTokens: 2,
    },
  ]);
});

test('keeps complete provider captures when the AgentRun trace ends with a torn record', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-provider-trace-'));
  const traceEventsPath = join(dir, 'events.jsonl');
  await writeFile(
    traceEventsPath,
    `${JSON.stringify({
      type: 'provider_request_captured',
      id: 'capture-1',
      runId: 'run-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      ts: 1,
      data: {
        schemaVersion: 1,
        traceId: 'provider-trace-1',
        captureId: 'capture-1',
        artifactId: 'artifact-capture-1',
        step: 0,
        providerId: 'openai',
        modelId: 'gpt-test',
        requestHash: 'sha256:request-1',
        requestPayloadWithoutProviderOptionsHash: 'sha256:shared-request-1',
        requestBytes: 100,
        segments: [],
      },
    })}\n{"type":"provider_request_captured"`,
  );

  const result = await traceAnalysis.readProviderRequestTrace(traceEventsPath);

  assert.deepEqual(
    result.captures.map((capture) => capture.captureId),
    ['capture-1'],
  );
  assert.deepEqual(result.attempts, []);
});
