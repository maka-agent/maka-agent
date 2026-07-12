import type { CuAction } from '@maka/core';
import {
  convertOpenAIComputerAction,
  type OpenAIComputerActionConversion,
} from './openai-computer-actions.js';
import {
  createOpenAIComputerContinuationRequest,
  createOpenAIComputerInitialRequest,
  decodeOpenAIComputerResponse,
  type OpenAIComputerCall,
  type OpenAIComputerDialect,
  type OpenAIComputerRequest,
  type OpenAIComputerResponse,
  type OpenAIComputerSafetyCheck,
  type OpenAIComputerScreenshot,
} from './openai-computer-codec.js';

export interface OpenAIComputerTransport {
  create(request: OpenAIComputerRequest, signal: AbortSignal): Promise<unknown>;
}

export interface OpenAIComputerExecutor {
  execute(action: CuAction, signal: AbortSignal): Promise<OpenAIComputerScreenshot | void>;
}

export interface OpenAIComputerScreenshotProvider {
  capture(signal: AbortSignal): Promise<OpenAIComputerScreenshot>;
}

export type OpenAIComputerLoopResult =
  | { status: 'completed'; response: OpenAIComputerResponse; turns: number }
  | {
      status: 'safety_blocked';
      response: OpenAIComputerResponse;
      call: OpenAIComputerCall;
      checks: OpenAIComputerSafetyCheck[];
      turns: number;
    }
  | {
      status: 'unsupported_action';
      response: OpenAIComputerResponse;
      call: OpenAIComputerCall;
      actionIndex: number;
      failure: Extract<OpenAIComputerActionConversion, { ok: false }>;
      turns: number;
    };

export interface OpenAIComputerLoopObservation {
  turn: number;
  responseId: string;
  callId?: string;
  actions: Readonly<OpenAIComputerCall['actions']>;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('openai_computer_loop_aborted');
}

function snapshotComputerCall(call: OpenAIComputerCall): OpenAIComputerCall {
  const actions = call.actions.map((action) => {
    const clone = structuredClone(action);
    if ('keys' in clone && Array.isArray(clone.keys)) Object.freeze(clone.keys);
    if (clone.type === 'drag') {
      for (const point of clone.path) Object.freeze(point);
      Object.freeze(clone.path);
    }
    return Object.freeze(clone);
  });
  const pendingSafetyChecks = call.pendingSafetyChecks.map((check) =>
    Object.freeze({ ...check }));
  return Object.freeze({
    ...call,
    actions: Object.freeze(actions),
    pendingSafetyChecks: Object.freeze(pendingSafetyChecks),
  }) as OpenAIComputerCall;
}

export async function runOpenAIComputerLoop(input: {
  dialect: OpenAIComputerDialect;
  model: string;
  prompt: string;
  transport: OpenAIComputerTransport;
  executor: OpenAIComputerExecutor;
  screenshot: OpenAIComputerScreenshotProvider;
  signal?: AbortSignal;
  maxTurns?: number;
  display?: { widthPx: number; heightPx: number; environment: 'browser' | 'mac' | 'windows' | 'linux' };
  acknowledgeSafetyChecks?: (
    checks: OpenAIComputerSafetyCheck[],
    call: OpenAIComputerCall,
    signal: AbortSignal,
  ) => Promise<boolean>;
  observeTurn?: (observation: OpenAIComputerLoopObservation) => void | Promise<void>;
  allowAction?: (
    action: OpenAIComputerCall['actions'][number],
    context: { turn: number; actionIndex: number; call: OpenAIComputerCall },
  ) => boolean | Promise<boolean>;
}): Promise<OpenAIComputerLoopResult> {
  const signal = input.signal ?? new AbortController().signal;
  const maxTurns = input.maxTurns ?? 64;
  let request = createOpenAIComputerInitialRequest(input);

  for (let turns = 1; turns <= maxTurns; turns += 1) {
    throwIfAborted(signal);
    const response = decodeOpenAIComputerResponse(
      await input.transport.create(request, signal),
      input.dialect,
    );
    if (response.status === 'failed' || response.error) {
      throw new Error(
        `openai_computer_response_failed: ${
          response.error?.code ?? response.error?.type ?? response.status
        }: ${response.error?.message ?? 'request failed'}`,
      );
    }
    if (response.status === 'incomplete') {
      throw new Error('openai_computer_response_incomplete');
    }
    if (response.calls.length === 0) {
      await input.observeTurn?.({
        turn: turns,
        responseId: response.id,
        actions: [],
      });
      return { status: 'completed', response, turns };
    }
    if (response.calls.length !== 1) {
      throw new Error(`unsupported_openai_computer_parallel_calls: received ${response.calls.length}`);
    }

    const call = snapshotComputerCall(response.calls[0]);
    await input.observeTurn?.({
      turn: turns,
      responseId: response.id,
      callId: call.callId,
      actions: call.actions,
    });
    let acknowledgedSafetyChecks: OpenAIComputerSafetyCheck[] | undefined;
    if (call.pendingSafetyChecks.length > 0) {
      const acknowledged = await input.acknowledgeSafetyChecks?.(
        call.pendingSafetyChecks,
        call,
        signal,
      ) ?? false;
      if (!acknowledged) {
        return {
          status: 'safety_blocked',
          response,
          call,
          checks: call.pendingSafetyChecks,
          turns,
        };
      }
      acknowledgedSafetyChecks = call.pendingSafetyChecks;
    }

    const converted: CuAction[][] = [];
    for (let actionIndex = 0; actionIndex < call.actions.length; actionIndex += 1) {
      if (
        input.allowAction
        && !await input.allowAction(call.actions[actionIndex], { turn: turns, actionIndex, call })
      ) {
        return {
          status: 'unsupported_action',
          response,
          call,
          actionIndex,
          failure: {
            ok: false,
            code: 'unsupported_action_policy',
            message: `OpenAI computer action '${call.actions[actionIndex].type}' was rejected by the scenario policy`,
          },
          turns,
        };
      }
      const conversion = convertOpenAIComputerAction(call.actions[actionIndex]);
      if (!conversion.ok) {
        return {
          status: 'unsupported_action',
          response,
          call,
          actionIndex,
          failure: conversion,
          turns,
        };
      }
      converted.push(conversion.actions);
    }

    let lastScreenshot: OpenAIComputerScreenshot | undefined;
    for (const actions of converted) {
      for (const action of actions) {
        throwIfAborted(signal);
        const result = await input.executor.execute(action, signal);
        if (action.type === 'screenshot' && result) lastScreenshot = result;
      }
    }

    const screenshot = lastScreenshot ?? await input.screenshot.capture(signal);
    request = createOpenAIComputerContinuationRequest({
      dialect: input.dialect,
      model: input.model,
      previousResponseId: response.id,
      callId: call.callId,
      screenshot,
      acknowledgedSafetyChecks,
      display: input.display,
    });
  }

  throw new Error(`openai_computer_loop_max_turns_exceeded: ${maxTurns}`);
}
