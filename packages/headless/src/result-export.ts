import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ResultRecord } from './contracts.js';
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
    diff: { status: 'present' | 'not_captured'; artifactRef?: string; path?: string; hash?: string };
  };
  verifier?: VerifierResult & { benchmark?: Record<string, unknown> };
  score?: ScoreResult;
  budget?: Record<string, unknown>;
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
      diff: diffMetadata(scoreDetails),
    },
    verifier: verifier
      ? {
          ...verifier,
          ...(benchmark ? { benchmark } : {}),
        }
      : undefined,
    score,
    budget: recordValue(scoreDetails.budget) ? scoreDetails.budget as Record<string, unknown> : undefined,
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
    `- submitted_snapshot: ${snapshotValue(exported.workspace.submittedSnapshot)}`,
    `- diff: ${exported.workspace.diff.status}`,
    '',
  ];
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
          benchmark: exported.verifier.benchmark,
        }
      : undefined,
    score: exported.score,
    workspace: exported.workspace,
    legacyResultRecord: exported.legacyResultRecord,
  };
}

function runtimeRefsFromFeedback(projection: TaskRunProjection): unknown {
  return projection.feedback.find((observation) => recordValue(observation.details?.runtimeRefs))?.details?.runtimeRefs;
}

function runtimeEventIdsFrom(runtimeRefs: unknown): string[] {
  if (!recordValue(runtimeRefs) || !Array.isArray(runtimeRefs.runtimeEventIds)) return [];
  return runtimeRefs.runtimeEventIds.filter((value): value is string => typeof value === 'string');
}

function submittedSnapshotRef(verifier: VerifierResult | undefined): Record<string, unknown> | undefined {
  return verifier?.submittedSnapshotId ? { id: verifier.submittedSnapshotId } : undefined;
}

function diffMetadata(details: Record<string, unknown>): TaskRunExport['workspace']['diff'] {
  const diff = details.diff;
  if (!recordValue(diff)) return { status: 'not_captured' };
  return {
    status: 'present',
    ...(typeof diff.artifactRef === 'string' ? { artifactRef: diff.artifactRef } : {}),
    ...(typeof diff.path === 'string' ? { path: diff.path } : {}),
    ...(typeof diff.hash === 'string' ? { hash: diff.hash } : {}),
  };
}

function verifierBenchmark(verifier: VerifierResult | undefined): Record<string, unknown> | undefined {
  if (!verifier?.details) return undefined;
  return verifier.details;
}

function eventsJsonl(events: readonly TaskEvent[]): string {
  const body = events.map((event) => JSON.stringify(event)).join('\n');
  return body.length > 0 ? `${body}\n` : '';
}

export function exportContentHash(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function scoreValue(score: ScoreResult | undefined): string {
  if (!score) return 'none';
  if (score.score !== undefined || score.maxScore !== undefined) return `${score.score ?? 'unknown'}/${score.maxScore ?? 'unknown'}`;
  return score.passed ? 'pass' : 'fail';
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

function recordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
