import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, test } from 'node:test';
import {
  createTelemetryRepo,
  TelemetryRepoClosedError,
  TelemetryRepoNotLoadedError,
  TelemetryRepoPublicationError,
} from '../telemetry-repo.js';

describe('FileTelemetryRepo', () => {
  test('upserts LLM calls by id and aggregates the latest record', async () => {
    await withRepo(async (repo) => {
      await repo.load();
      await repo.insertLlmCall(
        llmRecord({
          id: 'usage_turn_1',
          inputTokens: 10,
          outputTokens: 20,
          cacheMissInputTokens: 10,
          totalTokens: 30,
        }),
      );
      await repo.insertLlmCall(
        llmRecord({
          id: 'usage_turn_1',
          inputTokens: 30,
          outputTokens: 40,
          cacheMissInputTokens: 30,
          totalTokens: 70,
        }),
      );

      const summary = repo.summary({ range: 'all' });
      const logs = repo.logs({ range: 'all' });

      assert.equal(summary.totalRequests, 1);
      assert.equal(summary.totalTokens.input, 30);
      assert.equal(summary.totalTokens.output, 40);
      assert.equal(summary.totalTokens.cacheMiss, 30);
      assert.equal(summary.totalTokens.total, 70);
      assert.equal(logs.total, 1);
      assert.equal(logs.rows[0]?.inputTokens, 30);
      assert.equal(logs.rows[0]?.cacheMissTokens, 30);
    });
  });

  test('carries the tool-availability diagnostic and tool-schema change reason through logs()', async () => {
    await withRepo(async (repo) => {
      await repo.load();
      await repo.insertLlmCall(
        llmRecord({
          id: 'usage_diag',
          systemPromptHash: 'sys-hash',
          toolSchemaChangeReason: 'tool_source_enabled',
          toolAvailability: {
            mode: 'economy',
            enabledSourceIds: ['office'],
            availableSourceIds: ['rive'],
            connectorToolName: 'load_tools',
            visibleToolNamesBySource: { office: ['office_edit'] },
            hiddenToolCount: 1,
          },
        }),
      );

      const row = repo.logs({ range: 'all' }).rows[0];
      assert.equal(row?.systemPromptHash, 'sys-hash');
      assert.equal(row?.toolSchemaChangeReason, 'tool_source_enabled');
      assert.equal(row?.toolAvailability?.mode, 'economy');
      assert.deepEqual(row?.toolAvailability?.enabledSourceIds, ['office']);
      assert.equal(row?.toolAvailability?.hiddenToolCount, 1);
    });
  });

  test('carries auxiliary LLM call identity through logs()', async () => {
    await withRepo(async (repo) => {
      await repo.load();
      await repo.insertLlmCall(
        llmRecord({
          id: 'usage_semantic_compact_turn_1_2_3',
          callKind: 'semantic_compact',
          callId: 'semantic_compact_turn_1_2_3',
        }),
      );

      const row = repo.logs({ range: 'all' }).rows[0];
      assert.equal(row?.callKind, 'semantic_compact');
      assert.equal(row?.callId, 'semantic_compact_turn_1_2_3');
    });
  });

  test('filters logs by range, status, provider, model, and pagination', async () => {
    await withRepo(async (repo) => {
      await repo.load();
      await repo.insertLlmCall(
        llmRecord({ id: 'old', ts: 1, status: 'success', providerId: 'openai', modelId: 'gpt-4o' }),
      );
      await repo.insertLlmCall(
        llmRecord({
          id: 'new-success',
          ts: 20,
          status: 'success',
          providerId: 'openai',
          modelId: 'gpt-4o',
        }),
      );
      await repo.insertLlmCall(
        llmRecord({
          id: 'new-error',
          ts: 30,
          status: 'error',
          providerId: 'anthropic',
          modelId: 'claude',
        }),
      );

      const logs = repo.logs(
        { range: { from: 10, to: 40 }, status: 'success', providerId: 'openai', modelId: 'gpt-4o' },
        0,
        10,
      );

      assert.equal(logs.total, 1);
      assert.equal(logs.rows[0]?.id, 'new-success');
    });
  });

  test('filters and returns latest LLM runtime probes by connection slug', async () => {
    await withRepo(async (repo) => {
      await repo.load();
      await repo.insertLlmCall(
        llmRecord({
          id: 'conn-a-old',
          connectionSlug: 'conn-a',
          modelId: 'glm-4.7',
          ts: 10,
          status: 'success',
        }),
      );
      await repo.insertLlmCall(
        llmRecord({
          id: 'conn-b-new',
          connectionSlug: 'conn-b',
          modelId: 'glm-4.7',
          ts: 50,
          status: 'error',
        }),
      );
      await repo.insertLlmCall(
        llmRecord({
          id: 'conn-a-new',
          connectionSlug: 'conn-a',
          modelId: 'glm-4.7',
          ts: 40,
          status: 'aborted',
        }),
      );

      const logs = repo.logs({ range: 'all', connectionSlug: 'conn-a' });
      const latest = repo.latestLlmRuntimeProbe('conn-a', 'glm-4.7');

      assert.equal(logs.total, 2);
      assert.equal(logs.rows[0]?.id, 'conn-a-new');
      assert.equal(logs.rows[0]?.connectionSlug, 'conn-a');
      assert.equal(latest?.id, 'conn-a-new');
      assert.equal(repo.latestLlmRuntimeProbe('missing'), undefined);
    });
  });

  test('builds provider, model, day, hour, and tool buckets', async () => {
    await withRepo(async (repo) => {
      await repo.load();
      await repo.insertLlmCall(
        llmRecord({
          id: 'usage_1',
          providerId: 'openai',
          modelId: 'gpt-4o',
          ts: Date.UTC(2026, 0, 1, 1),
          date: '2026-01-01',
        }),
      );
      await repo.insertLlmCall(
        llmRecord({
          id: 'usage_2',
          providerId: 'openai',
          modelId: 'gpt-4o-mini',
          ts: Date.UTC(2026, 0, 1, 2),
          date: '2026-01-01',
        }),
      );
      await repo.insertToolInvocation(
        toolRecord({ id: 'tool_1', toolName: 'Bash', durationMs: 30, status: 'success' }),
      );
      await repo.insertToolInvocation(
        toolRecord({ id: 'tool_2', toolName: 'Bash', durationMs: 90, status: 'error' }),
      );

      assert.equal(repo.buckets({ range: 'all' }, 'provider')[0]?.key, 'openai');
      assert.equal(repo.buckets({ range: 'all' }, 'model').length, 2);
      assert.equal(repo.buckets({ range: 'all' }, 'day')[0]?.key, '2026-01-01');
      assert.equal(repo.buckets({ range: 'all' }, 'hour').length, 2);

      const tool = repo.buckets({ range: 'all' }, 'tool')[0];
      assert.equal(tool?.key, 'Bash');
      assert.equal(tool?.requests, 2);
      assert.equal(tool?.avgLatencyMs, 60);
      assert.equal(tool?.errorRate, 0.5);
    });
  });

  test('flush waits for every accepted record publication', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-telemetry-flush-'));
    const repo = createTelemetryRepo(root);
    try {
      await repo.load();
      const first = repo.insertLlmCall(llmRecord({ id: 'usage_flush_1' }));
      const second = repo.insertToolInvocation(toolRecord({ id: 'tool_flush_1' }));

      await repo.flush();
      await Promise.all([first, second]);

      const persisted = JSON.parse(await readFile(join(root, 'telemetry.json'), 'utf8')) as {
        usageRecords: Array<{ id: string }>;
        toolInvocations: Array<{ id: string }>;
      };
      assert.equal(persisted.usageRecords[0]?.id, 'usage_flush_1');
      assert.equal(persisted.toolInvocations[0]?.id, 'tool_flush_1');
    } finally {
      await repo.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  test('close seals new records, drains accepted writes, and is idempotent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-telemetry-close-'));
    const repo = createTelemetryRepo(root);
    try {
      await repo.load();
      const accepted = repo.insertLlmCall(llmRecord({ id: 'usage_before_close' }));
      const firstClose = repo.close();
      const secondClose = repo.close();

      assert.equal(firstClose, secondClose);
      assert.throws(
        () => repo.insertLlmCall(llmRecord({ id: 'usage_after_close' })),
        TelemetryRepoClosedError,
      );
      await Promise.all([accepted, firstClose]);

      const reloaded = createTelemetryRepo(root);
      await reloaded.load();
      assert.equal(reloaded.logs({ range: 'all' }).rows[0]?.id, 'usage_before_close');
      await reloaded.close();
    } finally {
      await repo.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  test('record and flush expose derived-index write failures without committing memory state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-telemetry-write-error-'));
    const repo = createTelemetryRepo(root);
    try {
      await repo.load();
      const path = join(root, 'telemetry.json');
      const emptyDocument = await readFile(path, 'utf8');
      await rm(path);
      await mkdir(path);

      let firstFailure: unknown;
      await assert.rejects(
        () => repo.insertLlmCall(llmRecord({ id: 'usage_write_error' })),
        (error: unknown) => {
          firstFailure = error;
          return isPublicationError('telemetry_derived_index')(error);
        },
      );
      assert.equal(repo.logs({ range: 'all' }).total, 0);
      await rm(path, { recursive: true });
      await writeFile(path, emptyDocument, 'utf8');

      await assert.rejects(
        () => repo.insertToolInvocation(toolRecord({ id: 'tool_after_failure' })),
        (error: unknown) => error === firstFailure,
      );
      assert.equal(await readFile(path, 'utf8'), emptyDocument);
      await assert.rejects(
        () => repo.flush(),
        (error: unknown) => error === firstFailure,
      );
      await assert.rejects(
        () => repo.close(),
        (error: unknown) => error === firstFailure,
      );
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  test('load creates an empty telemetry file only when missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-telemetry-missing-'));
    try {
      const repo = createTelemetryRepo(root);

      await repo.load();
      const raw = await readFile(join(root, 'telemetry.json'), 'utf8');

      assert.deepEqual(repo.logs({ range: 'all' }), { rows: [], total: 0 });
      assert.match(raw, /"version": 1/);
      assert.match(raw, /"usageRecords": \[\]/);
      assert.match(raw, /"toolInvocations": \[\]/);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  test('queries and mutations fail closed before load without overwriting an existing file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-telemetry-not-loaded-'));
    const path = join(root, 'telemetry.json');
    const existing =
      JSON.stringify({ version: 1, usageRecords: [llmRecord()], toolInvocations: [] }, null, 2) +
      '\n';
    await writeFile(path, existing, 'utf8');
    const repo = createTelemetryRepo(root);
    try {
      assert.throws(() => repo.summary({ range: 'all' }), TelemetryRepoNotLoadedError);
      assert.throws(() => repo.buckets({ range: 'all' }, 'provider'), TelemetryRepoNotLoadedError);
      assert.throws(() => repo.logs({ range: 'all' }), TelemetryRepoNotLoadedError);
      assert.throws(() => repo.latestLlmRuntimeProbe('connection'), TelemetryRepoNotLoadedError);
      assert.throws(
        () => repo.insertLlmCall(llmRecord({ id: 'unloaded-write' })),
        TelemetryRepoNotLoadedError,
      );
      assert.throws(
        () => repo.insertToolInvocation(toolRecord({ id: 'unloaded-tool-write' })),
        TelemetryRepoNotLoadedError,
      );
      assert.equal(await readFile(path, 'utf8'), existing);
    } finally {
      await repo.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  test('load rejects missing fields and legacy pricingOverrides without overwriting bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-telemetry-legacy-'));
    try {
      const legacy =
        JSON.stringify({ usageRecords: [], toolInvocations: [], pricingOverrides: [] }) + '\n';
      await writeFile(join(root, 'telemetry.json'), legacy, 'utf8');
      const repo = createTelemetryRepo(root);

      await assert.rejects(() => repo.load(), /expected exactly/);
      assert.equal(await readFile(join(root, 'telemetry.json'), 'utf8'), legacy);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  test('load rejects corrupt telemetry.json without overwriting usage history bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-telemetry-corrupt-'));
    try {
      const corrupt = '{"usageRecords":[{"id":"usage_1"}]';
      await writeFile(join(root, 'telemetry.json'), corrupt, 'utf8');
      const repo = createTelemetryRepo(root);

      await assert.rejects(() => repo.load(), SyntaxError);
      assert.equal(await readFile(join(root, 'telemetry.json'), 'utf8'), corrupt);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  test('load rejects wrong telemetry schema without overwriting bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-telemetry-wrong-schema-'));
    try {
      const wrongShape =
        JSON.stringify({ version: 2, usageRecords: [], toolInvocations: [] }, null, 2) + '\n';
      await writeFile(join(root, 'telemetry.json'), wrongShape, 'utf8');
      const repo = createTelemetryRepo(root);

      await assert.rejects(() => repo.load(), /expected version 1/);
      assert.equal(await readFile(join(root, 'telemetry.json'), 'utf8'), wrongShape);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  test('load rejects known telemetry sections with non-array values', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-telemetry-bad-section-'));
    try {
      const wrongShape =
        JSON.stringify({ version: 1, usageRecords: {}, toolInvocations: [] }, null, 2) + '\n';
      await writeFile(join(root, 'telemetry.json'), wrongShape, 'utf8');
      const repo = createTelemetryRepo(root);

      await assert.rejects(() => repo.load(), /usageRecords must be an array/);
      assert.equal(await readFile(join(root, 'telemetry.json'), 'utf8'), wrongShape);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  test('load strictly rejects malformed persisted LLM and tool rows without overwriting bytes', async () => {
    const malformedRows: Array<[string, unknown, unknown]> = [
      ['LLM unknown field', { ...llmRecord(), legacy: true }, toolRecord()],
      ['LLM cachedInputTokens alias', { ...llmRecord(), cachedInputTokens: 0 }, toolRecord()],
      ['LLM missing required field', withoutField(llmRecord(), 'providerId'), toolRecord()],
      ['LLM invalid status', { ...llmRecord(), status: 'pending' }, toolRecord()],
      ['LLM invalid numeric value', { ...llmRecord(), totalTokens: -1 }, toolRecord()],
      ['tool unknown field', llmRecord(), { ...toolRecord(), legacy: true }],
      ['tool missing required field', llmRecord(), withoutField(toolRecord(), 'bytesOut')],
      ['tool invalid status', llmRecord(), { ...toolRecord(), status: 'pending' }],
      ['tool invalid numeric value', llmRecord(), { ...toolRecord(), durationMs: -1 }],
    ];

    for (const [label, usageRecord, toolInvocation] of malformedRows) {
      const root = await mkdtemp(join(tmpdir(), 'maka-telemetry-malformed-row-'));
      const path = join(root, 'telemetry.json');
      const bytes =
        JSON.stringify(
          { version: 1, usageRecords: [usageRecord], toolInvocations: [toolInvocation] },
          null,
          2,
        ) + '\n';
      await writeFile(path, bytes, 'utf8');
      const repo = createTelemetryRepo(root, { createIfMissing: false });
      try {
        await assert.rejects(() => repo.load(), /Invalid telemetry file/, label);
        assert.equal(await readFile(path, 'utf8'), bytes, label);
      } finally {
        await repo.close();
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
      }
    }
  });
});

async function withRepo(
  fn: (repo: ReturnType<typeof createTelemetryRepo>) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-telemetry-'));
  const repo = createTelemetryRepo(root);
  try {
    await fn(repo);
  } finally {
    await repo.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}

function llmRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'usage_1',
    providerId: 'openai',
    modelId: 'gpt-4o',
    inputTokens: 10,
    outputTokens: 20,
    cacheHitInputTokens: 0,
    cacheMissInputTokens: 10,
    cacheWriteInputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 30,
    costUsd: 0.001,
    latencyMs: 100,
    status: 'success',
    date: '2026-01-01',
    ts: Date.UTC(2026, 0, 1),
    startedAt: Date.UTC(2026, 0, 1) - 100,
    ...overrides,
  } as Parameters<ReturnType<typeof createTelemetryRepo>['insertLlmCall']>[0];
}

function toolRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tool_1',
    toolName: 'Bash',
    durationMs: 10,
    status: 'success',
    argsSummary: '',
    bytesIn: 0,
    bytesOut: 0,
    date: '2026-01-01',
    ts: Date.UTC(2026, 0, 1),
    startedAt: Date.UTC(2026, 0, 1) - 10,
    ...overrides,
  } as Parameters<ReturnType<typeof createTelemetryRepo>['insertToolInvocation']>[0];
}

function isPublicationError(domain: TelemetryRepoPublicationError['domain']) {
  return (error: unknown): boolean =>
    error instanceof TelemetryRepoPublicationError && error.domain === domain;
}

function withoutField(value: object, key: string): Record<string, unknown> {
  const result: Record<string, unknown> = { ...value };
  delete result[key];
  return result;
}
