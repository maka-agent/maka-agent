import { createHash } from 'node:crypto';
import type { ModelInfo } from '@maka/core';
import { renderAbComparisonMarkdown } from './ab-render.js';
import { runAbComparison } from './ab-run.js';
import type { AbArmSpec, AbComparisonSummary } from './ab-types.js';
import type { Config } from './contracts.js';
import {
  runFixedPromptController,
  type FixedPromptTask,
  type TaskRunner,
} from './fixed-prompt-controller.js';
import type { HarborBillingMode } from './harbor-task-runner.js';
import {
  readProviderRequestTrace,
  type ProviderRequestTraceAnalysis,
  type ProviderRequestTraceCaptureAnalysis,
} from './provider-request-trace.js';

export type KimiProtocol = Extract<
  NonNullable<ModelInfo['apiProtocol']>,
  'anthropic-messages' | 'openai-chat'
>;

export interface KimiProtocolRequestMetrics {
  requests: number;
  completed: number;
  failed: number;
  interrupted: number;
  aborted: number;
  completeUsageRequests: number;
  missingUsageRequests: number;
  inputTokens: number | null;
  cacheReadInputTokens: number | null;
  cacheMissInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
  totalLatencyMs: number | null;
  meanLatencyMs: number | null;
  meanTimeToFirstTokenMs: number | null;
}

export interface KimiProtocolSmokeTrace {
  onlyIntendedDifferences: true;
  requestCount: 1;
  sharedSegmentCount: number;
  differingSegments: readonly ['provider_options'];
  anthropicProviderId: string;
  openaiProviderId: string;
}

export interface KimiProtocolAbEvidence {
  armId: 'anthropic' | 'openai';
  protocol: KimiProtocol;
  taskId: string;
  rep: number;
  eventId: string;
  traceEventsPath: string;
  trace: ProviderRequestTraceAnalysis;
}

export type KimiProtocolDefaultRecommendation = 'keep_anthropic_default' | 'openai_candidate';

export interface KimiProtocolAbResult {
  summary: AbComparisonSummary;
  evidence: KimiProtocolAbEvidence[];
  requestMetrics: {
    anthropic: KimiProtocolRequestMetrics;
    openai: KimiProtocolRequestMetrics;
  };
  smokeTrace: KimiProtocolSmokeTrace;
  defaultRecommendation: KimiProtocolDefaultRecommendation;
}

export interface RunKimiProtocolAbComparisonInput {
  runId: string;
  config: Config;
  systemPromptPath: string;
  resultsJsonlPath: string;
  evaluationTasks: readonly FixedPromptTask[];
  taskRunner: TaskRunner;
  reps?: number;
  maxConcurrency?: number;
  armExecution?: 'parallel' | 'sequential';
  budgetMs?: number;
  nonInferiorityMargin?: number;
  resumeFingerprint?: string;
  sharedAgentEnv?: Record<string, string>;
  requireExecutionIdentity?: boolean;
  requireFinalUsage?: boolean;
  expectedPricingProfile?: string;
  billingMode?: HarborBillingMode;
  now?: () => number;
  newId?: () => string;
}

const KIMI_PROTOCOL_ARMS = [
  {
    id: 'anthropic',
    protocol: 'anthropic-messages',
  },
  {
    id: 'openai',
    protocol: 'openai-chat',
  },
] as const;

export async function runKimiProtocolAbComparison(
  input: RunKimiProtocolAbComparisonInput,
): Promise<KimiProtocolAbResult> {
  if (input.config.llmConnectionSlug !== 'kimi-coding-plan') {
    throw new Error('Kimi protocol A/B requires the existing kimi-coding-plan connection');
  }
  for (const key of ['MAKA_MODEL_API_PROTOCOL', 'MAKA_HOST_MODEL_API_PROTOCOL'] as const) {
    if (input.sharedAgentEnv?.[key] !== undefined || process.env[key] !== undefined) {
      throw new Error(`Kimi protocol A/B owns ${key} per arm`);
    }
  }
  const evidence: KimiProtocolAbEvidence[] = [];
  const arms = KIMI_PROTOCOL_ARMS.map(protocolArmSpec) as [AbArmSpec, AbArmSpec];
  const summary = await runAbComparison({
    runId: input.runId,
    arms,
    evaluationTasks: input.evaluationTasks,
    ...(input.reps !== undefined ? { reps: input.reps } : {}),
    ...(input.maxConcurrency !== undefined ? { maxConcurrency: input.maxConcurrency } : {}),
    armExecution: input.armExecution ?? 'sequential',
    ...(input.budgetMs !== undefined ? { budgetMs: input.budgetMs } : {}),
    ...(input.nonInferiorityMargin !== undefined
      ? { nonInferiorityMargin: input.nonInferiorityMargin }
      : {}),
    runArm: async ({ roundId, arm, task, rep }) => {
      const protocolArm = KIMI_PROTOCOL_ARMS.find((candidate) => candidate.id === arm.id);
      if (!protocolArm) throw new Error(`unknown Kimi protocol A/B arm: ${arm.id}`);
      const result = await runFixedPromptController({
        runId: input.runId,
        roundId,
        config: input.config,
        systemPromptPath: input.systemPromptPath,
        resultsJsonlPath: input.resultsJsonlPath,
        resultsTsvPath: `${input.resultsJsonlPath}.${roundId}.tsv`,
        tasks: [task],
        infraFailurePolicy: 'terminal',
        protectPassAtOne: true,
        resumeFingerprint: armResumeFingerprint(input.resumeFingerprint, protocolArm.protocol),
        taskRunner: (runnerInput) =>
          input.taskRunner({
            ...runnerInput,
            agentEnv: {
              ...(input.sharedAgentEnv ?? {}),
              MAKA_MODEL_API_PROTOCOL: protocolArm.protocol,
            },
          }),
        ...(input.requireExecutionIdentity !== undefined
          ? { requireExecutionIdentity: input.requireExecutionIdentity }
          : {}),
        ...(input.requireFinalUsage !== undefined
          ? { requireFinalUsage: input.requireFinalUsage }
          : {}),
        ...(input.expectedPricingProfile !== undefined
          ? { expectedPricingProfile: input.expectedPricingProfile }
          : {}),
        ...(input.billingMode !== undefined ? { billingMode: input.billingMode } : {}),
        ...(input.now ? { now: input.now } : {}),
        ...(input.newId ? { newId: input.newId } : {}),
      });
      const event = result.events.find((candidate) => candidate.taskId === task.id);
      if (!event) throw new Error(`Kimi protocol A/B arm ${roundId} produced no event`);
      if (!('traceEventsPath' in event) || !event.traceEventsPath) {
        throw new Error(`Kimi protocol A/B arm ${roundId} produced no #1268 request trace`);
      }
      const trace = await readProviderRequestTrace(event.traceEventsPath);
      if (trace.captures.length === 0 || trace.attempts.length === 0) {
        throw new Error(`Kimi protocol A/B arm ${roundId} has incomplete #1268 request telemetry`);
      }
      validateKimiProtocolRequestTrace(trace, roundId);
      evidence.push({
        armId: protocolArm.id,
        protocol: protocolArm.protocol,
        taskId: task.id,
        rep,
        eventId: event.id,
        traceEventsPath: event.traceEventsPath,
        trace,
      });
      return event;
    },
  });
  evidence.sort(
    (left, right) =>
      left.rep - right.rep ||
      left.taskId.localeCompare(right.taskId) ||
      left.armId.localeCompare(right.armId),
  );
  const anthropicEvidence = evidence.filter((entry) => entry.armId === 'anthropic');
  const openaiEvidence = evidence.filter((entry) => entry.armId === 'openai');
  const firstPair = firstEvidencePair(anthropicEvidence, openaiEvidence);
  const anthropic = summarizeKimiProtocolRequestMetrics(
    anthropicEvidence.map((entry) => entry.trace),
  );
  const openai = summarizeKimiProtocolRequestMetrics(openaiEvidence.map((entry) => entry.trace));
  const completeTelemetry =
    anthropic.requests > 0 &&
    openai.requests > 0 &&
    anthropic.missingUsageRequests === 0 &&
    openai.missingUsageRequests === 0;
  const correctnessUnchanged =
    summary.pairedAttempts.evaluatedPairs > 0 &&
    summary.pairedAttempts.wins === 0 &&
    summary.pairedAttempts.losses === 0 &&
    summary.pairedAttempts.missingPairIds.length === 0 &&
    summary.pairedAttempts.excludedPairIds.length === 0;
  return {
    summary,
    evidence,
    requestMetrics: { anthropic, openai },
    smokeTrace: compareKimiProtocolSmokeTrace(firstPair.anthropic.trace, firstPair.openai.trace),
    defaultRecommendation: recommendKimiProtocolDefault({
      conclusive: summary.decision === 'non_inferior',
      correctnessUnchanged,
      completeTelemetry,
      anthropic,
      openai,
      anthropicCostUsd: summary.baseline.totalCostUsd,
      openaiCostUsd: summary.candidate.totalCostUsd,
    }),
  };
}

export function kimiProtocolAbArms(): [AbArmSpec, AbArmSpec] {
  return KIMI_PROTOCOL_ARMS.map(protocolArmSpec) as [AbArmSpec, AbArmSpec];
}

export function renderKimiProtocolAbMarkdown(result: KimiProtocolAbResult): string {
  const metrics = (label: string, value: KimiProtocolRequestMetrics) =>
    `- ${label}: requests=${value.requests}, completed=${value.completed}, missing_usage=${value.missingUsageRequests}, input=${value.inputTokens}, cache_read=${value.cacheReadInputTokens}, cache_miss=${value.cacheMissInputTokens}, cache_write=${value.cacheWriteInputTokens}, output=${value.outputTokens}, reasoning=${value.reasoningTokens}, total=${value.totalTokens}, total_latency_ms=${value.totalLatencyMs ?? 'null'}, mean_latency_ms=${value.meanLatencyMs ?? 'null'}, mean_ttft_ms=${value.meanTimeToFirstTokenMs ?? 'null'}`;
  return [
    '# Kimi Coding Plan Protocol A/B',
    '',
    '- Provider: `kimi-coding-plan` (single existing connection)',
    '- Baseline protocol: `anthropic-messages`',
    '- Candidate protocol: `openai-chat`',
    `- Smoke trace: ${result.smokeTrace.onlyIntendedDifferences ? 'pass' : 'fail'}; differing request segment: ${result.smokeTrace.differingSegments.join(', ')}`,
    `- Default recommendation: \`${result.defaultRecommendation}\``,
    '',
    '## Request-level metrics',
    '',
    metrics('Anthropic', result.requestMetrics.anthropic),
    metrics('OpenAI', result.requestMetrics.openai),
    '',
    '## Raw request telemetry',
    '',
    ...result.evidence.map(
      (entry) =>
        `- ${entry.armId} task=${entry.taskId} rep=${entry.rep}: event=${entry.eventId}; trace=${entry.traceEventsPath}; trace_id=${entry.trace.traceId ?? 'unknown'}`,
    ),
    '',
    renderAbComparisonMarkdown(result.summary).trimEnd(),
    '',
  ].join('\n');
}

export function compareKimiProtocolSmokeTrace(
  anthropic: ProviderRequestTraceAnalysis,
  openai: ProviderRequestTraceAnalysis,
): KimiProtocolSmokeTrace {
  const anthropicCapture = requireFirstCapture(anthropic, 'Anthropic');
  const openaiCapture = requireFirstCapture(openai, 'OpenAI');
  if (anthropicCapture.modelId !== openaiCapture.modelId) {
    throw new Error('Kimi protocol smoke trace model differs');
  }
  if (anthropicCapture.providerId === openaiCapture.providerId) {
    throw new Error('Kimi protocol smoke trace did not switch provider protocol');
  }
  const anthropicShared = sharedSegments(anthropicCapture);
  const openaiShared = sharedSegments(openaiCapture);
  if (canonicalJson(anthropicShared) !== canonicalJson(openaiShared)) {
    throw new Error('Kimi protocol smoke trace shared request segment differs');
  }
  if (
    !anthropicCapture.requestPayloadWithoutProviderOptionsHash ||
    !openaiCapture.requestPayloadWithoutProviderOptionsHash
  ) {
    throw new Error('Kimi protocol smoke trace is missing non-protocol request parameter evidence');
  }
  if (
    anthropicCapture.requestPayloadWithoutProviderOptionsHash !==
    openaiCapture.requestPayloadWithoutProviderOptionsHash
  ) {
    throw new Error('Kimi protocol smoke trace non-protocol request parameters differ');
  }
  const anthropicOptions = providerOptionSegments(anthropicCapture);
  const openaiOptions = providerOptionSegments(openaiCapture);
  if (
    anthropicOptions.length === 0 ||
    openaiOptions.length === 0 ||
    canonicalJson(anthropicOptions) === canonicalJson(openaiOptions)
  ) {
    throw new Error('Kimi protocol smoke trace must differ in provider_options');
  }
  return {
    onlyIntendedDifferences: true,
    requestCount: 1,
    sharedSegmentCount: anthropicShared.length,
    differingSegments: ['provider_options'],
    anthropicProviderId: anthropicCapture.providerId,
    openaiProviderId: openaiCapture.providerId,
  };
}

export function summarizeKimiProtocolRequestMetrics(
  traces: readonly ProviderRequestTraceAnalysis[],
): KimiProtocolRequestMetrics {
  const attempts = traces.flatMap((trace) => trace.attempts);
  const completeUsage = attempts.filter(
    (attempt) =>
      attempt.inputTokens !== undefined &&
      attempt.cacheReadInputTokens !== undefined &&
      attempt.cacheMissInputTokens !== undefined &&
      attempt.outputTokens !== undefined,
  );
  const ttft = attempts
    .map((attempt) => attempt.timeToFirstTokenMs)
    .filter((value): value is number => value !== undefined);
  const completeSum = (
    select: (attempt: (typeof attempts)[number]) => number | undefined,
  ): number | null => {
    const values = attempts.map(select);
    if (values.length === 0 || values.some((value) => value === undefined)) return null;
    return (values as number[]).reduce((total, value) => total + value, 0);
  };
  const inputTokens = completeSum((attempt) => attempt.inputTokens);
  const outputTokens = completeSum((attempt) => attempt.outputTokens);
  return {
    requests: attempts.length,
    completed: attempts.filter((attempt) => attempt.status === 'completed').length,
    failed: attempts.filter((attempt) => attempt.status === 'failed').length,
    interrupted: attempts.filter((attempt) => attempt.status === 'interrupted').length,
    aborted: attempts.filter((attempt) => attempt.status === 'aborted').length,
    completeUsageRequests: completeUsage.length,
    missingUsageRequests: attempts.length - completeUsage.length,
    inputTokens,
    cacheReadInputTokens: completeSum((attempt) => attempt.cacheReadInputTokens),
    cacheMissInputTokens: completeSum((attempt) => attempt.cacheMissInputTokens),
    cacheWriteInputTokens: completeSum((attempt) => attempt.cacheWriteInputTokens),
    outputTokens,
    reasoningTokens: completeSum((attempt) => attempt.reasoningTokens),
    totalTokens: inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null,
    totalLatencyMs:
      attempts.length > 0
        ? attempts.reduce((total, attempt) => total + attempt.latencyMs, 0)
        : null,
    meanLatencyMs: mean(attempts.map((attempt) => attempt.latencyMs)),
    meanTimeToFirstTokenMs: mean(ttft),
  };
}

export function recommendKimiProtocolDefault(input: {
  conclusive: boolean;
  correctnessUnchanged: boolean;
  completeTelemetry: boolean;
  anthropic: KimiProtocolRequestMetrics;
  openai: KimiProtocolRequestMetrics;
  anthropicCostUsd?: number;
  openaiCostUsd?: number;
}): KimiProtocolDefaultRecommendation {
  if (!input.conclusive || !input.correctnessUnchanged || !input.completeTelemetry) {
    return 'keep_anthropic_default';
  }
  const improvesTokens =
    input.openai.totalTokens !== null &&
    input.anthropic.totalTokens !== null &&
    input.openai.totalTokens < input.anthropic.totalTokens;
  const improvesLatency =
    input.openai.totalLatencyMs !== null &&
    input.anthropic.totalLatencyMs !== null &&
    input.openai.totalLatencyMs < input.anthropic.totalLatencyMs;
  const improvesCost =
    input.openaiCostUsd !== undefined &&
    input.anthropicCostUsd !== undefined &&
    input.openaiCostUsd < input.anthropicCostUsd;
  return improvesTokens || improvesLatency || improvesCost
    ? 'openai_candidate'
    : 'keep_anthropic_default';
}

export function validateKimiProtocolRequestTrace(
  trace: ProviderRequestTraceAnalysis,
  label: string,
): void {
  if (trace.captures.length === 0 || trace.attempts.length === 0) {
    throw new Error(`${label} has incomplete #1268 request telemetry`);
  }
  const captures = new Map(trace.captures.map((capture) => [capture.captureId, capture] as const));
  if (captures.size !== trace.captures.length) {
    throw new Error(`${label} has duplicate request capture ids`);
  }
  const referencedCaptures = new Set<string>();
  for (const attempt of trace.attempts) {
    const capture = captures.get(attempt.captureId);
    if (
      !capture ||
      attempt.traceId !== capture.traceId ||
      attempt.captureArtifactId !== capture.artifactId ||
      attempt.turnId !== capture.turnId ||
      attempt.step !== capture.step ||
      attempt.providerId !== capture.providerId ||
      attempt.modelId !== capture.modelId ||
      attempt.requestHash !== capture.requestHash ||
      attempt.requestBytes !== capture.requestBytes
    ) {
      throw new Error(`${label} request attempt does not match its request capture`);
    }
    referencedCaptures.add(capture.captureId);
  }
  if (referencedCaptures.size !== trace.captures.length) {
    throw new Error(`${label} has an unattempted request capture`);
  }
}

function protocolArmSpec(arm: (typeof KIMI_PROTOCOL_ARMS)[number]): AbArmSpec {
  return {
    id: arm.id,
    kind: 'provider',
    fingerprint: `sha256:${createHash('sha256').update(arm.protocol).digest('hex')}`,
    metadata: { provider: 'kimi-coding-plan', protocol: arm.protocol },
  };
}

function armResumeFingerprint(base: string | undefined, protocol: KimiProtocol): string {
  return `sha256:${createHash('sha256')
    .update(canonicalJson({ version: 1, base: base ?? null, protocol }))
    .digest('hex')}`;
}

function firstEvidencePair(
  anthropic: readonly KimiProtocolAbEvidence[],
  openai: readonly KimiProtocolAbEvidence[],
): { anthropic: KimiProtocolAbEvidence; openai: KimiProtocolAbEvidence } {
  for (const left of anthropic) {
    const right = openai.find(
      (candidate) => candidate.taskId === left.taskId && candidate.rep === left.rep,
    );
    if (right) return { anthropic: left, openai: right };
  }
  throw new Error('Kimi protocol A/B produced no paired request telemetry');
}

function requireFirstCapture(
  trace: ProviderRequestTraceAnalysis,
  label: string,
): ProviderRequestTraceCaptureAnalysis {
  const capture = trace.captures.find((candidate) => candidate.step === 0);
  if (!capture) throw new Error(`${label} Kimi protocol smoke trace has no first request`);
  return capture;
}

function sharedSegments(capture: ProviderRequestTraceCaptureAnalysis) {
  return capture.segments.filter((segment) => segment.kind !== 'provider_options');
}

function providerOptionSegments(capture: ProviderRequestTraceCaptureAnalysis) {
  return capture.segments.filter((segment) => segment.kind === 'provider_options');
}

function mean(values: readonly number[]): number | null {
  return values.length > 0
    ? values.reduce((total, value) => total + value, 0) / values.length
    : null;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
