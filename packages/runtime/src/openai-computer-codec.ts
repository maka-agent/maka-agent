import { z } from 'zod';
import {
  openAIComputerActionSchema,
  type OpenAIComputerAction,
} from './openai-computer-actions.js';

export type OpenAIComputerDialect = 'ga' | 'preview';

export interface OpenAIComputerSafetyCheck {
  id: string;
  code?: string | null;
  message?: string | null;
}

export interface OpenAIComputerCall {
  id: string;
  callId: string;
  status: 'in_progress' | 'completed' | 'incomplete';
  actions: OpenAIComputerAction[];
  pendingSafetyChecks: OpenAIComputerSafetyCheck[];
}

export interface OpenAIComputerResponse {
  id: string;
  calls: OpenAIComputerCall[];
  raw: unknown;
}

export interface OpenAIComputerScreenshot {
  base64: string;
  mimeType: 'image/png' | 'image/jpeg';
}

export type OpenAIComputerInputItem = {
  type: 'computer_call_output';
  call_id: string;
  output: {
    type: 'computer_screenshot';
    image_url: string;
    detail: 'original';
  };
  acknowledged_safety_checks?: OpenAIComputerSafetyCheck[];
};

export interface OpenAIComputerRequest {
  model: string;
  tools: Array<Record<string, unknown>>;
  input: string | OpenAIComputerInputItem[];
  previous_response_id?: string;
  truncation?: 'auto';
}

const safetyCheckSchema = z.object({
  id: z.string().min(1),
  code: z.string().nullable().optional(),
  message: z.string().nullable().optional(),
}).strict();

const commonCallFields = {
  type: z.literal('computer_call'),
  id: z.string().min(1),
  call_id: z.string().min(1),
  pending_safety_checks: z.array(safetyCheckSchema),
  status: z.enum(['in_progress', 'completed', 'incomplete']),
};

const gaCallSchema = z.object({
  ...commonCallFields,
  actions: z.array(openAIComputerActionSchema),
}).strict();

const previewCallSchema = z.object({
  ...commonCallFields,
  action: openAIComputerActionSchema,
}).strict();

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`invalid_openai_computer_${label}: expected object`);
  }
  return value as Record<string, unknown>;
}

export function decodeOpenAIComputerResponse(
  value: unknown,
  dialect: OpenAIComputerDialect,
): OpenAIComputerResponse {
  const response = asRecord(value, 'response');
  if (typeof response.id !== 'string' || response.id.length === 0) {
    throw new Error('invalid_openai_computer_response: missing response id');
  }
  if (!Array.isArray(response.output)) {
    throw new Error('invalid_openai_computer_response: output must be an array');
  }

  const calls = response.output
    .filter((item) => asRecord(item, 'output_item').type === 'computer_call')
    .map((item): OpenAIComputerCall => {
      if (dialect === 'ga') {
        const parsed = gaCallSchema.parse(item);
        return {
          id: parsed.id,
          callId: parsed.call_id,
          status: parsed.status,
          actions: parsed.actions,
          pendingSafetyChecks: parsed.pending_safety_checks,
        };
      }
      const parsed = previewCallSchema.parse(item);
      return {
        id: parsed.id,
        callId: parsed.call_id,
        status: parsed.status,
        actions: [parsed.action],
        pendingSafetyChecks: parsed.pending_safety_checks,
      };
    });

  return { id: response.id, calls, raw: value };
}

export function createOpenAIComputerInitialRequest(input: {
  dialect: OpenAIComputerDialect;
  model: string;
  prompt: string;
  display?: { widthPx: number; heightPx: number; environment: 'browser' | 'mac' | 'windows' | 'linux' };
}): OpenAIComputerRequest {
  if (input.dialect === 'ga') {
    return {
      model: input.model,
      tools: [{ type: 'computer' }],
      input: input.prompt,
    };
  }
  if (!input.display) {
    throw new Error('invalid_openai_computer_preview_request: display is required');
  }
  return {
    model: input.model,
    tools: [{
      type: 'computer_use_preview',
      display_width: input.display.widthPx,
      display_height: input.display.heightPx,
      environment: input.display.environment,
    }],
    input: input.prompt,
    truncation: 'auto',
  };
}

export function createOpenAIComputerContinuationRequest(input: {
  dialect: OpenAIComputerDialect;
  model: string;
  previousResponseId: string;
  callId: string;
  screenshot: OpenAIComputerScreenshot;
  acknowledgedSafetyChecks?: OpenAIComputerSafetyCheck[];
  display?: { widthPx: number; heightPx: number; environment: 'browser' | 'mac' | 'windows' | 'linux' };
}): OpenAIComputerRequest {
  const initial = createOpenAIComputerInitialRequest({
    dialect: input.dialect,
    model: input.model,
    prompt: '',
    display: input.display,
  });
  const output: OpenAIComputerInputItem = {
    type: 'computer_call_output',
    call_id: input.callId,
    output: {
      type: 'computer_screenshot',
      image_url: `data:${input.screenshot.mimeType};base64,${input.screenshot.base64}`,
      detail: 'original',
    },
    ...(input.acknowledgedSafetyChecks && input.acknowledgedSafetyChecks.length > 0
      ? { acknowledged_safety_checks: input.acknowledgedSafetyChecks }
      : {}),
  };
  return {
    ...initial,
    input: [output],
    previous_response_id: input.previousResponseId,
  };
}
