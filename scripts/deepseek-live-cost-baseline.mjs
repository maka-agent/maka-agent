#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
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

const sessionStore = createSessionStore(workspaceRoot);
const runStore = createAgentRunStore(workspaceRoot);
const runtimeEventStore = createRuntimeEventStore(workspaceRoot);
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
    input: usageEvent?.input ?? llmRecord?.inputTokens,
    cacheHitInput: usageEvent?.cacheHitInput ?? llmRecord?.cacheHitInputTokens,
    cacheMissInput: usageEvent?.cacheMissInput ?? llmRecord?.cacheMissInputTokens,
    output: usageEvent?.output ?? llmRecord?.outputTokens,
    total: usageEvent?.total,
    estimatedCostUsd: cost?.totalCost,
    promptSegments: usageEvent?.promptSegments ?? llmRecord?.promptSegments,
    contextBudget: usageEvent?.contextBudget ?? llmRecord?.contextBudget,
    errorReason: errorEvent?.reason,
  });
}

const totals = turns.reduce((acc, turn) => {
  acc.input += turn.input ?? 0;
  acc.cacheHitInput += turn.cacheHitInput ?? 0;
  acc.cacheMissInput += turn.cacheMissInput ?? 0;
  acc.output += turn.output ?? 0;
  acc.estimatedCostUsd += turn.estimatedCostUsd ?? 0;
  return acc;
}, { input: 0, cacheHitInput: 0, cacheMissInput: 0, output: 0, estimatedCostUsd: 0 });

const report = {
  sourceRef: process.env.MAKA_COST_BASELINE_SOURCE_REF ?? 'local-build',
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
    .filter((event) => event.data?.prefixHash || event.data?.prefixChangeReason)
    .map((event) => ({
      phase: event.phase,
      type: event.type,
      prefixHash: event.data?.prefixHash,
      prefixChangeReason: event.data?.prefixChangeReason,
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

function buildContextBudgetPolicy() {
  if (process.env.MAKA_CONTEXT_BUDGET === 'off') return undefined;
  const maxHistoryEstimatedTokens = parseOptionalPositiveInt(
    process.env.MAKA_CONTEXT_HISTORY_BUDGET_TOKENS,
  );
  if (maxHistoryEstimatedTokens === undefined) return undefined;
  const maxHistoryTurns = parseOptionalPositiveInt(process.env.MAKA_CONTEXT_HISTORY_BUDGET_TURNS);
  return {
    name: process.env.MAKA_CONTEXT_BUDGET_NAME ?? 'cost-baseline-history-budget',
    maxHistoryEstimatedTokens,
    minRecentTurns: parsePositiveInt(process.env.MAKA_CONTEXT_MIN_RECENT_TURNS, 2),
    ...(maxHistoryTurns !== undefined ? { maxHistoryTurns } : {}),
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

function renderMarkdown(report, jsonPath) {
  const lines = [
    '# DeepSeek Live Cost Baseline',
    '',
    `JSON: \`${jsonPath}\``,
    `Model: \`${report.model}\``,
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
    `- output: ${report.totals.output}`,
    `- estimatedCostUsd: ${report.totals.estimatedCostUsd}`,
    '',
    '## Turns',
    '',
    '| turn | input | hit | miss | output | reason | prior history est | budget after |',
    '| ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: |',
  ];
  for (const turn of report.turns) {
    const prior = turn.promptSegments?.find((segment) => segment.kind === 'prior_history');
    lines.push([
      `| ${turn.turn}`,
      turn.input ?? 0,
      turn.cacheHitInput ?? 0,
      turn.cacheMissInput ?? 0,
      turn.output ?? 0,
      turn.prefixChangeReason ?? '',
      prior?.estimatedTokens ?? 0,
      turn.contextBudget?.estimatedTokensAfter ?? 0,
    ].join(' | ') + ' |');
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}
