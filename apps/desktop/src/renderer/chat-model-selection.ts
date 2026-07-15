import type { LlmConnection, SessionSummary } from '@maka/core';
import { CODEX_SUBSCRIPTION_UNSUPPORTED_CHATGPT_MODELS } from '@maka/core';
import type { ChatModelChoice } from '@maka/ui';
import { buildCatalogChatModelChoices } from './model-catalog-choices';

export function buildChatModelChoices(connections: readonly LlmConnection[]): ChatModelChoice[] {
  return buildCatalogChatModelChoices(connections);
}

export function normalizeActiveChatModel(
  session: SessionSummary | undefined,
  connection: LlmConnection | undefined,
  choices: readonly ChatModelChoice[],
): string | undefined {
  if (!session || session.backend === 'fake') return undefined;
  const requested = session.model || connection?.defaultModel;
  const matchingChoice = choices.find(
    (choice) => choice.connectionSlug === session.llmConnectionSlug && choice.model === requested,
  );
  if (matchingChoice) return matchingChoice.model;
  if (
    connection?.providerType === 'openai-codex' &&
    requested &&
    CODEX_SUBSCRIPTION_UNSUPPORTED_CHATGPT_MODELS.has(requested)
  ) {
    return choices.find((choice) => choice.connectionSlug === session.llmConnectionSlug)?.model;
  }
  return requested;
}

export function chatModelChoiceLabel(
  choices: readonly ChatModelChoice[],
  connectionSlug: string | undefined,
  model: string | undefined,
): string | undefined {
  if (!connectionSlug || !model) return model;
  return choices.find((choice) => choice.connectionSlug === connectionSlug && choice.model === model)?.label ?? model;
}
