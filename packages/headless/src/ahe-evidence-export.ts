import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import {
  EXECUTION_EVIDENCE_REF_SCHEMA_VERSION,
  validateExecutionEvidenceRef,
  type ExecutionEvidenceRef,
  type ExecutionLogCoverage,
} from '@maka/core/execution-evidence';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { AgentRunInspectDocument } from '@maka/runtime';
import {
  MAKA_AHE_EXECUTION_LINEAGE_SCHEMA_VERSION,
  MAKA_AHE_CURRENT_COMPONENTS,
  MAKA_AHE_RUN_RESULT_SCHEMA_VERSION,
  MAKA_AHE_TARGET_PROTOCOL_VERSION,
  MAKA_AHE_TARGET_SOURCE_LABEL,
  type MakaAheArtifactRef,
  type MakaAheExecutionLineage,
  type MakaAheExecutionLineageAgentRun,
  type MakaAheExecutionLineageGap,
  type MakaAheHarnessResults,
  type MakaAheResultStatus,
  type MakaAheRunResult,
  type MakaAheScoreAuthority,
  type MakaAheSnapshotIdentity,
  type MakaAheSourceManifest,
  type MakaAheSourceManifestEntry,
  type MakaAheTargetComponent,
  type MakaAheTargetSnapshot,
  type MakaAheTraceIndex,
  type MakaAheTraceIndexEntry,
  type MakaAheValidationIssue,
  makaAheSourceManifestDigest,
  makaAheTargetSnapshotId,
  validateMakaAheRunResult,
  validateMakaAheExecutionLineage,
  validateMakaAheTargetComponents,
  validateMakaAheTargetSnapshot,
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
import {
  auditSelfCheckPlanConsistency,
  heavyTaskSelfCheckSandboxStatus,
  heavyTaskSelfCheckStrongPassBlocker,
  heavyTaskSelfCheckWorkspaceGuardStatus,
} from './heavy-task-self-check.js';
import type {
  AutonomousResultTaxonomy,
  HeavyTaskSelfCheckExecutionHygiene,
  HeavyTaskSelfCheckPlanAuditSummary,
  ScoreResult,
  TaskRunArtifact,
  VerifierResult,
} from './task-contracts.js';
import type { TaskRunProjection } from './task-run-store.js';

export const MAKA_AHE_EVIDENCE_EXPORT_SOURCE_LABEL = 'ahe-evidence-export-20260714' as const;

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
  generatedRefs?: MakaAheGeneratedRefsByTaskRun;
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
  agentRunEvidence?: MakaAheAgentRunEvidenceByTaskRun;
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

export interface MakaAheAgentRunEvidenceSource {
  sessionId: string;
  agentRunId: string;
  inspect?: AgentRunInspectDocument;
  /** Immutable Runtime Event rows only. Mutable partial snapshots must not be supplied. */
  runtimeEvents?: readonly RuntimeEvent[];
  inspectError?: string;
  runtimeEventsError?: string;
}

export type MakaAheAgentRunEvidenceByTaskRun =
  | ReadonlyMap<string, readonly MakaAheAgentRunEvidenceSource[]>
  | Record<string, readonly MakaAheAgentRunEvidenceSource[]>;

export interface MakaAheGeneratedTaskRefs {
  taskRun: MakaAheArtifactRef;
  transcript: MakaAheArtifactRef;
  messages: MakaAheArtifactRef;
  taskEvents: MakaAheArtifactRef;
  executionLineage: MakaAheArtifactRef;
  agentRunInspections: readonly MakaAheArtifactRef[];
  runtimeEventSources: readonly MakaAheArtifactRef[];
  officialResult?: MakaAheArtifactRef;
  failureDigest?: MakaAheArtifactRef;
}

export type MakaAheGeneratedRefsByTaskRun =
  | ReadonlyMap<string, MakaAheGeneratedTaskRefs>
  | Record<string, MakaAheGeneratedTaskRefs>;

export interface WriteMakaAheEvidenceExportResult extends MakaAheRunEvidence {
  targetSnapshot: MakaAheTargetSnapshot;
  files: {
    targetSnapshotJson: string;
    harnessResultsJson: string;
    traceIndexJson: string;
    traceDirs: Record<string, string>;
    executionLineageJson: Record<string, string>;
    agentRunDirs: Record<string, Record<string, string>>;
    failureDigests: Record<string, string>;
  };
}

export interface MakaAheFailureDigest {
  schemaVersion: 'maka.ahe.failure_digest.v1';
  taskRunId: string;
  taskId: string;
  exportedAt: string;
  status: MakaAheResultStatus;
  scoreAuthority: MakaAheScoreAuthority;
  score?: number;
  failureTaxonomy: string[];
  warnings: string[];
  officialHarbor: {
    imported: boolean;
    verifier?: CompactVerifierResult;
    score?: CompactScoreResult;
    sourceRef?: MakaAheArtifactRef;
  };
  selfCheck: {
    divergence:
      | 'self_check_pass_official_fail'
      | 'self_check_fail_official_pass'
      | 'aligned'
      | 'no_self_check'
      | 'unscored';
    hygiene: {
      scratchUsed: boolean | 'unknown';
      cleanupPerformed: boolean | 'unknown';
      sandboxStatus: 'present' | 'missing';
      sandboxRoot?: string;
      sandboxStrategy?: string;
      strongPassBlocker?: string;
      workspaceGuardStatus: 'clean' | 'dirty' | 'unchecked' | 'unknown';
      strongPassEligible: boolean;
      workspacePollutionSuspected: boolean;
      remainingSideEffectPaths: string[];
      addedPaths: string[];
      modifiedPaths: string[];
      removedPaths: string[];
      checkedPaths: string[];
      riskFlags: string[];
      latest?: HeavyTaskSelfCheckExecutionHygiene;
    };
    heavyTaskSelfChecks: TaskRunProjection['heavyTaskSelfChecks'];
    selfCheckPlan?: {
      latest?: TaskRunProjection['latestHeavyTaskSelfCheckPlan'];
      audit?: HeavyTaskSelfCheckPlanAuditSummary;
    };
    legacySelfChecks: TaskRunProjection['selfChecks'];
  };
  finalState: {
    taskRun: TaskRunExport['taskRun'];
    workspace: TaskRunExport['workspace'];
    selfCheckGate?: NonNullable<TaskRunExport['heavyTask']>['selfCheckGate'];
    artifacts: Array<{
      kind: string;
      ref: string;
      label?: string;
      authority?: string;
      hash?: string;
      metadata?: Record<string, unknown>;
    }>;
    progress?: TaskRunExport['progress'];
    recentEvidence: Array<{
      kind: string;
      ts: number;
      source?: Record<string, unknown>;
      tool?: Record<string, unknown>;
      artifact?: Record<string, unknown>;
      check?: Record<string, unknown>;
    }>;
  };
  debugRefs: {
    taskRun: MakaAheArtifactRef;
    messages: MakaAheArtifactRef;
    transcript: MakaAheArtifactRef;
    executionLineage: MakaAheArtifactRef;
    taskEventsJsonl: MakaAheArtifactRef;
    agentRunInspections: MakaAheArtifactRef[];
    runtimeEventSources: MakaAheArtifactRef[];
    officialHarborResult?: MakaAheArtifactRef;
  };
}

interface CompactVerifierResult {
  id: string;
  kind: string;
  passed: boolean;
  exitCode?: number | null;
  score?: number;
  maxScore?: number;
  errorClass?: string;
  error?: string;
  stdoutExcerpt?: string;
  stderrExcerpt?: string;
  authority?: VerifierResult['authority'];
  details?: Record<string, unknown>;
}

interface CompactScoreResult {
  id: string;
  passed: boolean;
  scored: boolean;
  eligible: boolean;
  score?: number;
  maxScore?: number;
  taxonomy: AutonomousResultTaxonomy;
  errorClass?: string;
  excludedReason?: string;
  authority?: ScoreResult['authority'];
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

  await Promise.all(
    components.flatMap((component, componentIndex) =>
      component.sourceRefs.map(async (sourceRef, refIndex) => {
        const path = `components[${componentIndex}].sourceRefs[${refIndex}].path`;
        const issue = unsafeRepoPathReason(sourceRef.path);
        if (issue) {
          errors.push({ path, message: issue });
          return;
        }
        try {
          await resolveMakaAheSourceFile(repoRoot, sourceRef.path);
        } catch (error) {
          errors.push({ path, message: (error as Error).message });
        }
      }),
    ),
  );

  return errors.sort((a, b) => a.path.localeCompare(b.path) || a.message.localeCompare(b.message));
}

export async function buildMakaAheTargetSnapshot(
  options: BuildMakaAheTargetSnapshotOptions,
): Promise<MakaAheTargetSnapshot> {
  const components = options.components ?? MAKA_AHE_CURRENT_COMPONENTS;
  const errors = await validateMakaAheSourceRefs(options.repoRoot, components);
  if (errors.length > 0) {
    throw new Error(
      `invalid Maka AHE target snapshot source refs:\n${errors.map((error) => `- ${error.path}: ${error.message}`).join('\n')}`,
    );
  }

  const sourceLabel = options.sourceLabel ?? MAKA_AHE_EVIDENCE_EXPORT_SOURCE_LABEL;
  const sourceManifest = await buildMakaAheSourceManifest(options.repoRoot, components);

  return {
    protocolVersion: MAKA_AHE_TARGET_PROTOCOL_VERSION,
    sourceLabel,
    snapshotId: makaAheTargetSnapshotId(components, sourceManifest),
    createdAt: options.createdAt ?? new Date().toISOString(),
    ...(options.git ? { git: options.git } : {}),
    components,
    sourceManifest,
  };
}

export function makaAheEvidenceFromTaskRunProjections(
  projections: readonly TaskRunProjection[],
  options: MakaAheRunEvidenceOptions,
): MakaAheRunEvidence {
  const sorted = sortProjections(projections);
  const runId =
    options.runId ??
    `maka-ahe-run-${shortHash({
      snapshotId: options.snapshotId,
      taskRunIds: sorted.map((projection) => projection.taskRunId),
    })}`;
  const traceBaseRef = trimTrailingSlash(options.traceBaseRef ?? 'traces');
  const results: MakaAheRunResult[] = [];
  const entries: MakaAheTraceIndexEntry[] = [];

  for (const projection of sorted) {
    const exported = taskRunExportFromProjection(projection, { exportedAt: options.exportedAt });
    const official = officialResultFor(options.officialResults, projection.taskRunId);
    const effectiveExport = official
      ? taskRunExportWithOfficialOverlay(exported, official)
      : exported;
    const taskRunRef = `${traceBaseRef}/${safePathSegment(projection.taskRunId)}`;
    const generatedRefs = generatedRefsFor(options.generatedRefs, projection.taskRunId);
    const result = runResultFromProjection(projection, effectiveExport, {
      snapshotId: options.snapshotId,
      runId,
      taskRunRef,
      officialResultRef: official ? `${taskRunRef}/official-harbor-result.json` : undefined,
      generatedRefs,
    });
    const validation = validateMakaAheRunResult(result);
    if (!validation.ok) {
      throw new Error(
        `invalid Maka AHE run result for ${projection.taskRunId}:\n${validation.errors.map((error) => `- ${error.path}: ${error.message}`).join('\n')}`,
      );
    }
    results.push(result);
    entries.push(
      traceIndexEntryFromProjection(projection, effectiveExport, {
        snapshotId: options.snapshotId,
        runId,
        taskRunRef,
        officialResultRef: official ? `${taskRunRef}/official-harbor-result.json` : undefined,
        generatedRefs,
      }),
    );
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
  const snapshotValidation = validateMakaAheTargetSnapshot(options.snapshot);
  if (!snapshotValidation.ok) {
    throw new Error(
      `invalid Maka AHE target snapshot:\n${snapshotValidation.errors.map((error) => `- ${error.path}: ${error.message}`).join('\n')}`,
    );
  }
  await mkdir(outDir, { recursive: true });
  const exportedAt = options.exportedAt ?? new Date().toISOString();
  const generatedRefs: Record<string, MakaAheGeneratedTaskRefs> = {};
  const files: WriteMakaAheEvidenceExportResult['files'] = {
    targetSnapshotJson: join(outDir, 'target-snapshot.json'),
    harnessResultsJson: join(outDir, 'harness-results.json'),
    traceIndexJson: join(outDir, 'trace-index.json'),
    traceDirs: {},
    executionLineageJson: {},
    agentRunDirs: {},
    failureDigests: {},
  };

  await writeStableJson(files.targetSnapshotJson, options.snapshot);

  for (const projection of sortProjections(options.projections)) {
    const traceDir = join(outDir, 'traces', safePathSegment(projection.taskRunId));
    const taskRunRef = `traces/${safePathSegment(projection.taskRunId)}`;
    files.traceDirs[projection.taskRunId] = traceDir;
    files.agentRunDirs[projection.taskRunId] = {};
    const taskRunWrite = await writeTaskRunExport(traceDir, projection, {
      includeEvents: true,
      eventsFileName: 'task-events.jsonl',
      exportedAt,
    });
    const exported = taskRunWrite.export;
    const official = officialResultFor(options.officialResults, projection.taskRunId);
    const effectiveExport = official
      ? taskRunExportWithOfficialOverlay(exported, official)
      : exported;
    const sessionMessages = sessionMessagesFor(options.sessionMessages, projection.taskRunId);
    const messagesPath = join(traceDir, 'messages.json');
    await writeStableJson(
      messagesPath,
      aheAgentRunMessages(projection, exported, official, sessionMessages),
    );
    const officialResultPath = official ? join(traceDir, 'official-harbor-result.json') : undefined;
    if (official) {
      await writeStableJson(officialResultPath!, official);
    }

    const materializedAgentRuns = await materializeAgentRunEvidence(
      traceDir,
      taskRunRef,
      linkedAgentRunEvidence(
        projection,
        agentRunEvidenceFor(options.agentRunEvidence, projection.taskRunId),
      ),
      options.includeEvents === true,
      files.agentRunDirs[projection.taskRunId]!,
    );
    const lineage = executionLineageFromProjection(
      projection,
      options.snapshot,
      options.includeEvents === true,
      materializedAgentRuns,
    );
    const lineageValidation = validateMakaAheExecutionLineage(lineage);
    if (!lineageValidation.ok) {
      throw new Error(
        `invalid Maka AHE execution lineage for ${projection.taskRunId}:\n${lineageValidation.errors.map((error) => `- ${error.path}: ${error.message}`).join('\n')}`,
      );
    }
    const lineagePath = join(traceDir, 'execution-lineage.json');
    files.executionLineageJson[projection.taskRunId] = lineagePath;
    await writeStableJson(lineagePath, lineage);

    const taskRefs: MakaAheGeneratedTaskRefs = {
      taskRun: await localFileRef(
        taskRunWrite.files.taskRunJson,
        `${taskRunRef}/task-run.json`,
        'application/json',
      ),
      transcript: await localFileRef(
        taskRunWrite.files.resultMd,
        `${taskRunRef}/result.md`,
        'text/markdown',
      ),
      messages: await localFileRef(messagesPath, `${taskRunRef}/messages.json`, 'application/json'),
      taskEvents: await localFileRef(
        taskRunWrite.files.eventsJsonl!,
        `${taskRunRef}/task-events.jsonl`,
        'application/jsonl',
        'payload-safe Task Event projection; source coverage refers to the canonical Task Event ledger',
      ),
      executionLineage: await localFileRef(
        lineagePath,
        `${taskRunRef}/execution-lineage.json`,
        'application/json',
      ),
      agentRunInspections: materializedAgentRuns.flatMap((source) =>
        source.inspectRef ? [source.inspectRef] : [],
      ),
      runtimeEventSources: materializedAgentRuns.flatMap((source) =>
        source.runtimeEventsRef ? [source.runtimeEventsRef] : [],
      ),
      ...(officialResultPath
        ? {
            officialResult: await localFileRef(
              officialResultPath,
              `${taskRunRef}/official-harbor-result.json`,
              'application/json',
            ),
          }
        : {}),
    };
    const failureDigest = failureDigestFromProjection(projection, effectiveExport, {
      official,
      exportedAt,
      generatedRefs: taskRefs,
    });
    if (failureDigest) {
      const failureDigestPath = join(traceDir, 'failure-digest.json');
      files.failureDigests[projection.taskRunId] = failureDigestPath;
      await writeStableJson(failureDigestPath, failureDigest);
      taskRefs.failureDigest = await localFileRef(
        failureDigestPath,
        `${taskRunRef}/failure-digest.json`,
        'application/json',
      );
    }
    generatedRefs[projection.taskRunId] = taskRefs;
  }

  const evidence = makaAheEvidenceFromTaskRunProjections(options.projections, {
    snapshotId: options.snapshot.snapshotId,
    runId: options.runId,
    exportedAt,
    includeEvents: options.includeEvents,
    officialResults: options.officialResults,
    generatedRefs,
  });
  await writeStableJson(files.traceIndexJson, evidence.traceIndex);
  evidence.harnessResults.traceIndexRef = await localFileRef(
    files.traceIndexJson,
    'trace-index.json',
    'application/json',
  );
  await writeStableJson(files.harnessResultsJson, evidence.harnessResults);

  return { targetSnapshot: options.snapshot, ...evidence, files };
}

function runResultFromProjection(
  projection: TaskRunProjection,
  exported: TaskRunExport,
  ids: {
    snapshotId: string;
    runId: string;
    taskRunRef: string;
    officialResultRef?: string;
    generatedRefs?: MakaAheGeneratedTaskRefs;
  },
): MakaAheRunResult {
  const authority = scoreAuthority(exported.score, exported.verifier, projection);
  const status = resultStatus(exported, projection, authority);
  const normalized = normalizedScore(exported.score, exported.verifier);
  const warnings = resultWarnings(exported, projection, status, authority);
  return {
    schemaVersion: MAKA_AHE_RUN_RESULT_SCHEMA_VERSION,
    protocolVersion: MAKA_AHE_TARGET_PROTOCOL_VERSION,
    runId: ids.runId,
    snapshotId: ids.snapshotId,
    taskRunId: projection.taskRunId,
    taskId: exported.taskRun.taskId,
    status,
    scoreAuthority: authority,
    ...(normalized !== undefined ? { score: normalized } : {}),
    ...(exported.verifier
      ? {
          verifierRef:
            ids.generatedRefs?.officialResult ??
            (ids.generatedRefs?.taskRun
              ? {
                  ...ids.generatedRefs.taskRun,
                  description: `${exported.verifier.kind} verifier result ${exported.verifier.id}`,
                }
              : undefined) ??
            verifierRef(exported.verifier, ids.taskRunRef, ids.officialResultRef),
        }
      : {}),
    traceRef: ids.generatedRefs?.taskRun ?? {
      kind: 'file',
      ref: `${ids.taskRunRef}/task-run.json`,
      mediaType: 'application/json',
    },
    executionLineageRef: ids.generatedRefs?.executionLineage ?? {
      kind: 'file',
      ref: `${ids.taskRunRef}/execution-lineage.json`,
      mediaType: 'application/json',
    },
    ...(status === 'official_pass' ? {} : { failureTaxonomy: failureTaxonomy(exported) }),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

function traceIndexEntryFromProjection(
  projection: TaskRunProjection,
  exported: TaskRunExport,
  ids: {
    snapshotId: string;
    runId: string;
    taskRunRef: string;
    officialResultRef?: string;
    generatedRefs?: MakaAheGeneratedTaskRefs;
  },
): MakaAheTraceIndexEntry {
  const artifacts = [
    ...(ids.officialResultRef
      ? [
          {
            ...(ids.generatedRefs?.officialResult ?? {
              kind: 'file' as const,
              ref: ids.officialResultRef,
              mediaType: 'application/json',
            }),
            description: 'Harbor post-exit official verifier result imported for AHE scoring',
          },
        ]
      : []),
    ...(shouldWriteFailureDigest(projection, exported)
      ? [
          {
            ...(ids.generatedRefs?.failureDigest ?? {
              kind: 'file' as const,
              ref: `${ids.taskRunRef}/failure-digest.json`,
              mediaType: 'application/json',
            }),
            description:
              'AHE failure digest with official verifier excerpts, self-check blocks, and final artifact state',
          },
        ]
      : []),
    ...exported.artifacts.items.map(artifactRefFromTaskRunArtifact),
  ];
  return {
    taskRunId: projection.taskRunId,
    taskId: exported.taskRun.taskId,
    runId: ids.runId,
    snapshotId: ids.snapshotId,
    executionLineage: ids.generatedRefs?.executionLineage ?? {
      kind: 'file',
      ref: `${ids.taskRunRef}/execution-lineage.json`,
      mediaType: 'application/json',
    },
    taskEventsJsonl: ids.generatedRefs?.taskEvents ?? {
      kind: 'file',
      ref: `${ids.taskRunRef}/task-events.jsonl`,
      mediaType: 'application/jsonl',
    },
    agentRunInspections: ids.generatedRefs?.agentRunInspections ?? [],
    runtimeEventSources: ids.generatedRefs?.runtimeEventSources ?? [],
    messages: ids.generatedRefs?.messages ?? {
      kind: 'file',
      ref: `${ids.taskRunRef}/messages.json`,
      mediaType: 'application/json',
    },
    transcript: ids.generatedRefs?.transcript ?? {
      kind: 'file',
      ref: `${ids.taskRunRef}/result.md`,
      mediaType: 'text/markdown',
    },
    toolResults: projection.artifacts
      .filter((artifact) => artifact.kind === 'runtime_trace')
      .map(artifactRefFromTaskRunArtifact),
    artifacts,
  };
}

function shouldWriteFailureDigest(projection: TaskRunProjection, exported: TaskRunExport): boolean {
  const authority = scoreAuthority(exported.score, exported.verifier, projection);
  return resultStatus(exported, projection, authority) !== 'official_pass';
}

function failureDigestFromProjection(
  projection: TaskRunProjection,
  exported: TaskRunExport,
  options: {
    official?: MakaAheOfficialResultOverlay;
    exportedAt?: string;
    generatedRefs?: MakaAheGeneratedTaskRefs;
  },
): MakaAheFailureDigest | undefined {
  const authority = scoreAuthority(exported.score, exported.verifier, projection);
  const status = resultStatus(exported, projection, authority);
  if (status === 'official_pass') return undefined;
  const taskRunRef = `traces/${safePathSegment(projection.taskRunId)}`;
  return {
    schemaVersion: 'maka.ahe.failure_digest.v1',
    taskRunId: projection.taskRunId,
    taskId: projection.taskId,
    exportedAt: options.exportedAt ?? new Date().toISOString(),
    status,
    scoreAuthority: authority,
    ...(normalizedScore(exported.score, exported.verifier) !== undefined
      ? { score: normalizedScore(exported.score, exported.verifier) }
      : {}),
    failureTaxonomy: failureTaxonomy(exported),
    warnings: resultWarnings(exported, projection, status, authority),
    officialHarbor: {
      imported: Boolean(options.official),
      ...(exported.verifier ? { verifier: compactVerifierResult(exported.verifier) } : {}),
      ...(exported.score ? { score: compactScoreResult(exported.score) } : {}),
      ...(options.official?.sourceRef ? { sourceRef: options.official.sourceRef } : {}),
    },
    selfCheck: {
      divergence: selfCheckDivergence(projection, exported),
      hygiene: selfCheckHygieneSummary(projection),
      heavyTaskSelfChecks: projection.heavyTaskSelfChecks,
      ...(projection.latestHeavyTaskSelfCheckPlan || projection.latestHeavyTaskSelfCheck
        ? {
            selfCheckPlan: {
              ...(projection.latestHeavyTaskSelfCheckPlan
                ? { latest: projection.latestHeavyTaskSelfCheckPlan }
                : {}),
              audit: auditSelfCheckPlanConsistency(
                projection.latestHeavyTaskSelfCheckPlan,
                projection.latestHeavyTaskSelfCheck,
              ),
            },
          }
        : {}),
      legacySelfChecks: projection.selfChecks,
    },
    finalState: {
      taskRun: exported.taskRun,
      workspace: exported.workspace,
      ...(exported.heavyTask?.selfCheckGate
        ? { selfCheckGate: exported.heavyTask.selfCheckGate }
        : {}),
      artifacts: exported.artifacts.items.map(compactArtifact),
      ...(exported.progress ? { progress: exported.progress } : {}),
      recentEvidence: projection.heavyTaskEvidence.slice(-20).map(compactHeavyTaskEvidence),
    },
    debugRefs: {
      taskRun: options.generatedRefs?.taskRun ?? {
        kind: 'file',
        ref: `${taskRunRef}/task-run.json`,
        mediaType: 'application/json',
      },
      messages: options.generatedRefs?.messages ?? {
        kind: 'file',
        ref: `${taskRunRef}/messages.json`,
        mediaType: 'application/json',
      },
      transcript: options.generatedRefs?.transcript ?? {
        kind: 'file',
        ref: `${taskRunRef}/result.md`,
        mediaType: 'text/markdown',
      },
      executionLineage: options.generatedRefs?.executionLineage ?? {
        kind: 'file',
        ref: `${taskRunRef}/execution-lineage.json`,
        mediaType: 'application/json',
      },
      taskEventsJsonl: options.generatedRefs?.taskEvents ?? {
        kind: 'file',
        ref: `${taskRunRef}/task-events.jsonl`,
        mediaType: 'application/jsonl',
      },
      agentRunInspections: [...(options.generatedRefs?.agentRunInspections ?? [])],
      runtimeEventSources: [...(options.generatedRefs?.runtimeEventSources ?? [])],
      ...(options.official
        ? {
            officialHarborResult: options.generatedRefs?.officialResult ?? {
              kind: 'file',
              ref: `${taskRunRef}/official-harbor-result.json`,
              mediaType: 'application/json',
            },
          }
        : {}),
    },
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
    return (exported.score?.passed ?? exported.verifier?.passed ?? false)
      ? 'official_pass'
      : 'official_fail';
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

function isOfficialAuthority(
  authority: { source: string; authoritative: boolean } | undefined,
): boolean {
  return authority?.authoritative === true && authority.source === 'official_harbor_verifier';
}

function hasSelfCheckEvidence(
  projection: TaskRunProjection,
  score: ScoreResult | undefined,
  verifier: VerifierResult | undefined,
): boolean {
  return (
    score?.authority?.source === 'self_check' ||
    verifier?.authority?.source === 'self_check' ||
    projection.selfChecks.length > 0 ||
    projection.heavyTaskSelfChecks.length > 0 ||
    projection.heavyTaskEvidence.some((item) => item.kind === 'check')
  );
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
  return fields.some((field) =>
    [
      'infra_failed',
      'setup_failed',
      'verification_error',
      'agent_failed',
      'agent_incomplete',
      'budget_exhausted',
      'aborted',
      'blocked',
      'cancelled',
    ].includes(field),
  );
}

function normalizedScore(
  score: ScoreResult | undefined,
  verifier: VerifierResult | undefined,
): number | undefined {
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
  const hasNonOfficialPass =
    exported.score?.passed === true ||
    exported.verifier?.passed === true ||
    exported.taxonomy.passed === true;
  if (
    status !== 'official_pass' &&
    authority !== 'official_scorer' &&
    authority !== 'official_verifier' &&
    hasNonOfficialPass
  ) {
    warnings.push(
      'non-authoritative pass evidence was exported outside official pass/fail buckets',
    );
  }
  if (
    projection.latestHeavyTaskSelfCheck &&
    status !== 'official_pass' &&
    status !== 'official_fail'
  ) {
    warnings.push('self-check evidence is advisory and was exported as non-official evidence');
  }
  return uniqueStrings(warnings);
}

function selfCheckDivergence(
  projection: TaskRunProjection,
  exported: TaskRunExport,
): MakaAheFailureDigest['selfCheck']['divergence'] {
  const latest = projection.latestHeavyTaskSelfCheck;
  const officialPassed =
    exported.score?.authority?.source === 'official_harbor_verifier' ||
    exported.verifier?.authority?.source === 'official_harbor_verifier'
      ? (exported.score?.passed ?? exported.verifier?.passed)
      : undefined;
  if (!latest && projection.selfChecks.length === 0) return 'no_self_check';
  if (officialPassed === undefined) return 'unscored';
  if (latest?.status === 'pass' && officialPassed === false) return 'self_check_pass_official_fail';
  if (latest?.status === 'fail' && officialPassed === true) return 'self_check_fail_official_pass';
  return 'aligned';
}

function selfCheckHygieneSummary(
  projection: TaskRunProjection,
): MakaAheFailureDigest['selfCheck']['hygiene'] {
  const latest = projection.latestHeavyTaskSelfCheck?.executionHygiene;
  if (!latest) {
    return {
      scratchUsed: 'unknown',
      cleanupPerformed: 'unknown',
      sandboxStatus: 'missing',
      workspaceGuardStatus: 'unchecked',
      strongPassEligible: false,
      strongPassBlocker: 'latest self-check is missing sandbox execution evidence',
      workspacePollutionSuspected: false,
      remainingSideEffectPaths: [],
      addedPaths: [],
      modifiedPaths: [],
      removedPaths: [],
      checkedPaths: [],
      riskFlags: ['hygiene_not_reported'],
    };
  }

  const remainingSideEffectPaths = uniqueStrings(latest.remainingSideEffectPaths ?? []);
  const addedPaths = uniqueStrings(latest.workspaceGuard?.addedPaths ?? []);
  const modifiedPaths = uniqueStrings(latest.workspaceGuard?.modifiedPaths ?? []);
  const removedPaths = uniqueStrings(latest.workspaceGuard?.removedPaths ?? []);
  const checkedPaths = uniqueStrings(latest.workspaceGuard?.checkedPaths ?? []);
  const workspaceGuardStatus = projection.latestHeavyTaskSelfCheck
    ? heavyTaskSelfCheckWorkspaceGuardStatus(
        projection.latestHeavyTaskSelfCheck,
        projection.latestHeavyTaskSelfCheckPlan,
      )
    : 'unchecked';
  const sandboxStatus = projection.latestHeavyTaskSelfCheck
    ? heavyTaskSelfCheckSandboxStatus(projection.latestHeavyTaskSelfCheck)
    : 'missing';
  const strongPassBlocker = projection.latestHeavyTaskSelfCheck
    ? heavyTaskSelfCheckStrongPassBlocker(
        projection.latestHeavyTaskSelfCheck,
        projection.latestHeavyTaskSelfCheckPlan,
      )
    : 'latest self-check is missing sandbox execution evidence';
  const planAudit = auditSelfCheckPlanConsistency(
    projection.latestHeavyTaskSelfCheckPlan,
    projection.latestHeavyTaskSelfCheck,
  );
  const riskFlags = [
    ...(sandboxStatus === 'missing' ? ['sandbox_not_reported'] : []),
    ...(latest.scratchUsed === false ? ['scratch_not_used'] : []),
    ...(latest.scratchUsed === undefined ? ['scratch_unknown'] : []),
    ...(latest.cleanupPerformed === false ? ['cleanup_not_performed'] : []),
    ...(latest.cleanupPerformed === undefined ? ['cleanup_unknown'] : []),
    ...(latest.workspaceSideEffects === 'present' ? ['workspace_side_effects_present'] : []),
    ...(latest.workspaceSideEffects === 'unknown' || latest.workspaceSideEffects === undefined
      ? ['workspace_side_effects_unknown']
      : []),
    ...(remainingSideEffectPaths.length > 0 ? ['remaining_side_effect_paths_reported'] : []),
    ...(latest.workspaceGuard?.checked !== true ? ['workspace_guard_not_checked'] : []),
    ...(addedPaths.length > 0 ? ['workspace_guard_added_paths_reported'] : []),
    ...planAudit.riskFlags,
  ];

  return {
    scratchUsed: latest.scratchUsed ?? 'unknown',
    cleanupPerformed: latest.cleanupPerformed ?? 'unknown',
    sandboxStatus,
    ...(latest.sandbox?.root ? { sandboxRoot: latest.sandbox.root } : {}),
    ...(latest.sandbox?.strategy ? { sandboxStrategy: latest.sandbox.strategy } : {}),
    workspaceGuardStatus,
    strongPassEligible: !strongPassBlocker,
    ...(strongPassBlocker ? { strongPassBlocker } : {}),
    workspacePollutionSuspected: workspaceGuardStatus === 'dirty',
    remainingSideEffectPaths,
    addedPaths,
    modifiedPaths,
    removedPaths,
    checkedPaths,
    riskFlags: uniqueStrings(riskFlags),
    latest,
  };
}

function compactVerifierResult(verifier: VerifierResult): CompactVerifierResult {
  return {
    id: verifier.id,
    kind: verifier.kind,
    passed: verifier.passed,
    ...(verifier.exitCode !== undefined ? { exitCode: verifier.exitCode } : {}),
    ...(verifier.score !== undefined ? { score: verifier.score } : {}),
    ...(verifier.maxScore !== undefined ? { maxScore: verifier.maxScore } : {}),
    ...(verifier.errorClass ? { errorClass: verifier.errorClass } : {}),
    ...(verifier.error ? { error: truncateText(verifier.error, 4000) } : {}),
    ...(verifier.stdout ? { stdoutExcerpt: truncateText(verifier.stdout, 20000, 'tail') } : {}),
    ...(verifier.stderr ? { stderrExcerpt: truncateText(verifier.stderr, 12000, 'tail') } : {}),
    ...(verifier.authority ? { authority: verifier.authority } : {}),
    ...(recordValue(verifier.details)
      ? { details: verifier.details as Record<string, unknown> }
      : {}),
  };
}

function compactScoreResult(score: ScoreResult): CompactScoreResult {
  return {
    id: score.id,
    passed: score.passed,
    scored: score.scored ?? false,
    eligible: score.eligible ?? false,
    ...(score.score !== undefined ? { score: score.score } : {}),
    ...(score.maxScore !== undefined ? { maxScore: score.maxScore } : {}),
    taxonomy: score.taxonomy,
    ...(score.errorClass ? { errorClass: score.errorClass } : {}),
    ...(score.excludedReason ? { excludedReason: score.excludedReason } : {}),
    ...(score.authority ? { authority: score.authority } : {}),
  };
}

function compactArtifact(
  artifact: TaskRunArtifact,
): MakaAheFailureDigest['finalState']['artifacts'][number] {
  return {
    kind: artifact.kind,
    ref: artifact.artifactRef ?? artifact.path ?? artifact.workspacePath ?? artifact.artifactId,
    ...(artifact.label ? { label: artifact.label } : {}),
    ...(artifact.authority ? { authority: artifact.authority.source } : {}),
    ...(artifact.hash ? { hash: artifact.hash } : {}),
    ...(recordValue(artifact.metadata)
      ? { metadata: artifact.metadata as Record<string, unknown> }
      : {}),
  };
}

function compactHeavyTaskEvidence(
  evidence: TaskRunProjection['heavyTaskEvidence'][number],
): MakaAheFailureDigest['finalState']['recentEvidence'][number] {
  return {
    kind: evidence.kind,
    ts: evidence.ts,
    source: compactRecord(evidence.source),
    ...(evidence.tool
      ? {
          tool: compactRecord({
            name: evidence.tool.name,
            inputSummary: evidence.tool.inputSummary,
            exitCode: evidence.tool.exitCode,
            timedOut: evidence.tool.timedOut,
            ok: evidence.tool.ok,
            outputs: evidence.tool.outputs,
            diff: evidence.tool.diff,
          }),
        }
      : {}),
    ...(evidence.artifact ? { artifact: compactRecord(evidence.artifact) } : {}),
    ...(evidence.check ? { check: compactRecord(evidence.check) } : {}),
  };
}

function compactRecord(value: unknown): Record<string, unknown> {
  if (!recordValue(value)) return {};
  return JSON.parse(
    JSON.stringify(value, (_key, inner) =>
      typeof inner === 'string' ? truncateText(inner, 4000) : inner,
    ),
  ) as Record<string, unknown>;
}

function verifierRef(
  verifier: VerifierResult,
  taskRunRef: string,
  officialResultRef: string | undefined,
): MakaAheArtifactRef {
  return {
    kind: 'file',
    ref: officialResultRef ?? `${taskRunRef}/task-run.json`,
    mediaType: 'application/json',
    description: `${verifier.kind} verifier result ${verifier.id}`,
  };
}

function taskRunExportWithOfficialOverlay(
  exported: TaskRunExport,
  official: MakaAheOfficialResultOverlay,
): TaskRunExport {
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
    warnings: uniqueStrings([
      ...exported.warnings,
      'Harbor post-exit official verifier result was imported for AHE scoring',
    ]),
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
    ...(output.artifacts
      ? {
          artifacts: output.artifacts.map((artifact, index) =>
            taskRunArtifactFromDescriptor(artifact, projection, ts + index),
          ),
        }
      : {}),
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
    artifactId:
      descriptor.artifactId ??
      `harbor-official-artifact-${shortHash({ projection: projection.taskRunId, descriptor })}`,
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
): {
  trace_id: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
} {
  const publicEvents = projection.events.flatMap(exportableTaskEvents);
  const normalizedSessionMessages = (sessionMessages ?? []).flatMap(
    aheMessagesFromStoredSessionMessage,
  );
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
        content: JSON.stringify(
          {
            taskRun: exported,
            publicEvents,
            officialHarborResult: official,
          },
          null,
          2,
        ),
      },
      {
        role: 'assistant',
        content:
          'Ready to analyze this Maka task-run evidence, including runtime events, advisory self-checks, and any imported official Harbor result.',
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

function aheMessagesFromStoredSessionMessage(
  message: unknown,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  if (!message || typeof message !== 'object') return [];
  const record = message as Record<string, unknown>;
  switch (record.type) {
    case 'user':
      return stringField(record, 'text')
        ? [{ role: 'user', content: stringField(record, 'text')! }]
        : [];
    case 'assistant': {
      const parts = [
        stringField(record, 'thinking')
          ? `[thinking]\n${stringField(record, 'thinking')}`
          : undefined,
        stringField(record, 'text'),
      ].filter((part): part is string => Boolean(part));
      return parts.length > 0 ? [{ role: 'assistant', content: parts.join('\n\n') }] : [];
    }
    case 'tool_call':
      return [
        {
          role: 'assistant',
          content: JSON.stringify(
            {
              kind: 'tool_call',
              id: stringField(record, 'id'),
              toolName: stringField(record, 'toolName'),
              args: record.args,
              ts: record.ts,
            },
            null,
            2,
          ),
        },
      ];
    case 'tool_result':
      return [
        {
          role: 'user',
          content: JSON.stringify(
            {
              kind: 'tool_result',
              toolUseId: stringField(record, 'toolUseId'),
              isError: record.isError,
              content: record.content,
              durationMs: record.durationMs,
              ts: record.ts,
            },
            null,
            2,
          ),
        },
      ];
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

function truncateText(text: string, maxChars: number, mode: 'head' | 'tail' = 'head'): string {
  if (text.length <= maxChars) return text;
  const marker = `\n...[truncated ${text.length - maxChars} chars]`;
  if (mode === 'tail') return `${marker}\n${text.slice(-maxChars)}`;
  return `${text.slice(0, maxChars)}${marker}`;
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
  const ref =
    artifact.artifactRef ?? artifact.path ?? artifact.workspacePath ?? artifact.artifactId;
  return {
    kind: artifactRefKind(ref, artifact),
    ref,
    ...(artifact.mimeType ? { mediaType: artifact.mimeType } : {}),
    ...((artifact.label ?? artifact.kind) ? { description: artifact.label ?? artifact.kind } : {}),
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
  return [...projections].sort(
    (a, b) => a.taskId.localeCompare(b.taskId) || a.taskRunId.localeCompare(b.taskRunId),
  );
}

interface MaterializedAgentRunEvidence {
  source: MakaAheAgentRunEvidenceSource;
  inspectRef?: MakaAheArtifactRef;
  runtimeEventsRef?: MakaAheArtifactRef;
  inspectError?: string;
  runtimeEventsError?: string;
}

async function materializeAgentRunEvidence(
  traceDir: string,
  taskRunRef: string,
  sources: readonly MakaAheAgentRunEvidenceSource[],
  includeRuntimeEvents: boolean,
  outputDirs: Record<string, string>,
): Promise<MaterializedAgentRunEvidence[]> {
  const unique = new Map<string, MakaAheAgentRunEvidenceSource>();
  for (const source of sources) {
    const key = agentRunEvidenceKey(source.sessionId, source.agentRunId);
    if (!unique.has(key)) unique.set(key, source);
  }
  const runSegmentCounts = new Map<string, number>();
  for (const source of unique.values()) {
    const segment = safePathSegment(source.agentRunId);
    runSegmentCounts.set(segment, (runSegmentCounts.get(segment) ?? 0) + 1);
  }
  const materialized: MaterializedAgentRunEvidence[] = [];
  for (const source of [...unique.values()].sort(
    (a, b) => a.agentRunId.localeCompare(b.agentRunId) || a.sessionId.localeCompare(b.sessionId),
  )) {
    const baseRunSegment = safePathSegment(source.agentRunId);
    const runSegment =
      runSegmentCounts.get(baseRunSegment)! > 1
        ? `${baseRunSegment}-${shortHash({ sessionId: source.sessionId, agentRunId: source.agentRunId })}`
        : baseRunSegment;
    const runDir = join(traceDir, 'agent-runs', runSegment);
    const runRef = `${taskRunRef}/agent-runs/${runSegment}`;
    const outputKey = `${source.sessionId}/${source.agentRunId}`;
    outputDirs[outputKey] = runDir;
    await mkdir(runDir, { recursive: true });
    const row: MaterializedAgentRunEvidence = {
      source,
      ...(source.inspectError ? { inspectError: source.inspectError } : {}),
      ...(source.runtimeEventsError ? { runtimeEventsError: source.runtimeEventsError } : {}),
    };

    if (source.inspect) {
      if (
        source.inspect.agentRun.sessionId !== source.sessionId ||
        source.inspect.agentRun.agentRunId !== source.agentRunId
      ) {
        row.inspectError = 'AgentRun inspect identity does not match the supplied source identity';
      } else {
        const inspectPath = join(runDir, 'inspect.json');
        await writeStableJson(inspectPath, source.inspect);
        row.inspectRef = await localFileRef(
          inspectPath,
          `${runRef}/inspect.json`,
          'application/json',
          `payload-safe inspect for maka-agent-run:${source.agentRunId}`,
        );
      }
    }

    if (includeRuntimeEvents && source.runtimeEvents) {
      const identityMismatch = source.runtimeEvents.find(
        (event) => event.sessionId !== source.sessionId || event.runId !== source.agentRunId,
      );
      if (identityMismatch) {
        row.runtimeEventsError = `RuntimeEvent ${identityMismatch.id} identity does not match the supplied AgentRun`;
      } else {
        const runtimeEventsPath = join(runDir, 'runtime-events.jsonl');
        await writeFile(
          runtimeEventsPath,
          source.runtimeEvents.map((event) => JSON.stringify(event)).join('\n') +
            (source.runtimeEvents.length > 0 ? '\n' : ''),
          'utf8',
        );
        row.runtimeEventsRef = await localFileRef(
          runtimeEventsPath,
          `${runRef}/runtime-events.jsonl`,
          'application/jsonl',
          `canonical immutable Runtime Events for maka-agent-run:${source.agentRunId}`,
        );
      }
    }
    materialized.push(row);
  }
  return materialized;
}

function executionLineageFromProjection(
  projection: TaskRunProjection,
  snapshot: MakaAheTargetSnapshot,
  includeRuntimeEvents: boolean,
  materialized: readonly MaterializedAgentRunEvidence[],
): MakaAheExecutionLineage {
  const target = { snapshotId: snapshot.snapshotId, sourceLabel: snapshot.sourceLabel };
  const taskCoverage = coverageForTaskEvents(projection);
  const sourceByAgentRun = new Map(
    materialized.map((source) => [
      agentRunEvidenceKey(source.source.sessionId, source.source.agentRunId),
      source,
    ]),
  );
  const gaps: MakaAheExecutionLineageGap[] = [];
  if (projection.attempts.length === 0) {
    gaps.push({
      code: 'attempt_execution_missing',
      message: 'TaskRun has no projected attempts; execution lineage is unavailable.',
    });
  }
  const attempts = projection.attempts.map((attempt) => {
    const attemptGaps: MakaAheExecutionLineageGap[] = [];
    if (attempt.executionLineage.length === 0) {
      attemptGaps.push({
        code: 'attempt_execution_missing',
        message: 'Attempt has no durable AgentRun execution link.',
        attemptId: attempt.attemptId,
      });
    }
    const executions = attempt.executionLineage.map(
      (sourceEvidence): MakaAheExecutionLineageAgentRun => {
        const evidence: ExecutionEvidenceRef = {
          ...sourceEvidence,
          schemaVersion: EXECUTION_EVIDENCE_REF_SCHEMA_VERSION,
          task: { taskRunId: projection.taskRunId, attemptId: attempt.attemptId },
          ...(taskCoverage ? { taskCoverage } : {}),
          target,
        };
        const validation = validateExecutionEvidenceRef(evidence);
        if (!validation.ok) {
          throw new Error(
            `invalid projected AHE execution evidence: ${validation.errors.map((issue) => `${issue.path}: ${issue.message}`).join('; ')}`,
          );
        }
        const executionGaps: MakaAheExecutionLineageGap[] = [];
        const identity = evidence.execution;
        if (!identity?.sessionId || !identity.agentRunId) {
          executionGaps.push({
            code: 'execution_identity_missing',
            message: 'Execution link does not identify an AgentRun.',
            attemptId: attempt.attemptId,
          });
        }
        if (!evidence.runtimeCoverage) {
          executionGaps.push({
            code: 'runtime_coverage_missing',
            message: 'Execution link has no immutable Runtime Event coverage.',
            attemptId: attempt.attemptId,
            ...(identity?.sessionId ? { sessionId: identity.sessionId } : {}),
            ...(identity?.agentRunId ? { agentRunId: identity.agentRunId } : {}),
          });
        }
        const source =
          identity?.sessionId && identity.agentRunId
            ? sourceByAgentRun.get(agentRunEvidenceKey(identity.sessionId, identity.agentRunId))
            : undefined;
        if (!source?.inspectRef) {
          executionGaps.push({
            code: 'agent_run_inspect_missing',
            message: source?.inspectError
              ? `Payload-safe AgentRun inspect is unavailable: ${source.inspectError}`
              : 'Payload-safe AgentRun inspect was not supplied.',
            attemptId: attempt.attemptId,
            ...(identity?.sessionId ? { sessionId: identity.sessionId } : {}),
            ...(identity?.agentRunId ? { agentRunId: identity.agentRunId } : {}),
          });
        } else if (
          evidence.runtimeCoverage &&
          source.source.inspect?.sources.runtimeCoverage &&
          !sameCoverage(evidence.runtimeCoverage, source.source.inspect.sources.runtimeCoverage)
        ) {
          executionGaps.push({
            code: 'runtime_coverage_mismatch',
            message:
              'AgentRun inspect coverage does not match the TaskRun execution-link coverage.',
            attemptId: attempt.attemptId,
            ...(identity?.sessionId ? { sessionId: identity.sessionId } : {}),
            ...(identity?.agentRunId ? { agentRunId: identity.agentRunId } : {}),
          });
        }
        if (includeRuntimeEvents) {
          const runtimeEvents = source?.source.runtimeEvents;
          if (!source?.runtimeEventsRef || !runtimeEvents || runtimeEvents.length === 0) {
            executionGaps.push({
              code: 'runtime_events_missing',
              message: source?.runtimeEventsError
                ? `Canonical Runtime Events are unavailable: ${source.runtimeEventsError}`
                : 'Canonical Runtime Events were requested but not supplied.',
              attemptId: attempt.attemptId,
              ...(identity?.sessionId ? { sessionId: identity.sessionId } : {}),
              ...(identity?.agentRunId ? { agentRunId: identity.agentRunId } : {}),
            });
          } else {
            const observed = coverageForRuntimeEvents(identity!.agentRunId!, runtimeEvents);
            if (
              (!evidence.runtimeCoverage || !sameCoverage(evidence.runtimeCoverage, observed)) &&
              !executionGaps.some((gap) => gap.code === 'runtime_coverage_mismatch')
            ) {
              executionGaps.push({
                code: 'runtime_coverage_mismatch',
                message:
                  'Exported Runtime Event rows do not match the TaskRun execution-link coverage.',
                attemptId: attempt.attemptId,
                sessionId: identity!.sessionId,
                agentRunId: identity!.agentRunId!,
              });
            }
          }
        }
        gaps.push(...executionGaps);
        return {
          evidence: validation.value,
          ...(source?.inspectRef ? { inspectRef: source.inspectRef } : {}),
          ...(includeRuntimeEvents && source?.runtimeEventsRef
            ? { runtimeEventsRef: source.runtimeEventsRef }
            : {}),
          gaps: executionGaps,
        };
      },
    );
    gaps.push(...attemptGaps);
    return {
      attemptId: attempt.attemptId,
      status: attempt.status,
      executions,
      gaps: attemptGaps,
    };
  });
  return {
    schemaVersion: MAKA_AHE_EXECUTION_LINEAGE_SCHEMA_VERSION,
    target,
    task: {
      taskRunId: projection.taskRunId,
      taskId: projection.taskId,
      ...(taskCoverage ? { coverage: taskCoverage } : {}),
    },
    rawRuntimeEvents: !includeRuntimeEvents
      ? 'omitted_by_policy'
      : attempts.some((attempt) => attempt.executions.length > 0) &&
          !gaps.some((gap) => gap.code === 'runtime_events_missing')
        ? 'included'
        : 'requested_with_gaps',
    attempts,
    gaps,
  };
}

function coverageForTaskEvents(projection: TaskRunProjection): ExecutionLogCoverage | undefined {
  const first = projection.events[0];
  const last = projection.events.at(-1);
  if (!first || !last) return undefined;
  return {
    lowWater: {
      ledger: 'task_event',
      streamId: projection.taskRunId,
      sequence: 0,
      eventId: first.id,
    },
    highWater: {
      ledger: 'task_event',
      streamId: projection.taskRunId,
      sequence: projection.events.length - 1,
      eventId: last.id,
    },
    eventCount: projection.events.length,
  };
}

function coverageForRuntimeEvents(
  agentRunId: string,
  events: readonly RuntimeEvent[],
): ExecutionLogCoverage | undefined {
  const first = events[0];
  const last = events.at(-1);
  if (!first || !last) return undefined;
  return {
    lowWater: { ledger: 'runtime_event', streamId: agentRunId, sequence: 0, eventId: first.id },
    highWater: {
      ledger: 'runtime_event',
      streamId: agentRunId,
      sequence: events.length - 1,
      eventId: last.id,
    },
    eventCount: events.length,
  };
}

function sameCoverage(
  left: ExecutionLogCoverage,
  right: ExecutionLogCoverage | undefined,
): boolean {
  if (!right) return false;
  return (
    left.lowWater?.ledger === right.lowWater?.ledger &&
    left.lowWater?.streamId === right.lowWater?.streamId &&
    left.lowWater?.sequence === right.lowWater?.sequence &&
    left.lowWater?.eventId === right.lowWater?.eventId &&
    left.highWater.ledger === right.highWater.ledger &&
    left.highWater.streamId === right.highWater.streamId &&
    left.highWater.sequence === right.highWater.sequence &&
    left.highWater.eventId === right.highWater.eventId &&
    left.eventCount === right.eventCount
  );
}

async function localFileRef(
  path: string,
  ref: string,
  mediaType: string,
  description?: string,
): Promise<MakaAheArtifactRef> {
  const content = await readFile(path);
  return {
    kind: 'file',
    ref,
    mediaType,
    ...(description ? { description } : {}),
    digest: `sha256:${createHash('sha256').update(content).digest('hex')}`,
    sizeBytes: content.byteLength,
  };
}

function agentRunEvidenceKey(sessionId: string, agentRunId: string): string {
  return `${sessionId}\u0000${agentRunId}`;
}

function agentRunEvidenceFor(
  sources: MakaAheAgentRunEvidenceByTaskRun | undefined,
  taskRunId: string,
): readonly MakaAheAgentRunEvidenceSource[] {
  if (!sources) return [];
  return isReadonlyMap(sources) ? (sources.get(taskRunId) ?? []) : (sources[taskRunId] ?? []);
}

function linkedAgentRunEvidence(
  projection: TaskRunProjection,
  sources: readonly MakaAheAgentRunEvidenceSource[],
): MakaAheAgentRunEvidenceSource[] {
  const linked = new Set(
    projection.executionLineage.flatMap((evidence) => {
      const identity = evidence.execution;
      return identity?.sessionId && identity.agentRunId
        ? [agentRunEvidenceKey(identity.sessionId, identity.agentRunId)]
        : [];
    }),
  );
  return sources.filter((source) =>
    linked.has(agentRunEvidenceKey(source.sessionId, source.agentRunId)),
  );
}

function generatedRefsFor(
  refs: MakaAheGeneratedRefsByTaskRun | undefined,
  taskRunId: string,
): MakaAheGeneratedTaskRefs | undefined {
  if (!refs) return undefined;
  return isReadonlyMap(refs) ? refs.get(taskRunId) : refs[taskRunId];
}

async function buildMakaAheSourceManifest(
  repoRoot: string,
  components: readonly MakaAheTargetComponent[],
): Promise<MakaAheSourceManifest> {
  const sourceDigests = new Map<string, Promise<{ digest: string; sizeBytes: number }>>();
  const digestFor = (sourceRefPath: string): Promise<{ digest: string; sizeBytes: number }> => {
    const existing = sourceDigests.get(sourceRefPath);
    if (existing) return existing;
    const pending = (async () => {
      const sourcePath = await resolveMakaAheSourceFile(repoRoot, sourceRefPath);
      const content = await readFile(sourcePath);
      return {
        digest: `sha256:${createHash('sha256').update(content).digest('hex')}`,
        sizeBytes: content.byteLength,
      };
    })();
    sourceDigests.set(sourceRefPath, pending);
    return pending;
  };
  const entries = await Promise.all(
    components.flatMap((component) =>
      component.sourceRefs.map(async (sourceRef) => {
        const source = await digestFor(sourceRef.path);
        return {
          componentId: component.id,
          path: sourceRef.path,
          ...(sourceRef.exportName ? { exportName: sourceRef.exportName } : {}),
          digest: source.digest,
          sizeBytes: source.sizeBytes,
        } satisfies MakaAheSourceManifestEntry;
      }),
    ),
  );
  entries.sort(
    (a, b) =>
      a.componentId.localeCompare(b.componentId) ||
      a.path.localeCompare(b.path) ||
      (a.exportName ?? '').localeCompare(b.exportName ?? ''),
  );
  return {
    algorithm: 'sha256',
    digest: makaAheSourceManifestDigest(entries),
    entries,
  };
}

async function resolveMakaAheSourceFile(repoRoot: string, sourcePath: string): Promise<string> {
  const root = resolve(repoRoot);
  const lexicalPath = resolve(root, sourcePath);
  if (!isWithinRoot(root, lexicalPath)) {
    throw new Error(`source ref "${sourcePath}" resolves outside the repo root`);
  }

  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(root);
  } catch {
    throw new Error(`repo root "${repoRoot}" does not exist`);
  }

  let canonicalPath: string;
  try {
    canonicalPath = await realpath(lexicalPath);
  } catch {
    throw new Error(`source ref "${sourcePath}" does not exist under repo root`);
  }
  if (!isWithinRoot(canonicalRoot, canonicalPath)) {
    throw new Error(
      `source ref "${sourcePath}" resolves outside the repo root through a symbolic link`,
    );
  }
  const sourceStat = await stat(canonicalPath);
  if (!sourceStat.isFile()) {
    throw new Error(`source ref "${sourcePath}" must resolve to a regular file`);
  }
  return canonicalPath;
}

function unsafeRepoPathReason(path: string): string | undefined {
  if (path.trim().length === 0) return 'source ref path must be non-empty';
  if (path.startsWith('/') || path.includes('\\'))
    return 'source ref path must be a repo-relative POSIX path';
  if (path === '.' || path === '..' || path.includes('../') || path.includes('/..'))
    return 'source ref path must not traverse outside the repo';
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
  return exportContentHash(value)
    .replace(/^sha256:/, '')
    .slice(0, 16);
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '') || '.';
}

async function writeStableJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function uniqueStrings(values: readonly (string | undefined)[]): string[] {
  return [
    ...new Set(
      values.filter((value): value is string => typeof value === 'string' && value.length > 0),
    ),
  ];
}

function recordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
