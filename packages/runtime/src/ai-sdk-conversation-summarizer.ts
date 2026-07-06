import type { ModelMessage } from 'ai';
import type {
  LlmConversationSummarizer,
  LlmConversationSummarizerInput,
} from './history-compact-summarizer.js';

export interface AiSdkGenerateTextOptions {
  model: unknown;
  system: string;
  messages: ModelMessage[];
  maxOutputTokens?: number;
  abortSignal?: AbortSignal;
}

export type AiSdkGenerateTextLike = (
  options: AiSdkGenerateTextOptions,
) => Promise<{ text: string }>;

export interface CreateAiSdkConversationSummarizerOptions {
  resolveModel: () => unknown;
  maxOutputTokens?: number;
  generateText?: AiSdkGenerateTextLike;
}

// Stub: returns empty string so tests RED.
export function createAiSdkConversationSummarizer(
  options: CreateAiSdkConversationSummarizerOptions,
): LlmConversationSummarizer {
  return async (input: LlmConversationSummarizerInput): Promise<string> => {
    const generateText = options.generateText ?? (await loadAiSdkGenerateText());
    const result = await generateText({
      model: options.resolveModel(),
      system: input.system,
      messages: input.messages,
      ...(options.maxOutputTokens !== undefined ? { maxOutputTokens: options.maxOutputTokens } : {}),
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    });
    return result.text;
  };
}

async function loadAiSdkGenerateText(): Promise<AiSdkGenerateTextLike> {
  const ai = await import('ai').catch((err) => {
    throw new Error(`Failed to load 'ai' package for history summarization. Run \`npm install ai\`. Inner: ${(err as Error).message}`);
  });
  const { generateText } = ai as { generateText: AiSdkGenerateTextLike };
  return generateText;
}
