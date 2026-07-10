import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { applyLiveTurnEvent, armLiveTurn, settleLiveTurnStep } from '../live-turn-projection.js';

describe('applyLiveTurnEvent', () => {
  it('moves an armed turn from waiting to streamed on its first content event', () => {
    const waiting = armLiveTurn('turn-1');
    assert.equal(waiting.phase, 'waiting');

    const streamed = applyLiveTurnEvent(waiting, {
      type: 'thinking_delta',
      id: 'event-1',
      turnId: 'turn-1',
      messageId: 'step-1',
      ts: 100,
      text: '开始',
    });
    assert.equal(streamed.phase, 'streamed');
  });

  it('keeps the thinking message id as the live step identity', () => {
    const projection = applyLiveTurnEvent(undefined, {
      type: 'thinking_delta',
      id: 'event-1',
      turnId: 'turn-1',
      messageId: 'step-1',
      ts: 100,
      text: '先检查工具',
    });

    assert.equal(projection.turnId, 'turn-1');
    assert.deepEqual(projection.steps, [{
      stepId: 'step-1',
      thinking: {
        text: '先检查工具',
        truncated: false,
        complete: false,
      },
      tools: [],
    }]);
  });

  it('places a tool in the live step identified by tool_start.stepId', () => {
    const thinking = applyLiveTurnEvent(undefined, {
      type: 'thinking_delta',
      id: 'event-1',
      turnId: 'turn-1',
      messageId: 'step-1',
      ts: 100,
      text: '先检查工具',
    });
    const projection = applyLiveTurnEvent(thinking, {
      type: 'tool_start',
      id: 'event-2',
      turnId: 'turn-1',
      stepId: 'step-1',
      toolUseId: 'tool-1',
      toolName: 'Task List',
      args: {},
      ts: 101,
    });

    assert.equal(projection.steps.length, 1);
    assert.deepEqual(projection.steps[0]?.tools, [{
      toolUseId: 'tool-1',
      toolName: 'Task List',
      stepId: 'step-1',
      status: 'pending',
      args: {},
    }]);
  });

  it('replaces the live reasoning with thinking_complete on the same step', () => {
    const partial = applyLiveTurnEvent(undefined, {
      type: 'thinking_delta',
      id: 'event-1',
      turnId: 'turn-1',
      messageId: 'step-1',
      ts: 100,
      text: '部分',
    });
    const projection = applyLiveTurnEvent(partial, {
      type: 'thinking_complete',
      id: 'event-2',
      turnId: 'turn-1',
      messageId: 'step-1',
      ts: 101,
      text: '完整思考',
    });

    assert.deepEqual(projection.steps[0]?.thinking, {
      text: '完整思考',
      truncated: false,
      complete: true,
    });
  });

  it('keeps answer text in the same step as its reasoning', () => {
    const thinking = applyLiveTurnEvent(undefined, {
      type: 'thinking_delta',
      id: 'event-1',
      turnId: 'turn-1',
      messageId: 'step-1',
      ts: 100,
      text: '先分析',
    });
    const projection = applyLiveTurnEvent(thinking, {
      type: 'text_delta',
      id: 'event-2',
      turnId: 'turn-1',
      messageId: 'step-1',
      ts: 101,
      text: '答案',
    });

    assert.equal(projection.steps.length, 1);
    assert.deepEqual(projection.steps[0]?.text, {
      text: '答案',
      truncated: false,
      complete: false,
    });
  });

  it('marks final answer text complete without changing its step identity', () => {
    const partial = applyLiveTurnEvent(undefined, {
      type: 'text_delta',
      id: 'event-1',
      turnId: 'turn-1',
      messageId: 'step-1',
      ts: 100,
      text: '答',
    });
    const projection = applyLiveTurnEvent(partial, {
      type: 'text_complete',
      id: 'event-2',
      turnId: 'turn-1',
      messageId: 'step-1',
      ts: 101,
      text: '答案',
    });

    assert.equal(projection.steps[0]?.stepId, 'step-1');
    assert.deepEqual(projection.steps[0]?.text, {
      text: '答案',
      truncated: false,
      complete: true,
    });
  });

  it('settles a tool result in place inside its live step', () => {
    const started = applyLiveTurnEvent(undefined, {
      type: 'tool_start',
      id: 'event-1',
      turnId: 'turn-1',
      stepId: 'step-1',
      toolUseId: 'tool-1',
      toolName: 'Bash',
      args: {},
      ts: 100,
    });
    const projection = applyLiveTurnEvent(started, {
      type: 'tool_result',
      id: 'event-2',
      turnId: 'turn-1',
      toolUseId: 'tool-1',
      isError: false,
      content: { kind: 'text', text: 'ok' },
      durationMs: 12,
      ts: 101,
    });

    assert.equal(projection.steps.length, 1);
    assert.deepEqual(projection.steps[0]?.tools[0], {
      toolUseId: 'tool-1',
      toolName: 'Bash',
      stepId: 'step-1',
      status: 'completed',
      args: {},
      result: { kind: 'text', text: 'ok' },
      durationMs: 12,
    });
  });

  it('appends streamed tool output to the existing tool without changing its step', () => {
    const started = applyLiveTurnEvent(undefined, {
      type: 'tool_start',
      id: 'event-1',
      turnId: 'turn-1',
      stepId: 'step-1',
      toolUseId: 'tool-1',
      toolName: 'Bash',
      args: {},
      ts: 100,
    });
    const projection = applyLiveTurnEvent(started, {
      type: 'tool_output_delta',
      id: 'event-2',
      turnId: 'turn-1',
      sessionId: 'session-1',
      toolCallId: 'tool-1',
      toolUseId: 'tool-1',
      seq: 0,
      stream: 'stdout',
      chunk: 'hello\n',
      redacted: false,
      createdAt: 101,
      ts: 101,
    });

    assert.equal(projection.steps[0]?.stepId, 'step-1');
    assert.equal(projection.steps[0]?.tools[0]?.status, 'running');
    assert.deepEqual(projection.steps[0]?.tools[0]?.outputChunks, [{
      seq: 0,
      stream: 'stdout',
      text: 'hello\n',
      redacted: false,
      createdAt: 101,
    }]);
  });

  it('keeps permission status on the same live tool', () => {
    const started = applyLiveTurnEvent(undefined, {
      type: 'tool_start',
      id: 'event-1',
      turnId: 'turn-1',
      stepId: 'step-1',
      toolUseId: 'tool-1',
      toolName: 'Bash',
      args: { command: 'rm file' },
      ts: 100,
    });
    const waiting = applyLiveTurnEvent(started, {
      type: 'permission_request',
      id: 'event-2',
      turnId: 'turn-1',
      requestId: 'request-1',
      toolUseId: 'tool-1',
      toolName: 'Bash',
      category: 'shell_unsafe',
      reason: 'shell_dangerous',
      args: { command: 'rm file' },
      ts: 101,
    });
    const allowed = applyLiveTurnEvent(waiting, {
      type: 'permission_decision_ack',
      id: 'event-3',
      turnId: 'turn-1',
      requestId: 'request-1',
      toolUseId: 'tool-1',
      decision: 'allow',
      ts: 102,
    });

    assert.equal(waiting?.steps[0]?.tools[0]?.status, 'waiting_permission');
    assert.equal(allowed?.steps[0]?.tools[0]?.status, 'running');
    assert.equal(allowed?.steps[0]?.stepId, 'step-1');
  });

  it('drops a terminal projection only after its last live step settles', () => {
    const streaming = applyLiveTurnEvent(armLiveTurn('turn-1'), {
      type: 'text_delta',
      id: 'event-1',
      turnId: 'turn-1',
      messageId: 'step-1',
      ts: 100,
      text: 'answer',
    });
    const terminal = applyLiveTurnEvent(streaming, {
      type: 'complete',
      id: 'event-2',
      turnId: 'turn-1',
      ts: 101,
      stopReason: 'end_turn',
    });

    assert.equal(terminal?.terminal, true);
    assert.equal(settleLiveTurnStep(terminal!, 'step-1'), undefined);
  });
});

describe('settleLiveTurnStep', () => {
  it('removes only the committed step and drops an empty projection', () => {
    const projection = {
      turnId: 'turn-1',
      phase: 'streamed' as const,
      steps: [
        { stepId: 'step-1', tools: [] },
        { stepId: 'step-2', tools: [] },
      ],
    };

    assert.deepEqual(settleLiveTurnStep(projection, 'step-1'), {
      turnId: 'turn-1',
      phase: 'streamed',
      steps: [{ stepId: 'step-2', tools: [] }],
    });
    assert.deepEqual(
      settleLiveTurnStep({ turnId: 'turn-1', phase: 'streamed', steps: [{ stepId: 'step-1', tools: [] }] }, 'step-1'),
      { turnId: 'turn-1', phase: 'streamed', steps: [] },
    );
  });
});
