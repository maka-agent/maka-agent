import { anthropic } from '@ai-sdk/anthropic';
import type { LlmConnection } from '@maka/core/llm-connections';

import type { MakaTool } from './tool-runtime.js';

export type AiSdkToolExecute = (
  args: unknown,
  ctx: { toolCallId: string; abortSignal: AbortSignal },
) => Promise<unknown>;

interface CompileProviderToolInput {
  connection: LlmConnection;
  tool: MakaTool;
  execute: AiSdkToolExecute;
}

/**
 * Compile one provider-neutral Maka tool into the strongest compatible AI SDK
 * declaration. The executor is always Maka's permission/telemetry wrapper.
 */
export function compileProviderTool(input: CompileProviderToolInput): Record<string, unknown> {
  const { connection, tool, execute } = input;
  const fallback = {
    description: tool.description,
    inputSchema: tool.parameters,
    execute,
    ...(tool.toModelOutput ? { toModelOutput: tool.toModelOutput } : {}),
  };
  const binding = tool.providerBinding;
  if (!binding || binding.kind !== 'computer' || binding.environment !== 'desktop') {
    return fallback;
  }

  const display = binding.resolveDisplay();
  if (
    !Number.isInteger(display.widthPx)
    || display.widthPx <= 0
    || !Number.isInteger(display.heightPx)
    || display.heightPx <= 0
  ) {
    throw new Error(`invalid computer display contract: ${display.widthPx}x${display.heightPx}`);
  }

  if (binding.wireMode === 'function') {
    return {
      ...fallback,
      description:
        `${tool.description} The current screenshot and every coordinate use exactly `
        + `${display.widthPx}x${display.heightPx} pixels with origin (0,0) at the screenshot top-left. `
        + 'Do not rescale coordinates from a rendered preview.',
    };
  }

  switch (connection.providerType) {
    case 'anthropic':
    case 'claude-subscription': {
      const providerExecute = (
        args: unknown,
        options: { toolCallId: string; abortSignal?: AbortSignal },
      ): Promise<unknown> => execute(args, {
        toolCallId: options.toolCallId,
        abortSignal: options.abortSignal ?? new AbortController().signal,
      });
      return anthropic.tools.computer_20251124({
        displayWidthPx: display.widthPx,
        displayHeightPx: display.heightPx,
        enableZoom: true,
        execute: providerExecute,
        ...(tool.toModelOutput ? { toModelOutput: tool.toModelOutput } : {}),
      }) as Record<string, unknown>;
    }
    default:
      // Google computer_use is browser-only; current OpenAI AI SDK does not
      // expose a client-executed desktop provider tool. Keep the shared function
      // adapter explicit and bind its concrete coordinate space in the prompt.
      return {
        ...fallback,
        description:
          `${tool.description} The current screenshot and every coordinate use exactly `
          + `${display.widthPx}x${display.heightPx} pixels with origin (0,0) at the screenshot top-left. `
          + 'Do not rescale coordinates from a rendered preview.',
      };
  }
}
