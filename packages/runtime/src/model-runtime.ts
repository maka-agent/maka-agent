import {
  PROVIDER_DEFAULTS,
  effectiveBaseUrl,
  type LlmConnection,
  type ModelInfo,
  type ProviderRuntimeAdapter,
} from '@maka/core/llm-connections';
import { lookupModelProviderOverride } from '@maka/core/model-metadata';

export interface ResolvedModelRuntime {
  adapter: ProviderRuntimeAdapter;
  baseUrl: string;
  /** Account-advertised request wire for adapters that route per model. */
  apiProtocol?: ModelInfo['apiProtocol'];
}

export function resolveModelRuntime(
  connection: LlmConnection,
  modelId: string,
): ResolvedModelRuntime {
  const override = lookupModelProviderOverride(connection.providerType, modelId);
  const defaults = PROVIDER_DEFAULTS[connection.providerType];
  // Unknown providerType with no per-model override → can't resolve an adapter.
  // Throw a clear error rather than crashing on `.runtimeAdapter`. Mirrors
  // `isFakeBackend` in @maka/core/connection-readiness.ts.
  if (!override && !defaults) {
    throw new Error(
      `Unknown provider type "${connection.providerType}"; cannot resolve model runtime.`,
    );
  }
  const adapter = override ? runtimeAdapterOverride(override.npm) : defaults.runtimeAdapter;
  const configuredBaseUrl = connection.baseUrl?.trim();
  const apiProtocol = connection.models?.find((model) => model.id === modelId)?.apiProtocol;
  return {
    adapter,
    baseUrl: configuredBaseUrl
      ? effectiveBaseUrl(connection)
      : (override?.api ?? effectiveBaseUrl(connection)),
    ...(apiProtocol ? { apiProtocol } : {}),
  };
}

function runtimeAdapterOverride(packageName: string): ProviderRuntimeAdapter {
  switch (packageName) {
    case '@ai-sdk/anthropic':
      return { kind: 'anthropic', auth: 'api-key', normalizeBaseUrl: true };
    case '@ai-sdk/google':
      return { kind: 'google', normalizeBaseUrl: false };
    case '@ai-sdk/openai':
      return { kind: 'openai' };
    case '@ai-sdk/openai-compatible':
      return { kind: 'openai-compatible', name: 'provider' };
    default:
      throw new Error(`models.dev model runtime package ${packageName} is unsupported`);
  }
}
