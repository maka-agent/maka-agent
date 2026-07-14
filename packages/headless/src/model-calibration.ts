import { effectiveBaseUrl, type LlmConnection, type ThinkingLevel } from '@maka/core';
import { buildRunManifestFingerprint } from './ab-manifest.js';

export const MODEL_CALIBRATION_SCHEMA_VERSION = 'maka.model_calibration.v2' as const;

export type ModelCalibrationCaseKind =
  | 'structured_json'
  | 'single_tool'
  | 'two_step_tool'
  | 'malformed_tool_recovery'
  | 'long_input_bounded_output';

export const MODEL_CALIBRATION_CASE_COUNTS: Readonly<Record<ModelCalibrationCaseKind, number>> = Object.freeze({
  structured_json: 5,
  single_tool: 5,
  two_step_tool: 5,
  malformed_tool_recovery: 3,
  long_input_bounded_output: 2,
});

export interface ModelCalibrationEnvironment {
  readonly schemaVersion: typeof MODEL_CALIBRATION_SCHEMA_VERSION;
  readonly environmentId: string;
  readonly connectionSlug: string;
  readonly providerType: LlmConnection['providerType'];
  readonly endpointId: string;
  readonly modelIds: readonly string[];
}

/**
 * Freezes model ids returned by Maka's existing fetchProviderModels adapter.
 * Provider auth, URL handling, and model discovery deliberately stay in runtime.
 */
export function buildModelCalibrationEnvironment(input: {
  connection: Pick<LlmConnection, 'slug' | 'providerType' | 'baseUrl'>;
  modelIds: readonly string[];
}): ModelCalibrationEnvironment {
  const connectionSlug = nonEmpty(input.connection.slug, 'connection.slug');
  const providerType = input.connection.providerType;
  const endpointId = buildRunManifestFingerprint({
    kind: 'maka.model_calibration.endpoint.v1',
    providerType,
    baseUrl: effectiveBaseUrl(input.connection),
  });
  const modelIds = [...new Set(input.modelIds.map((modelId) => nonEmpty(modelId, 'modelId')))].sort();
  if (modelIds.length === 0) throw new Error('model calibration environment requires at least one model id');
  const environmentId = modelCalibrationEnvironmentId({ connectionSlug, providerType, endpointId, modelIds });
  return Object.freeze({
    schemaVersion: MODEL_CALIBRATION_SCHEMA_VERSION,
    environmentId,
    connectionSlug,
    providerType,
    endpointId,
    modelIds: Object.freeze(modelIds),
  });
}

export interface ModelCalibrationTokenUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

/** Normalized evidence produced by the existing headless/runtime execution path. */
export interface ModelCalibrationCaseResult {
  caseId: string;
  kind: ModelCalibrationCaseKind;
  success: boolean;
  terminalProtocolSuccess: boolean;
  timeout: boolean;
  toolAdjacencyError: boolean;
  forbiddenToolCalls: number;
  latencyMs: number;
  usage?: ModelCalibrationTokenUsage;
}

export interface ModelCalibrationRoleQualification {
  qualified: boolean;
  successRate: number;
  terminalProtocolSuccessRate: number;
  timeoutRate: number;
  toolAdjacencyErrors: number;
  forbiddenToolCalls: number;
}

export interface ModelCalibrationQualification {
  main: ModelCalibrationRoleQualification;
  curator: ModelCalibrationRoleQualification;
}

export function qualifyModelCalibrationResults(
  results: readonly ModelCalibrationCaseResult[],
): ModelCalibrationQualification {
  assertCalibrationMatrix(results);
  const metrics = {
    successRate: results.filter((result) => result.success).length / results.length,
    terminalProtocolSuccessRate: results.filter((result) => result.terminalProtocolSuccess).length / results.length,
    timeoutRate: results.filter((result) => result.timeout).length / results.length,
    toolAdjacencyErrors: sum(results.map((result) => result.toolAdjacencyError ? 1 : 0)),
    forbiddenToolCalls: sum(results.map((result) => result.forbiddenToolCalls)),
  };
  return {
    main: {
      ...metrics,
      qualified: metrics.successRate >= 0.9 && metrics.toolAdjacencyErrors === 0,
    },
    curator: {
      ...metrics,
      qualified: metrics.terminalProtocolSuccessRate >= 0.95
        && metrics.timeoutRate <= 0.05
        && metrics.toolAdjacencyErrors === 0
        && metrics.forbiddenToolCalls === 0,
    },
  };
}

export interface ModelCalibrationConfigReport {
  environmentId: string;
  connectionSlug: string;
  modelId: string;
  thinkingLevel: ThinkingLevel | 'default';
  results: ModelCalibrationCaseResult[];
  qualification: ModelCalibrationQualification;
}

export interface ModelCalibrationDecision {
  schemaVersion: typeof MODEL_CALIBRATION_SCHEMA_VERSION;
  status: 'QUALIFIED' | 'BLOCKED';
  requiredMainQualifiedConfigs: number;
  mainQualifiedModelIds: string[];
  mainQualifiedConfigIds: string[];
  curatorQualifiedConfigIds: string[];
}

export function buildModelCalibrationConfigId(
  config: Pick<ModelCalibrationConfigReport, 'environmentId' | 'connectionSlug' | 'modelId' | 'thinkingLevel'>,
): string {
  return buildRunManifestFingerprint({
    kind: 'maka.model_calibration.config.v2',
    environmentId: nonEmpty(config.environmentId, 'config.environmentId'),
    connectionSlug: nonEmpty(config.connectionSlug, 'config.connectionSlug'),
    modelId: nonEmpty(config.modelId, 'config.modelId'),
    thinkingLevel: config.thinkingLevel,
  });
}

export function buildModelCalibrationDecision(
  environment: ModelCalibrationEnvironment,
  reports: readonly ModelCalibrationConfigReport[],
  requiredMainQualifiedConfigs = 2,
): ModelCalibrationDecision {
  if (!Number.isSafeInteger(requiredMainQualifiedConfigs) || requiredMainQualifiedConfigs < 1) {
    throw new Error('requiredMainQualifiedConfigs must be a positive integer');
  }
  if (environment.schemaVersion !== MODEL_CALIBRATION_SCHEMA_VERSION) {
    throw new Error(`unsupported model calibration schemaVersion: ${environment.schemaVersion}`);
  }
  const recomputedEnvironmentId = modelCalibrationEnvironmentId(environment);
  if (environment.environmentId !== recomputedEnvironmentId) {
    throw new Error('model calibration environment fingerprint does not match its contents');
  }
  const reportConfigIds = new Set<string>();
  for (const report of reports) {
    nonEmpty(report.environmentId, 'report.environmentId');
    nonEmpty(report.connectionSlug, 'report.connectionSlug');
    nonEmpty(report.modelId, 'report.modelId');
    if (report.environmentId !== environment.environmentId) {
      throw new Error(`model calibration report belongs to a different environment: ${report.modelId}`);
    }
    if (report.connectionSlug !== environment.connectionSlug) {
      throw new Error(`model calibration report belongs to a different connection: ${report.connectionSlug}`);
    }
    if (!environment.modelIds.includes(report.modelId)) {
      throw new Error(`model calibration report uses a model outside the frozen environment: ${report.modelId}`);
    }
    const configId = buildModelCalibrationConfigId(report);
    if (reportConfigIds.has(configId)) {
      throw new Error(`duplicate model calibration config: ${report.modelId}:${report.thinkingLevel}`);
    }
    reportConfigIds.add(configId);
    const recomputed = qualifyModelCalibrationResults(report.results);
    if (!modelCalibrationQualificationEquals(recomputed, report.qualification)) {
      throw new Error(`model calibration qualification does not match case evidence: ${report.modelId}:${report.thinkingLevel}`);
    }
  }
  const main = reports.filter((report) => report.qualification.main.qualified);
  const mainQualifiedModelIds = [...new Set(main.map((report) => report.modelId))].sort();
  const mainQualifiedConfigIds = main.map(buildModelCalibrationConfigId).sort();
  return {
    schemaVersion: MODEL_CALIBRATION_SCHEMA_VERSION,
    status: mainQualifiedConfigIds.length >= requiredMainQualifiedConfigs ? 'QUALIFIED' : 'BLOCKED',
    requiredMainQualifiedConfigs,
    mainQualifiedModelIds,
    mainQualifiedConfigIds,
    curatorQualifiedConfigIds: reports
      .filter((report) => report.qualification.curator.qualified)
      .map(buildModelCalibrationConfigId)
      .sort(),
  };
}

function assertCalibrationMatrix(results: readonly ModelCalibrationCaseResult[]): void {
  const expectedTotal = sum(Object.values(MODEL_CALIBRATION_CASE_COUNTS));
  if (results.length !== expectedTotal) {
    throw new Error(`model calibration requires exactly ${expectedTotal} case results`);
  }
  const caseIds = new Set<string>();
  for (const result of results) {
    nonEmpty(result.caseId, 'caseId');
    if (!(result.kind in MODEL_CALIBRATION_CASE_COUNTS)) {
      throw new Error(`unknown model calibration case kind: ${String(result.kind)}`);
    }
    for (const key of ['success', 'terminalProtocolSuccess', 'timeout', 'toolAdjacencyError'] as const) {
      if (typeof result[key] !== 'boolean') {
        throw new Error(`model calibration case ${result.caseId} ${key} must be a boolean`);
      }
    }
    if (caseIds.has(result.caseId)) throw new Error(`duplicate model calibration caseId: ${result.caseId}`);
    caseIds.add(result.caseId);
    if (!Number.isFinite(result.latencyMs) || result.latencyMs < 0) {
      throw new Error(`invalid latency for model calibration case ${result.caseId}`);
    }
    if (!Number.isSafeInteger(result.forbiddenToolCalls) || result.forbiddenToolCalls < 0) {
      throw new Error(`invalid forbiddenToolCalls for model calibration case ${result.caseId}`);
    }
    if (result.usage) assertTokenUsage(result.caseId, result.usage);
  }
  for (const [kind, expected] of Object.entries(MODEL_CALIBRATION_CASE_COUNTS)) {
    const actual = results.filter((result) => result.kind === kind).length;
    if (actual !== expected) throw new Error(`model calibration requires ${expected} ${kind} results, received ${actual}`);
  }
}

function modelCalibrationEnvironmentId(input: {
  connectionSlug: string;
  providerType: LlmConnection['providerType'];
  endpointId: string;
  modelIds: readonly string[];
}): string {
  return buildRunManifestFingerprint({
    kind: 'maka.model_calibration.environment.v1',
    connectionSlug: input.connectionSlug,
    providerType: input.providerType,
    endpointId: input.endpointId,
    modelIds: [...input.modelIds],
  });
}

function modelCalibrationQualificationEquals(
  left: ModelCalibrationQualification,
  right: ModelCalibrationQualification,
): boolean {
  return modelCalibrationRoleEquals(left.main, right.main)
    && modelCalibrationRoleEquals(left.curator, right.curator);
}

function modelCalibrationRoleEquals(
  left: ModelCalibrationRoleQualification,
  right: ModelCalibrationRoleQualification,
): boolean {
  return left.qualified === right.qualified
    && left.successRate === right.successRate
    && left.terminalProtocolSuccessRate === right.terminalProtocolSuccessRate
    && left.timeoutRate === right.timeoutRate
    && left.toolAdjacencyErrors === right.toolAdjacencyErrors
    && left.forbiddenToolCalls === right.forbiddenToolCalls;
}

function assertTokenUsage(caseId: string, usage: ModelCalibrationTokenUsage): void {
  const values = [usage.inputTokens, usage.outputTokens, usage.reasoningTokens, usage.totalTokens];
  if (!values.every((value) => Number.isSafeInteger(value) && value >= 0)
    || usage.totalTokens < usage.inputTokens + usage.outputTokens) {
    throw new Error(`invalid token usage for model calibration case ${caseId}`);
  }
}

function nonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${label} must be non-empty`);
  return normalized;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
