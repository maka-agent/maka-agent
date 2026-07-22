import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { StorageRootAuthorityError } from '@maka/storage/root-authority';
import type { Config, ResultRecord, Task } from './contracts.js';
import { openHeadlessStorageForRead, type HeadlessStorageReader } from './headless-storage.js';
import { readResults } from './results.js';
import {
  isTerminalTaskRunStatus,
  taxonomyFromResultRecord,
  type AutonomousResultTaxonomy,
} from './task-contracts.js';
import { resultRecordFromTaskRunProjection } from './task-run-adapter.js';

export const MATRIX_CELL_SEPARATOR = '\u0000';

export interface MatrixCellDecision {
  task: Task;
  config: Config;
  key: string;
  prior?: ResultRecord;
  taxonomy?: AutonomousResultTaxonomy;
  action: 'run' | 'skip' | 'retry';
  reason: string;
}

export interface MatrixRetryPlanOptions {
  retryFailed?: boolean;
  onlyTaxonomy?: readonly string[];
}

export function matrixCellKey(taskId: string, configId: string): string {
  return `${taskId}${MATRIX_CELL_SEPARATOR}${configId}`;
}

export function planMatrixRetry(
  tasks: readonly Task[],
  configs: readonly Config[],
  priorRecords: readonly ResultRecord[],
  options: MatrixRetryPlanOptions = {},
): MatrixCellDecision[] {
  const latest = latestRecordsByCell(priorRecords);
  const only = options.onlyTaxonomy ? new Set(options.onlyTaxonomy) : undefined;
  const decisions: MatrixCellDecision[] = [];
  for (const task of tasks) {
    for (const config of configs) {
      const key = matrixCellKey(task.id, config.id);
      const prior = latest.get(key);
      if (!prior) {
        decisions.push({ task, config, key, action: 'run', reason: 'no prior result' });
        continue;
      }
      const taxonomy = taxonomyFromResultRecord(prior);
      if (only && !only.has(taxonomy)) {
        decisions.push({
          task,
          config,
          key,
          prior,
          taxonomy,
          action: 'skip',
          reason: `taxonomy ${taxonomy} not selected`,
        });
        continue;
      }
      if (prior.passed) {
        decisions.push({
          task,
          config,
          key,
          prior,
          taxonomy,
          action: 'skip',
          reason: 'already passed',
        });
        continue;
      }
      if (
        !options.retryFailed &&
        prior.status === 'completed' &&
        prior.scored !== false &&
        prior.eligible !== false
      ) {
        decisions.push({
          task,
          config,
          key,
          prior,
          taxonomy,
          action: 'skip',
          reason: 'completed benchmark result already recorded',
        });
        continue;
      }
      if (isRetryableTaxonomy(taxonomy)) {
        decisions.push({
          task,
          config,
          key,
          prior,
          taxonomy,
          action: 'retry',
          reason: `retryable taxonomy ${taxonomy}`,
        });
      } else {
        decisions.push({
          task,
          config,
          key,
          prior,
          taxonomy,
          action: 'skip',
          reason: `non-retryable taxonomy ${taxonomy}`,
        });
      }
    }
  }
  return decisions;
}

export function isRetryableTaxonomy(taxonomy: AutonomousResultTaxonomy): boolean {
  return (
    taxonomy === 'verification_failed' ||
    taxonomy === 'verification_error' ||
    taxonomy === 'agent_failed' ||
    taxonomy === 'agent_incomplete' ||
    taxonomy === 'budget_exhausted'
  );
}

export async function readMatrixPriorRecords(inputPath: string): Promise<ResultRecord[]> {
  const stats = await stat(inputPath);
  if (!stats.isDirectory()) return readResults(inputPath);

  const resultsPath = join(inputPath, 'results.jsonl');
  try {
    return await readResults(resultsPath);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }

  return readTaskRunStoreRecords(join(inputPath, 'runs'));
}

export async function readTaskRunStoreRecords(storageRoot: string): Promise<ResultRecord[]> {
  let storage: HeadlessStorageReader;
  try {
    storage = await openHeadlessStorageForRead(storageRoot);
  } catch (error) {
    if (error instanceof StorageRootAuthorityError && error.code === 'root_not_found') return [];
    throw error;
  }
  const { taskRunStore } = storage;
  const records: ResultRecord[] = [];
  for (const taskRunId of await taskRunStore.listTaskRunIds()) {
    const projection = await taskRunStore.project(taskRunId);
    if (!isTerminalTaskRunStatus(projection.status) && projection.status !== 'needs_approval')
      continue;
    records.push(resultRecordFromTaskRunProjection(projection));
  }
  return records;
}

function latestRecordsByCell(records: readonly ResultRecord[]): Map<string, ResultRecord> {
  const latest = new Map<string, ResultRecord>();
  for (const record of records) {
    latest.set(matrixCellKey(record.taskId, record.configId), record);
  }
  return latest;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT'
  );
}
