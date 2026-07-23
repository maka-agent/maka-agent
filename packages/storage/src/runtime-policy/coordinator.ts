import {
  decodeConnectionSlug,
  decodeCredentialLocator,
  normalizeDeleteCredentialInput,
  normalizeRemoveCatalogConnectionInput,
  normalizeSetCredentialInput,
  type ConnectionCatalogEntry,
  type CreateCatalogConnectionInput,
  type CredentialLocator,
  type CredentialStatus,
  type DeleteCredentialInput,
  type MutateRuntimePolicyInput,
  type RemoveCatalogConnectionInput,
  type RuntimePolicy,
  type SetCredentialInput,
  type SetDefaultConnectionTargetInput,
  type UpdateCatalogConnectionInput,
} from '@maka/core/runtime-policy';
import { deriveProviderAuthContract } from '@maka/core/provider-auth';
import { PROVIDER_DEFAULTS } from '@maka/core/llm-connections';
import { deepFreeze } from './codec.js';
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
  vaultSnapshot,
} from './credential-vault-document.js';
import { cleanupRuntimePolicyDocumentTemps } from './document-io.js';
import {
  codecError,
  commitOutcomeUnknown,
  decodeConnectionInput,
  decodeCredentialInput,
} from './errors.js';
import {
  connectionCredentialLocator,
  type CredentialStatusQueryResult,
  type RuntimePolicyCredentialMaterial,
  type RuntimePolicyOperationSecretMaterial,
  type ResolveExecutionConnectionResult,
} from './operations.js';
import { policySnapshot, RuntimePolicyDocumentOwner } from './policy-document.js';

type RootExecutor = <T>(operation: (root: string) => Promise<T>) => Promise<T>;

interface PreparedConnectionMaterial {
  readonly kind: 'ready';
  readonly secretMaterial: RuntimePolicyOperationSecretMaterial;
  readonly networkProxy: RuntimePolicy['networkProxy'];
}

export class RuntimePolicyCoordinator {
  private readonly lane = new MutationLane();
  private readonly policy = new RuntimePolicyDocumentOwner();
  private readonly catalog = new ConnectionCatalogDocumentOwner();
  private readonly vault = new CredentialVaultDocumentOwner();

  constructor(private readonly execute: RootExecutor) {}

  recoverForWrite(): Promise<void> {
    return this.inLane(async (root) => {
      await cleanupRuntimePolicyDocumentTemps(root);
      const catalog = await this.catalog.read(root);
      const vault = await this.vault.read(root);
      await this.vault.deleteOrphanedConnectionCredentials(
        root,
        vault,
        new Set(catalog.connections.map((connection) => connection.connectionId)),
      );
    });
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
    return this.inLane(async (root) => {
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
      if (!connection) {
        await this.vault.deleteConnectionCredentials(root, vault, expected.connectionId);
        return deepFreeze({ kind: 'committed' as const, snapshot: catalogSnapshot(catalog) });
      }
      const result = await this.catalog.remove(root, { expected });
      if (result.kind === 'committed') {
        try {
          await this.vault.deleteConnectionCredentials(root, vault, expected.connectionId);
        } catch (error) {
          throw commitOutcomeUnknown(
            'Connection removal committed before credential cleanup completed',
            error,
          );
        }
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
      if (locator.scope === 'connection') {
        const catalog = await this.catalog.read(root);
        const connection = findConnection(catalog, locator);
        if (!connection) {
          return deepFreeze({ kind: 'connection_not_found' as const });
        }
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
        if (locator.kind === 'oauth_token' && connection.providerType !== 'github-copilot') {
          throw codecError(
            'invalid_credential_input',
            'Client-supplied OAuth credentials are only accepted for GitHub Copilot',
          );
        }
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

  resolveExecutionConnection(rawConnectionSlug: string): Promise<ResolveExecutionConnectionResult> {
    return this.inLane(async (root) => {
      const connectionSlug = decodeConnectionInput(() => decodeConnectionSlug(rawConnectionSlug));
      const catalog = await this.catalog.read(root);
      const connection = catalog.connections.find((candidate) => candidate.slug === connectionSlug);
      if (!connection) return deepFreeze({ kind: 'not_found' as const });
      if (!connection.enabled) return deepFreeze({ kind: 'disabled' as const });

      const contract = deriveProviderAuthContract({
        providerType: connection.providerType,
        enabled: true,
        hasSecret: true,
        lastTestStatus: connection.lastTest?.status,
      });
      const prepared = await this.prepareConnectionMaterial(
        root,
        connection,
        contract.requiresSecret,
      );
      if (prepared.kind !== 'ready') return prepared;
      return deepFreeze({
        kind: 'ready' as const,
        connection: structuredClone(connection),
        secretMaterial: prepared.secretMaterial,
        networkProxy: structuredClone(prepared.networkProxy),
      });
    });
  }

  private async prepareConnectionMaterial(
    root: string,
    connection: ConnectionCatalogEntry,
    requiresConnectionSecret: boolean,
  ): Promise<
    | PreparedConnectionMaterial
    | { readonly kind: 'credential_not_configured'; readonly status: CredentialStatus }
  > {
    const authKind = PROVIDER_DEFAULTS[connection.providerType].authKind;
    const locator = connectionCredentialLocator(connection.connectionId, authKind);
    const policy = await this.policy.read(root);
    const networkProxy = structuredClone(policy.policy.networkProxy);
    const proxyLocator = requiresNetworkProxyCredential(networkProxy)
      ? networkProxyCredentialLocator()
      : null;
    const secretMaterial: {
      connection?: RuntimePolicyCredentialMaterial;
      networkProxy?: RuntimePolicyCredentialMaterial;
    } = {};

    if (locator || proxyLocator) {
      const vault = await this.vault.read(root);
      if (locator) {
        const status = credentialStatus(vault, locator);
        const entry = findCredential(vault, locator);
        if (!entry) {
          if (requiresConnectionSecret) {
            return deepFreeze({
              kind: 'credential_not_configured' as const,
              status,
            });
          }
        } else {
          secretMaterial.connection = credentialMaterial(entry);
        }
      }
      if (proxyLocator) {
        const status = credentialStatus(vault, proxyLocator);
        const entry = findCredential(vault, proxyLocator);
        if (!entry) {
          return deepFreeze({
            kind: 'credential_not_configured' as const,
            status,
          });
        }
        secretMaterial.networkProxy = credentialMaterial(entry);
      }
    }

    return {
      kind: 'ready',
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

function networkProxyCredentialLocator(): Extract<CredentialLocator, { scope: 'network_proxy' }> {
  return { scope: 'network_proxy', kind: 'password' };
}

function requiresNetworkProxyCredential(networkProxy: RuntimePolicy['networkProxy']): boolean {
  return networkProxy.enabled && networkProxy.authEnabled;
}
