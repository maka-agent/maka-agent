import { mkdir, stat, writeFile } from 'node:fs/promises';
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
  exportContentHash,
  taskRunExportFromProjection,
  writeTaskRunExport,
  type TaskRunExport,
} from './result-export.js';
import type { ScoreResult, TaskRunArtifact, VerifierResult } from './task-contracts.js';
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
}

export interface WriteMakaAheEvidenceExportResult extends MakaAheRunEvidence {
  targetSnapshot: MakaAheTargetSnapshot;
  files: {
    targetSnapshotJson: string;
    harnessResultsJson: string;
    traceIndexJson: string;
    traceDirs: Record<string, string>;
  };
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
    const taskRunRef = `${traceBaseRef}/${safePathSegment(projection.taskRunId)}`;
    const result = runResultFromProjection(projection, exported, {
      snapshotId: options.snapshotId,
      runId,
      taskRunRef,
    });
    const validation = validateMakaAheRunResult(result);
    if (!validation.ok) {
      throw new Error(`invalid Maka AHE run result for ${projection.taskRunId}:\n${validation.errors.map((error) => `- ${error.path}: ${error.message}`).join('\n')}`);
    }
    results.push(result);
    entries.push(traceIndexEntryFromProjection(projection, exported, {
      snapshotId: options.snapshotId,
      runId,
      taskRunRef,
      includeEvents: options.includeEvents,
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
  }

  return { targetSnapshot: options.snapshot, ...evidence, files };
}

function runResultFromProjection(
  projection: TaskRunProjection,
  exported: TaskRunExport,
  ids: { snapshotId: string; runId: string; taskRunRef: string },
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
    ...(exported.verifier ? { verifierRef: verifierRef(exported.verifier, ids.taskRunRef) } : {}),
    traceRef: { kind: 'file', ref: `${ids.taskRunRef}/task-run.json`, mediaType: 'application/json' },
    ...(status === 'official_pass' ? {} : { failureTaxonomy: failureTaxonomy(exported) }),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

function traceIndexEntryFromProjection(
  projection: TaskRunProjection,
  exported: TaskRunExport,
  ids: { snapshotId: string; runId: string; taskRunRef: string; includeEvents?: boolean },
): MakaAheTraceIndexEntry {
  return {
    taskId: exported.taskRun.taskId,
    runId: ids.runId,
    snapshotId: ids.snapshotId,
    ...(ids.includeEvents || (exported.runtime.trajectoryRefs.runtimeEventIds && exported.runtime.trajectoryRefs.runtimeEventIds.length > 0)
      ? { runtimeEventsJsonl: { kind: 'file', ref: `${ids.taskRunRef}/events.jsonl`, mediaType: 'application/jsonl' } }
      : {}),
    ...(exported.runtime.agentRunId ? { agentRun: { kind: 'other', ref: `maka-agent-run:${exported.runtime.agentRunId}` } } : {}),
    transcript: { kind: 'file', ref: `${ids.taskRunRef}/result.md`, mediaType: 'text/markdown' },
    toolResults: projection.artifacts.filter((artifact) => artifact.kind === 'runtime_trace').map(artifactRefFromTaskRunArtifact),
    artifacts: exported.artifacts.items.map(artifactRefFromTaskRunArtifact),
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

function verifierRef(verifier: VerifierResult, taskRunRef: string): MakaAheArtifactRef {
  return {
    kind: 'file',
    ref: `${taskRunRef}/task-run.json`,
    mediaType: 'application/json',
    description: `${verifier.kind} verifier result ${verifier.id}`,
  };
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
