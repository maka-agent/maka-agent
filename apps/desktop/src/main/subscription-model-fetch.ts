import type { LlmConnection } from '@maka/core/llm-connections';
import { buildSubscriptionModelFetch as buildRuntimeSubscriptionModelFetch } from '@maka/runtime';
import {
  type ClaudeSubscriptionService,
  isCloakEnabled,
} from './oauth/claude-subscription-service.js';

interface SubscriptionModelFetchDeps {
  claudeSubscription: ClaudeSubscriptionService;
}

export function createSubscriptionModelFetch(deps: SubscriptionModelFetchDeps) {
  return function buildSubscriptionModelFetch(
    connection: LlmConnection,
    sessionId: string,
    modelId: string,
  ): typeof fetch | undefined {
    if (connection.providerType === 'claude-subscription' && isCloakEnabled()) {
      return buildClaudeSubscriptionCloakedFetch(connection, deps.claudeSubscription, sessionId, modelId);
    }
    if (
      connection.providerType === 'openai-codex'
      || connection.providerType === 'github-copilot'
    ) {
      return buildRuntimeSubscriptionModelFetch({ connection, sessionId, modelId });
    }
    return undefined;
  };
}

function buildClaudeSubscriptionCloakedFetch(
  connection: LlmConnection,
  claudeSubscription: ClaudeSubscriptionService,
  sessionId: string,
  modelId: string,
): typeof fetch {
  return async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const [deviceId, accountState] = await Promise.all([
      claudeSubscription.getOrCreateDeviceId(),
      claudeSubscription.getAccountState(),
    ]);
    const modelFetch = buildRuntimeSubscriptionModelFetch({
      connection,
      sessionId,
      modelId,
      fetchFn: fetch,
      claude: {
        cloakEnabled: true,
        deviceId,
        accountUuid: accountState.profile?.accountUuid ?? '',
      },
    });
    return (modelFetch ?? fetch)(url, init);
  };
}
