import type { SessionEvent } from '@maka/core';
import { applyAssistantComplete, applyAssistantDelta } from './assistant-stream.js';
import type { ToolActivityItem } from './materialize.js';
import { applyThinkingComplete, applyThinkingDelta } from './thinking-stream.js';
import { applyToolOutputChunk } from './tool-output-stream.js';

type LiveTurnContentEvent = Extract<SessionEvent, { type: 'thinking_delta' | 'thinking_complete' | 'text_delta' | 'text_complete' | 'tool_start' | 'tool_output_delta' | 'tool_result' | 'permission_request' | 'permission_decision_ack' }>;

export interface LiveThinkingProjection {
  text: string;
  truncated: boolean;
  complete: boolean;
}

export interface LiveTurnStepProjection {
  stepId: string;
  thinking?: LiveThinkingProjection;
  text?: LiveTextProjection;
  tools: ToolActivityItem[];
}

export interface LiveTextProjection {
  text: string;
  truncated: boolean;
  complete: boolean;
}

export interface LiveTurnProjection {
  turnId: string;
  phase: 'waiting' | 'streamed';
  terminal?: true;
  steps: LiveTurnStepProjection[];
}

export function armLiveTurn(turnId: string): LiveTurnProjection {
  return { turnId, phase: 'waiting', steps: [] };
}

export function applyLiveTurnEvent(
  current: LiveTurnProjection | undefined,
  event: LiveTurnContentEvent,
): LiveTurnProjection;
export function applyLiveTurnEvent(
  current: LiveTurnProjection | undefined,
  event: SessionEvent,
): LiveTurnProjection | undefined;
export function applyLiveTurnEvent(
  current: LiveTurnProjection | undefined,
  event: SessionEvent,
): LiveTurnProjection | undefined {
  if (event.type === 'error' || event.type === 'abort') {
    if (!current || current.turnId !== event.turnId) return current;
    const steps = current.steps.map((step) => ({
      ...step,
      tools: step.tools.map((tool) => (
        tool.status === 'pending' || tool.status === 'running' || tool.status === 'waiting_permission'
          ? { ...tool, status: 'interrupted' as const }
          : tool
      )),
    }));
    return steps.length > 0 ? { ...current, terminal: true, steps } : undefined;
  }
  if (event.type === 'complete') {
    if (event.stopReason === 'permission_handoff' || !current || current.turnId !== event.turnId) return current;
    return current.steps.length > 0 ? { ...current, terminal: true } : undefined;
  }
  if (
    event.type !== 'thinking_delta'
    && event.type !== 'thinking_complete'
    && event.type !== 'text_delta'
    && event.type !== 'text_complete'
    && event.type !== 'tool_start'
    && event.type !== 'tool_output_delta'
    && event.type !== 'tool_result'
    && event.type !== 'permission_request'
    && event.type !== 'permission_decision_ack'
  ) {
    return current;
  }
  const prior = current?.turnId === event.turnId
    ? current
    : { turnId: event.turnId, phase: 'streamed' as const, steps: [] };
  const messageEvent = event.type === 'thinking_delta'
    || event.type === 'thinking_complete'
    || event.type === 'text_delta'
    || event.type === 'text_complete';
  const existingToolStep = event.type === 'tool_start'
    || event.type === 'tool_output_delta'
    || event.type === 'tool_result'
    || event.type === 'permission_request'
    || event.type === 'permission_decision_ack'
    ? prior.steps.find((candidate) => candidate.tools.some((tool) => tool.toolUseId === event.toolUseId))
    : undefined;
  const stepId = messageEvent
    ? event.messageId
    : event.type === 'tool_start'
      ? event.stepId ?? existingToolStep?.stepId ?? `tool:${event.toolUseId}`
      : existingToolStep?.stepId ?? `tool:${event.toolUseId}`;
  const stepIndex = prior.steps.findIndex((step) => step.stepId === stepId);
  const step = stepIndex >= 0 ? prior.steps[stepIndex]! : { stepId, tools: [] };
  let nextStep: LiveTurnStepProjection;
  if (event.type === 'thinking_delta') {
    const applied = applyThinkingDelta(step.thinking?.text ?? '', event.text);
    nextStep = {
      ...step,
      thinking: {
        text: applied.text,
        truncated: (step.thinking?.truncated ?? false) || applied.truncated,
        complete: false,
      },
    };
  } else if (event.type === 'thinking_complete') {
    const applied = applyThinkingComplete(event.text);
    nextStep = {
      ...step,
      thinking: {
        text: applied.text,
        truncated: applied.truncated,
        complete: true,
      },
    };
  } else if (event.type === 'text_delta') {
    const applied = applyAssistantDelta(step.text?.text ?? '', event.text);
    nextStep = {
      ...step,
      text: {
        text: applied.text,
        truncated: (step.text?.truncated ?? false) || applied.truncated,
        complete: false,
      },
    };
  } else if (event.type === 'text_complete') {
    const applied = applyAssistantComplete(event.text);
    nextStep = {
      ...step,
      text: {
        text: applied.text,
        truncated: applied.truncated,
        complete: true,
      },
    };
  } else if (event.type === 'tool_start') {
    const startedTool: ToolActivityItem = {
      toolUseId: event.toolUseId,
      toolName: event.toolName,
      ...(event.displayName !== undefined ? { displayName: event.displayName } : {}),
      ...(event.intent !== undefined ? { intent: event.intent } : {}),
      ...(event.stepId !== undefined ? { stepId: event.stepId } : {}),
      status: 'pending',
      args: event.args,
    };
    const existingTool = existingToolStep?.tools.find((candidate) => candidate.toolUseId === event.toolUseId);
    const tool: ToolActivityItem = existingTool
      ? { ...existingTool, ...startedTool, status: existingTool.status }
      : startedTool;
    const toolIndex = step.tools.findIndex((candidate) => candidate.toolUseId === event.toolUseId);
    nextStep = {
      ...step,
      tools: toolIndex >= 0
        ? step.tools.map((candidate, index) => index === toolIndex ? { ...candidate, ...tool } : candidate)
        : [...step.tools, tool],
    };
  } else if (event.type === 'tool_output_delta') {
    const toolIndex = step.tools.findIndex((candidate) => candidate.toolUseId === event.toolUseId);
    const base: ToolActivityItem = toolIndex >= 0
      ? step.tools[toolIndex]!
      : { toolUseId: event.toolUseId, toolName: 'Tool', status: 'running', args: undefined };
    const applied = applyToolOutputChunk(base.outputChunks, {
      seq: event.seq,
      stream: event.stream,
      text: event.chunk,
      redacted: event.redacted,
      createdAt: event.createdAt,
    });
    const tool: ToolActivityItem = {
      ...base,
      status: base.status === 'pending' ? 'running' : base.status,
      outputChunks: applied.chunks,
      outputTruncated: base.outputTruncated || applied.truncated,
    };
    nextStep = {
      ...step,
      tools: toolIndex >= 0
        ? step.tools.map((candidate, index) => index === toolIndex ? tool : candidate)
        : [...step.tools, tool],
    };
  } else if (event.type === 'tool_result') {
    const toolIndex = step.tools.findIndex((candidate) => candidate.toolUseId === event.toolUseId);
    const base: ToolActivityItem = toolIndex >= 0
      ? step.tools[toolIndex]!
      : { toolUseId: event.toolUseId, toolName: 'Tool', status: 'pending', args: undefined };
    const tool: ToolActivityItem = {
      ...base,
      status: event.isError ? 'errored' : 'completed',
      result: event.content,
      ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
    };
    nextStep = {
      ...step,
      tools: toolIndex >= 0
        ? step.tools.map((candidate, index) => index === toolIndex ? tool : candidate)
        : [...step.tools, tool],
    };
  } else {
    const toolIndex = step.tools.findIndex((candidate) => candidate.toolUseId === event.toolUseId);
    const base: ToolActivityItem = toolIndex >= 0
      ? step.tools[toolIndex]!
      : {
          toolUseId: event.toolUseId,
          toolName: event.type === 'permission_request' ? event.toolName : 'Tool',
          status: 'pending',
          args: event.type === 'permission_request' ? event.args : undefined,
        };
    const tool: ToolActivityItem = {
      ...base,
      status: event.type === 'permission_request'
        ? 'waiting_permission'
        : event.decision === 'allow' ? 'running' : 'errored',
    };
    nextStep = {
      ...step,
      tools: toolIndex >= 0
        ? step.tools.map((candidate, index) => index === toolIndex ? tool : candidate)
        : [...step.tools, tool],
    };
  }
  let steps: LiveTurnStepProjection[];
  if (existingToolStep && existingToolStep.stepId !== stepId && !messageEvent) {
    const sourceIndex = prior.steps.findIndex((candidate) => candidate.stepId === existingToolStep.stepId);
    const sourceWithoutTool = {
      ...existingToolStep,
      tools: existingToolStep.tools.filter((tool) => tool.toolUseId !== event.toolUseId),
    };
    const sourceIsEmpty = !sourceWithoutTool.thinking && !sourceWithoutTool.text && sourceWithoutTool.tools.length === 0;
    steps = [];
    for (let index = 0; index < prior.steps.length; index += 1) {
      const candidate = prior.steps[index]!;
      if (index === sourceIndex) {
        if (!sourceIsEmpty) steps.push(sourceWithoutTool);
        if (stepIndex < 0 && sourceIsEmpty) steps.push(nextStep);
      } else if (index === stepIndex) {
        steps.push(nextStep);
      } else {
        steps.push(candidate);
      }
    }
    if (stepIndex < 0 && !sourceIsEmpty) steps.push(nextStep);
  } else {
    steps = stepIndex >= 0
      ? prior.steps.map((candidate, index) => index === stepIndex ? nextStep : candidate)
      : [...prior.steps, nextStep];
  }
  return { ...prior, phase: 'streamed', steps };
}

export function settleLiveTurnStep(
  current: LiveTurnProjection,
  stepId: string,
): LiveTurnProjection | undefined {
  const steps = current.steps.filter((step) => step.stepId !== stepId);
  if (steps.length === current.steps.length) return current;
  if (steps.length === 0 && current.terminal) return undefined;
  return { ...current, steps };
}
