import { z } from 'zod';
import {
  openAIComputerActionSchema,
  type OpenAIComputerAction,
} from './openai-computer-actions.js';
import { OPENAI_COMPUTER_INSTRUCTIONS } from './openai-computer-policy.js';

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
  status: 'completed' | 'failed' | 'incomplete' | 'in_progress';
  error?: { type?: string; code?: string; message: string } | null;
  calls: OpenAIComputerCall[];
  text: string;
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
  instructions: string;
  tools: Array<Record<string, unknown>>;
  input: string | OpenAIComputerInputItem[];
  previous_response_id?: string;
  truncation?: 'auto';
  parallel_tool_calls: false;
  store: false;
}

const safetyCheckSchema = z
  .object({
    id: z.string().min(1),
    code: z.string().nullable().optional(),
    message: z.string().nullable().optional(),
  })
  .strict();

const commonCallFields = {
  type: z.literal('computer_call'),
  id: z.string().min(1),
  call_id: z.string().min(1),
  pending_safety_checks: z.array(safetyCheckSchema).optional().default([]),
  status: z.enum(['in_progress', 'completed', 'incomplete']),
};

const gaCallSchema = z
  .object({
    ...commonCallFields,
    actions: z.array(openAIComputerActionSchema).min(1),
  })
  .strict();

const previewCallSchema = z
  .object({
    ...commonCallFields,
    action: openAIComputerActionSchema,
  })
  .strict();

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
  const status = z
    .enum(['completed', 'failed', 'incomplete', 'in_progress'])
    .parse(response.status ?? 'completed');
  const error =
    response.error == null
      ? null
      : z
          .object({
            type: z.string().optional(),
            code: z.string().optional(),
            message: z.string(),
          })
          .passthrough()
          .parse(response.error);

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

  const text = response.output
    .flatMap((item) => {
      const outputItem = asRecord(item, 'output_item');
      if (outputItem.type !== 'message' || !Array.isArray(outputItem.content)) return [];
      return outputItem.content.flatMap((part) => {
        const contentPart = asRecord(part, 'message_content');
        return contentPart.type === 'output_text' && typeof contentPart.text === 'string'
          ? [contentPart.text]
          : [];
      });
    })
    .join('');

  return { id: response.id, status, error, calls, text, raw: value };
}

export function createOpenAIComputerInitialRequest(input: {
  dialect: OpenAIComputerDialect;
  model: string;
  prompt: string;
  display?: {
    widthPx: number;
    heightPx: number;
    environment: 'browser' | 'mac' | 'windows' | 'linux';
  };
}): OpenAIComputerRequest {
  if (input.dialect === 'ga') {
    return {
      model: input.model,
      instructions: OPENAI_COMPUTER_INSTRUCTIONS,
      tools: [{ type: 'computer' }],
      input: input.prompt,
      parallel_tool_calls: false,
      store: false,
    };
  }
  if (!input.display) {
    throw new Error('invalid_openai_computer_preview_request: display is required');
  }
  return {
    model: input.model,
    instructions: OPENAI_COMPUTER_INSTRUCTIONS,
    tools: [
      {
        type: 'computer_use_preview',
        display_width: input.display.widthPx,
        display_height: input.display.heightPx,
        environment: input.display.environment,
      },
    ],
    input: input.prompt,
    truncation: 'auto',
    parallel_tool_calls: false,
    store: false,
  };
}

export function createOpenAIComputerContinuationRequest(input: {
  dialect: OpenAIComputerDialect;
  model: string;
  previousResponseId: string;
  callId: string;
  screenshot: OpenAIComputerScreenshot;
  acknowledgedSafetyChecks?: OpenAIComputerSafetyCheck[];
  display?: {
    widthPx: number;
    heightPx: number;
    environment: 'browser' | 'mac' | 'windows' | 'linux';
  };
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
