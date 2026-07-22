import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { LlmCallRecord, SessionHeader } from '@maka/core';
import {
  buildPricingLookup,
  createSandboxDiagnosticsProvider,
  EMBEDDED_RUNTIME_EXECUTION,
  PermissionEngine,
  type BackendFactoryContext,
} from '@maka/runtime';
import { createPlanStore, createPricingStore, createTelemetryRepo } from '@maka/storage';
import {
  createAiSdkBackendFactory,
  type AiSdkBackendFactoryDeps,
} from '../session-stream.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('the first Desktop backend waits for pricing overrides before capturing cost authority', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-desktop-usage-ready-'));
  const pricingStore = createPricingStore(root, { createIfMissing: false });
  const telemetryRepo = createTelemetryRepo(root);
  const loadGate = deferred();
  let lookupPricing = buildPricingLookup();
  let readyConnectionReads = 0;

  try {
    await writeFile(
      join(root, 'pricing.json'),
      JSON.stringify({
        version: 1,
        revision: 1,
        overrides: [{ modelKey: 'openai:gpt-4o', inputUsdPer1M: 7, outputUsdPer1M: 11 }],
      }),
      'utf8',
    );
    const ensureUsageReady = async () => {
      await loadGate.promise;
      await Promise.all([telemetryRepo.load(), pricingStore.load()]);
      lookupPricing = buildPricingLookup(pricingStore.snapshot().overrides);
    };
    const factory = createAiSdkBackendFactory({
      isComputerUseRealModelE2e: false,
      ensureMcpReady: async () => {},
      getReadyConnection: async () => {
        readyConnectionReads += 1;
        return {
          connection: {
            slug: 'openai-main',
            name: 'OpenAI',
            providerType: 'openai',
            defaultModel: 'gpt-4o',
            enabled: true,
            createdAt: 1,
            updatedAt: 1,
          },
          apiKey: 'test-key',
          model: 'gpt-4o',
        };
      },
      buildSubscriptionModelFetch: () => undefined,
      systemPromptService: {
        buildLocalMemoryPromptFragment: async () => undefined,
        buildBackendSystemPrompt: () => '',
        buildTurnTailPrompt: () => undefined,
      },
      mcpManager: {},
      permissionEngine: new PermissionEngine({ newId: () => 'permission-1', now: () => 1 }),
      taskLedgerStore: {},
      telemetryRepo,
      ensureUsageReady,
      artifactStore: {},
      deepResearchTools: [],
      desktopSessionSkillHosts: new Map(),
      computerUseTools: [],
      agentTeamLeadTools: [],
      builtinTools: [],
      toolAvailability: { economy: false, groups: [] },
      sandboxDiagnosticsProvider: createSandboxDiagnosticsProvider({ platform: 'win32' }),
      persistToolArtifacts: async () => {},
      persistArchivedToolResult: async () => {},
      readArchivedToolResult: async () => undefined,
      runtimeCommitStore: undefined,
      planStore: createPlanStore(root),
      safeSendToRenderer: () => {},
      getRuntime: () => ({}),
      getLookupPricing: () => lookupPricing,
    } as unknown as AiSdkBackendFactoryDeps);

    const backendPromise = Promise.resolve(factory(factoryContext(root)));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(readyConnectionReads, 0, 'backend creation crossed the delayed usage load');

    loadGate.resolve();
    const backend = await backendPromise;
    assert.equal(readyConnectionReads, 1);
    const probe = backend as unknown as {
      computeTokenUsageCostUsd(usage: {
        inputTokens: number;
        outputTokens: number;
      }): number | undefined;
      input: { recordLlmCall(event: LlmCallRecord): Promise<void> };
    };
    const firstCostUsd = probe.computeTokenUsageCostUsd({
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    assert.equal(firstCostUsd, 18);

    await probe.input.recordLlmCall({
      sessionId: 'session-1',
      turnId: 'turn-1',
      connectionSlug: 'openai-main',
      providerId: 'openai',
      modelId: 'gpt-4o',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      latencyMs: 5,
      status: 'success',
      costUsd: firstCostUsd,
      startedAt: 1_000,
    });
    assert.equal(telemetryRepo.logs({ range: 'all' }).rows[0]?.costUsd, 18);
    await backend.dispose();
  } finally {
    await Promise.allSettled([telemetryRepo.close(), pricingStore.close()]);
    await rm(root, { recursive: true, force: true });
  }
});

function factoryContext(root: string): BackendFactoryContext {
  const header: SessionHeader = {
    id: 'session-1',
    workspaceRoot: root,
    cwd: root,
    createdAt: 1,
    lastUsedAt: 1,
    name: 'Usage readiness test',
    titleIsManual: true,
    isFlagged: false,
    labels: [],
    isArchived: false,
    status: 'active',
    statusUpdatedAt: 1,
    hasUnread: false,
    backend: 'ai-sdk',
    llmConnectionSlug: 'openai-main',
    connectionLocked: true,
    model: 'gpt-4o',
    permissionMode: 'ask',
    schemaVersion: 1,
  };
  return {
    sessionId: header.id,
    workspaceRoot: root,
    header,
    store: { appendMessage: async () => {} } as unknown as BackendFactoryContext['store'],
    tools: [],
    execution: EMBEDDED_RUNTIME_EXECUTION,
  };
}
