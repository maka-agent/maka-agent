import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, test } from 'node:test';
import type {
  ConnectionCatalogEntry,
  ConnectionCatalogEntryDraft,
  ConnectionVersionBasis,
  CredentialLocator,
  CredentialStatus,
  CredentialVersionBasis,
  MutateRuntimePolicyInput,
  RuntimePolicy,
} from '@maka/core/runtime-policy';
import {
  createHeadlessRootLease,
  resolveStorageRoot,
  StorageRootAuthorityError,
  tryAcquireInteractiveRootOwner,
  tryAcquireInteractiveRootReader,
  type StorageRootLease,
} from '../root-authority.js';
import {
  authenticateRuntimePolicyStoresReader,
  authenticateRuntimePolicyStoresWriter,
  openInteractiveRuntimePolicyStoresForRead,
  openInteractiveRuntimePolicyStoresForWrite,
  RuntimePolicyStoreError,
} from '../runtime-policy-stores.js';

const execFileAsync = promisify(execFile);

describe('runtime policy stores', () => {
  test('commits closed policy mutations, canonicalizes proxy hosts, and preserves connection identity', async () => {
    await withInteractiveOwner(async ({ root, stores }) => {
      const policy = await stores.runtimePolicy.mutate(personalizationMutation(0));
      assert.equal(policy.kind, 'committed');
      assert.deepEqual(
        await stores.runtimePolicy.mutate({
          expectedRevision: 0,
          operation: {
            kind: 'set_memory',
            value: { enabled: false, agentReadEnabled: false },
          },
        }),
        {
          kind: 'revision_conflict',
          expectedRevision: 0,
          actualRevision: 1,
        },
      );
      await assert.rejects(
        () =>
          stores.runtimePolicy.mutate({
            expectedRevision: 1,
            operation: { kind: 'replace_everything', value: {} },
          } as unknown as MutateRuntimePolicyInput),
        isStoreError('invalid_policy_input'),
      );
      for (const host of ['   ', 'proxy\u0000.internal']) {
        await assert.rejects(
          () => stores.runtimePolicy.mutate(networkProxyMutation(1, { host })),
          isStoreError('invalid_policy_input'),
        );
      }
      const proxy = await stores.runtimePolicy.mutate(
        networkProxyMutation(1, {
          host: ' proxy.internal ',
          authEnabled: false,
          username: '',
        }),
      );
      assert.equal(proxy.kind, 'committed');
      if (proxy.kind === 'committed')
        assert.equal(proxy.snapshot.policy.networkProxy.host, 'proxy.internal');

      const connection = await createConnection(stores, 0, {
        ...connectionDraft('openai-main', 'openai', 'OpenAI'),
        baseUrl: 'HTTPS://API.OPENAI.COM:443/v1',
      });
      assert.match(connection.connectionId, UUID_PATTERN);
      assert.equal(connection.baseUrl, undefined);
      assert.equal(
        (await stores.connectionCatalog.getSnapshot()).connections[0]?.baseUrl,
        undefined,
      );
      assert.deepEqual(connectionBasis(connection), {
        connectionId: connection.connectionId,
        revision: 1,
      });

      const target = { connectionId: connection.connectionId, modelId: 'gpt-5' };
      assert.equal(
        (
          await stores.connectionCatalog.setDefaultTarget({
            expectedCatalogRevision: 1,
            target,
          })
        ).kind,
        'committed',
      );

      const changes = {
        name: 'Renamed',
        baseUrl: ' https://Gateway.EXAMPLE:443/v1 ',
        enabled: true,
        enabledModelIds: ['gpt-5'],
      };
      await assert.rejects(
        () =>
          stores.connectionCatalog.update({
            expected: connectionBasis(connection),
            changes: { ...changes, slug: 'replacement', providerType: 'anthropic' },
          } as never),
        isStoreError('invalid_connection_input'),
      );
      const updated = await stores.connectionCatalog.update({
        expected: connectionBasis(connection),
        changes,
      });
      assert.equal(updated.kind, 'committed');
      if (updated.kind !== 'committed') return;
      const current = updated.snapshot.connections[0];
      assert.ok(current);
      assert.equal(current.connectionId, connection.connectionId);
      assert.equal(current.slug, 'openai-main');
      assert.equal(current.providerType, 'openai');
      assert.equal(current.name, 'Renamed');
      assert.equal(current.baseUrl, 'https://gateway.example/v1');
      assert.deepEqual(updated.snapshot.defaultTarget, target);

      const persisted = JSON.parse(
        await readFile(join(root, 'connection-catalog.json'), 'utf8'),
      ) as {
        connections: Array<Record<string, unknown>>;
      };
      assert.equal(persisted.connections[0]?.baseUrl, 'https://gateway.example/v1');
    });
  });

  test('rejects a valid mutation whose combined policy document exceeds its byte limit', async () => {
    await withInteractiveOwner(async ({ root, stores }) => {
      const committed = await stores.runtimePolicy.mutate(personalizationMutation(0));
      assert.equal(committed.kind, 'committed');
      if (committed.kind !== 'committed') return;
      const path = join(root, 'runtime-policy.json');
      const persistedBefore = await readFile(path);

      const entries = Array.from(
        { length: 64 },
        (_, index) => `domain-${index}-${'x'.repeat(480)}`,
      );
      await assert.rejects(
        () =>
          stores.runtimePolicy.mutate(
            networkProxyMutation(1, {
              bypassList: entries.map((entry) => `bypass-${entry}`),
              autoBypassDomains: entries.map((entry) => `auto-${entry}`),
            }),
          ),
        isStoreError('invalid_policy_input'),
      );

      assert.deepEqual(await stores.runtimePolicy.getSnapshot(), committed.snapshot);
      assert.deepEqual(await readFile(path), persistedBefore);
    });
  });

  test('owns endpoints and fails closed on unsafe or unreachable persisted connection state', async () => {
    await withInteractiveOwner(async ({ root, stores }) => {
      const rejected: ConnectionCatalogEntryDraft[] = [
        { ...connectionDraft('ftp', 'openai', 'FTP'), baseUrl: 'ftp://example.com/v1' },
        {
          ...connectionDraft('userinfo', 'openai', 'Userinfo'),
          baseUrl: 'https://user:pass@example.com/v1',
        },
        {
          ...connectionDraft('query', 'openai', 'Query'),
          baseUrl: 'https://example.com/v1?tenant=a',
        },
        {
          ...connectionDraft('fragment', 'openai', 'Fragment'),
          baseUrl: 'https://example.com/v1#models',
        },
        {
          ...connectionDraft('oauth', 'github-copilot', 'OAuth'),
          baseUrl: 'https://example.com/copilot',
        },
      ];
      for (const connection of rejected) {
        await assert.rejects(
          () => stores.connectionCatalog.create({ expectedCatalogRevision: 0, connection }),
          isStoreError('invalid_connection_input'),
        );
      }

      const canonical = await createConnection(stores, 0, {
        ...connectionDraft('canonical', 'openai', 'Canonical'),
        baseUrl: 'HTTPS://Gateway.EXAMPLE:443/v1',
      });
      assert.equal(canonical.baseUrl, 'https://gateway.example/v1');

      const path = join(root, 'connection-catalog.json');
      const document = JSON.parse(await readFile(path, 'utf8')) as {
        connections: Array<Record<string, unknown>>;
      };
      document.connections[0]!.models = [{ id: 'persisted-but-unreachable' }];
      const unreachable = `${JSON.stringify(document)}\n`;
      await writeFile(path, unreachable, 'utf8');
      await assert.rejects(
        () => stores.connectionCatalog.getSnapshot(),
        isStoreError('invalid_document'),
      );
      assert.equal(await readFile(path, 'utf8'), unreachable);
    });
  });

  test('applies action admission precedence, auth binding, proxy capture, and status redaction', async () => {
    await withInteractiveOwner(async ({ stores }) => {
      const disabled = await createConnection(stores, 0, {
        ...connectionDraft('disabled', 'tencent-coding-plan', 'Disabled'),
        enabled: false,
      });
      const fallback = await createConnection(
        stores,
        1,
        connectionDraft('fallback', 'tencent-coding-plan', 'Fallback discovery'),
      );
      const preview = await createConnection(
        stores,
        2,
        connectionDraft('preview', 'gemini-cli', 'Preview OAuth'),
      );
      const required = await createConnection(
        stores,
        3,
        connectionDraft('required', 'openai', 'Required key'),
      );
      const optional = await createConnection(
        stores,
        4,
        connectionDraft('optional', 'localai', 'Optional key'),
      );
      const none = await createConnection(stores, 5, connectionDraft('none', 'ollama', 'No auth'));

      assert.deepEqual(await stores.operations.beginModelFetch(disabled.connectionId), {
        kind: 'connection_disabled',
      });
      assert.deepEqual(await stores.operations.beginModelFetch(fallback.connectionId), {
        kind: 'provider_action_unavailable',
        availability: 'hidden',
      });
      assert.deepEqual(await stores.operations.beginStoredOAuthRefresh(preview.connectionId), {
        kind: 'provider_action_unavailable',
        availability: 'preview_only',
      });

      const missingRequired = await stores.operations.beginModelFetch(required.connectionId);
      assert.equal(missingRequired.kind, 'credential_not_configured');
      if (missingRequired.kind === 'credential_not_configured') {
        assert.deepEqual(missingRequired.status.locator, connectionCredential(required, 'api_key'));
      }
      const optionalReady = await stores.operations.beginModelFetch(optional.connectionId);
      assert.equal(optionalReady.kind, 'ready');
      if (optionalReady.kind === 'ready') assert.deepEqual(optionalReady.secretMaterial, {});
      const noneReady = await stores.operations.beginModelFetch(none.connectionId);
      assert.equal(noneReady.kind, 'ready');
      if (noneReady.kind === 'ready') assert.deepEqual(noneReady.secretMaterial, {});

      assert.deepEqual(
        await stores.credentialVault.getStatus({
          scope: 'connection',
          connectionId: '00000000-0000-4000-8000-000000000001',
          kind: 'api_key',
        }),
        { kind: 'connection_not_found' },
      );
      await assert.rejects(
        () => stores.credentialVault.getStatus(connectionCredential(required, 'oauth_token')),
        isStoreError('invalid_credential_input'),
      );

      const apiSecret = 'api-secret-never-redacted-back';
      const proxySecret = 'proxy-secret-never-redacted-back';
      const apiSet = await stores.credentialVault.set({
        locator: connectionCredential(required, 'api_key'),
        expected: null,
        secret: apiSecret,
      });
      assert.equal(apiSet.kind, 'committed');
      assert.equal(
        (
          await stores.runtimePolicy.mutate(
            networkProxyMutation(0, {
              host: ' proxy.capture.internal ',
            }),
          )
        ).kind,
        'committed',
      );

      const missingProxy = await stores.operations.beginConnectionTest(required.connectionId);
      assert.equal(missingProxy.kind, 'credential_not_configured');
      if (missingProxy.kind === 'credential_not_configured') {
        assert.deepEqual(missingProxy.status.locator, proxyCredential());
      }
      const proxySet = await stores.credentialVault.set({
        locator: proxyCredential(),
        expected: null,
        secret: proxySecret,
      });
      assert.equal(proxySet.kind, 'committed');

      const ready = await stores.operations.beginConnectionTest(required.connectionId);
      assert.equal(ready.kind, 'ready');
      if (ready.kind !== 'ready') return;
      assert.equal(ready.networkProxy.host, 'proxy.capture.internal');
      assert.equal(ready.networkProxy.enabled, true);
      assert.equal(ready.networkProxy.authEnabled, true);
      assert.equal(ready.secretMaterial.connection?.secret, apiSecret);
      assert.equal(ready.secretMaterial.networkProxy?.secret, proxySecret);

      const requiredStatus = await getCredentialStatus(
        stores.credentialVault,
        connectionCredential(required, 'api_key'),
      );
      const proxyStatus = await getCredentialStatus(stores.credentialVault, proxyCredential());
      const publicViews = JSON.stringify([
        apiSet,
        proxySet,
        requiredStatus,
        proxyStatus,
        await stores.credentialVault.getSnapshot(),
      ]);
      assert.equal(publicViews.includes(apiSecret), false);
      assert.equal(publicViews.includes(proxySecret), false);
    });
  });

  test('resolves execution connection material from one mutation cut', async () => {
    await withInteractiveOwner(async ({ stores }) => {
      const disabled = await createConnection(stores, 0, {
        ...connectionDraft('execution-disabled', 'openai', 'Disabled'),
        enabled: false,
      });
      const required = await createConnection(
        stores,
        1,
        connectionDraft('execution-required', 'openai', 'Required'),
      );
      const optional = await createConnection(
        stores,
        2,
        connectionDraft('execution-optional', 'localai', 'Optional'),
      );
      const none = await createConnection(
        stores,
        3,
        connectionDraft('execution-none', 'ollama', 'None'),
      );

      assert.deepEqual(await stores.operations.resolveExecutionConnection('missing'), {
        kind: 'not_found',
      });
      assert.deepEqual(await stores.operations.resolveExecutionConnection(disabled.slug), {
        kind: 'disabled',
      });

      const missingRequired = await stores.operations.resolveExecutionConnection(required.slug);
      assert.equal(missingRequired.kind, 'credential_not_configured');
      if (missingRequired.kind === 'credential_not_configured') {
        assert.deepEqual(missingRequired.status.locator, connectionCredential(required, 'api_key'));
      }
      for (const connection of [optional, none]) {
        const resolved = await stores.operations.resolveExecutionConnection(connection.slug);
        assert.equal(resolved.kind, 'ready');
        if (resolved.kind === 'ready') assert.deepEqual(resolved.secretMaterial, {});
      }

      assert.equal(
        (
          await stores.credentialVault.set({
            locator: connectionCredential(required, 'api_key'),
            expected: null,
            secret: 'execution-connection-secret',
          })
        ).kind,
        'committed',
      );
      assert.equal(
        (
          await stores.runtimePolicy.mutate(
            networkProxyMutation(0, { host: 'execution.proxy.internal' }),
          )
        ).kind,
        'committed',
      );
      const missingProxy = await stores.operations.resolveExecutionConnection(required.slug);
      assert.equal(missingProxy.kind, 'credential_not_configured');
      if (missingProxy.kind === 'credential_not_configured') {
        assert.deepEqual(missingProxy.status.locator, proxyCredential());
      }

      const [proxySet, resolved] = await Promise.all([
        stores.credentialVault.set({
          locator: proxyCredential(),
          expected: null,
          secret: 'execution-proxy-secret',
        }),
        stores.operations.resolveExecutionConnection(required.slug),
      ]);
      assert.equal(proxySet.kind, 'committed');
      assert.equal(resolved.kind, 'ready');
      if (resolved.kind !== 'ready') return;
      assert.deepEqual(resolved.connection, required);
      assert.equal(resolved.networkProxy.host, 'execution.proxy.internal');
      assert.equal(resolved.secretMaterial.connection?.secret, 'execution-connection-secret');
      assert.equal(resolved.secretMaterial.networkProxy?.secret, 'execution-proxy-secret');
    });
  });

  test('supersedes older tickets per action, keeps action issuance independent, and rejects replay', async () => {
    await withInteractiveOwner(async ({ stores }) => {
      const connection = await createConnection(
        stores,
        0,
        connectionDraft('latest', 'localai', 'Latest issuance'),
      );
      const originalProjection = connectionProjection(connection);

      const oldFetch = await beginReadyModelFetch(stores, connection.connectionId);
      const oldTest = await beginReadyConnectionTest(stores, connection.connectionId);
      const latestFetch = await beginReadyModelFetch(stores, connection.connectionId);
      const latestTest = await beginReadyConnectionTest(stores, connection.connectionId);

      assert.deepEqual(
        await stores.operations.completeModelFetch(oldFetch.ticket, {
          models: [{ id: 'old-fetch-must-not-write' }],
          source: 'fetched',
          fetchedAt: 1,
        }),
        { kind: 'superseded' },
      );
      assert.deepEqual(
        await stores.operations.completeConnectionTest(oldTest.ticket, {
          status: 'error',
          checkedAt: '2026-07-18T00:00:00.000Z',
          errorClass: 'unknown',
        }),
        { kind: 'superseded' },
      );

      const testResult = { status: 'verified' as const, checkedAt: '2026-07-18T01:00:00.000Z' };
      const tested = await stores.operations.completeConnectionTest(latestTest.ticket, testResult);
      assert.equal(tested.kind, 'committed');
      if (tested.kind !== 'committed') return;
      const afterTest = tested.snapshot.connections[0];
      assert.ok(afterTest);
      assert.deepEqual(connectionProjection(afterTest), originalProjection);
      assert.deepEqual(afterTest.lastTest, testResult);
      assert.deepEqual(afterTest.models, []);

      const fetchResult = {
        models: [{ id: 'qwen3-8b', capabilities: { chat: true, functionCalling: true } }],
        source: 'fetched' as const,
        fetchedAt: 42,
      };
      const completion = stores.operations.completeModelFetch(latestFetch.ticket, fetchResult);
      const replay = assert.rejects(
        () =>
          stores.operations.completeModelFetch(latestFetch.ticket, {
            models: [{ id: 'replay-must-not-write' }],
            source: 'fallback',
            fetchedAt: 43,
          }),
        isStoreError('invalid_connection_input'),
      );
      const [fetched] = await Promise.all([completion, replay]);
      assert.equal(fetched.kind, 'committed');
      if (fetched.kind !== 'committed') return;
      const afterFetch = fetched.snapshot.connections[0];
      assert.ok(afterFetch);
      assert.deepEqual(connectionProjection(afterFetch), originalProjection);
      assert.deepEqual(afterFetch.models, fetchResult.models);
      assert.equal(afterFetch.modelSource, 'fetched');
      assert.equal(afterFetch.modelsFetchedAt, 42);
      assert.deepEqual(afterFetch.lastTest, testResult);
    });
  });

  test('fences endpoint, connection credential, and effective proxy while preserving orthogonal projection', async () => {
    await withInteractiveOwner(async ({ stores }) => {
      const connection = await createConnection(
        stores,
        0,
        connectionDraft('semantic', 'openai', 'Semantic basis'),
      );
      const connectionLocator = connectionCredential(connection, 'api_key');
      assert.equal(
        (
          await stores.credentialVault.set({
            locator: connectionLocator,
            expected: null,
            secret: 'connection-v1',
          })
        ).kind,
        'committed',
      );
      assert.equal(
        (
          await stores.runtimePolicy.mutate(
            networkProxyMutation(0, {
              host: 'proxy-one.internal',
            }),
          )
        ).kind,
        'committed',
      );
      assert.equal(
        (
          await stores.credentialVault.set({
            locator: proxyCredential(),
            expected: null,
            secret: 'proxy-v1',
          })
        ).kind,
        'committed',
      );

      const fetch = await beginReadyModelFetch(stores, connection.connectionId);
      const orthogonalTest = await beginReadyConnectionTest(stores, connection.connectionId);
      assert.equal(fetch.networkProxy.host, 'proxy-one.internal');
      assert.equal(fetch.secretMaterial.connection?.secret, 'connection-v1');
      assert.equal(fetch.secretMaterial.networkProxy?.secret, 'proxy-v1');

      const projectionUpdate = await stores.connectionCatalog.update({
        expected: connectionBasis(connection),
        changes: {
          name: 'Orthogonal projection',
          enabled: false,
          enabledModelIds: ['orthogonal-model'],
        },
      });
      assert.equal(projectionUpdate.kind, 'committed');
      assert.equal(
        (await stores.runtimePolicy.mutate(personalizationMutation(1))).kind,
        'committed',
      );

      const fetched = await stores.operations.completeModelFetch(fetch.ticket, {
        models: [{ id: 'orthogonal-model' }],
        source: 'fetched',
        fetchedAt: 50,
      });
      assert.equal(fetched.kind, 'committed');
      if (fetched.kind !== 'committed') return;
      const patched = fetched.snapshot.connections[0];
      assert.ok(patched);
      assert.equal(patched.name, 'Orthogonal projection');
      assert.equal(patched.enabled, false);
      assert.deepEqual(patched.enabledModelIds, ['orthogonal-model']);
      assert.deepEqual(patched.models, [{ id: 'orthogonal-model' }]);
      assert.equal(patched.lastTest, undefined);

      const testResult = {
        status: 'verified' as const,
        checkedAt: '2026-07-18T01:30:00.000Z',
      };
      const tested = await stores.operations.completeConnectionTest(orthogonalTest.ticket, {
        ...testResult,
      });
      assert.equal(tested.kind, 'committed');
      if (tested.kind !== 'committed') return;
      const testedProjection = tested.snapshot.connections[0];
      assert.ok(testedProjection);
      assert.equal(testedProjection.name, 'Orthogonal projection');
      assert.equal(testedProjection.enabled, false);
      assert.deepEqual(testedProjection.enabledModelIds, ['orthogonal-model']);
      assert.deepEqual(testedProjection.models, [{ id: 'orthogonal-model' }]);
      assert.equal(testedProjection.modelSource, 'fetched');
      assert.equal(testedProjection.modelsFetchedAt, 50);
      assert.deepEqual(testedProjection.lastTest, testResult);

      const reenabled = await stores.connectionCatalog.update({
        expected: connectionBasis(testedProjection),
        changes: {
          name: testedProjection.name,
          enabled: true,
          enabledModelIds: testedProjection.enabledModelIds,
        },
      });
      assert.equal(reenabled.kind, 'committed');
      if (reenabled.kind !== 'committed') return;
      const current = reenabled.snapshot.connections[0];
      assert.ok(current);

      const proxyConfigurationTicket = await beginReadyModelFetch(stores, current.connectionId);
      assert.equal(proxyConfigurationTicket.networkProxy.host, 'proxy-one.internal');
      assert.equal(
        (
          await stores.runtimePolicy.mutate(
            networkProxyMutation(2, {
              host: 'proxy-two.internal',
            }),
          )
        ).kind,
        'committed',
      );
      assert.deepEqual(
        await stores.operations.completeModelFetch(proxyConfigurationTicket.ticket, {
          models: [{ id: 'must-not-cross-proxy-configuration' }],
          source: 'fetched',
          fetchedAt: 51,
        }),
        { kind: 'stale', changed: ['runtime_policy'] },
      );

      const proxyCredentialTicket = await beginReadyConnectionTest(stores, current.connectionId);
      assert.equal(proxyCredentialTicket.networkProxy.host, 'proxy-two.internal');
      assert.equal(proxyCredentialTicket.secretMaterial.networkProxy?.secret, 'proxy-v1');
      const proxyStatus = await getCredentialStatus(stores.credentialVault, proxyCredential());
      assert.equal(
        (
          await stores.credentialVault.set({
            locator: proxyCredential(),
            expected: credentialExpectation(proxyStatus),
            secret: 'proxy-v2',
          })
        ).kind,
        'committed',
      );
      assert.deepEqual(
        await stores.operations.completeConnectionTest(proxyCredentialTicket.ticket, {
          status: 'verified',
          checkedAt: '2026-07-18T01:45:00.000Z',
        }),
        { kind: 'stale', changed: ['credential'] },
      );

      const semanticTicket = await beginReadyConnectionTest(stores, current.connectionId);
      assert.equal(semanticTicket.secretMaterial.networkProxy?.secret, 'proxy-v2');

      const connectionStatus = await getCredentialStatus(stores.credentialVault, connectionLocator);
      assert.equal(
        (
          await stores.connectionCatalog.update({
            expected: connectionBasis(current),
            changes: {
              name: current.name,
              baseUrl: 'https://gateway.changed.example/v1',
              enabled: current.enabled,
              enabledModelIds: current.enabledModelIds,
            },
          })
        ).kind,
        'committed',
      );
      assert.equal(
        (
          await stores.credentialVault.set({
            locator: connectionLocator,
            expected: credentialExpectation(connectionStatus),
            secret: 'connection-v2',
          })
        ).kind,
        'committed',
      );
      assert.deepEqual(
        await stores.operations.completeConnectionTest(semanticTicket.ticket, {
          status: 'verified',
          checkedAt: '2026-07-18T02:00:00.000Z',
        }),
        { kind: 'stale', changed: ['connection', 'credential'] },
      );
    });
  });

  test('refreshes OAuth across orthogonal changes and cannot overwrite a delete/recreate replacement', async () => {
    await withInteractiveOwner(async ({ stores }) => {
      const connection = await createConnection(
        stores,
        0,
        connectionDraft('copilot', 'github-copilot', 'Copilot'),
      );
      const oauthLocator = connectionCredential(connection, 'oauth_token');
      assert.equal(
        (
          await stores.credentialVault.set({
            locator: oauthLocator,
            expected: null,
            secret: 'oauth-v1',
          })
        ).kind,
        'committed',
      );
      assert.equal(
        (
          await stores.runtimePolicy.mutate(
            networkProxyMutation(0, {
              host: 'oauth-proxy-one.internal',
            }),
          )
        ).kind,
        'committed',
      );
      assert.equal(
        (
          await stores.credentialVault.set({
            locator: proxyCredential(),
            expected: null,
            secret: 'oauth-proxy-v1',
          })
        ).kind,
        'committed',
      );

      const refresh = await beginReadyOAuthRefresh(stores, connection.connectionId);
      assert.equal(refresh.secretMaterial.connection.secret, 'oauth-v1');
      assert.equal(refresh.secretMaterial.networkProxy?.secret, 'oauth-proxy-v1');
      const model = await beginReadyModelFetch(stores, connection.connectionId);
      const connectionTest = await beginReadyConnectionTest(stores, connection.connectionId);
      assert.equal(
        (
          await stores.operations.completeModelFetch(model.ticket, {
            models: [{ id: 'copilot-model' }],
            source: 'fetched',
            fetchedAt: 60,
          })
        ).kind,
        'committed',
      );
      assert.equal(
        (
          await stores.operations.completeConnectionTest(connectionTest.ticket, {
            status: 'verified',
            checkedAt: '2026-07-18T03:00:00.000Z',
          })
        ).kind,
        'committed',
      );

      const current = (await stores.connectionCatalog.getSnapshot()).connections[0];
      assert.ok(current);
      const projection = await stores.connectionCatalog.update({
        expected: connectionBasis(current),
        changes: {
          name: 'OAuth orthogonal projection',
          enabled: false,
          enabledModelIds: ['copilot-orthogonal'],
        },
      });
      assert.equal(projection.kind, 'committed');
      if (projection.kind !== 'committed') return;
      const disabled = projection.snapshot.connections[0];
      assert.ok(disabled);
      const proxyStatus = await getCredentialStatus(stores.credentialVault, proxyCredential());
      assert.equal(
        (
          await stores.runtimePolicy.mutate(
            networkProxyMutation(1, {
              host: 'oauth-proxy-two.internal',
            }),
          )
        ).kind,
        'committed',
      );
      assert.equal(
        (await stores.runtimePolicy.mutate(personalizationMutation(2))).kind,
        'committed',
      );
      assert.equal(
        (
          await stores.credentialVault.set({
            locator: proxyCredential(),
            expected: credentialExpectation(proxyStatus),
            secret: 'oauth-proxy-v2',
          })
        ).kind,
        'committed',
      );

      assert.equal(
        (
          await stores.operations.completeStoredOAuthRefresh(refresh.ticket, {
            secret: 'oauth-v2',
          })
        ).kind,
        'committed',
      );
      const reenabled = await stores.connectionCatalog.update({
        expected: connectionBasis(disabled),
        changes: {
          name: disabled.name,
          enabled: true,
          enabledModelIds: disabled.enabledModelIds,
        },
      });
      assert.equal(reenabled.kind, 'committed');

      const late = await beginReadyOAuthRefresh(stores, connection.connectionId);
      assert.equal(late.secretMaterial.connection.secret, 'oauth-v2');
      assert.equal(late.secretMaterial.networkProxy?.secret, 'oauth-proxy-v2');
      assert.equal(late.networkProxy.host, 'oauth-proxy-two.internal');
      const refreshedCredentialId = late.secretMaterial.connection.credentialId;
      assert.equal(
        (
          await stores.credentialVault.delete({
            expected: materialBasis(late.secretMaterial.connection),
          })
        ).kind,
        'committed',
      );
      assert.equal(
        (
          await stores.credentialVault.set({
            locator: oauthLocator,
            expected: null,
            secret: 'oauth-replacement',
          })
        ).kind,
        'committed',
      );
      assert.deepEqual(
        await stores.operations.completeStoredOAuthRefresh(late.ticket, {
          secret: 'late-refresh-must-not-win',
        }),
        { kind: 'stale', changed: ['credential'] },
      );

      const replacement = await beginReadyOAuthRefresh(stores, connection.connectionId);
      assert.equal(replacement.secretMaterial.connection.secret, 'oauth-replacement');
      assert.notEqual(replacement.secretMaterial.connection.credentialId, refreshedCredentialId);
      assert.equal(replacement.secretMaterial.networkProxy?.secret, 'oauth-proxy-v2');
    });
  });

  test('removes credentials only for a matching connection revision and converges on partial retries', async () => {
    await withInteractiveOwner(async ({ stores }) => {
      const original = await createConnection(
        stores,
        0,
        connectionDraft('removable', 'openai', 'Removable'),
      );
      const locator = connectionCredential(original, 'api_key');
      assert.equal(
        (
          await stores.credentialVault.set({
            locator,
            expected: null,
            secret: 'must-survive-stale-remove',
          })
        ).kind,
        'committed',
      );
      assert.equal(
        (
          await stores.connectionCatalog.setDefaultTarget({
            expectedCatalogRevision: 1,
            target: { connectionId: original.connectionId, modelId: 'gpt-5' },
          })
        ).kind,
        'committed',
      );
      const updatedResult = await stores.connectionCatalog.update({
        expected: connectionBasis(original),
        changes: {
          name: 'Current revision',
          enabled: true,
          enabledModelIds: ['gpt-5'],
        },
      });
      assert.equal(updatedResult.kind, 'committed');
      if (updatedResult.kind !== 'committed') return;
      const updated = updatedResult.snapshot.connections[0];
      assert.ok(updated);

      const stale = await stores.connectionCatalog.remove({ expected: connectionBasis(original) });
      assert.equal(stale.kind, 'connection_stale');
      const admitted = await beginReadyModelFetch(stores, updated.connectionId);
      const pendingTest = await beginReadyConnectionTest(stores, updated.connectionId);
      assert.equal(admitted.secretMaterial.connection?.secret, 'must-survive-stale-remove');
      assert.deepEqual((await stores.connectionCatalog.getSnapshot()).defaultTarget, {
        connectionId: original.connectionId,
        modelId: 'gpt-5',
      });

      const removed = await stores.connectionCatalog.remove({ expected: connectionBasis(updated) });
      assert.equal(removed.kind, 'committed');
      if (removed.kind !== 'committed') return;
      assert.deepEqual(removed.snapshot.connections, []);
      assert.equal(removed.snapshot.defaultTarget, null);
      assert.deepEqual((await stores.credentialVault.getSnapshot()).entries, []);
      assert.deepEqual(await stores.credentialVault.getStatus(locator), {
        kind: 'connection_not_found',
      });
      assert.deepEqual(
        await stores.operations.completeModelFetch(admitted.ticket, {
          models: [{ id: 'late-model-must-not-write' }],
          source: 'fetched',
          fetchedAt: 80,
        }),
        { kind: 'superseded' },
      );
      assert.deepEqual(
        await stores.operations.completeConnectionTest(pendingTest.ticket, {
          status: 'verified',
          checkedAt: '2026-07-18T04:00:00.000Z',
        }),
        { kind: 'superseded' },
      );
      const retry = await stores.connectionCatalog.remove({ expected: connectionBasis(updated) });
      assert.equal(retry.kind, 'committed');
      if (retry.kind === 'committed')
        assert.equal(retry.snapshot.revision, removed.snapshot.revision);

      const recreated = await createConnection(
        stores,
        removed.snapshot.revision,
        connectionDraft('removable', 'openai', 'Recreated'),
      );
      assert.notEqual(recreated.connectionId, original.connectionId);
      const recreatedLocator = connectionCredential(recreated, 'api_key');
      assert.equal(
        (
          await stores.credentialVault.set({
            locator: recreatedLocator,
            expected: null,
            secret: 'partial-state-secret',
          })
        ).kind,
        'committed',
      );
      const recreatedStatus = await getCredentialStatus(stores.credentialVault, recreatedLocator);
      assert.equal(
        (
          await stores.credentialVault.delete({
            expected: credentialBasis(recreatedStatus),
          })
        ).kind,
        'committed',
      );
      const converged = await stores.connectionCatalog.remove({
        expected: connectionBasis(recreated),
      });
      assert.equal(converged.kind, 'committed');
      if (converged.kind === 'committed') assert.deepEqual(converged.snapshot.connections, []);
      assert.deepEqual((await stores.credentialVault.getSnapshot()).entries, []);
    });
  });

  test('drains every synchronously admitted ordered mutation before owner close completes', async () => {
    await withInteractiveRoot(async ({ capability }) => {
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      if (!owner) return;
      const stores = await openInteractiveRuntimePolicyStoresForWrite(owner.lease);

      const first = stores.runtimePolicy.mutate(personalizationMutation(0));
      const second = stores.runtimePolicy.mutate({
        expectedRevision: 1,
        operation: {
          kind: 'set_memory',
          value: { enabled: false, agentReadEnabled: false },
        },
      });
      const third = stores.runtimePolicy.mutate({
        expectedRevision: 2,
        operation: {
          kind: 'set_privacy',
          value: { incognitoActive: true },
        },
      });
      const closing = owner.close();
      assert.equal(owner.closed, true);

      const results = await Promise.all([first, second, third, closing]);
      assert.deepEqual(
        results.slice(0, 3).map((result) => result?.kind),
        ['committed', 'committed', 'committed'],
      );

      const readerHandle = await tryAcquireInteractiveRootReader(capability);
      assert.ok(readerHandle);
      if (!readerHandle) return;
      try {
        const reader = await openInteractiveRuntimePolicyStoresForRead(readerHandle.lease);
        const snapshot = await reader.runtimePolicy.getSnapshot();
        assert.equal(snapshot.revision, 3);
        assert.deepEqual(snapshot.policy.personalization, {
          displayName: 'Maka',
          assistantTone: 'concise',
        });
        assert.deepEqual(snapshot.policy.memory, { enabled: false, agentReadEnabled: false });
        assert.deepEqual(snapshot.policy.privacy, { incognitoActive: true });
      } finally {
        await readerHandle.close();
      }
    });
  });

  test('fails closed on final symlinks, FIFOs, and oversized documents without changing bytes', {
    skip: process.platform === 'win32',
  }, async () => {
    await withInteractiveOwner(async ({ root, stores }) => {
      const external = join(root, '..', 'external-policy.json');
      const original = Buffer.from('{"external":true}\n');
      await writeFile(external, original);
      await symlink(external, join(root, 'runtime-policy.json'));
      await assert.rejects(
        () => stores.runtimePolicy.mutate(personalizationMutation(0)),
        isStoreError('invalid_document'),
      );
      assert.deepEqual(await readFile(external), original);
      assert.equal((await lstat(join(root, 'runtime-policy.json'))).isSymbolicLink(), true);
    });

    await withInteractiveOwner(async ({ root, stores }) => {
      const path = join(root, 'runtime-policy.json');
      await execFileAsync('mkfifo', [path]);
      await assert.rejects(
        () => stores.runtimePolicy.getSnapshot(),
        isStoreError('invalid_document'),
      );
      assert.equal((await lstat(path)).isFIFO(), true);
    });

    await withInteractiveOwner(async ({ root, stores }) => {
      const path = join(root, 'runtime-policy.json');
      const original = Buffer.alloc(256 * 1024 + 1, 0x78);
      await writeFile(path, original);
      await assert.rejects(
        () => stores.runtimePolicy.mutate(personalizationMutation(0)),
        isStoreError('invalid_document'),
      );
      assert.deepEqual(await readFile(path), original);
    });
  });

  test('retries the same model fetch ticket after a real pre-publication I/O failure', {
    skip:
      process.platform === 'win32' ||
      (typeof process.geteuid === 'function' && process.geteuid() === 0),
  }, async () => {
    await withInteractiveOwner(async ({ root, stores }) => {
      const connection = await createConnection(
        stores,
        0,
        connectionDraft('io-retry', 'localai', 'I/O retry'),
      );
      const fetch = await beginReadyModelFetch(stores, connection.connectionId);
      const result = {
        models: [{ id: 'retry-model' }],
        source: 'fetched' as const,
        fetchedAt: 70,
      };

      await chmod(root, 0o500);
      try {
        await assert.rejects(
          () => stores.operations.completeModelFetch(fetch.ticket, result),
          isStoreError('io_failed'),
        );
      } finally {
        await chmod(root, 0o700);
      }

      const retried = await stores.operations.completeModelFetch(fetch.ticket, result);
      assert.equal(retried.kind, 'committed');
      if (retried.kind === 'committed') {
        assert.deepEqual(retried.snapshot.connections[0]?.models, [{ id: 'retry-model' }]);
      }
    });
  });

  test('single-flights writer recovery and preserves credential material across owner reopen', async () => {
    await withInteractiveRoot(async ({ root, capability }) => {
      const firstOwner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(firstOwner);
      if (!firstOwner) return;
      let connection!: ConnectionCatalogEntry;
      let firstStatus!: CredentialStatus;
      const secret = 'persisted-secret-after-recovery';
      const temporaryNames = [
        'runtime-policy.json.11111111-1111-4111-8111-111111111111.tmp',
        'connection-catalog.json.22222222-2222-4222-8222-222222222222.tmp',
        'credential-vault.json.33333333-3333-4333-8333-333333333333.tmp',
      ];
      try {
        await Promise.all([
          writeFile(join(root, temporaryNames[0]!), '{"orphan":true}\n', 'utf8'),
          writeFile(join(root, temporaryNames[1]!), '{"orphan":true}\n', 'utf8'),
          writeFile(join(root, temporaryNames[2]!), 'plaintext-credential-orphan\n', 'utf8'),
        ]);
        const [first, sameLeaseOpen] = await Promise.all([
          openInteractiveRuntimePolicyStoresForWrite(firstOwner.lease),
          openInteractiveRuntimePolicyStoresForWrite(firstOwner.lease),
        ]);
        assert.equal(first, sameLeaseOpen);
        const remaining = new Set(await readdir(root));
        assert.deepEqual(
          temporaryNames.filter((name) => remaining.has(name)),
          [],
        );

        connection = await createConnection(
          first,
          0,
          connectionDraft('reopen', 'openai', 'Reopen'),
        );
        const locator = connectionCredential(connection, 'api_key');
        assert.equal(
          (
            await first.credentialVault.set({
              locator,
              expected: null,
              secret,
            })
          ).kind,
          'committed',
        );
        firstStatus = await getCredentialStatus(first.credentialVault, locator);
        assert.equal(JSON.stringify(firstStatus).includes(secret), false);
      } finally {
        if (!firstOwner.closed) await firstOwner.close();
      }

      const secondOwner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(secondOwner);
      if (!secondOwner) return;
      try {
        const second = await openInteractiveRuntimePolicyStoresForWrite(secondOwner.lease);
        const admitted = await beginReadyModelFetch(second, connection.connectionId);
        assert.equal(admitted.secretMaterial.connection?.secret, secret);
        assert.equal(admitted.secretMaterial.connection?.credentialId, firstStatus.credentialId);
      } finally {
        if (!secondOwner.closed) await secondOwner.close();
      }

      const readerHandle = await tryAcquireInteractiveRootReader(capability);
      assert.ok(readerHandle);
      if (!readerHandle) return;
      try {
        const reader = await openInteractiveRuntimePolicyStoresForRead(readerHandle.lease);
        const publicStatus = await getCredentialStatus(
          reader.credentialVault,
          connectionCredential(connection, 'api_key'),
        );
        assert.equal(publicStatus.credentialId, firstStatus.credentialId);
        const publicViews = JSON.stringify([
          publicStatus,
          await reader.credentialVault.getSnapshot(),
        ]);
        assert.equal(publicViews.includes(secret), false);
      } finally {
        await readerHandle.close();
      }
    });
  });

  test('rejects headless leases, forged facades, and operations after interactive lease close', async () => {
    await withTempDir(async (base) => {
      const headlessRoot = join(base, 'headless');
      const headless = await resolveStorageRoot({ path: headlessRoot, kind: 'headless' });
      const before = await snapshotRoot(headlessRoot);
      await assert.rejects(
        () =>
          openInteractiveRuntimePolicyStoresForWrite(
            createHeadlessRootLease(headless, 'write') as unknown as StorageRootLease<
              'interactive',
              'write'
            >,
          ),
        isInvalidLease,
      );
      assert.deepEqual(await snapshotRoot(headlessRoot), before);
    });

    await withInteractiveRoot(async ({ capability }) => {
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      if (!owner) return;
      const writer = await openInteractiveRuntimePolicyStoresForWrite(owner.lease);
      assert.equal(authenticateRuntimePolicyStoresWriter(writer), writer);
      assert.throws(() => authenticateRuntimePolicyStoresWriter({ ...writer }), isInvalidLease);
      await owner.close();
      await assert.rejects(() => writer.runtimePolicy.getSnapshot(), isInvalidLease);

      const readerHandle = await tryAcquireInteractiveRootReader(capability);
      assert.ok(readerHandle);
      if (!readerHandle) return;
      const reader = await openInteractiveRuntimePolicyStoresForRead(readerHandle.lease);
      assert.equal(authenticateRuntimePolicyStoresReader(reader), reader);
      assert.throws(() => authenticateRuntimePolicyStoresReader({ ...reader }), isInvalidLease);
      await readerHandle.close();
      await assert.rejects(() => reader.connectionCatalog.getSnapshot(), isInvalidLease);
    });
  });
});

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type Writer = Awaited<ReturnType<typeof openInteractiveRuntimePolicyStoresForWrite>>;

async function createConnection(
  stores: Writer,
  expectedCatalogRevision: number,
  connection: ConnectionCatalogEntryDraft,
): Promise<ConnectionCatalogEntry> {
  const result = await stores.connectionCatalog.create({ expectedCatalogRevision, connection });
  assert.equal(result.kind, 'committed');
  if (result.kind !== 'committed') throw new Error('connection creation did not commit');
  const created = result.snapshot.connections.find((item) => item.slug === connection.slug);
  assert.ok(created);
  return created;
}

function connectionDraft(
  slug: string,
  providerType: ConnectionCatalogEntryDraft['providerType'],
  name: string,
): ConnectionCatalogEntryDraft {
  return {
    slug,
    name,
    providerType,
    enabled: true,
    enabledModelIds: ['gpt-5'],
  };
}

function connectionBasis(connection: ConnectionCatalogEntry): ConnectionVersionBasis {
  return { connectionId: connection.connectionId, revision: connection.revision };
}

function connectionCredential(
  connection: ConnectionCatalogEntry,
  kind: 'api_key' | 'oauth_token',
): Extract<CredentialLocator, { scope: 'connection' }> {
  return { scope: 'connection', connectionId: connection.connectionId, kind };
}

function proxyCredential(): Extract<CredentialLocator, { scope: 'network_proxy' }> {
  return { scope: 'network_proxy', kind: 'password' };
}

async function getCredentialStatus(
  vault: Pick<Writer['credentialVault'], 'getStatus'>,
  locator: CredentialLocator,
): Promise<CredentialStatus> {
  const result = await vault.getStatus(locator);
  assert.equal(result.kind, 'status');
  if (result.kind !== 'status') throw new Error('credential status query did not return a status');
  return result.status;
}

function credentialBasis(status: CredentialStatus): CredentialVersionBasis {
  assert.equal(status.configured, true);
  if (!status.configured) throw new Error('credential is not configured');
  return {
    locator: status.locator,
    credentialId: status.credentialId,
    revision: status.revision,
  };
}

function credentialExpectation(status: CredentialStatus): {
  credentialId: string;
  revision: number;
} {
  const basis = credentialBasis(status);
  return { credentialId: basis.credentialId, revision: basis.revision };
}

function materialBasis(material: CredentialVersionBasis): CredentialVersionBasis {
  return {
    locator: material.locator,
    credentialId: material.credentialId,
    revision: material.revision,
  };
}

function connectionProjection(connection: ConnectionCatalogEntry) {
  return {
    connectionId: connection.connectionId,
    slug: connection.slug,
    name: connection.name,
    providerType: connection.providerType,
    baseUrl: connection.baseUrl,
    enabled: connection.enabled,
    enabledModelIds: connection.enabledModelIds,
  };
}

async function beginReadyModelFetch(stores: Writer, connectionId: string) {
  const result = await stores.operations.beginModelFetch(connectionId);
  assert.equal(result.kind, 'ready');
  if (result.kind !== 'ready') throw new Error('model fetch was not ready');
  return result;
}

async function beginReadyConnectionTest(stores: Writer, connectionId: string) {
  const result = await stores.operations.beginConnectionTest(connectionId);
  assert.equal(result.kind, 'ready');
  if (result.kind !== 'ready') throw new Error('connection test was not ready');
  return result;
}

async function beginReadyOAuthRefresh(stores: Writer, connectionId: string) {
  const result = await stores.operations.beginStoredOAuthRefresh(connectionId);
  assert.equal(result.kind, 'ready');
  if (result.kind !== 'ready') throw new Error('OAuth refresh was not ready');
  return result;
}

function personalizationMutation(expectedRevision: number): MutateRuntimePolicyInput {
  return {
    expectedRevision,
    operation: {
      kind: 'set_personalization',
      value: { displayName: 'Maka', assistantTone: 'concise' },
    },
  };
}

function networkProxyMutation(
  expectedRevision: number,
  changes: Partial<RuntimePolicy['networkProxy']> = {},
): MutateRuntimePolicyInput {
  return {
    expectedRevision,
    operation: {
      kind: 'set_network_proxy',
      value: {
        enabled: true,
        protocol: 'http',
        host: '127.0.0.1',
        port: 8080,
        authEnabled: true,
        username: 'proxy-user',
        bypassList: ['localhost'],
        autoBypassDomains: ['127.0.0.1'],
        ...changes,
      },
    },
  };
}

function isStoreError(code: RuntimePolicyStoreError['code']) {
  return (error: unknown) => error instanceof RuntimePolicyStoreError && error.code === code;
}

function isInvalidLease(error: unknown): boolean {
  return error instanceof StorageRootAuthorityError && error.code === 'invalid_lease';
}

async function withInteractiveOwner(
  run: (input: { root: string; stores: Writer }) => Promise<void>,
): Promise<void> {
  await withInteractiveRoot(async ({ root, capability }) => {
    const owner = await tryAcquireInteractiveRootOwner(capability);
    assert.ok(owner);
    if (!owner) return;
    try {
      await run({ root, stores: await openInteractiveRuntimePolicyStoresForWrite(owner.lease) });
    } finally {
      if (!owner.closed) await owner.close();
    }
  });
}

async function withInteractiveRoot(
  run: (input: {
    root: string;
    capability: Awaited<ReturnType<typeof resolveStorageRoot<'interactive'>>>;
  }) => Promise<void>,
): Promise<void> {
  await withTempDir(async (base) => {
    const root = join(base, 'interactive');
    const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
    await run({ root, capability });
  });
}

async function withTempDir(run: (base: string) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'maka-runtime-policy-'));
  try {
    await run(base);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

async function snapshotRoot(root: string): Promise<readonly RootSnapshotEntry[]> {
  const names = (await readdir(root)).sort();
  return Promise.all(
    names.map(async (name) => {
      const path = join(root, name);
      const metadata = await stat(path);
      return {
        name,
        size: metadata.size,
        mtimeMs: metadata.mtimeMs,
        contents: metadata.isFile() ? await readFile(path, 'utf8') : null,
      };
    }),
  );
}

interface RootSnapshotEntry {
  readonly name: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly contents: string | null;
}
