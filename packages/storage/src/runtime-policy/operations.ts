import type {
  ConnectionCatalogEntry,
  ConnectionCatalogSnapshot,
  ConnectionModelDiscoveryResult,
  ConnectionTestSummary,
  CredentialLocator,
  CredentialStatus,
  CredentialVaultSnapshot,
  CredentialVersionBasis,
  RuntimePolicy,
} from '@maka/core/runtime-policy';
import type { ProviderAuthActionAvailability } from '@maka/core/provider-auth';
import type { ProviderDefaults } from '@maka/core/llm-connections';

declare const operationTicketBrand: unique symbol;

export type ProviderAuthKind = ProviderDefaults['authKind'];
export type CompletionChangedDomain = 'connection' | 'credential' | 'runtime_policy';
export type UnavailableProviderActionAvailability = Exclude<
  ProviderAuthActionAvailability,
  'available'
>;

export interface RuntimePolicyCredentialMaterial extends CredentialVersionBasis {
  readonly secret: string;
}

export interface RuntimePolicyOperationSecretMaterial {
  readonly connection?: RuntimePolicyCredentialMaterial;
  readonly networkProxy?: RuntimePolicyCredentialMaterial;
}

export type CredentialStatusQueryResult =
  | { readonly kind: 'status'; readonly status: CredentialStatus }
  | { readonly kind: 'connection_not_found' };

export interface ModelFetchTicket {
  readonly [operationTicketBrand]: 'model_fetch';
}

export interface ConnectionTestTicket {
  readonly [operationTicketBrand]: 'connection_test';
}

export interface StoredOAuthRefreshTicket {
  readonly [operationTicketBrand]: 'stored_oauth_refresh';
}

export type ModelFetchResult = ConnectionModelDiscoveryResult;
export type ConnectionTestResult = ConnectionTestSummary;

export interface StoredOAuthRefreshResult {
  readonly secret: string;
}

export type BeginModelFetchResult =
  | { readonly kind: 'connection_not_found' }
  | { readonly kind: 'connection_disabled' }
  | {
      readonly kind: 'provider_action_unavailable';
      readonly availability: UnavailableProviderActionAvailability;
    }
  | { readonly kind: 'credential_not_configured'; readonly status: CredentialStatus }
  | {
      readonly kind: 'ready';
      readonly ticket: ModelFetchTicket;
      readonly connection: ConnectionCatalogEntry;
      readonly secretMaterial: RuntimePolicyOperationSecretMaterial;
      readonly networkProxy: RuntimePolicy['networkProxy'];
    };

export type BeginConnectionTestResult =
  | { readonly kind: 'connection_not_found' }
  | { readonly kind: 'connection_disabled' }
  | {
      readonly kind: 'provider_action_unavailable';
      readonly availability: UnavailableProviderActionAvailability;
    }
  | { readonly kind: 'credential_not_configured'; readonly status: CredentialStatus }
  | {
      readonly kind: 'ready';
      readonly ticket: ConnectionTestTicket;
      readonly connection: ConnectionCatalogEntry;
      readonly secretMaterial: RuntimePolicyOperationSecretMaterial;
      readonly networkProxy: RuntimePolicy['networkProxy'];
    };

export type BeginStoredOAuthRefreshResult =
  | { readonly kind: 'connection_not_found' }
  | { readonly kind: 'connection_disabled' }
  | {
      readonly kind: 'provider_action_unavailable';
      readonly availability: UnavailableProviderActionAvailability;
    }
  | { readonly kind: 'credential_not_configured'; readonly status: CredentialStatus }
  | {
      readonly kind: 'ready';
      readonly ticket: StoredOAuthRefreshTicket;
      readonly connection: ConnectionCatalogEntry;
      readonly secretMaterial: RuntimePolicyOperationSecretMaterial & {
        readonly connection: RuntimePolicyCredentialMaterial;
      };
      readonly networkProxy: RuntimePolicy['networkProxy'];
    };

export type ResolveExecutionConnectionResult =
  | { readonly kind: 'not_found' }
  | { readonly kind: 'disabled' }
  | { readonly kind: 'credential_not_configured'; readonly status: CredentialStatus }
  | {
      readonly kind: 'ready';
      readonly connection: ConnectionCatalogEntry;
      readonly secretMaterial: RuntimePolicyOperationSecretMaterial;
      readonly networkProxy: RuntimePolicy['networkProxy'];
    };

export type ModelFetchCompletionResult =
  | { readonly kind: 'committed'; readonly snapshot: ConnectionCatalogSnapshot }
  | { readonly kind: 'stale'; readonly changed: readonly CompletionChangedDomain[] }
  | { readonly kind: 'superseded' };

export type ConnectionTestCompletionResult =
  | { readonly kind: 'committed'; readonly snapshot: ConnectionCatalogSnapshot }
  | { readonly kind: 'stale'; readonly changed: readonly CompletionChangedDomain[] }
  | { readonly kind: 'superseded' };

export type StoredOAuthRefreshCompletionResult =
  | { readonly kind: 'committed'; readonly snapshot: CredentialVaultSnapshot }
  | { readonly kind: 'stale'; readonly changed: readonly CompletionChangedDomain[] };

export interface RuntimePolicyOperationCoordinator {
  resolveExecutionConnection(connectionSlug: string): Promise<ResolveExecutionConnectionResult>;
  beginModelFetch(connectionId: string): Promise<BeginModelFetchResult>;
  completeModelFetch(
    ticket: ModelFetchTicket,
    result: ModelFetchResult,
  ): Promise<ModelFetchCompletionResult>;
  beginConnectionTest(connectionId: string): Promise<BeginConnectionTestResult>;
  completeConnectionTest(
    ticket: ConnectionTestTicket,
    result: ConnectionTestResult,
  ): Promise<ConnectionTestCompletionResult>;
  beginStoredOAuthRefresh(connectionId: string): Promise<BeginStoredOAuthRefreshResult>;
  completeStoredOAuthRefresh(
    ticket: StoredOAuthRefreshTicket,
    result: StoredOAuthRefreshResult,
  ): Promise<StoredOAuthRefreshCompletionResult>;
}

export function connectionCredentialLocator(
  connectionId: string,
  authKind: ProviderAuthKind,
): Extract<CredentialLocator, { scope: 'connection' }> | null {
  switch (authKind) {
    case 'api_key':
    case 'optional_api_key':
      return { scope: 'connection', connectionId, kind: 'api_key' };
    case 'oauth_token':
      return { scope: 'connection', connectionId, kind: 'oauth_token' };
    case 'none':
      return null;
  }
}
