#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  AiSdkBackend,
  BackendRegistry,
  PermissionEngine,
  SessionManager,
  buildBuiltinTools,
  buildProviderOptions,
  computeCost,
  createDefaultPermissionEngineDeps,
  getAIModel,
  getBuiltinPricing,
} from '../packages/runtime/dist/index.js';
import {
  createAgentRunStore,
  createArtifactStore,
  createRuntimeEventStore,
  createSessionStore,
} from '../packages/storage/dist/index.js';

const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) {
  throw new Error('DEEPSEEK_API_KEY is not set. Source your local secret env before running this script.');
}

const repoRoot = resolve(new URL('..', import.meta.url).pathname);
const outputRoot = resolve(process.env.MAKA_COST_BASELINE_OUTPUT ?? join(tmpdir(), 'maka-deepseek-cost-baseline'));
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const workspaceRoot = join(outputRoot, runId, 'workspace');
await mkdir(workspaceRoot, { recursive: true });

const model = process.env.MAKA_COST_BASELINE_MODEL ?? 'deepseek-chat';
const turnCount = parsePositiveInt(process.env.MAKA_COST_BASELINE_TURNS, 10);
const toolMode = process.env.MAKA_COST_BASELINE_TOOLS ?? 'none';
const seed = process.env.MAKA_COST_BASELINE_SEED ?? runId;
const cwd = resolve(process.env.MAKA_COST_BASELINE_CWD ?? repoRoot);
const contextBudget = buildContextBudgetPolicy();
const stablePolicyLines = parsePositiveInt(process.env.MAKA_COST_BASELINE_STABLE_POLICY_LINES, 140);
const payloadLines = parsePositiveInt(process.env.MAKA_COST_BASELINE_PAYLOAD_LINES, 70);

if (process.env.MAKA_COST_BASELINE_PHASE7_TOOL_MATRIX === 'on') {
  const exitCode = await runPhase7ToolMatrix({
    apiKey,
    model,
    repoRoot,
    outputRoot,
    runId,
    seed,
    cwd,
  });
  process.exit(exitCode);
}

const sessionStore = createSessionStore(workspaceRoot);
const runStore = createAgentRunStore(workspaceRoot);
const runtimeEventStore = createRuntimeEventStore(workspaceRoot);
const artifactStore = createArtifactStore(workspaceRoot);
const permissionEngine = new PermissionEngine(createDefaultPermissionEngineDeps());
const backends = new BackendRegistry();
const llmRecords = [];
const runTraceEvents = [];
const tools = toolMode === 'builtin' ? buildBuiltinTools() : [];

const connection = {
  slug: 'deepseek-live-cost-baseline',
  name: 'DeepSeek live cost baseline',
  providerType: 'deepseek',
  baseUrl: 'https://api.deepseek.com',
  defaultModel: model,
  enabled: true,
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

const durablePrefix = [
  'You are a concise Maka runtime cost baseline assistant.',
  `Baseline seed: ${seed}`,
  'Always answer exactly: OK',
  'The following stable policy block is intentionally repeated to make provider prefix caching observable.',
  '<stable-policy>',
  Array.from({ length: stablePolicyLines }, (_, index) =>
    `Stable policy line ${String(index + 1).padStart(3, '0')}: preserve the durable system prefix, avoid unnecessary wording churn, and keep responses short.`,
  ).join('\n'),
  '</stable-policy>',
].join('\n');

function turnTailPrompt() {
  return [
    '<current-session-environment>',
    `cwd: ${cwd}`,
    `git_branch: ${process.env.MAKA_COST_BASELINE_BRANCH ?? 'unknown'}`,
    `calendar_date: ${process.env.MAKA_COST_BASELINE_DATE ?? new Date().toISOString().slice(0, 10)}`,
    '</current-session-environment>',
  ].join('\n');
}

backends.register('ai-sdk', async (ctx) =>
  new AiSdkBackend({
    sessionId: ctx.sessionId,
    header: { ...ctx.header, model },
    appendMessage: (message) => ctx.store.appendMessage(ctx.sessionId, message),
    connection,
    apiKey,
    modelId: model,
    permissionEngine,
    modelFactory: getAIModel,
    tools,
    providerOptions: buildProviderOptions(connection, model),
    contextBudget,
    systemPrompt: durablePrefix,
    turnTailPrompt,
    recordLlmCall: (record) => llmRecords.push(record),
    recordRunTrace: (event) => runTraceEvents.push(event),
    archiveToolResult: async (event) => {
      const artifact = await artifactStore.create({
        sessionId: event.sessionId,
        turnId: event.turnId,
        name: `tool-result-${event.runtimeEventId}.json`,
        kind: 'file',
        content: event.serializedResult,
        mimeType: 'application/json',
        source: 'tool_result_archive',
        summary: `Archived ${event.toolName} tool result for DeepSeek cost baseline replay`,
      });
      return { artifactId: artifact.id };
    },
    readToolResultArchive: async (event) => {
      const record = await artifactStore.get(event.artifactId);
      if (!record) return { ok: false, reason: 'not_found' };
      if (record.status === 'deleted') return { ok: false, reason: 'deleted' };
      if (record.source !== 'tool_result_archive') return { ok: false, reason: 'source_mismatch' };
      if (record.sessionId !== event.sessionId) return { ok: false, reason: 'session_mismatch' };
      if (record.sizeBytes !== event.originalBytes) return { ok: false, reason: 'size_mismatch' };
      const read = await artifactStore.readText(event.artifactId, {
        maxBytes: event.maxBytes ?? event.originalBytes,
      });
      if (!read.ok) return read;
      if (sha256(read.text) !== event.bodySha256) return { ok: false, reason: 'corrupt' };
      return { ok: true, serializedResult: read.text };
    },
    newId: randomUUID,
    now: Date.now,
    maxSteps: 1,
    streamConnectTimeoutMs: 30_000,
    streamIdleTimeoutMs: 120_000,
  }),
);

const manager = new SessionManager({
  store: sessionStore,
  runStore,
  runtimeEventStore,
  backends,
  newId: randomUUID,
  now: Date.now,
});
const session = await manager.createSession({
  cwd,
  backend: 'ai-sdk',
  llmConnectionSlug: connection.slug,
  model,
  permissionMode: 'explore',
  name: 'DeepSeek live cost baseline',
});

const turns = [];
const repeatedPayload = Array.from({ length: payloadLines }, (_, index) =>
  `baseline fact ${String(index + 1).padStart(2, '0')}: this stable user payload is repeated to expose how much new-tail text becomes cache miss.`,
).join('\n');

for (let i = 1; i <= turnCount; i += 1) {
  const turnId = `cost-turn-${String(i).padStart(2, '0')}`;
  const text = [
    `Turn ${i}. Answer exactly OK.`,
    repeatedPayload,
    `Unique turn marker: ${String(i).padStart(2, '0')}.`,
  ].join('\n');
  const events = [];
  const startedAt = Date.now();
  for await (const event of manager.sendMessage(session.id, { turnId, text })) {
    events.push(event);
  }
  const finishedAt = Date.now();
  const usageEvent = events.find((event) => event.type === 'token_usage');
  const completeEvent = events.find((event) => event.type === 'complete');
  const errorEvent = events.find((event) => event.type === 'error');
  const llmRecord = llmRecords.at(-1);
  const cacheMissInputSource = usageEvent?.cacheMissInputSource ?? llmRecord?.cacheMissInputSource;
  const cacheMissInput = usageEvent?.cacheMissInput ?? llmRecord?.cacheMissInputTokens;
  const contextBudgetDiagnostic = usageEvent?.contextBudget ?? llmRecord?.contextBudget;
  const cost = llmRecord
    ? computeCost(
        {
          inputTokens: llmRecord.inputTokens,
          outputTokens: llmRecord.outputTokens,
          cacheHitInputTokens: llmRecord.cacheHitInputTokens,
          cacheMissInputTokens: llmRecord.cacheMissInputTokens,
          cacheWriteInputTokens: llmRecord.cacheWriteInputTokens,
        },
        getBuiltinPricing(`${connection.providerType}:${model}`),
      )
    : undefined;
  turns.push({
    turn: i,
    turnId,
    durationMs: finishedAt - startedAt,
    eventCount: events.length,
    status: errorEvent ? 'error' : 'ok',
    stopReason: completeEvent?.stopReason,
    prefixChangeReason: usageEvent?.prefixChangeReason,
    prefixHash: usageEvent?.prefixHash,
    requestShapeChangeReason: usageEvent?.requestShapeChangeReason,
    requestShapeHash: usageEvent?.requestShapeHash,
    input: usageEvent?.input ?? llmRecord?.inputTokens,
    cacheHitInput: usageEvent?.cacheHitInput ?? llmRecord?.cacheHitInputTokens,
    cacheMissInput,
    cacheMissInputSource,
    providerExplicitCacheMissInput: cacheMissInputSource === 'explicit' ? cacheMissInput : null,
    locallyDerivedCacheMissInput: cacheMissInputSource === 'derived' ? cacheMissInput : null,
    cacheWriteInput: usageEvent?.cacheWriteInput ?? llmRecord?.cacheWriteInputTokens,
    cacheMissShapeSource: classifyCacheMissShape(
      usageEvent?.prefixChangeReason,
      usageEvent?.requestShapeChangeReason,
    ),
    output: usageEvent?.output ?? llmRecord?.outputTokens,
    total: usageEvent?.total,
    estimatedCostUsd: cost?.totalCost,
    promptSegments: usageEvent?.promptSegments ?? llmRecord?.promptSegments,
    contextBudget: contextBudgetDiagnostic,
    archivePlaceholders: contextBudgetDiagnostic?.archivePlaceholders ?? 0,
    archiveWriteFailures: contextBudgetDiagnostic?.archiveWriteFailures ?? 0,
    archivePlaceholderReasonCounts: contextBudgetDiagnostic?.archivePlaceholderReasonCounts,
    retrievedArchiveToolResults: contextBudgetDiagnostic?.retrievedArchiveToolResults ?? 0,
    retrievedArchiveEstimatedTokens: contextBudgetDiagnostic?.retrievedArchiveEstimatedTokens ?? 0,
    archiveRetrievalSkipped: contextBudgetDiagnostic?.archiveRetrievalSkipped ?? 0,
    archiveRetrievalFailures: contextBudgetDiagnostic?.archiveRetrievalFailures ?? 0,
    archiveRetrievalFailureReasonCounts: contextBudgetDiagnostic?.archiveRetrievalFailureReasonCounts,
    errorReason: errorEvent?.reason,
  });
}

const totals = turns.reduce((acc, turn) => {
  acc.input += turn.input ?? 0;
  acc.cacheHitInput += turn.cacheHitInput ?? 0;
  acc.cacheMissInput += turn.cacheMissInput ?? 0;
  acc.cacheWriteInput += turn.cacheWriteInput ?? 0;
  acc.output += turn.output ?? 0;
  acc.estimatedCostUsd += turn.estimatedCostUsd ?? 0;
  if (turn.cacheMissInputSource === 'explicit') acc.explicitCacheMissTurns += 1;
  else if (turn.cacheMissInputSource === 'derived') acc.derivedCacheMissTurns += 1;
  else acc.unknownCacheMissTurns += 1;
  acc.archivePlaceholders += turn.archivePlaceholders ?? 0;
  acc.archiveWriteFailures += turn.archiveWriteFailures ?? 0;
  acc.retrievedArchiveToolResults += turn.retrievedArchiveToolResults ?? 0;
  acc.retrievedArchiveEstimatedTokens += turn.retrievedArchiveEstimatedTokens ?? 0;
  acc.archiveRetrievalSkipped += turn.archiveRetrievalSkipped ?? 0;
  acc.archiveRetrievalFailures += turn.archiveRetrievalFailures ?? 0;
  for (const [reason, count] of Object.entries(turn.archivePlaceholderReasonCounts ?? {})) {
    acc.archivePlaceholderReasonCounts[reason] = (acc.archivePlaceholderReasonCounts[reason] ?? 0) + count;
  }
  for (const [reason, count] of Object.entries(turn.archiveRetrievalFailureReasonCounts ?? {})) {
    acc.archiveRetrievalFailureReasonCounts[reason] = (acc.archiveRetrievalFailureReasonCounts[reason] ?? 0) + count;
  }
  return acc;
}, {
  input: 0,
  cacheHitInput: 0,
  cacheMissInput: 0,
  cacheWriteInput: 0,
  output: 0,
  estimatedCostUsd: 0,
  explicitCacheMissTurns: 0,
  derivedCacheMissTurns: 0,
  unknownCacheMissTurns: 0,
  archivePlaceholders: 0,
  archiveWriteFailures: 0,
  archivePlaceholderReasonCounts: {},
  retrievedArchiveToolResults: 0,
  retrievedArchiveEstimatedTokens: 0,
  archiveRetrievalSkipped: 0,
  archiveRetrievalFailures: 0,
  archiveRetrievalFailureReasonCounts: {},
});

const report = {
  sourceRef: process.env.MAKA_COST_BASELINE_SOURCE_REF ?? 'local-build',
  scenario: buildScenario(contextBudget),
  repoRoot,
  workspaceRoot,
  model,
  seed,
  toolMode,
  toolCount: tools.length,
  turnCount,
  stablePolicyLines,
  payloadLines,
  contextBudget,
  sessionId: session.id,
  totals,
  turns,
  runTracePrefixEvents: runTraceEvents
    .filter((event) =>
      event.data?.prefixHash ||
      event.data?.prefixChangeReason ||
      event.data?.requestShapeHash ||
      event.data?.requestShapeChangeReason
    )
    .map((event) => ({
      phase: event.phase,
      type: event.type,
      prefixHash: event.data?.prefixHash,
      prefixChangeReason: event.data?.prefixChangeReason,
      requestShapeHash: event.data?.requestShapeHash,
      requestShapeChangeReason: event.data?.requestShapeChangeReason,
      promptSegments: event.data?.promptSegments,
      contextBudget: event.data?.contextBudget,
    })),
};

const outputDir = join(outputRoot, runId);
await mkdir(outputDir, { recursive: true });
const jsonPath = join(outputDir, 'deepseek-live-cost-baseline.json');
const markdownPath = join(outputDir, 'deepseek-live-cost-baseline.md');
await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
await writeFile(markdownPath, renderMarkdown(report, jsonPath), 'utf8');
console.log(JSON.stringify({ jsonPath, markdownPath, totals, turnCount, toolMode, contextBudget }, null, 2));

async function runPhase7ToolMatrix(input) {
  const matrixOutputRoot = join(input.outputRoot, input.runId, 'phase7-tool-matrix');
  await mkdir(matrixOutputRoot, { recursive: true });
  const sentinel = process.env.MAKA_COST_BASELINE_PHASE7_SENTINEL
    ?? `PHASE7_SENTINEL_${sha256(`${input.seed}:phase7`).slice(0, 16)}`;
  const lookupKey = process.env.MAKA_COST_BASELINE_PHASE7_LOOKUP_KEY ?? 'phase7-live-key';
  const resultLines = parsePositiveInt(process.env.MAKA_COST_BASELINE_PHASE7_RESULT_LINES, 220);
  const noisyArchiveCount = parsePositiveInt(process.env.MAKA_COST_BASELINE_PHASE7_NOISY_ARCHIVES, 8);
  const cases = [];
  for (const matrixCase of [
    { name: 'single_archive_recovery', noiseArchiveCount: 0 },
    { name: 'multi_archive_selectivity', noiseArchiveCount: noisyArchiveCount },
  ]) {
    const scenarios = [];
    for (const mode of ['full', 'prune', 'eager', 'gated']) {
      scenarios.push(await runPhase7ToolScenario({
        ...input,
        matrixOutputRoot: join(matrixOutputRoot, matrixCase.name),
        matrixCase: matrixCase.name,
        mode,
        sentinel,
        lookupKey,
        resultLines,
        noiseArchiveCount: matrixCase.noiseArchiveCount,
      }));
    }
    cases.push({
      name: matrixCase.name,
      noiseArchiveCount: matrixCase.noiseArchiveCount,
      archiveCount: matrixCase.noiseArchiveCount + 1,
      scenarios,
    });
  }
  const scenarios = cases[0]?.scenarios ?? [];
  const invariantFailures = validatePhase7ToolMatrix(cases, sentinel);

  const report = {
    sourceRef: process.env.MAKA_COST_BASELINE_SOURCE_REF ?? 'local-build',
    scenario: {
      name: 'phase7_tool_archive_retrieval_matrix',
      cases: cases.map((matrixCase) => matrixCase.name),
      modes: scenarios.map((scenario) => scenario.mode),
    },
    passed: invariantFailures.length === 0,
    invariantFailures,
    repoRoot: input.repoRoot,
    outputRoot: matrixOutputRoot,
    model: input.model,
    seed: input.seed,
    lookupKey,
    sentinelSha256: sha256(sentinel),
    resultLines,
    noisyArchiveCount,
    cases,
    scenarios,
  };
  const jsonPath = resolve(
    process.env.MAKA_COST_BASELINE_PHASE7_MATRIX_JSON
      ?? join(matrixOutputRoot, 'phase7-tool-live-matrix.json'),
  );
  await mkdir(resolve(jsonPath, '..'), { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    jsonPath,
    model: input.model,
    scenario: report.scenario.name,
    cases: cases.map((matrixCase) => ({
      name: matrixCase.name,
      modes: matrixCase.scenarios.map((scenario) => ({
        mode: scenario.mode,
        recoveredSentinel: scenario.recoveredSentinel,
        finalAnswerExactlySentinel: scenario.finalAnswerExactlySentinel,
        archivedToolResultsRead: scenario.archivedToolResultsRead,
        finalArchivedToolResultsRead: scenario.finalArchivedToolResultsRead,
        finalUsage: scenario.finalUsage,
        scenarioUsageTotals: scenario.scenarioUsageTotals,
        toolCalls: scenario.toolCalls.length,
      })),
    })),
    invariantFailures,
  }, null, 2));
  if (invariantFailures.length > 0) {
    console.error([
      'Phase 7 tool matrix invariant failures:',
      ...invariantFailures.map((failure) => `- ${failure}`),
    ].join('\n'));
    return 1;
  }
  return 0;
}

async function runPhase7ToolScenario(input) {
  const workspaceRoot = join(input.matrixOutputRoot, input.mode, 'workspace');
  await mkdir(workspaceRoot, { recursive: true });
  const sessionStore = createSessionStore(workspaceRoot);
  const runStore = createAgentRunStore(workspaceRoot);
  const runtimeEventStore = createRuntimeEventStore(workspaceRoot);
  const artifactStore = createArtifactStore(workspaceRoot);
  const permissionEngine = new PermissionEngine(createDefaultPermissionEngineDeps());
  const backends = new BackendRegistry();
  const llmRecords = [];
  const runTraceEvents = [];
  const archiveReads = [];
  let activeTurnId;
  const tools = [buildPhase7LookupTool(input)];
  const connection = {
    slug: `deepseek-live-phase7-${input.mode}`,
    name: `DeepSeek live Phase 7 ${input.mode}`,
    providerType: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    defaultModel: input.model,
    enabled: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const contextBudget = buildPhase7ContextBudgetPolicy(input.mode);
  const systemPrompt = [
    'You are a Maka Phase 7 live harness assistant.',
    `Lookup key: ${input.lookupKey}`,
    'When asked to store the Phase 7 lookup, call Phase7Lookup exactly once with the lookup key.',
    'After the tool result is available, answer exactly STORED.',
    'Do not include the sentinel value in the storage acknowledgement.',
    'When later asked to recover the sentinel, answer only the sentinel value found in prior tool results.',
    'Do not call Phase7Lookup during sentinel recovery; recovery must use prior context only.',
  ].join('\n');

  backends.register('ai-sdk', async (ctx) =>
    new AiSdkBackend({
      sessionId: ctx.sessionId,
      header: { ...ctx.header, model: input.model },
      appendMessage: (message) => ctx.store.appendMessage(ctx.sessionId, message),
      connection,
      apiKey: input.apiKey,
      modelId: input.model,
      permissionEngine,
      modelFactory: getAIModel,
      tools,
      providerOptions: buildProviderOptions(connection, input.model),
      contextBudget,
      systemPrompt,
      turnTailPrompt: phase7TurnTailPrompt(input.cwd),
      recordLlmCall: (record) => llmRecords.push(record),
      recordRunTrace: (event) => runTraceEvents.push(event),
      archiveToolResult: async (event) => {
        const artifact = await artifactStore.create({
          sessionId: event.sessionId,
          turnId: event.turnId,
          name: `phase7-tool-result-${event.runtimeEventId}.json`,
          kind: 'file',
          content: event.serializedResult,
          mimeType: 'application/json',
          source: 'tool_result_archive',
          summary: `Archived ${event.toolName} Phase 7 tool result for ${input.mode}`,
        });
        return { artifactId: artifact.id };
      },
      readToolResultArchive: async (event) => {
        archiveReads.push({
          requestTurnId: activeTurnId,
          runtimeEventId: event.runtimeEventId,
          turnId: event.turnId,
          artifactId: event.artifactId,
        });
        const record = await artifactStore.get(event.artifactId);
        if (!record) return { ok: false, reason: 'not_found' };
        if (record.status === 'deleted') return { ok: false, reason: 'deleted' };
        if (record.source !== 'tool_result_archive') return { ok: false, reason: 'source_mismatch' };
        if (record.sessionId !== event.sessionId) return { ok: false, reason: 'session_mismatch' };
        if (record.sizeBytes !== event.originalBytes) return { ok: false, reason: 'size_mismatch' };
        const read = await artifactStore.readText(event.artifactId, {
          maxBytes: event.maxBytes ?? event.originalBytes,
        });
        if (!read.ok) return read;
        if (sha256(read.text) !== event.bodySha256) return { ok: false, reason: 'corrupt' };
        return { ok: true, serializedResult: read.text };
      },
      newId: randomUUID,
      now: Date.now,
      maxSteps: 4,
      streamConnectTimeoutMs: 30_000,
      streamIdleTimeoutMs: 120_000,
    }),
  );

  const manager = new SessionManager({
    store: sessionStore,
    runStore,
    runtimeEventStore,
    backends,
    newId: randomUUID,
    now: Date.now,
  });
  const session = await manager.createSession({
    cwd: input.cwd,
    backend: 'ai-sdk',
    llmConnectionSlug: connection.slug,
    model: input.model,
    permissionMode: 'explore',
    name: `DeepSeek Phase 7 ${input.mode}`,
  });

  const storeSpecs = buildPhase7StoreSpecs(input);
  const storeTurns = [];
  for (const storeSpec of storeSpecs) {
    storeTurns.push({
      ...storeSpec,
      ...(await sendPhase7ScenarioTurn(
        manager,
        session.id,
        storeSpec.turnId,
        [
          `Store the Phase 7 lookup for key ${storeSpec.key}.`,
          'Call Phase7Lookup, then acknowledge with exactly STORED.',
          'Do not repeat any sentinel value.',
        ].join('\n'),
        (turnId) => { activeTurnId = turnId; },
      )),
    });
  }
  const fillerTurn = await sendPhase7ScenarioTurn(
    manager,
    session.id,
    'phase7-filler',
    'Answer exactly OK. This turn exists so the old tool result becomes stale for pruning.',
    (turnId) => { activeTurnId = turnId; },
  );
  const recoverTurn = await sendPhase7ScenarioTurn(
    manager,
    session.id,
    'phase7-recover',
    `Recover the sentinel for lookup key ${input.lookupKey} from the archived Phase 7 tool result. Do not call tools. Answer only the sentinel.`,
    (turnId) => { activeTurnId = turnId; },
  );
  activeTurnId = undefined;
  const finalUsage = recoverTurn.events.find((event) => event.type === 'token_usage');
  const storageAnswerIncludedSentinel = storeTurns.some((turn) => turn.assistantText.includes(input.sentinel));
  const finalArchiveReads = archiveReads.filter((read) => read.requestTurnId === 'phase7-recover');
  const pricingId = `${connection.providerType}:${input.model}`;
  return {
    matrixCase: input.matrixCase,
    mode: input.mode,
    contextBudget,
    sessionId: session.id,
    storeTurns: storeTurns.map((turn) => ({
      turnId: turn.turnId,
      key: turn.key,
      target: turn.target,
      assistantText: turn.assistantText,
    })),
    expectedToolCallTurns: storeSpecs.map((spec) => spec.turnId),
    targetToolCallTurnId: storeSpecs.find((spec) => spec.target)?.turnId,
    toolCalls: [
      ...storeTurns.flatMap((turn) => turn.events),
      ...fillerTurn.events,
      ...recoverTurn.events,
    ]
      .filter((event) => event.type === 'tool_start')
      .map((event) => ({ turnId: event.turnId, toolName: event.toolName })),
    storageAnswerIncludedSentinel,
    finalAnswer: recoverTurn.assistantText,
    recoveredSentinel: recoverTurn.assistantText.includes(input.sentinel),
    finalAnswerExactlySentinel: recoverTurn.assistantText.trim() === input.sentinel,
    archivedToolResultsRead: archiveReads.length,
    archiveReads,
    finalArchivedToolResultsRead: finalArchiveReads.length,
    finalArchiveReads,
    finalContextBudget: finalUsage?.contextBudget,
    finalUsage: usageSummary(finalUsage, llmRecords.at(-1), pricingId),
    scenarioUsageTotals: usageTotals(llmRecords, pricingId),
    requestShapeTrace: runTraceEvents
      .filter((event) =>
        event.data?.requestShapeHash ||
        event.data?.requestShapeChangeReason ||
        event.data?.contextBudget
      )
      .map((event) => ({
        phase: event.phase,
        type: event.type,
        requestShapeHash: event.data?.requestShapeHash,
        requestShapeChangeReason: event.data?.requestShapeChangeReason,
        contextBudget: event.data?.contextBudget,
      })),
  };
}

function buildPhase7LookupTool(input) {
  return {
    name: 'Phase7Lookup',
    description: 'Deterministic Phase 7 harness tool. Use only when asked to store the Phase 7 lookup key.',
    parameters: z.object({
      key: z.string().describe('The lookup key requested by the user.'),
    }),
    permissionRequired: false,
    impl: ({ key }) => {
      const target = key === input.lookupKey;
      const sentinel = target
        ? input.sentinel
        : `PHASE7_NOISE_${sha256(`${input.seed}:${input.matrixCase}:${key}`).slice(0, 16)}`;
      return {
        key,
        target,
        sentinel,
        rows: Array.from({ length: input.resultLines }, (_, index) => ({
          index,
          text: `phase7 archived payload row ${String(index + 1).padStart(3, '0')} for ${key}`,
        })),
      };
    },
  };
}

function buildPhase7StoreSpecs(input) {
  const noiseSpecs = Array.from({ length: input.noiseArchiveCount ?? 0 }, (_, index) => ({
    turnId: `phase7-store-noise-${String(index + 1).padStart(2, '0')}`,
    key: `${input.lookupKey}-noise-${String(index + 1).padStart(2, '0')}`,
    target: false,
  }));
  const targetTurnId = noiseSpecs.length === 0 ? 'phase7-store' : 'phase7-store-target';
  return [
    ...noiseSpecs,
    {
      turnId: targetTurnId,
      key: input.lookupKey,
      target: true,
    },
  ];
}

function buildPhase7ContextBudgetPolicy(mode) {
  if (mode === 'full') return undefined;
  const base = {
    name: `phase7-${mode}`,
    minRecentTurns: 1,
    charsPerToken: 4,
    staleToolResultPrune: {
      enabled: true,
      maxResultEstimatedTokens: parsePositiveInt(
        process.env.MAKA_CONTEXT_STALE_TOOL_RESULT_MAX_TOKENS,
        128,
      ),
      minRecentTurnsFull: 0,
    },
  };
  if (mode === 'prune') return base;
  const archiveRetrieval = {
    enabled: true,
    mode: mode === 'gated' ? 'history_search_gated' : 'eager',
    maxResults: 4,
    maxEstimatedTokens: parsePositiveInt(process.env.MAKA_CONTEXT_ARCHIVE_RETRIEVAL_MAX_TOKENS, 16_384),
    maxBytes: parsePositiveInt(process.env.MAKA_CONTEXT_ARCHIVE_RETRIEVAL_MAX_BYTES, 2 * 1024 * 1024),
    order: 'newest_first',
  };
  if (mode === 'gated') {
    return {
      ...base,
      archiveRetrieval,
      historySearch: {
        enabled: true,
        maxResults: 1,
        around: 0,
        maxEstimatedTokens: 4096,
      },
    };
  }
  return {
    ...base,
    archiveRetrieval,
  };
}

function phase7TurnTailPrompt(cwd) {
  return [
    '<current-session-environment>',
    `cwd: ${cwd}`,
    `calendar_date: ${process.env.MAKA_COST_BASELINE_DATE ?? new Date().toISOString().slice(0, 10)}`,
    '</current-session-environment>',
  ].join('\n');
}

async function sendPhase7Turn(manager, sessionId, turnId, text) {
  const events = [];
  for await (const event of manager.sendMessage(sessionId, { turnId, text })) {
    events.push(event);
  }
  return {
    events,
    assistantText: events
      .filter((event) => event.type === 'text_complete')
      .map((event) => event.text)
      .join('\n'),
  };
}

async function sendPhase7ScenarioTurn(manager, sessionId, turnId, text, setActiveTurnId) {
  setActiveTurnId(turnId);
  try {
    return await sendPhase7Turn(manager, sessionId, turnId, text);
  } finally {
    setActiveTurnId(undefined);
  }
}

function usageSummary(usageEvent, llmRecord, pricingId) {
  const cost = llmRecord ? costForLlmRecord(llmRecord, pricingId) : undefined;
  return {
    input: usageEvent?.input ?? llmRecord?.inputTokens,
    output: usageEvent?.output ?? llmRecord?.outputTokens,
    cacheHitInput: usageEvent?.cacheHitInput ?? llmRecord?.cacheHitInputTokens,
    cacheMissInput: usageEvent?.cacheMissInput ?? llmRecord?.cacheMissInputTokens,
    cacheWriteInput: usageEvent?.cacheWriteInput ?? llmRecord?.cacheWriteInputTokens,
    estimatedCostUsd: cost?.totalCost,
    requestShapeChangeReason: usageEvent?.requestShapeChangeReason ?? llmRecord?.requestShapeChangeReason,
    contextBudget: usageEvent?.contextBudget ?? llmRecord?.contextBudget,
  };
}

function usageTotals(llmRecords, pricingId) {
  return llmRecords.reduce((acc, record) => {
    const cost = costForLlmRecord(record, pricingId);
    acc.calls += 1;
    acc.input += record.inputTokens ?? 0;
    acc.output += record.outputTokens ?? 0;
    acc.cacheHitInput += record.cacheHitInputTokens ?? 0;
    acc.cacheMissInput += record.cacheMissInputTokens ?? 0;
    acc.cacheWriteInput += record.cacheWriteInputTokens ?? 0;
    acc.estimatedCostUsd += cost?.totalCost ?? 0;
    return acc;
  }, {
    calls: 0,
    input: 0,
    output: 0,
    cacheHitInput: 0,
    cacheMissInput: 0,
    cacheWriteInput: 0,
    estimatedCostUsd: 0,
  });
}

function costForLlmRecord(record, pricingId) {
  return computeCost(
    {
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      cacheHitInputTokens: record.cacheHitInputTokens,
      cacheMissInputTokens: record.cacheMissInputTokens,
      cacheWriteInputTokens: record.cacheWriteInputTokens,
    },
    getBuiltinPricing(pricingId),
  );
}

function validatePhase7ToolMatrix(cases, sentinel) {
  const failures = [];
  for (const matrixCase of cases) {
    const byMode = new Map(matrixCase.scenarios.map((scenario) => [scenario.mode, scenario]));
    for (const mode of ['full', 'prune', 'eager', 'gated']) {
      const scenario = byMode.get(mode);
      if (!scenario) {
        failures.push(`${matrixCase.name}: missing ${mode} scenario`);
        continue;
      }
      if (scenario.storageAnswerIncludedSentinel) {
        failures.push(`${matrixCase.name}: ${mode} scenario repeated sentinel in storage acknowledgement`);
      }
      const expectedTurnCounts = new Map(scenario.expectedToolCallTurns.map((turnId) => [turnId, 0]));
      for (const call of scenario.toolCalls) {
        if (call.toolName !== 'Phase7Lookup') {
          failures.push(`${matrixCase.name}: ${mode} scenario unexpected tool call ${call.toolName}`);
        }
        if (!expectedTurnCounts.has(call.turnId)) {
          failures.push(`${matrixCase.name}: ${mode} scenario unexpected tool call on ${call.turnId}`);
        } else {
          expectedTurnCounts.set(call.turnId, expectedTurnCounts.get(call.turnId) + 1);
        }
      }
      for (const [turnId, count] of expectedTurnCounts.entries()) {
        if (count !== 1) {
          failures.push(`${matrixCase.name}: ${mode} scenario expected one Phase7Lookup call on ${turnId}, saw ${count}`);
        }
      }
      if (scenario.toolCalls.length !== scenario.expectedToolCallTurns.length) {
        failures.push(`${matrixCase.name}: ${mode} scenario expected ${scenario.expectedToolCallTurns.length} tool calls, saw ${scenario.toolCalls.length}`);
      }
    }

    const full = byMode.get('full');
    const prune = byMode.get('prune');
    const eager = byMode.get('eager');
    const gated = byMode.get('gated');
    if (full && !full.recoveredSentinel) failures.push(`${matrixCase.name}: full scenario did not recover sentinel`);
    if (prune?.recoveredSentinel) failures.push(`${matrixCase.name}: prune scenario recovered sentinel without archive retrieval`);
    if (prune && prune.archivedToolResultsRead !== 0) failures.push(`${matrixCase.name}: prune scenario unexpectedly read archives`);
    if (eager && !eager.recoveredSentinel) failures.push(`${matrixCase.name}: eager scenario did not recover sentinel`);
    if (eager && eager.archivedToolResultsRead < 1) failures.push(`${matrixCase.name}: eager scenario did not read any archive`);
    if (eager?.finalContextBudget?.archiveRetrievalMode !== 'eager') {
      failures.push(`${matrixCase.name}: eager scenario did not report eager retrieval mode`);
    }
    if ((eager?.finalContextBudget?.retrievedArchiveToolResults ?? 0) < 1) {
      failures.push(`${matrixCase.name}: eager scenario final turn did not retrieve an archive`);
    }
    if (gated && !gated.recoveredSentinel) failures.push(`${matrixCase.name}: gated scenario did not recover sentinel`);
    if (gated && gated.archivedToolResultsRead < 1) failures.push(`${matrixCase.name}: gated scenario did not read any archive`);
    if (gated?.finalContextBudget?.archiveRetrievalMode !== 'history_search_gated') {
      failures.push(`${matrixCase.name}: gated scenario did not report history_search_gated retrieval mode`);
    }
    if ((gated?.finalContextBudget?.retrievedArchiveToolResults ?? 0) < 1) {
      failures.push(`${matrixCase.name}: gated scenario final turn did not retrieve an archive`);
    }
    if ((gated?.finalContextBudget?.archiveRetrievalEligibleTurns ?? 0) < 1) {
      failures.push(`${matrixCase.name}: gated scenario did not report any archive retrieval eligible turns`);
    }
    if ((gated?.finalContextBudget?.historySearchMatches ?? 0) < 1) {
      failures.push(`${matrixCase.name}: gated scenario did not report a history search match`);
    }
    if (matrixCase.name === 'multi_archive_selectivity') {
      if ((gated?.finalArchivedToolResultsRead ?? 0) !== 1) {
        failures.push(`${matrixCase.name}: gated scenario final turn should read exactly one matching archive, saw ${gated?.finalArchivedToolResultsRead ?? 0}`);
      }
      if ((gated?.finalContextBudget?.retrievedArchiveToolResults ?? 0) !== 1) {
        failures.push(`${matrixCase.name}: gated scenario should inject exactly one matching archive, saw ${gated?.finalContextBudget?.retrievedArchiveToolResults ?? 0}`);
      }
      if ((eager?.finalArchivedToolResultsRead ?? 0) <= (gated?.finalArchivedToolResultsRead ?? 0)) {
        failures.push(`${matrixCase.name}: eager scenario final turn did not read more archives than gated`);
      }
      if ((eager?.finalContextBudget?.retrievedArchiveToolResults ?? 0) <= (gated?.finalContextBudget?.retrievedArchiveToolResults ?? 0)) {
        failures.push(`${matrixCase.name}: eager scenario did not inject more archives than gated`);
      }
      if ((eager?.finalContextBudget?.retrievedArchiveEstimatedTokens ?? 0) <= (gated?.finalContextBudget?.retrievedArchiveEstimatedTokens ?? 0)) {
        failures.push(`${matrixCase.name}: eager scenario did not report higher retrieved archive token volume than gated`);
      }
    }
  }
  return failures;
}

function buildScenario(policy) {
  const explicitName = process.env.MAKA_COST_BASELINE_SCENARIO;
  if (explicitName) {
    return {
      name: explicitName,
      contextBudgetMode: contextBudgetMode(policy),
      archivePruneEnabled: policy?.staleToolResultPrune?.enabled === true,
      historyTokenCap: policy?.maxHistoryEstimatedTokens ?? null,
      historyTurnCap: policy?.maxHistoryTurns ?? null,
      archiveRetrievalEnabled: policy?.archiveRetrieval?.enabled === true,
    };
  }
  return {
    name: scenarioNameForPolicy(policy),
    contextBudgetMode: contextBudgetMode(policy),
    archivePruneEnabled: policy?.staleToolResultPrune?.enabled === true,
    historyTokenCap: policy?.maxHistoryEstimatedTokens ?? null,
    historyTurnCap: policy?.maxHistoryTurns ?? null,
    archiveRetrievalEnabled: policy?.archiveRetrieval?.enabled === true,
  };
}

function scenarioNameForPolicy(policy) {
  if (!policy) return 'budget_off';
  if (policy.staleToolResultPrune?.enabled === true && !policy.maxHistoryEstimatedTokens && !policy.maxHistoryTurns) {
    if (policy.archiveRetrieval?.enabled === true) {
      return policy.archiveRetrieval.mode === 'history_search_gated'
        ? 'archive_prune_on_retrieval_history_search_gated'
        : 'archive_prune_on_retrieval_on';
    }
    return 'archive_prune_on_retrieval_off';
  }
  if (policy.historyRewrite?.enabled === true) return 'named_history_rewrite';
  if (policy.archiveRetrieval?.enabled === true) {
    return policy.archiveRetrieval.mode === 'history_search_gated'
      ? 'emergency_history_cap_archive_retrieval_history_search_gated'
      : 'emergency_history_cap_archive_retrieval_on';
  }
  return 'emergency_history_cap';
}

function contextBudgetMode(policy) {
  if (!policy) return 'off';
  if (policy.staleToolResultPrune?.enabled === true && !policy.maxHistoryEstimatedTokens && !policy.maxHistoryTurns) {
    if (policy.archiveRetrieval?.enabled === true) {
      return policy.archiveRetrieval.mode === 'history_search_gated'
        ? 'archive_prune_plus_history_search_gated_retrieval'
        : 'archive_prune_plus_retrieval';
    }
    return 'archive_prune_only';
  }
  return 'emergency_cap';
}

function buildContextBudgetPolicy() {
  if (process.env.MAKA_CONTEXT_BUDGET === 'off') return undefined;
  const maxHistoryEstimatedTokens = parseOptionalPositiveInt(
    process.env.MAKA_CONTEXT_HISTORY_BUDGET_TOKENS,
  );
  const maxHistoryTurns = parseOptionalPositiveInt(process.env.MAKA_CONTEXT_HISTORY_BUDGET_TURNS);
  const staleToolResultPrune = buildStaleToolResultPrunePolicy();
  const archiveRetrieval = buildArchiveRetrievalPolicy();
  const historySearch = buildHistorySearchPolicy();
  const historyRewrite = buildHistoryRewriteGatePolicy();
  if (
    maxHistoryEstimatedTokens === undefined &&
    maxHistoryTurns === undefined &&
    !staleToolResultPrune &&
    !archiveRetrieval &&
    !historySearch &&
    !historyRewrite
  ) {
    return undefined;
  }
  return {
    name: process.env.MAKA_CONTEXT_BUDGET_NAME ?? 'cost-baseline-history-budget',
    minRecentTurns: parsePositiveInt(process.env.MAKA_CONTEXT_MIN_RECENT_TURNS, 2),
    ...(maxHistoryEstimatedTokens !== undefined ? { maxHistoryEstimatedTokens } : {}),
    ...(staleToolResultPrune ? { staleToolResultPrune } : {}),
    ...(archiveRetrieval ? { archiveRetrieval } : {}),
    ...(historySearch ? { historySearch } : {}),
    ...(historyRewrite ? { historyRewrite } : {}),
    ...(maxHistoryTurns !== undefined ? { maxHistoryTurns } : {}),
  };
}

function buildStaleToolResultPrunePolicy() {
  if (process.env.MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE !== 'on') return undefined;
  return {
    enabled: true,
    maxResultEstimatedTokens: parsePositiveInt(
      process.env.MAKA_CONTEXT_STALE_TOOL_RESULT_MAX_TOKENS,
      2048,
    ),
    minRecentTurnsFull: parsePositiveInt(
      process.env.MAKA_CONTEXT_STALE_TOOL_RESULT_MIN_RECENT_TURNS,
      parsePositiveInt(process.env.MAKA_CONTEXT_MIN_RECENT_TURNS, 2),
    ),
  };
}

function buildArchiveRetrievalPolicy() {
  if (process.env.MAKA_CONTEXT_ARCHIVE_RETRIEVAL !== 'on') return undefined;
  const mode = parseArchiveRetrievalMode(process.env.MAKA_CONTEXT_ARCHIVE_RETRIEVAL_MODE);
  return {
    enabled: true,
    ...(mode ? { mode } : {}),
    maxResults: parsePositiveInt(process.env.MAKA_CONTEXT_ARCHIVE_RETRIEVAL_MAX_RESULTS, 3),
    maxEstimatedTokens: parsePositiveInt(process.env.MAKA_CONTEXT_ARCHIVE_RETRIEVAL_MAX_TOKENS, 8192),
    maxBytes: parsePositiveInt(process.env.MAKA_CONTEXT_ARCHIVE_RETRIEVAL_MAX_BYTES, 1024 * 1024),
    order: 'newest_first',
  };
}

function buildHistorySearchPolicy() {
  if (process.env.MAKA_CONTEXT_HISTORY_SEARCH !== 'on') return undefined;
  return {
    enabled: true,
    maxResults: parsePositiveInt(process.env.MAKA_CONTEXT_HISTORY_SEARCH_MAX_RESULTS, 5),
    around: parsePositiveInt(process.env.MAKA_CONTEXT_HISTORY_SEARCH_AROUND, 1),
    maxEstimatedTokens: parsePositiveInt(process.env.MAKA_CONTEXT_HISTORY_SEARCH_MAX_TOKENS, 4096),
  };
}

function buildHistoryRewriteGatePolicy() {
  if (process.env.MAKA_CONTEXT_HISTORY_REWRITE !== 'on') return undefined;
  return {
    enabled: true,
    name: process.env.MAKA_CONTEXT_HISTORY_REWRITE_NAME ?? 'baseline-history-rewrite',
    historyRewriteVersion: process.env.MAKA_CONTEXT_HISTORY_REWRITE_VERSION ?? 'phase6-v1',
    resetReason: process.env.MAKA_CONTEXT_HISTORY_REWRITE_RESET_REASON ?? 'operator_enabled_history_rewrite_gate',
  };
}

function parsePositiveInt(value, fallback) {
  return parseOptionalPositiveInt(value) ?? fallback;
}

function parseOptionalPositiveInt(value) {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseArchiveRetrievalMode(value) {
  if (!value || value === 'eager') return undefined;
  if (value === 'history_search_gated') return value;
  throw new Error(`Unsupported MAKA_CONTEXT_ARCHIVE_RETRIEVAL_MODE: ${value}`);
}

function classifyCacheMissShape(prefixChangeReason, requestShapeChangeReason) {
  if (!prefixChangeReason && !requestShapeChangeReason) return undefined;
  if (prefixChangeReason === 'first_turn') return 'first_turn';
  if (prefixChangeReason && prefixChangeReason !== 'stable') return 'explicit_durable_prefix_change';
  if (requestShapeChangeReason && requestShapeChangeReason !== 'stable') return 'derived_request_shape_change';
  return 'stable_shape';
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function renderMarkdown(report, jsonPath) {
  const lines = [
    '# DeepSeek Live Cost Baseline',
    '',
    `JSON: \`${jsonPath}\``,
    `Model: \`${report.model}\``,
    `Scenario: \`${report.scenario.name}\` (${report.scenario.contextBudgetMode})`,
    `Turns: ${report.turnCount}`,
    `Tools: ${report.toolMode} (${report.toolCount})`,
    `Stable policy lines: ${report.stablePolicyLines}`,
    `Payload lines: ${report.payloadLines}`,
    `Context budget: ${report.contextBudget ? JSON.stringify(report.contextBudget) : 'off'}`,
    '',
    '## Totals',
    '',
    `- input: ${report.totals.input}`,
    `- cacheHitInput: ${report.totals.cacheHitInput}`,
    `- cacheMissInput: ${report.totals.cacheMissInput}`,
    `- cacheWriteInput: ${report.totals.cacheWriteInput}`,
    `- output: ${report.totals.output}`,
    `- estimatedCostUsd: ${report.totals.estimatedCostUsd}`,
    `- cacheMissSourceTurns: explicit=${report.totals.explicitCacheMissTurns}, derived=${report.totals.derivedCacheMissTurns}, unknown=${report.totals.unknownCacheMissTurns}`,
    `- archivePlaceholders: ${report.totals.archivePlaceholders}`,
    `- archiveWriteFailures: ${report.totals.archiveWriteFailures}`,
    `- archivePlaceholderReasonCounts: ${JSON.stringify(report.totals.archivePlaceholderReasonCounts)}`,
    `- retrievedArchiveToolResults: ${report.totals.retrievedArchiveToolResults}`,
    `- retrievedArchiveEstimatedTokens: ${report.totals.retrievedArchiveEstimatedTokens}`,
    `- archiveRetrievalSkipped: ${report.totals.archiveRetrievalSkipped}`,
    `- archiveRetrievalFailures: ${report.totals.archiveRetrievalFailures}`,
    `- archiveRetrievalFailureReasonCounts: ${JSON.stringify(report.totals.archiveRetrievalFailureReasonCounts)}`,
    '',
    '## Turns',
    '',
    '| turn | input | hit | miss | write | output | prefix reason | request reason | miss source | archive | retrieved | retrieval fail | prior history est | budget after |',
    '| ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const turn of report.turns) {
    const prior = turn.promptSegments?.find((segment) => segment.kind === 'prior_history');
    lines.push([
      `| ${turn.turn}`,
      turn.input ?? 0,
      turn.cacheHitInput ?? 0,
      turn.cacheMissInput ?? 0,
      turn.cacheWriteInput ?? 0,
      turn.output ?? 0,
      turn.prefixChangeReason ?? '',
      turn.requestShapeChangeReason ?? '',
      turn.cacheMissShapeSource ?? turn.cacheMissInputSource ?? '',
      turn.archivePlaceholders ?? 0,
      turn.retrievedArchiveToolResults ?? 0,
      turn.archiveRetrievalFailures ?? 0,
      prior?.estimatedTokens ?? 0,
      turn.contextBudget?.estimatedTokensAfter ?? 0,
    ].join(' | ') + ' |');
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}
