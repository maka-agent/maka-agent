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
  execute(action: CuAction, signal: AbortSignal): Promise<void>;
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

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('openai_computer_loop_aborted');
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
    if (response.calls.length === 0) {
      return { status: 'completed', response, turns };
    }
    if (response.calls.length !== 1) {
      throw new Error(`unsupported_openai_computer_parallel_calls: received ${response.calls.length}`);
    }

    const call = response.calls[0];
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

    for (const actions of converted) {
      for (const action of actions) {
        throwIfAborted(signal);
        await input.executor.execute(action, signal);
      }
    }

    const screenshot = await input.screenshot.capture(signal);
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
