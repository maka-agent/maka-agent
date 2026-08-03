import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildMemoryExtractionScheduleTools,
  MEMORY_EXTRACT_TOOL_NAME,
  MEMORY_REMEMBER_TOOL_NAME,
  type MemoryExtractionScheduleRequest,
} from '../memory-extraction-tools.js';
import type { MakaToolContext } from '../tool-runtime.js';

test('memory scheduling tools expose stable empty schemas and distinct trigger semantics', async () => {
  const requests: MemoryExtractionScheduleRequest[] = [];
  const tools = buildMemoryExtractionScheduleTools({
    schedule: async (request) => {
      requests.push(request);
      return { status: 'accepted' };
    },
  });

  assert.deepEqual(
    tools.map((tool) => tool.name),
    [MEMORY_REMEMBER_TOOL_NAME, MEMORY_EXTRACT_TOOL_NAME],
  );
  assert.equal(
    tools.every((tool) => tool.recoveryMode === 'replay_safe'),
    true,
  );
  assert.equal(
    tools.every((tool) => tool.executionSemantics === 'exclusive_step'),
    true,
  );

  const remember = tools[0]!;
  const extract = tools[1]!;
  assert.deepEqual(await remember.impl({}, context()), { status: 'accepted' });
  assert.deepEqual(await extract.impl({}, context('tool-2')), { status: 'accepted' });
  assert.deepEqual(requests, [
    {
      mode: 'targeted',
      triggerKind: 'user_requested',
      sessionId: 'session-1',
      runId: 'run-1',
      turnId: 'turn-1',
      toolCallId: 'tool-1',
    },
    {
      mode: 'sweep',
      triggerKind: 'agent_requested',
      sessionId: 'session-1',
      runId: 'run-1',
      turnId: 'turn-1',
      toolCallId: 'tool-2',
    },
  ]);

  await assert.rejects(
    async () => remember!.impl({}, { ...context(), runId: undefined }),
    /requires an active Agent Run/,
  );
  assert.equal(requests.length, 2, 'invalid execution identity must not reach the scheduler');
});

function context(toolCallId = 'tool-1'): MakaToolContext {
  return {
    sessionId: 'session-1',
    runId: 'run-1',
    turnId: 'turn-1',
    cwd: '/workspace',
    toolCallId,
    abortSignal: new AbortController().signal,
    emitOutput: () => undefined,
  };
}
