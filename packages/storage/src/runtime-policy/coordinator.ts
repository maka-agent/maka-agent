import {
  decodeCredentialLocator,
  decodeCredentialVersionBasis,
  decodeRuntimePolicyEntityId,
  normalizeDeleteCredentialInput,
  normalizeRemoveCatalogConnectionInput,
  normalizeSetCredentialInput,
  type ConnectionCatalogEntry,
  type CreateCatalogConnectionInput,
  type CredentialLocator,
  type CredentialStatus,
  type CredentialVersionBasis,
  type DeleteCredentialInput,
  type MutateRuntimePolicyInput,
  type RemoveCatalogConnectionInput,
  type RuntimePolicy,
  type SetCredentialInput,
  type SetDefaultConnectionTargetInput,
  type UpdateCatalogConnectionInput,
} from '@maka/core/runtime-policy';
import { deriveProviderAuthContract, type ProviderAuthAction } from '@maka/core/provider-auth';
import { effectiveBaseUrl, PROVIDER_DEFAULTS, type ProviderType } from '@maka/core/llm-connections';
import { deepFreeze, record } from './codec.js';
import {
  catalogSnapshot,
  connectionBasis,
  ConnectionCatalogDocumentOwner,
  findConnection,
} from './connection-catalog-document.js';
import {
  credentialMaterial,
  credentialStatus,
  CredentialVaultDocumentOwner,
  findCredential,
  parseSecret,
  sameCredentialBasis,
  sameCredentialStatus,
  vaultSnapshot,
} from './credential-vault-document.js';
import { cleanupRuntimePolicyDocumentTemps } from './document-io.js';
import {
  codecError,
  decodeConnectionInput,
  decodeCredentialInput,
  RuntimePolicyStoreError,
  type CodecSource,
} from './errors.js';
import {
  connectionCredentialLocator,
  type BeginConnectionTestResult,
  type BeginModelFetchResult,
  type BeginStoredOAuthRefreshResult,
  type CompletionChangedDomain,
  type ConnectionTestCompletionResult,
  type ConnectionTestResult,
  type ConnectionTestTicket,
  type CredentialStatusQueryResult,
  type ModelFetchCompletionResult,
  type ModelFetchResult,
  type ModelFetchTicket,
  type RuntimePolicyCredentialMaterial,
  type RuntimePolicyOperationSecretMaterial,
  type StoredOAuthRefreshCompletionResult,
  type StoredOAuthRefreshResult,
  type StoredOAuthRefreshTicket,
} from './operations.js';
import { policySnapshot, RuntimePolicyDocumentOwner } from './policy-document.js';

type RootExecutor = <T>(operation: (root: string) => Promise<T>) => Promise<T>;
type TicketKind = 'model_fetch' | 'connection_test' | 'stored_oauth_refresh';
type TicketState = 'available' | 'in_flight' | 'consumed';

type EffectiveProxyConfigurationBasis =
  | { readonly kind: 'direct' }
  | {
      readonly kind: 'proxy';
      readonly protocol: RuntimePolicy['networkProxy']['protocol'];
      readonly host: string;
      readonly port: number;
      readonly authentication:
        | { readonly kind: 'none' }
        | { readonly kind: 'credentials'; readonly username: string };
      readonly bypassList: readonly string[];
      readonly autoBypassDomains: readonly string[];
    };

interface SemanticConnectionBasis {
  readonly connectionId: string;
  readonly providerType: ProviderType;
  readonly effectiveEndpoint: string;
  readonly credential: CredentialStatus | null;
  readonly effectiveProxy: EffectiveProxyConfigurationBasis;
  readonly proxyCredential: CredentialStatus | null;
}

interface ConnectionTicketRecord<K extends 'model_fetch' | 'connection_test'> {
  readonly kind: K;
  readonly basis: SemanticConnectionBasis;
  readonly issuance: object;
  state: TicketState;
}

interface OAuthTicketRecord {
  readonly kind: 'stored_oauth_refresh';
  readonly connectionId: string;
  readonly providerType: ProviderType;
  readonly credentialBasis: CredentialVersionBasis;
  state: TicketState;
}

type TicketRecord =
  | ConnectionTicketRecord<'model_fetch'>
  | ConnectionTicketRecord<'connection_test'>
  | OAuthTicketRecord;

type BeginPreparationFailure =
  | { readonly kind: 'connection_not_found' }
  | { readonly kind: 'connection_disabled' }
  | {
      readonly kind: 'provider_action_unavailable';
      readonly availability: 'hidden' | 'preview_only';
    }
  | { readonly kind: 'credential_not_configured'; readonly status: CredentialStatus };

interface PreparedConnectionOperation {
  readonly kind: 'ready';
  readonly connection: ConnectionCatalogEntry;
  readonly connectionCredentialStatus: CredentialStatus | null;
  readonly proxyCredentialStatus: CredentialStatus | null;
  readonly secretMaterial: RuntimePolicyOperationSecretMaterial;
  readonly networkProxy: RuntimePolicy['networkProxy'];
}

export class RuntimePolicyCoordinator {
  private readonly lane = new MutationLane();
  private readonly policy = new RuntimePolicyDocumentOwner();
  private readonly catalog = new ConnectionCatalogDocumentOwner();
  private readonly vault = new CredentialVaultDocumentOwner();
  private readonly tickets = new WeakMap<object, TicketRecord>();
  private readonly latestModelFetchIssuance = new Map<string, object>();
  private readonly latestConnectionTestIssuance = new Map<string, object>();

  constructor(private readonly execute: RootExecutor) {}

  recoverForWrite(): Promise<void> {
    return this.inLane((root) => cleanupRuntimePolicyDocumentTemps(root));
  }

  getPolicySnapshot() {
    return this.execute(async (root) => policySnapshot(await this.policy.read(root)));
  }

  getCatalogSnapshot() {
    return this.execute(async (root) => catalogSnapshot(await this.catalog.read(root)));
  }

  getVaultSnapshot() {
    return this.execute(async (root) => vaultSnapshot(await this.vault.read(root)));
  }

  getCredentialStatus(rawLocator: CredentialLocator): Promise<CredentialStatusQueryResult> {
    return this.execute(async (root) => {
      const locator = decodeCredentialInput(() => decodeCredentialLocator(rawLocator));
      if (!(await this.validateConnectionCredentialLocator(root, locator))) {
        return deepFreeze({ kind: 'connection_not_found' as const });
      }
      const status = credentialStatus(await this.vault.read(root), locator);
      return deepFreeze({ kind: 'status' as const, status });
    });
  }

  mutatePolicy(input: MutateRuntimePolicyInput) {
    return this.inLane((root) => this.policy.mutate(root, input));
  }

  createConnection(input: CreateCatalogConnectionInput) {
    return this.inLane((root) => this.catalog.create(root, input));
  }

  updateConnection(input: UpdateCatalogConnectionInput) {
    return this.inLane((root) => this.catalog.update(root, input));
  }

  removeConnection(rawInput: RemoveCatalogConnectionInput) {
    return this.inLane(async (root) => {
      const { expected } = decodeConnectionInput(() =>
        normalizeRemoveCatalogConnectionInput(rawInput),
      );
      const catalog = await this.catalog.read(root);
      const connection = findConnection(catalog, expected);
      if (connection && connection.revision !== expected.revision) {
        return deepFreeze({
          kind: 'connection_stale' as const,
          expected,
          actual: connectionBasis(connection),
        });
      }

      const vault = await this.vault.read(root);
      await this.vault.deleteConnectionCredentials(root, vault, expected.connectionId);
      if (!connection) {
        this.revokeConnectionIssuances(expected.connectionId);
        return deepFreeze({ kind: 'committed' as const, snapshot: catalogSnapshot(catalog) });
      }
      const result = await this.catalog.remove(root, { expected });
      if (result.kind === 'committed') {
        this.revokeConnectionIssuances(expected.connectionId);
      }
      return result;
    });
  }

  setDefaultTarget(input: SetDefaultConnectionTargetInput) {
    return this.inLane((root) => this.catalog.setDefaultTarget(root, input));
  }

  setCredential(rawInput: SetCredentialInput) {
    return this.inLane(async (root) => {
      const input = decodeCredentialInput(() => normalizeSetCredentialInput(rawInput));
      const { locator } = input;
      if (!(await this.validateConnectionCredentialLocator(root, locator))) {
        return deepFreeze({ kind: 'connection_not_found' as const });
      }
      return this.vault.set(root, input);
    });
  }

  deleteCredential(rawInput: DeleteCredentialInput) {
    return this.inLane(async (root) => {
      const { expected } = decodeCredentialInput(() => normalizeDeleteCredentialInput(rawInput));
      if (!(await this.validateConnectionCredentialLocator(root, expected.locator))) {
        return deepFreeze({ kind: 'connection_not_found' as const });
      }
      return this.vault.delete(root, { expected });
    });
  }

  beginModelFetch(rawConnectionId: string): Promise<BeginModelFetchResult> {
    return this.inLane(async (root) => {
      const connectionId = decodeConnectionInput(() =>
        decodeRuntimePolicyEntityId(rawConnectionId),
      );
      const prepared = await this.prepareConnectionOperation(root, connectionId, 'fetch_models');
      if (prepared.kind !== 'ready') return prepared;
      const issuance = createIssuanceIdentity();
      const ticket = this.issueConnectionTicket(
        'model_fetch',
        semanticConnectionBasis(prepared),
        issuance,
      ) as ModelFetchTicket;
      this.latestModelFetchIssuance.set(connectionId, issuance);
      return deepFreeze({
        kind: 'ready' as const,
        ticket,
        connection: structuredClone(prepared.connection),
        secretMaterial: prepared.secretMaterial,
        networkProxy: structuredClone(prepared.networkProxy),
      });
    });
  }

  async completeModelFetch(
    ticket: ModelFetchTicket,
    result: ModelFetchResult,
  ): Promise<ModelFetchCompletionResult> {
    const claimed = this.claimTicket(ticket, 'model_fetch', 'invalid_connection_input');
    return this.completeLatestIssuedTicket(claimed, this.latestModelFetchIssuance, () =>
      this.inLane(async (root) => {
        if (this.latestModelFetchIssuance.get(claimed.basis.connectionId) !== claimed.issuance) {
          return deepFreeze({ kind: 'superseded' as const });
        }
        const catalog = await this.catalog.read(root);
        const checked = await this.checkSemanticConnectionBasis(root, catalog, claimed.basis);
        if (checked.changed.length > 0 || !checked.connection) {
          return deepFreeze({ kind: 'stale' as const, changed: checked.changed });
        }
        const snapshot = await this.catalog.writeModelFetchResult(
          root,
          catalog,
          connectionBasis(checked.connection),
          result,
        );
        return deepFreeze({ kind: 'committed' as const, snapshot });
      }),
    );
  }

  beginConnectionTest(rawConnectionId: string): Promise<BeginConnectionTestResult> {
    return this.inLane(async (root) => {
      const connectionId = decodeConnectionInput(() =>
        decodeRuntimePolicyEntityId(rawConnectionId),
      );
      const prepared = await this.prepareConnectionOperation(
        root,
        connectionId,
        'test_credentials',
      );
      if (prepared.kind !== 'ready') return prepared;
      const issuance = createIssuanceIdentity();
      const ticket = this.issueConnectionTicket(
        'connection_test',
        semanticConnectionBasis(prepared),
        issuance,
      ) as ConnectionTestTicket;
      this.latestConnectionTestIssuance.set(connectionId, issuance);
      return deepFreeze({
        kind: 'ready' as const,
        ticket,
        connection: structuredClone(prepared.connection),
        secretMaterial: prepared.secretMaterial,
        networkProxy: structuredClone(prepared.networkProxy),
      });
    });
  }

  async completeConnectionTest(
    ticket: ConnectionTestTicket,
    result: ConnectionTestResult,
  ): Promise<ConnectionTestCompletionResult> {
    const claimed = this.claimTicket(ticket, 'connection_test', 'invalid_connection_input');
    return this.completeLatestIssuedTicket(claimed, this.latestConnectionTestIssuance, () =>
      this.inLane(async (root) => {
        if (
          this.latestConnectionTestIssuance.get(claimed.basis.connectionId) !== claimed.issuance
        ) {
          return deepFreeze({ kind: 'superseded' as const });
        }
        const catalog = await this.catalog.read(root);
        const checked = await this.checkSemanticConnectionBasis(root, catalog, claimed.basis);
        if (checked.changed.length > 0 || !checked.connection) {
          return deepFreeze({ kind: 'stale' as const, changed: checked.changed });
        }
        const snapshot = await this.catalog.writeConnectionTestResult(
          root,
          catalog,
          connectionBasis(checked.connection),
          result,
        );
        return deepFreeze({ kind: 'committed' as const, snapshot });
      }),
    );
  }

  beginStoredOAuthRefresh(rawConnectionId: string): Promise<BeginStoredOAuthRefreshResult> {
    return this.inLane(async (root) => {
      const connectionId = decodeCredentialInput(() =>
        decodeRuntimePolicyEntityId(rawConnectionId),
      );
      const prepared = await this.prepareConnectionOperation(root, connectionId, 'refresh_oauth');
      if (prepared.kind !== 'ready') return prepared;
      const material = prepared.secretMaterial.connection;
      const status = prepared.connectionCredentialStatus;
      if (!material || !status?.configured || material.locator.kind !== 'oauth_token') {
        throw codecError(
          'invalid_document',
          'OAuth refresh admission produced no OAuth credential',
        );
      }
      const ticket = this.issueOAuthTicket(
        connectionId,
        prepared.connection.providerType,
        credentialVersionBasis(material),
      );
      return deepFreeze({
        kind: 'ready' as const,
        ticket,
        connection: structuredClone(prepared.connection),
        secretMaterial: prepared.secretMaterial as RuntimePolicyOperationSecretMaterial & {
          readonly connection: RuntimePolicyCredentialMaterial;
        },
        networkProxy: structuredClone(prepared.networkProxy),
      });
    });
  }

  async completeStoredOAuthRefresh(
    ticket: StoredOAuthRefreshTicket,
    result: StoredOAuthRefreshResult,
  ): Promise<StoredOAuthRefreshCompletionResult> {
    const claimed = this.claimTicket(ticket, 'stored_oauth_refresh', 'invalid_credential_input');
    return this.completeClaimedTicket(claimed, () =>
      this.inLane(async (root) => {
        const secretInput = record(
          result,
          'stored OAuth refresh result',
          'invalid_credential_input',
          ['secret'],
        );
        const secret = parseSecret(secretInput.secret, 'stored OAuth refresh secret');
        const catalog = await this.catalog.read(root);
        const connection = findConnection(catalog, { connectionId: claimed.connectionId });
        const changed: CompletionChangedDomain[] = [];
        if (
          !connection ||
          connection.providerType !== claimed.providerType ||
          !isOAuthCredentialForConnection(claimed.credentialBasis, connection)
        ) {
          changed.push('connection');
        }
        const vault = await this.vault.read(root);
        if (
          !sameCredentialBasis(
            findCredential(vault, claimed.credentialBasis.locator),
            claimed.credentialBasis,
          )
        ) {
          changed.push('credential');
        }
        if (changed.length > 0) return deepFreeze({ kind: 'stale' as const, changed });
        const snapshot = await this.vault.writeRefresh(
          root,
          vault,
          claimed.credentialBasis,
          secret,
        );
        return deepFreeze({ kind: 'committed' as const, snapshot });
      }),
    );
  }

  private async prepareConnectionOperation(
    root: string,
    connectionId: string,
    action: ProviderAuthAction,
  ): Promise<PreparedConnectionOperation | BeginPreparationFailure> {
    const catalog = await this.catalog.read(root);
    const connection = findConnection(catalog, { connectionId });
    if (!connection) return deepFreeze({ kind: 'connection_not_found' as const });
    if (!connection.enabled) return deepFreeze({ kind: 'connection_disabled' as const });

    const inherentContract = deriveProviderAuthContract({
      providerType: connection.providerType,
      enabled: true,
      hasSecret: true,
      lastTestStatus: connection.lastTest?.status,
    });
    const availability = inherentContract.actionAvailability[action];
    if (availability !== 'available') {
      return deepFreeze({ kind: 'provider_action_unavailable' as const, availability });
    }

    const authKind = PROVIDER_DEFAULTS[connection.providerType].authKind;
    const locator = connectionCredentialLocator(connectionId, authKind);
    const policy = await this.policy.read(root);
    const networkProxy = structuredClone(policy.policy.networkProxy);
    const proxyLocator = requiresNetworkProxyCredential(networkProxy)
      ? networkProxyCredentialLocator()
      : null;
    let connectionCredentialStatus: CredentialStatus | null = null;
    let proxyCredentialStatus: CredentialStatus | null = null;
    const secretMaterial: {
      connection?: RuntimePolicyCredentialMaterial;
      networkProxy?: RuntimePolicyCredentialMaterial;
    } = {};

    if (locator || proxyLocator) {
      const vault = await this.vault.read(root);
      if (locator) {
        connectionCredentialStatus = credentialStatus(vault, locator);
        const entry = findCredential(vault, locator);
        if (!entry) {
          if (inherentContract.requiresSecret) {
            return deepFreeze({
              kind: 'credential_not_configured' as const,
              status: connectionCredentialStatus,
            });
          }
        } else {
          secretMaterial.connection = credentialMaterial(entry);
        }
      }
      if (proxyLocator) {
        proxyCredentialStatus = credentialStatus(vault, proxyLocator);
        const entry = findCredential(vault, proxyLocator);
        if (!entry) {
          return deepFreeze({
            kind: 'credential_not_configured' as const,
            status: proxyCredentialStatus,
          });
        }
        secretMaterial.networkProxy = credentialMaterial(entry);
      }
    }

    return {
      kind: 'ready',
      connection,
      connectionCredentialStatus,
      proxyCredentialStatus,
      secretMaterial,
      networkProxy,
    };
  }

  private async validateConnectionCredentialLocator(
    root: string,
    locator: CredentialLocator,
  ): Promise<boolean> {
    if (locator.scope !== 'connection') return true;
    const catalog = await this.catalog.read(root);
    const connection = findConnection(catalog, locator);
    if (!connection) return false;
    const required = connectionCredentialLocator(
      connection.connectionId,
      PROVIDER_DEFAULTS[connection.providerType].authKind,
    );
    if (!required || required.kind !== locator.kind) {
      throw codecError(
        'invalid_credential_input',
        'Connection credential kind does not match the provider auth contract',
      );
    }
    return true;
  }

  private async checkSemanticConnectionBasis(
    root: string,
    catalog: Awaited<ReturnType<ConnectionCatalogDocumentOwner['read']>>,
    basis: SemanticConnectionBasis,
  ): Promise<{
    readonly connection: ConnectionCatalogEntry | undefined;
    readonly changed: CompletionChangedDomain[];
  }> {
    const connection = findConnection(catalog, { connectionId: basis.connectionId });
    const changed: CompletionChangedDomain[] = [];
    const policy = await this.policy.read(root);
    if (
      !connection ||
      connection.providerType !== basis.providerType ||
      canonicalEffectiveEndpoint(connection) !== basis.effectiveEndpoint
    ) {
      changed.push('connection');
    }
    if (
      !sameEffectiveProxyConfiguration(
        effectiveProxyConfigurationBasis(policy.policy.networkProxy),
        basis.effectiveProxy,
      )
    ) {
      changed.push('runtime_policy');
    }
    const expectedConnectionCredential = basis.credential;
    const expectedProxyCredential = basis.proxyCredential;
    if ((connection && expectedConnectionCredential) || expectedProxyCredential) {
      const vault = await this.vault.read(root);
      const connectionCredentialChanged = Boolean(
        connection &&
          expectedConnectionCredential &&
          !sameCredentialStatus(
            credentialStatus(vault, expectedConnectionCredential.locator),
            expectedConnectionCredential,
          ),
      );
      const proxyCredentialChanged = Boolean(
        expectedProxyCredential &&
          !sameCredentialStatus(
            credentialStatus(vault, expectedProxyCredential.locator),
            expectedProxyCredential,
          ),
      );
      if (connectionCredentialChanged || proxyCredentialChanged) {
        changed.push('credential');
      }
    }
    return { connection, changed };
  }

  private issueConnectionTicket(
    kind: ConnectionTicketRecord<'model_fetch' | 'connection_test'>['kind'],
    basis: SemanticConnectionBasis,
    issuance: object,
  ): object {
    const ticket = Object.freeze(Object.create(null)) as object;
    if (kind === 'model_fetch') {
      this.tickets.set(ticket, { kind: 'model_fetch', basis, issuance, state: 'available' });
    } else {
      this.tickets.set(ticket, { kind: 'connection_test', basis, issuance, state: 'available' });
    }
    return ticket;
  }

  private issueOAuthTicket(
    connectionId: string,
    providerType: ProviderType,
    credentialBasis: CredentialVersionBasis,
  ): StoredOAuthRefreshTicket {
    const ticket = Object.freeze(Object.create(null)) as object;
    this.tickets.set(ticket, {
      kind: 'stored_oauth_refresh',
      connectionId,
      providerType,
      credentialBasis,
      state: 'available',
    });
    return ticket as StoredOAuthRefreshTicket;
  }

  private claimTicket<K extends TicketKind>(
    ticket: object,
    expectedKind: K,
    source: CodecSource,
  ): Extract<TicketRecord, { kind: K }> {
    const ticketRecord =
      ticket && typeof ticket === 'object' ? this.tickets.get(ticket) : undefined;
    if (!ticketRecord || ticketRecord.kind !== expectedKind || ticketRecord.state !== 'available') {
      throw codecError(
        source,
        `Expected an authentic available ${ticketLabel(expectedKind)} ticket`,
      );
    }
    ticketRecord.state = 'in_flight';
    return ticketRecord as Extract<TicketRecord, { kind: K }>;
  }

  private async completeClaimedTicket<T>(
    ticket: TicketRecord,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      const result = await operation();
      ticket.state = 'consumed';
      return result;
    } catch (error) {
      ticket.state =
        error instanceof RuntimePolicyStoreError && error.code === 'io_failed'
          ? 'available'
          : 'consumed';
      throw error;
    }
  }

  private async completeLatestIssuedTicket<T>(
    ticket: ConnectionTicketRecord<'model_fetch'> | ConnectionTicketRecord<'connection_test'>,
    latestIssuance: Map<string, object>,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await this.completeClaimedTicket(ticket, operation);
    } finally {
      if (
        ticket.state === 'consumed' &&
        latestIssuance.get(ticket.basis.connectionId) === ticket.issuance
      ) {
        latestIssuance.delete(ticket.basis.connectionId);
      }
    }
  }

  private revokeConnectionIssuances(connectionId: string): void {
    this.latestModelFetchIssuance.delete(connectionId);
    this.latestConnectionTestIssuance.delete(connectionId);
  }

  private inLane<T>(operation: (root: string) => Promise<T>): Promise<T> {
    const reservation = this.lane.reserve();
    let entered = false;
    let execution: Promise<T>;
    try {
      execution = this.execute(async (root) => {
        entered = true;
        await reservation.ready;
        try {
          return await operation(root);
        } finally {
          reservation.release();
        }
      });
    } catch (error) {
      reservation.release();
      throw error;
    }
    return execution.finally(() => {
      if (!entered) reservation.release();
    });
  }
}

interface MutationReservation {
  readonly ready: Promise<void>;
  release(): void;
}

class MutationLane {
  private tail: Promise<void> = Promise.resolve();

  reserve(): MutationReservation {
    const ready = this.tail;
    let resolve!: () => void;
    this.tail = new Promise<void>((release) => {
      resolve = release;
    });
    let released = false;
    return {
      ready,
      release: () => {
        if (released) return;
        released = true;
        resolve();
      },
    };
  }
}

function semanticConnectionBasis(prepared: PreparedConnectionOperation): SemanticConnectionBasis {
  return {
    connectionId: prepared.connection.connectionId,
    providerType: prepared.connection.providerType,
    effectiveEndpoint: canonicalEffectiveEndpoint(prepared.connection),
    credential: prepared.connectionCredentialStatus,
    effectiveProxy: effectiveProxyConfigurationBasis(prepared.networkProxy),
    proxyCredential: prepared.proxyCredentialStatus,
  };
}

function canonicalEffectiveEndpoint(connection: ConnectionCatalogEntry): string {
  const endpoint = effectiveBaseUrl(connection);
  if (!endpoint) return '';
  try {
    return new URL(endpoint).toString();
  } catch {
    throw codecError('invalid_document', 'Connection has an invalid effective endpoint');
  }
}

function effectiveProxyConfigurationBasis(
  networkProxy: RuntimePolicy['networkProxy'],
): EffectiveProxyConfigurationBasis {
  if (!networkProxy.enabled) return { kind: 'direct' };
  return {
    kind: 'proxy',
    protocol: networkProxy.protocol,
    host: networkProxy.host.trim().toLowerCase(),
    port: networkProxy.port,
    authentication: networkProxy.authEnabled
      ? { kind: 'credentials', username: networkProxy.username }
      : { kind: 'none' },
    bypassList: normalizeProxyPatterns(networkProxy.bypassList),
    autoBypassDomains: normalizeProxyPatterns(networkProxy.autoBypassDomains),
  };
}

function sameEffectiveProxyConfiguration(
  actual: EffectiveProxyConfigurationBasis,
  expected: EffectiveProxyConfigurationBasis,
): boolean {
  if (actual.kind !== expected.kind) return false;
  if (actual.kind === 'direct' || expected.kind === 'direct') return true;
  return (
    actual.protocol === expected.protocol &&
    actual.host === expected.host &&
    actual.port === expected.port &&
    sameProxyAuthentication(actual.authentication, expected.authentication) &&
    sameStringArray(actual.bypassList, expected.bypassList) &&
    sameStringArray(actual.autoBypassDomains, expected.autoBypassDomains)
  );
}

function sameProxyAuthentication(
  actual: Extract<EffectiveProxyConfigurationBasis, { kind: 'proxy' }>['authentication'],
  expected: Extract<EffectiveProxyConfigurationBasis, { kind: 'proxy' }>['authentication'],
): boolean {
  if (actual.kind !== expected.kind) return false;
  return (
    actual.kind === 'none' ||
    (expected.kind === 'credentials' && actual.username === expected.username)
  );
}

function normalizeProxyPatterns(patterns: readonly string[]): readonly string[] {
  return [
    ...new Set(
      patterns
        .map((pattern) => pattern.trim().toLowerCase())
        .filter((pattern) => pattern.length > 0),
    ),
  ].sort();
}

function sameStringArray(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length && actual.every((value, index) => value === expected[index])
  );
}

function credentialVersionBasis(material: RuntimePolicyCredentialMaterial): CredentialVersionBasis {
  return {
    locator: structuredClone(material.locator),
    credentialId: material.credentialId,
    revision: material.revision,
  };
}

function isOAuthCredentialForConnection(
  basis: CredentialVersionBasis,
  connection: ConnectionCatalogEntry,
): boolean {
  const locator = connectionCredentialLocator(
    connection.connectionId,
    PROVIDER_DEFAULTS[connection.providerType].authKind,
  );
  return (
    locator?.kind === 'oauth_token' &&
    basis.locator.scope === 'connection' &&
    basis.locator.connectionId === connection.connectionId &&
    basis.locator.kind === locator.kind
  );
}

function createIssuanceIdentity(): object {
  return Object.freeze(Object.create(null)) as object;
}

function ticketLabel(kind: TicketKind): string {
  switch (kind) {
    case 'model_fetch':
      return 'model fetch';
    case 'connection_test':
      return 'connection test';
    case 'stored_oauth_refresh':
      return 'stored OAuth refresh';
  }
}

function networkProxyCredentialLocator(): Extract<CredentialLocator, { scope: 'network_proxy' }> {
  return { scope: 'network_proxy', kind: 'password' };
}

function requiresNetworkProxyCredential(networkProxy: RuntimePolicy['networkProxy']): boolean {
  return networkProxy.enabled && networkProxy.authEnabled;
}
