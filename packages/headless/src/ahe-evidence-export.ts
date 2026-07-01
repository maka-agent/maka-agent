import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import {
  MAKA_AHE_CURRENT_COMPONENTS,
  MAKA_AHE_TARGET_PROTOCOL_VERSION,
  MAKA_AHE_TARGET_SOURCE_LABEL,
  type MakaAheArtifactRef,
  type MakaAheHarnessResults,
  type MakaAheResultStatus,
  type MakaAheRunResult,
  type MakaAheScoreAuthority,
  type MakaAheSnapshotIdentity,
  type MakaAheTargetComponent,
  type MakaAheTargetSnapshot,
  type MakaAheTraceIndex,
  type MakaAheTraceIndexEntry,
  type MakaAheValidationIssue,
  validateMakaAheRunResult,
  validateMakaAheTargetComponents,
} from './ahe-target-protocol.js';
import {
  exportableTaskEvents,
  exportContentHash,
  taskRunExportFromProjection,
  writeTaskRunExport,
  type TaskRunExport,
} from './result-export.js';
import { harborOfficialVerifierOutputFromArtifacts } from './harbor-official-artifacts.js';
import type { BenchmarkVerifierOutput } from './benchmark-adapters.js';
import type { AutonomousResultTaxonomy, ScoreResult, TaskRunArtifact, VerifierResult } from './task-contracts.js';
import type { TaskRunProjection } from './task-run-store.js';

export const MAKA_AHE_EVIDENCE_EXPORT_SOURCE_LABEL = 'ahe-evidence-export-20260701' as const;

export interface BuildMakaAheTargetSnapshotOptions {
  repoRoot: string;
  sourceLabel?: string;
  createdAt?: string;
  components?: readonly MakaAheTargetComponent[];
  git?: MakaAheSnapshotIdentity['git'];
}

export interface MakaAheRunEvidenceOptions {
  snapshotId: string;
  runId?: string;
  exportedAt?: string;
  traceBaseRef?: string;
  includeEvents?: boolean;
  officialResults?: MakaAheOfficialResultOverlays;
}

export interface MakaAheRunEvidence {
  harnessResults: MakaAheHarnessResults;
  traceIndex: MakaAheTraceIndex;
}

export interface WriteMakaAheEvidenceExportOptions {
  snapshot: MakaAheTargetSnapshot;
  projections: readonly TaskRunProjection[];
  runId?: string;
  exportedAt?: string;
  includeEvents?: boolean;
  officialResults?: MakaAheOfficialResultOverlays;
  sessionMessages?: MakaAheSessionMessagesByTaskRun;
}

export interface MakaAheOfficialResultOverlay {
  verifier: VerifierResult;
  score: ScoreResult;
  sourceRef?: MakaAheArtifactRef;
}

export type MakaAheSessionMessagesByTaskRun =
  | ReadonlyMap<string, readonly unknown[]>
  | Record<string, readonly unknown[]>;

export type MakaAheOfficialResultOverlays =
  | ReadonlyMap<string, MakaAheOfficialResultOverlay>
  | Record<string, MakaAheOfficialResultOverlay>;

export interface WriteMakaAheEvidenceExportResult extends MakaAheRunEvidence {
  targetSnapshot: MakaAheTargetSnapshot;
  files: {
    targetSnapshotJson: string;
    harnessResultsJson: string;
    traceIndexJson: string;
    traceDirs: Record<string, string>;
  };
}

export async function readMakaAheHarborOfficialResult(
  trialDir: string,
  projection: TaskRunProjection,
): Promise<MakaAheOfficialResultOverlay> {
  const resultJson = await readOptionalJson(join(trialDir, 'result.json'));
  const rewardText = await readOptionalText(join(trialDir, 'verifier', 'reward.txt'));
  const stdout = await readOptionalText(join(trialDir, 'verifier', 'test-stdout.txt'));
  const output = harborOfficialVerifierOutputFromArtifacts({
    resultJson,
    rewardText,
    stdout,
    details: {
      trialDir,
      taskRunId: projection.taskRunId,
      taskId: projection.taskId,
      source: 'harbor_post_exit_trial',
    },
  });
  const ts = projection.finishedAt ?? projection.events.at(-1)?.ts ?? 0;
  return officialOverlayFromHarborOutput(output, projection, ts, trialDir);
}

export async function validateMakaAheSourceRefs(
  repoRoot: string,
  components: readonly MakaAheTargetComponent[] = MAKA_AHE_CURRENT_COMPONENTS,
): Promise<MakaAheValidationIssue[]> {
  const errors: MakaAheValidationIssue[] = [];
  const componentResult = validateMakaAheTargetComponents(components);
  if (!componentResult.ok) {
    errors.push(...componentResult.errors);
    return errors;
  }

  await Promise.all(components.flatMap((component, componentIndex) => component.sourceRefs.map(async (sourceRef, refIndex) => {
    const path = `components[${componentIndex}].sourceRefs[${refIndex}].path`;
    const issue = unsafeRepoPathReason(sourceRef.path);
    if (issue) {
      errors.push({ path, message: issue });
      return;
    }
    const root = resolve(repoRoot);
    const resolved = resolve(root, sourceRef.path);
    if (!isWithinRoot(root, resolved)) {
      errors.push({ path, message: `source ref "${sourceRef.path}" resolves outside the repo root` });
      return;
    }
    try {
      await stat(resolved);
    } catch {
      errors.push({ path, message: `source ref "${sourceRef.path}" does not exist under repo root` });
    }
  })));

  return errors.sort((a, b) => a.path.localeCompare(b.path) || a.message.localeCompare(b.message));
}

export async function buildMakaAheTargetSnapshot(
  options: BuildMakaAheTargetSnapshotOptions,
): Promise<MakaAheTargetSnapshot> {
  const components = options.components ?? MAKA_AHE_CURRENT_COMPONENTS;
  const errors = await validateMakaAheSourceRefs(options.repoRoot, components);
  if (errors.length > 0) {
    throw new Error(`invalid Maka AHE target snapshot source refs:\n${errors.map((error) => `- ${error.path}: ${error.message}`).join('\n')}`);
  }

  const sourceLabel = options.sourceLabel ?? MAKA_AHE_EVIDENCE_EXPORT_SOURCE_LABEL;
  const identity = {
    protocolVersion: MAKA_AHE_TARGET_PROTOCOL_VERSION,
    sourceLabel,
    ...(options.git ? { git: options.git } : {}),
    components,
  };

  return {
    protocolVersion: MAKA_AHE_TARGET_PROTOCOL_VERSION,
    sourceLabel,
    snapshotId: `maka-ahe-${shortHash(identity)}`,
    createdAt: options.createdAt ?? new Date().toISOString(),
    ...(options.git ? { git: options.git } : {}),
    components,
  };
}

export function makaAheEvidenceFromTaskRunProjections(
  projections: readonly TaskRunProjection[],
  options: MakaAheRunEvidenceOptions,
): MakaAheRunEvidence {
  const sorted = sortProjections(projections);
  const runId = options.runId ?? `maka-ahe-run-${shortHash({
    snapshotId: options.snapshotId,
    taskRunIds: sorted.map((projection) => projection.taskRunId),
  })}`;
  const traceBaseRef = trimTrailingSlash(options.traceBaseRef ?? 'traces');
  const results: MakaAheRunResult[] = [];
  const entries: MakaAheTraceIndexEntry[] = [];

  for (const projection of sorted) {
    const exported = taskRunExportFromProjection(projection, { exportedAt: options.exportedAt });
    const official = officialResultFor(options.officialResults, projection.taskRunId);
    const effectiveExport = official ? taskRunExportWithOfficialOverlay(exported, official) : exported;
    const taskRunRef = `${traceBaseRef}/${safePathSegment(projection.taskRunId)}`;
    const result = runResultFromProjection(projection, effectiveExport, {
      snapshotId: options.snapshotId,
      runId,
      taskRunRef,
      officialResultRef: official ? `${taskRunRef}/official-harbor-result.json` : undefined,
    });
    const validation = validateMakaAheRunResult(result);
    if (!validation.ok) {
      throw new Error(`invalid Maka AHE run result for ${projection.taskRunId}:\n${validation.errors.map((error) => `- ${error.path}: ${error.message}`).join('\n')}`);
    }
    results.push(result);
    entries.push(traceIndexEntryFromProjection(projection, effectiveExport, {
      snapshotId: options.snapshotId,
      runId,
      taskRunRef,
      includeEvents: options.includeEvents,
      officialResultRef: official ? `${taskRunRef}/official-harbor-result.json` : undefined,
    }));
  }

  return {
    harnessResults: {
      protocolVersion: MAKA_AHE_TARGET_PROTOCOL_VERSION,
      snapshotId: options.snapshotId,
      runId,
      results,
      traceIndexRef: { kind: 'file', ref: 'trace-index.json', mediaType: 'application/json' },
    },
    traceIndex: {
      protocolVersion: MAKA_AHE_TARGET_PROTOCOL_VERSION,
      snapshotId: options.snapshotId,
      entries,
    },
  };
}

export async function writeMakaAheEvidenceExport(
  outDir: string,
  options: WriteMakaAheEvidenceExportOptions,
): Promise<WriteMakaAheEvidenceExportResult> {
  await mkdir(outDir, { recursive: true });
  const evidence = makaAheEvidenceFromTaskRunProjections(options.projections, {
    snapshotId: options.snapshot.snapshotId,
    runId: options.runId,
    exportedAt: options.exportedAt,
    includeEvents: options.includeEvents,
    officialResults: options.officialResults,
  });
  const files: WriteMakaAheEvidenceExportResult['files'] = {
    targetSnapshotJson: join(outDir, 'target-snapshot.json'),
    harnessResultsJson: join(outDir, 'harness-results.json'),
    traceIndexJson: join(outDir, 'trace-index.json'),
    traceDirs: {},
  };

  await writeStableJson(files.targetSnapshotJson, options.snapshot);
  await writeStableJson(files.harnessResultsJson, evidence.harnessResults);
  await writeStableJson(files.traceIndexJson, evidence.traceIndex);

  for (const projection of sortProjections(options.projections)) {
    const traceDir = join(outDir, 'traces', safePathSegment(projection.taskRunId));
    files.traceDirs[projection.taskRunId] = traceDir;
    await writeTaskRunExport(traceDir, projection, {
      includeEvents: options.includeEvents,
      exportedAt: options.exportedAt,
    });
    const exported = taskRunExportFromProjection(projection, { exportedAt: options.exportedAt });
    const official = officialResultFor(options.officialResults, projection.taskRunId);
    const sessionMessages = sessionMessagesFor(options.sessionMessages, projection.taskRunId);
    await writeStableJson(join(traceDir, 'messages.json'), aheAgentRunMessages(projection, exported, official, sessionMessages));
    if (official) {
      await writeStableJson(join(traceDir, 'official-harbor-result.json'), official);
    }
  }

  return { targetSnapshot: options.snapshot, ...evidence, files };
}

function runResultFromProjection(
  projection: TaskRunProjection,
  exported: TaskRunExport,
  ids: { snapshotId: string; runId: string; taskRunRef: string; officialResultRef?: string },
): MakaAheRunResult {
  const authority = scoreAuthority(exported.score, exported.verifier, projection);
  const status = resultStatus(exported, projection, authority);
  const normalized = normalizedScore(exported.score, exported.verifier);
  const warnings = resultWarnings(exported, projection, status, authority);
  return {
    protocolVersion: MAKA_AHE_TARGET_PROTOCOL_VERSION,
    runId: ids.runId,
    snapshotId: ids.snapshotId,
    taskId: exported.taskRun.taskId,
    status,
    scoreAuthority: authority,
    ...(normalized !== undefined ? { score: normalized } : {}),
    ...(exported.verifier ? { verifierRef: verifierRef(exported.verifier, ids.taskRunRef, ids.officialResultRef) } : {}),
    traceRef: { kind: 'file', ref: `${ids.taskRunRef}/task-run.json`, mediaType: 'application/json' },
    ...(status === 'official_pass' ? {} : { failureTaxonomy: failureTaxonomy(exported) }),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

function traceIndexEntryFromProjection(
  projection: TaskRunProjection,
  exported: TaskRunExport,
  ids: { snapshotId: string; runId: string; taskRunRef: string; includeEvents?: boolean; officialResultRef?: string },
): MakaAheTraceIndexEntry {
  const artifacts = [
    ...(ids.officialResultRef ? [{
      kind: 'file' as const,
      ref: ids.officialResultRef,
      mediaType: 'application/json',
      description: 'Harbor post-exit official verifier result imported for AHE scoring',
    }] : []),
    ...exported.artifacts.items.map(artifactRefFromTaskRunArtifact),
  ];
  return {
    taskId: exported.taskRun.taskId,
    runId: ids.runId,
    snapshotId: ids.snapshotId,
    ...(ids.includeEvents || (exported.runtime.trajectoryRefs.runtimeEventIds && exported.runtime.trajectoryRefs.runtimeEventIds.length > 0)
      ? { runtimeEventsJsonl: { kind: 'file', ref: `${ids.taskRunRef}/events.jsonl`, mediaType: 'application/jsonl' } }
      : {}),
    agentRun: {
      kind: 'file',
      ref: `${ids.taskRunRef}/messages.json`,
      mediaType: 'application/json',
      ...(exported.runtime.agentRunId ? { description: `normalized AHE messages for maka-agent-run:${exported.runtime.agentRunId}` } : {}),
    },
    transcript: { kind: 'file', ref: `${ids.taskRunRef}/result.md`, mediaType: 'text/markdown' },
    toolResults: projection.artifacts.filter((artifact) => artifact.kind === 'runtime_trace').map(artifactRefFromTaskRunArtifact),
    artifacts,
  };
}

function resultStatus(
  exported: TaskRunExport,
  projection: TaskRunProjection,
  authority: MakaAheScoreAuthority,
): MakaAheResultStatus {
  if (isExcluded(exported.score)) return 'excluded';
  if (isInfraFailure(exported)) return 'infra_failed';
  if (authority === 'official_scorer' || authority === 'official_verifier') {
    return (exported.score?.passed ?? exported.verifier?.passed ?? false) ? 'official_pass' : 'official_fail';
  }
  if (hasSelfCheckEvidence(projection, exported.score, exported.verifier)) return 'self_check_only';
  if (exported.score?.scored === false) return 'unscored';
  return 'unscored';
}

function scoreAuthority(
  score: ScoreResult | undefined,
  verifier: VerifierResult | undefined,
  projection: TaskRunProjection,
): MakaAheScoreAuthority {
  if (isOfficialAuthority(score?.authority)) return 'official_scorer';
  if (isOfficialAuthority(verifier?.authority)) return 'official_verifier';
  if (hasSelfCheckEvidence(projection, score, verifier)) return 'self_check';
  return 'analysis_only';
}

function isOfficialAuthority(authority: { source: string; authoritative: boolean } | undefined): boolean {
  return authority?.authoritative === true && authority.source === 'official_harbor_verifier';
}

function hasSelfCheckEvidence(
  projection: TaskRunProjection,
  score: ScoreResult | undefined,
  verifier: VerifierResult | undefined,
): boolean {
  return score?.authority?.source === 'self_check'
    || verifier?.authority?.source === 'self_check'
    || projection.selfChecks.length > 0
    || projection.heavyTaskSelfChecks.length > 0
    || projection.heavyTaskEvidence.some((item) => item.kind === 'check');
}

function isExcluded(score: ScoreResult | undefined): boolean {
  return score?.eligible === false || Boolean(score?.excludedReason);
}

function isInfraFailure(exported: TaskRunExport): boolean {
  const taxonomy = String(exported.taxonomy.value);
  const fields = [
    taxonomy,
    exported.taxonomy.errorClass,
    exported.taskRun.error?.class,
    exported.score?.errorClass,
    exported.verifier?.errorClass,
  ].filter((value): value is string => typeof value === 'string');
  return fields.some((field) => [
    'infra_failed',
    'setup_failed',
    'verification_error',
    'agent_failed',
    'agent_incomplete',
    'budget_exhausted',
    'aborted',
    'blocked',
    'cancelled',
  ].includes(field));
}

function normalizedScore(score: ScoreResult | undefined, verifier: VerifierResult | undefined): number | undefined {
  const rawScore = score?.score ?? verifier?.score;
  const maxScore = score?.maxScore ?? verifier?.maxScore;
  if (typeof rawScore !== 'number') return undefined;
  if (typeof maxScore === 'number' && maxScore > 0) return rawScore / maxScore;
  return rawScore;
}

function failureTaxonomy(exported: TaskRunExport): string[] {
  return uniqueStrings([
    String(exported.taxonomy.value),
    exported.taxonomy.errorClass,
    exported.taxonomy.excludedReason,
    exported.score?.taxonomy,
    exported.score?.errorClass,
    exported.score?.excludedReason,
    exported.verifier?.errorClass,
    exported.taskRun.error?.class,
  ]);
}

function resultWarnings(
  exported: TaskRunExport,
  projection: TaskRunProjection,
  status: MakaAheResultStatus,
  authority: MakaAheScoreAuthority,
): string[] {
  const warnings = [...exported.warnings];
  const hasNonOfficialPass = exported.score?.passed === true || exported.verifier?.passed === true || exported.taxonomy.passed === true;
  if (status !== 'official_pass' && authority !== 'official_scorer' && authority !== 'official_verifier' && hasNonOfficialPass) {
    warnings.push('non-authoritative pass evidence was exported outside official pass/fail buckets');
  }
  if (projection.latestHeavyTaskSelfCheck && status !== 'official_pass' && status !== 'official_fail') {
    warnings.push('self-check evidence is advisory and was exported as non-official evidence');
  }
  return uniqueStrings(warnings);
}

function verifierRef(verifier: VerifierResult, taskRunRef: string, officialResultRef: string | undefined): MakaAheArtifactRef {
  return {
    kind: 'file',
    ref: officialResultRef ?? `${taskRunRef}/task-run.json`,
    mediaType: 'application/json',
    description: `${verifier.kind} verifier result ${verifier.id}`,
  };
}

function taskRunExportWithOfficialOverlay(exported: TaskRunExport, official: MakaAheOfficialResultOverlay): TaskRunExport {
  return {
    ...exported,
    verifier: official.verifier,
    score: official.score,
    taxonomy: {
      value: official.score.taxonomy,
      passed: official.score.passed,
      scored: official.score.scored,
      eligible: official.score.eligible,
      errorClass: official.score.errorClass,
      excludedReason: official.score.excludedReason,
    },
    warnings: uniqueStrings([...exported.warnings, 'Harbor post-exit official verifier result was imported for AHE scoring']),
  };
}

function officialResultFor(
  overlays: MakaAheOfficialResultOverlays | undefined,
  taskRunId: string,
): MakaAheOfficialResultOverlay | undefined {
  if (!overlays) return undefined;
  if (isReadonlyMap(overlays)) return overlays.get(taskRunId);
  return overlays[taskRunId];
}

function isReadonlyMap<T>(
  value: ReadonlyMap<string, T> | Record<string, T>,
): value is ReadonlyMap<string, T> {
  return typeof (value as { get?: unknown }).get === 'function';
}

function officialOverlayFromHarborOutput(
  output: BenchmarkVerifierOutput,
  projection: TaskRunProjection,
  ts: number,
  trialDir: string,
): MakaAheOfficialResultOverlay {
  const verifier: VerifierResult = {
    id: `harbor-official-verifier-${shortHash({ taskRunId: projection.taskRunId, trialDir, output })}`,
    taskRunId: projection.taskRunId,
    ts,
    kind: output.kind,
    passed: output.passed,
    exitCode: output.exitCode,
    ...(output.durationMs !== undefined ? { durationMs: output.durationMs } : {}),
    ...(output.stdout ? { stdout: output.stdout } : {}),
    ...(output.stderr ? { stderr: output.stderr } : {}),
    ...(output.error ? { error: output.error } : {}),
    ...(output.errorClass ? { errorClass: output.errorClass } : {}),
    ...(output.score !== undefined ? { score: output.score } : {}),
    ...(output.maxScore !== undefined ? { maxScore: output.maxScore } : {}),
    ...(output.authority ? { authority: output.authority } : {}),
    ...(output.artifacts ? { artifacts: output.artifacts.map((artifact, index) => taskRunArtifactFromDescriptor(artifact, projection, ts + index)) } : {}),
    ...(output.details ? { details: output.details } : {}),
  };
  const authoritative = isOfficialAuthority(verifier.authority);
  const score: ScoreResult = {
    id: `harbor-official-score-${shortHash({ taskRunId: projection.taskRunId, trialDir, output })}`,
    taskRunId: projection.taskRunId,
    ts,
    passed: output.passed,
    scored: authoritative && output.score !== undefined,
    eligible: authoritative,
    ...(output.score !== undefined ? { score: output.score } : {}),
    ...(output.maxScore !== undefined ? { maxScore: output.maxScore } : {}),
    taxonomy: officialScoreTaxonomy(output),
    ...(output.errorClass ? { errorClass: output.errorClass } : {}),
    ...(output.authority ? { authority: output.authority } : {}),
    details: {
      source: 'harbor_post_exit_trial',
      trialDir,
      verifierResultId: verifier.id,
      ...(output.details ? { verifierDetails: output.details } : {}),
    },
  };
  return {
    verifier,
    score,
    sourceRef: { kind: 'file', ref: 'official-harbor-result.json', mediaType: 'application/json' },
  };
}

function officialScoreTaxonomy(output: BenchmarkVerifierOutput): AutonomousResultTaxonomy {
  if (output.passed) return 'passed';
  switch (output.errorClass) {
    case 'verification_error':
    case 'agent_failed':
    case 'agent_incomplete':
    case 'invalid_setup':
    case 'unsupported_adapter':
    case 'isolation_required':
    case 'setup_failed':
    case 'infra_failed':
    case 'policy_denied':
    case 'budget_exhausted':
    case 'aborted':
    case 'blocked':
    case 'cancelled':
      return output.errorClass;
    default:
      return 'verification_failed';
  }
}

function taskRunArtifactFromDescriptor(
  descriptor: Omit<TaskRunArtifact, 'schemaVersion' | 'artifactId' | 'taskRunId' | 'ts'> & {
    artifactId?: string;
    taskRunId?: string;
    ts?: number;
  },
  projection: TaskRunProjection,
  fallbackTs: number,
): TaskRunArtifact {
  return {
    schemaVersion: 1,
    artifactId: descriptor.artifactId ?? `harbor-official-artifact-${shortHash({ projection: projection.taskRunId, descriptor })}`,
    taskRunId: descriptor.taskRunId ?? projection.taskRunId,
    ts: descriptor.ts ?? fallbackTs,
    kind: descriptor.kind,
    authority: descriptor.authority,
    ...(descriptor.attemptId ? { attemptId: descriptor.attemptId } : {}),
    ...(descriptor.label ? { label: descriptor.label } : {}),
    ...(descriptor.path ? { path: descriptor.path } : {}),
    ...(descriptor.workspacePath ? { workspacePath: descriptor.workspacePath } : {}),
    ...(descriptor.artifactRef ? { artifactRef: descriptor.artifactRef } : {}),
    ...(descriptor.hash ? { hash: descriptor.hash } : {}),
    ...(descriptor.mimeType ? { mimeType: descriptor.mimeType } : {}),
    ...(descriptor.metadata ? { metadata: descriptor.metadata } : {}),
  };
}

function aheAgentRunMessages(
  projection: TaskRunProjection,
  exported: TaskRunExport,
  official: MakaAheOfficialResultOverlay | undefined,
  sessionMessages: readonly unknown[] | undefined,
): { trace_id: string; messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> } {
  const publicEvents = projection.events.flatMap(exportableTaskEvents);
  const normalizedSessionMessages = (sessionMessages ?? []).flatMap(aheMessagesFromStoredSessionMessage);
  return {
    trace_id: projection.taskRunId,
    messages: [
      {
        role: 'system',
        content: [
          'You are analyzing a Maka task-run evidence export for Agentic Harness Engineering.',
          'Use official Harbor scorer authority when present; treat self-check evidence as advisory only.',
        ].join(' '),
      },
      ...normalizedSessionMessages,
      {
        role: 'user',
        content: JSON.stringify({
          taskRun: exported,
          publicEvents,
          officialHarborResult: official,
        }, null, 2),
      },
      {
        role: 'assistant',
        content: 'Ready to analyze this Maka task-run evidence, including runtime events, advisory self-checks, and any imported official Harbor result.',
      },
    ],
  };
}

function sessionMessagesFor(
  messages: MakaAheSessionMessagesByTaskRun | undefined,
  taskRunId: string,
): readonly unknown[] | undefined {
  if (!messages) return undefined;
  if (isReadonlyMap(messages)) return messages.get(taskRunId);
  return messages[taskRunId];
}

function aheMessagesFromStoredSessionMessage(message: unknown): Array<{ role: 'user' | 'assistant'; content: string }> {
  if (!message || typeof message !== 'object') return [];
  const record = message as Record<string, unknown>;
  switch (record.type) {
    case 'user':
      return stringField(record, 'text')
        ? [{ role: 'user', content: stringField(record, 'text')! }]
        : [];
    case 'assistant': {
      const parts = [
        stringField(record, 'thinking') ? `[thinking]\n${stringField(record, 'thinking')}` : undefined,
        stringField(record, 'text'),
      ].filter((part): part is string => Boolean(part));
      return parts.length > 0 ? [{ role: 'assistant', content: parts.join('\n\n') }] : [];
    }
    case 'tool_call':
      return [{
        role: 'assistant',
        content: JSON.stringify({
          kind: 'tool_call',
          id: stringField(record, 'id'),
          toolName: stringField(record, 'toolName'),
          args: record.args,
          ts: record.ts,
        }, null, 2),
      }];
    case 'tool_result':
      return [{
        role: 'user',
        content: JSON.stringify({
          kind: 'tool_result',
          toolUseId: stringField(record, 'toolUseId'),
          isError: record.isError,
          content: record.content,
          durationMs: record.durationMs,
          ts: record.ts,
        }, null, 2),
      }];
    case 'system_note':
      return stringField(record, 'text')
        ? [{ role: 'user', content: `[system_note]\n${stringField(record, 'text')}` }]
        : [];
    default:
      return [];
  }
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (typeof value === 'string') return value;
  if (key === 'thinking' && value && typeof value === 'object') {
    const text = (value as { text?: unknown }).text;
    return typeof text === 'string' ? text : undefined;
  }
  return undefined;
}

async function readOptionalJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
}

async function readOptionalText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

function artifactRefFromTaskRunArtifact(artifact: TaskRunArtifact): MakaAheArtifactRef {
  const ref = artifact.artifactRef ?? artifact.path ?? artifact.workspacePath ?? artifact.artifactId;
  return {
    kind: artifactRefKind(ref, artifact),
    ref,
    ...(artifact.mimeType ? { mediaType: artifact.mimeType } : {}),
    ...(artifact.label ?? artifact.kind ? { description: artifact.label ?? artifact.kind } : {}),
  };
}

function artifactRefKind(ref: string, artifact: TaskRunArtifact): MakaAheArtifactRef['kind'] {
  if (ref.startsWith('http://') || ref.startsWith('https://')) return 'url';
  if (artifact.kind === 'container_workspace') return 'directory';
  if (artifact.artifactRef && !artifact.artifactRef.startsWith('/')) return 'blob';
  if (artifact.path || artifact.workspacePath) return 'file';
  return 'other';
}

function sortProjections(projections: readonly TaskRunProjection[]): TaskRunProjection[] {
  return [...projections].sort((a, b) => a.taskId.localeCompare(b.taskId) || a.taskRunId.localeCompare(b.taskRunId));
}

function unsafeRepoPathReason(path: string): string | undefined {
  if (path.trim().length === 0) return 'source ref path must be non-empty';
  if (path.startsWith('/') || path.includes('\\')) return 'source ref path must be a repo-relative POSIX path';
  if (path === '.' || path === '..' || path.includes('../') || path.includes('/..')) return 'source ref path must not traverse outside the repo';
  return undefined;
}

function isWithinRoot(root: string, candidate: string): boolean {
  const normalizedRoot = root.endsWith(sep) ? root : `${root}${sep}`;
  return candidate === root || candidate.startsWith(normalizedRoot);
}

function safePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || shortHash(value);
}

function shortHash(value: unknown): string {
  return exportContentHash(value).replace(/^sha256:/, '').slice(0, 16);
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '') || '.';
}

async function writeStableJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function uniqueStrings(values: readonly (string | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.length > 0))];
}
