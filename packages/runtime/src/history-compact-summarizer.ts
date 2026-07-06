import type { ModelMessage } from 'ai';
import { buildRuntimeEventModelReplayPlan } from './model-history.js';
import { toolResultOutput } from './ai-sdk-tool-output.js';
import type { HistoryCompactWriteInput } from './ai-sdk-backend.js';

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

export interface BuildLlmHistorySummarizerOptions {
  /** Resolve the AI SDK model used for summarization. Reuses the session model. */
  resolveModel: () => unknown;
  /** Optional cap on the generated summary length. */
  maxOutputTokens?: number;
  /** Injectable `generateText` for tests; defaults to the real AI SDK export. */
  generateText?: AiSdkGenerateTextLike;
}

// Conversation-summarization prompt (sectioned, modelled on pi/opencode):
// asks for a checkpoint another LLM can continue from. Tool calls and their
// results are part of the conversation sent to the summarizer, because the
// folded events are projected with the same policy the model would see them.
const SUMMARIZATION_SYSTEM_PROMPT = [
  'You are a context summarization assistant.',
  'Read the conversation between a user and an AI assistant, then produce a structured summary another LLM will use to continue the same task.',
  'Do NOT continue the conversation. Do NOT answer questions in it. ONLY output the structured summary.',
  '',
  'Use this exact format:',
  '',
  '## Goal',
  '[What the user is trying to accomplish]',
  '',
  '## Progress',
  '### Done',
  '- [Completed work and changes]',
  '### In Progress',
  '- [Current work]',
  '',
  '## Key Decisions',
  '- **[Decision]**: [Brief rationale]',
  '',
  '## Next Steps',
  '1. [Ordered list of what should happen next]',
  '',
  '## Critical Context',
  '- [Files, commands/results, errors, anything needed to continue; or "(none)"]',
  '',
  'Keep each section concise. Preserve exact file paths, function names, commands, and error messages.',
].join('\n');

export function buildLlmHistorySummarizer(options: BuildLlmHistorySummarizerOptions) {
  return async (input: HistoryCompactWriteInput): Promise<string | undefined> => {
    if (input.source.foldedRuntimeEvents.length === 0) return undefined;
    try {
      const plan = buildRuntimeEventModelReplayPlan(input.source.foldedRuntimeEvents);
      const messages = replayPlanItemsToModelMessages(plan.items);
      const generateText = options.generateText ?? (await loadAiSdkGenerateText());
      const result = await generateText({
        model: options.resolveModel(),
        system: SUMMARIZATION_SYSTEM_PROMPT,
        messages,
        ...(options.maxOutputTokens !== undefined ? { maxOutputTokens: options.maxOutputTokens } : {}),
        ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
      });
      return result.text;
    } catch {
      // Fail-open: a summarizer failure returns undefined so the runtime
      // keeps the deterministic draft summary instead of aborting the compact.
      return undefined;
    }
  };
}

async function loadAiSdkGenerateText(): Promise<AiSdkGenerateTextLike> {
  const ai = await import('ai').catch((err) => {
    throw new Error(`Failed to load 'ai' package for history summarization. Run \`npm install ai\`. Inner: ${(err as Error).message}`);
  });
  const { generateText } = ai as { generateText: AiSdkGenerateTextLike };
  return generateText;
}

type ReplayPlanItems = ReturnType<typeof buildRuntimeEventModelReplayPlan>['items'];

function replayPlanItemsToModelMessages(items: ReplayPlanItems): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (const item of items) {
    if (item.kind === 'text') {
      // Split on role so each push matches exactly one ModelMessage arm — no cast.
      const textPart = { type: 'text' as const, text: item.content };
      if (item.role === 'user') {
        out.push({ role: 'user', content: [textPart] });
      } else {
        out.push({ role: 'assistant', content: [textPart] });
      }
    } else if (item.kind === 'tool_call') {
      out.push({
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: item.toolCallId, toolName: item.toolName, input: item.input },
        ],
      });
    } else if (item.kind === 'tool_result') {
      out.push({
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: item.toolCallId, toolName: item.toolName, output: toolResultOutput(item.output, item.isError) }],
      });
    }
    // thinking entries are intentionally skipped for summarization
  }
  return out;
}
