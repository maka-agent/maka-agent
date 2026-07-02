import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ResultRecord } from './contracts.js';
import { isAcceptedHeavyTaskSelfCheck } from './heavy-task-self-check.js';
import {
  isTerminalTaskRunStatus,
  type AutonomousResultTaxonomy,
  type ScoreResult,
  type TaskEvent,
  type VerifierResult,
} from './task-contracts.js';
import { resultRecordFromTaskRunProjection } from './task-run-adapter.js';
import type { TaskRunProjection } from './task-run-store.js';

export interface TaskRunExport {
  schemaVersion: 'maka.task_run_export.v1';
  exportedAt: string;
  taskRun: {
    taskRunId: string;
    taskId: string;
    configId: string;
    status: TaskRunProjection['status'];
    startedAt?: number;
    finishedAt?: number;
    result?: TaskRunProjection['result'];
    error?: TaskRunProjection['error'];
  };
  runtime: {
    sessionId?: string;
    agentRunId?: string;
    attempts: TaskRunProjection['attempts'];
    runtimeRefs?: unknown;
    trajectoryRefs: {
      sessionId?: string;
      agentRunId?: string;
      runtimeEventIds?: string[];
    };
  };
  workspace: {
    lease?: TaskRunProjection['workspaceLease'];
    submittedSnapshot?: unknown;
    primaryWorkspacePath?: string;
    diff: { status: 'present' | 'not_captured'; artifactRef?: string; path?: string; hash?: string };
  };
  artifacts: {
    primaryWorkspacePath?: string;
    items: TaskRunProjection['artifacts'];
    byKind: Record<string, TaskRunProjection['artifacts']>;
  };
  verifier?: VerifierResult & { benchmark?: Record<string, unknown> };
  score?: ScoreResult;
  budget?: Record<string, unknown>;
  economy?: {
    tokens?: Record<string, unknown>;
    tools?: Record<string, unknown>;
  };
  policy?: {
    heavyTask?: TaskRunProjection['heavyTaskMode'];
    economyTask?: TaskRunProjection['economyTaskMode'];
  };
  heavyTask?: {
    mode?: TaskRunProjection['heavyTaskMode'];
    completion: NonNullable<TaskRunProjection['heavyTaskCompletion']>;
    selfCheckGate?: NonNullable<TaskRunProjection['latestHeavyTaskSelfCheckGate']>;
  };
  progress?: {
    inventory?: {
      latest: NonNullable<TaskRunProjection['latestHeavyTaskInventory']>;
      historyCount: number;
    };
    todos?: {
      latest: NonNullable<TaskRunProjection['latestHeavyTaskTodos']>;
      historyCount: number;
    };
    selfChecks?: {
      latest: NonNullable<TaskRunProjection['latestHeavyTaskSelfCheck']>;
      historyCount: number;
    };
    selfCheckGates?: {
      latest: NonNullable<TaskRunProjection['latestHeavyTaskSelfCheckGate']>;
      historyCount: number;
    };
    evidence?: {
      latest: NonNullable<TaskRunProjection['latestHeavyTaskEvidence']>;
      recent: TaskRunProjection['heavyTaskEvidence'];
      historyCount: number;
    };
  };
  isolation: {
    policy?: TaskRunProjection['isolation'];
    toolExecutors: TaskRunProjection['toolExecutors'];
    permissions: {
      requests: TaskRunProjection['permissionRequests'];
      grants: TaskRunProjection['permissionGrants'];
    };
  };
  inbox: {
    parked?: TaskRunProjection['parked'];
    items: TaskRunProjection['inboxItems'];
  };
  taxonomy: {
    value: AutonomousResultTaxonomy | string;
    passed: boolean;
    scored?: boolean;
    eligible?: boolean;
    errorClass?: string;
    excludedReason?: string;
  };
  warnings: string[];
  legacyResultRecord: ResultRecord;
}

export interface WriteTaskRunExportOptions {
  includeEvents?: boolean;
  exportedAt?: string;
}

export interface WriteTaskRunExportResult {
  export: TaskRunExport;
  files: {
    taskRunJson: string;
    resultJson: string;
    resultMd: string;
    eventsJsonl?: string;
  };
}

export async function writeTaskRunExport(
  outDir: string,
  projection: TaskRunProjection,
  options: WriteTaskRunExportOptions = {},
): Promise<WriteTaskRunExportResult> {
  await mkdir(outDir, { recursive: true });
  const rendered = taskRunExportFromProjection(projection, { exportedAt: options.exportedAt });
  const files: WriteTaskRunExportResult['files'] = {
    taskRunJson: join(outDir, 'task-run.json'),
    resultJson: join(outDir, 'result.json'),
    resultMd: join(outDir, 'result.md'),
  };
  await writeFile(files.taskRunJson, `${JSON.stringify(rendered, null, 2)}\n`, 'utf8');
  await writeFile(files.resultJson, `${JSON.stringify(compactResultView(rendered), null, 2)}\n`, 'utf8');
  await writeFile(files.resultMd, renderTaskRunMarkdown(rendered), 'utf8');
  if (options.includeEvents) {
    files.eventsJsonl = join(outDir, 'events.jsonl');
    await writeFile(files.eventsJsonl, eventsJsonl(projection.events), 'utf8');
  }
  return { export: rendered, files };
}

export function taskRunExportFromProjection(
  projection: TaskRunProjection,
  options: { exportedAt?: string } = {},
): TaskRunExport {
  const legacyResultRecord = resultRecordFromTaskRunProjection(projection);
  const score = projection.latestScoreResult;
  const verifier = projection.latestVerifierResult;
  const scoreDetails = score?.details ?? {};
  const runtimeRefs = scoreDetails.runtimeRefs ?? runtimeRefsFromFeedback(projection);
  const runtimeEventIds = runtimeEventIdsFrom(runtimeRefs);
  const benchmark = verifierBenchmark(verifier);
  const taxonomy = score?.taxonomy ?? projection.result?.taxonomy ?? legacyResultRecord.errorClass ?? projection.status;
  const primaryWorkspacePath = primaryWorkspacePathFromArtifacts(projection.artifacts);
  const policy = policyFromProjection(projection);
  const heavyTask = projection.heavyTaskCompletion
    ? {
        mode: projection.heavyTaskMode,
        completion: projection.heavyTaskCompletion,
        ...(projection.latestHeavyTaskSelfCheckGate ? { selfCheckGate: projection.latestHeavyTaskSelfCheckGate } : {}),
      }
    : undefined;
  const progress = progressFromProjection(projection);

  return {
    schemaVersion: 'maka.task_run_export.v1',
    exportedAt: options.exportedAt ?? new Date().toISOString(),
    taskRun: {
      taskRunId: projection.taskRunId,
      taskId: projection.taskId,
      configId: projection.configId,
      status: projection.status,
      startedAt: projection.startedAt,
      finishedAt: projection.finishedAt,
      result: projection.result,
      error: projection.error,
    },
    runtime: {
      sessionId: projection.sessionId,
      agentRunId: projection.agentRunId,
      attempts: projection.attempts,
      runtimeRefs,
      trajectoryRefs: {
        sessionId: projection.sessionId,
        agentRunId: projection.agentRunId,
        ...(runtimeEventIds.length > 0 ? { runtimeEventIds } : {}),
      },
    },
    workspace: {
      lease: projection.workspaceLease,
      submittedSnapshot: scoreDetails.submittedSnapshot ?? submittedSnapshotRef(verifier),
      ...(primaryWorkspacePath ? { primaryWorkspacePath } : {}),
      diff: diffMetadata(scoreDetails, projection.artifacts),
    },
    artifacts: {
      ...(primaryWorkspacePath ? { primaryWorkspacePath } : {}),
      items: projection.artifacts,
      byKind: artifactsByKind(projection.artifacts),
    },
    verifier: verifier
      ? {
          ...verifier,
          ...(benchmark ? { benchmark } : {}),
        }
      : undefined,
    score,
    budget: recordValue(scoreDetails.budget) ? scoreDetails.budget as Record<string, unknown> : undefined,
    economy: economyFromDetails(scoreDetails),
    policy,
    heavyTask,
    progress,
    isolation: {
      policy: projection.isolation,
      toolExecutors: projection.toolExecutors,
      permissions: {
        requests: projection.permissionRequests,
        grants: projection.permissionGrants,
      },
    },
    inbox: {
      parked: projection.parked,
      items: projection.inboxItems,
    },
    taxonomy: {
      value: taxonomy,
      passed: score?.passed ?? projection.result?.passed ?? legacyResultRecord.passed,
      scored: score?.scored ?? legacyResultRecord.scored,
      eligible: score?.eligible ?? legacyResultRecord.eligible,
      errorClass: score?.errorClass ?? verifier?.errorClass ?? projection.error?.class ?? legacyResultRecord.errorClass,
      excludedReason: score?.excludedReason ?? legacyResultRecord.excludedReason,
    },
    warnings: projection.warnings,
    legacyResultRecord,
  };
}

export function renderTaskRunMarkdown(exported: TaskRunExport): string {
  const score = exported.score;
  const verifier = exported.verifier;
  const lines = [
    `# Task Run ${md(exported.taskRun.taskRunId)}`,
    '',
    `- task: ${md(exported.taskRun.taskId)}`,
    `- config: ${md(exported.taskRun.configId)}`,
    `- status: ${md(exported.taskRun.status)}`,
    `- taxonomy: ${md(String(exported.taxonomy.value))}`,
    `- passed: ${exported.taxonomy.passed ? 'true' : 'false'}`,
    `- scored: ${score?.scored === undefined ? 'unknown' : String(score.scored)}`,
    `- eligible: ${score?.eligible === undefined ? 'unknown' : String(score.eligible)}`,
    `- verifier: ${verifier ? md(verifier.kind) : 'none'}`,
    `- verifier_exit_code: ${verifier?.exitCode ?? 'null'}`,
    `- score: ${scoreValue(score)}`,
    `- verifier_authority: ${authorityValue(verifier?.authority)}`,
    `- submitted_snapshot: ${snapshotValue(exported.workspace.submittedSnapshot)}`,
    `- diff: ${exported.workspace.diff.status}`,
    `- artifacts: ${exported.artifacts.items.length}`,
    `- tool_calls: ${exported.economy?.tools?.actualToolCalls ?? 'unknown'}`,
    `- tokens: ${exported.economy?.tokens?.total ?? 'unknown'}`,
    '',
  ];
  if (exported.artifacts.items.length > 0) {
    lines.push(
      '## artifacts',
      '',
      ...exported.artifacts.items.map((artifact) => `- ${md(artifact.kind)} ${md(artifact.workspacePath ?? artifact.path ?? artifact.artifactRef ?? artifact.artifactId)}`),
      '',
    );
  }
  if (verifier?.stdout) {
    lines.push('## verifier_stdout', '', fence(verifier.stdout), '');
  }
  if (verifier?.stderr) {
    lines.push('## verifier_stderr', '', fence(verifier.stderr), '');
  }
  if (exported.warnings.length > 0) {
    lines.push('## warnings', '', ...exported.warnings.map((warning) => `- ${md(warning)}`), '');
  }
  return `${lines.join('\n')}\n`;
}

function compactResultView(exported: TaskRunExport): Record<string, unknown> {
  return {
    schemaVersion: exported.schemaVersion,
    taskRun: exported.taskRun,
    taxonomy: exported.taxonomy,
    verifier: exported.verifier
      ? {
          id: exported.verifier.id,
          kind: exported.verifier.kind,
          passed: exported.verifier.passed,
          exitCode: exported.verifier.exitCode ?? null,
          errorClass: exported.verifier.errorClass,
          authority: exported.verifier.authority,
          benchmark: exported.verifier.benchmark,
        }
      : undefined,
    score: exported.score,
    economy: exported.economy,
    policy: exported.policy,
    heavyTask: exported.heavyTask,
    progress: exported.progress,
    workspace: exported.workspace,
    artifacts: exported.artifacts,
    legacyResultRecord: exported.legacyResultRecord,
  };
}

function runtimeRefsFromFeedback(projection: TaskRunProjection): unknown {
  return projection.feedback.find((observation) => recordValue(observation.details?.runtimeRefs))?.details?.runtimeRefs;
}

function progressFromProjection(projection: TaskRunProjection): TaskRunExport['progress'] {
  const progress: NonNullable<TaskRunExport['progress']> = {};
  if (projection.latestHeavyTaskInventory) {
    progress.inventory = {
      latest: projection.latestHeavyTaskInventory,
      historyCount: projection.heavyTaskInventory.length,
    };
  }
  if (projection.latestHeavyTaskTodos) {
    progress.todos = {
      latest: projection.latestHeavyTaskTodos,
      historyCount: projection.heavyTaskTodoStates.length,
    };
  }
  if (projection.latestHeavyTaskSelfCheck) {
    progress.selfChecks = {
      latest: projection.latestHeavyTaskSelfCheck,
      historyCount: projection.heavyTaskSelfChecks.length,
    };
  }
  if (projection.latestHeavyTaskSelfCheckGate) {
    progress.selfCheckGates = {
      latest: projection.latestHeavyTaskSelfCheckGate,
      historyCount: projection.heavyTaskSelfCheckGates.length,
    };
  }
  if (projection.latestHeavyTaskEvidence) {
    progress.evidence = {
      latest: projection.latestHeavyTaskEvidence,
      recent: projection.heavyTaskEvidence.slice(-25),
      historyCount: projection.heavyTaskEvidence.length,
    };
  }
  return progress.inventory || progress.todos || progress.selfChecks || progress.selfCheckGates || progress.evidence ? progress : undefined;
}

function runtimeEventIdsFrom(runtimeRefs: unknown): string[] {
  if (!recordValue(runtimeRefs) || !Array.isArray(runtimeRefs.runtimeEventIds)) return [];
  return runtimeRefs.runtimeEventIds.filter((value): value is string => typeof value === 'string');
}

function submittedSnapshotRef(verifier: VerifierResult | undefined): Record<string, unknown> | undefined {
  return verifier?.submittedSnapshotId ? { id: verifier.submittedSnapshotId } : undefined;
}

function diffMetadata(
  details: Record<string, unknown>,
  artifacts: TaskRunProjection['artifacts'],
): TaskRunExport['workspace']['diff'] {
  const diff = details.diff;
  if (!recordValue(diff)) {
    const artifact = artifacts.find((item) => item.kind === 'workspace_diff');
    if (!artifact) return { status: 'not_captured' };
    return {
      status: 'present',
      ...(artifact.artifactRef ? { artifactRef: artifact.artifactRef } : {}),
      ...(artifact.path ? { path: artifact.path } : {}),
      ...(artifact.hash ? { hash: artifact.hash } : {}),
    };
  }
  return {
    status: 'present',
    ...(typeof diff.artifactRef === 'string' ? { artifactRef: diff.artifactRef } : {}),
    ...(typeof diff.path === 'string' ? { path: diff.path } : {}),
    ...(typeof diff.hash === 'string' ? { hash: diff.hash } : {}),
  };
}

function primaryWorkspacePathFromArtifacts(artifacts: TaskRunProjection['artifacts']): string | undefined {
  return artifacts.find((artifact) => artifact.kind === 'container_workspace' && artifact.workspacePath)?.workspacePath;
}

function artifactsByKind(artifacts: TaskRunProjection['artifacts']): Record<string, TaskRunProjection['artifacts']> {
  const grouped: Record<string, TaskRunProjection['artifacts']> = {};
  for (const artifact of artifacts) {
    grouped[artifact.kind] = [...(grouped[artifact.kind] ?? []), artifact];
  }
  return grouped;
}

function verifierBenchmark(verifier: VerifierResult | undefined): Record<string, unknown> | undefined {
  if (!verifier?.details) return undefined;
  return verifier.details;
}

function eventsJsonl(events: readonly TaskEvent[]): string {
  const body = events.flatMap(exportableTaskEvents).map((event) => JSON.stringify(event)).join('\n');
  return body.length > 0 ? `${body}\n` : '';
}

export function exportableTaskEvents(event: TaskEvent): TaskEvent[] {
  if (event.type === 'heavy_task_self_check_recorded') {
    return isAcceptedHeavyTaskSelfCheck(event.selfCheck) ? [event] : [];
  }
  if (event.type === 'heavy_task_evidence_recorded') {
    return event.evidence.public === true ? [event] : [];
  }
  return [event];
}

export function exportContentHash(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function scoreValue(score: ScoreResult | undefined): string {
  if (!score) return 'none';
  if (score.score !== undefined || score.maxScore !== undefined) return `${score.score ?? 'unknown'}/${score.maxScore ?? 'unknown'}`;
  return score.passed ? 'pass' : 'fail';
}

function authorityValue(authority: VerifierResult['authority']): string {
  if (!authority) return 'none';
  return `${authority.source} authoritative=${authority.authoritative ? 'true' : 'false'}`;
}

function snapshotValue(value: unknown): string {
  if (!recordValue(value)) return 'none';
  return typeof value.id === 'string' ? value.id : exportContentHash(value);
}

function fence(value: string): string {
  return `\`\`\`\n${value.replace(/```/g, '``\\`')}\n\`\`\``;
}

function md(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function economyFromDetails(scoreDetails: Record<string, unknown>): TaskRunExport['economy'] {
  const budget = recordValue(scoreDetails.budget) ? scoreDetails.budget : undefined;
  const tools = recordValue(scoreDetails.tools) ? scoreDetails.tools : undefined;
  if (!budget && !tools) return undefined;
  return {
    ...(recordValue(budget) && recordValue(budget.totals) ? { tokens: budget.totals as Record<string, unknown> } : {}),
    ...(tools ? { tools } : {}),
  };
}

function policyFromProjection(projection: TaskRunProjection): TaskRunExport['policy'] {
  const policy: NonNullable<TaskRunExport['policy']> = {};
  if (projection.heavyTaskMode?.enabled) {
    policy.heavyTask = projection.heavyTaskMode;
  }
  if (projection.economyTaskMode?.enabled) {
    policy.economyTask = projection.economyTaskMode;
  }
  return Object.keys(policy).length > 0 ? policy : undefined;
}

function recordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
