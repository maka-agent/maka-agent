import type { Config, ResultRecord, Task } from './contracts.js';
import { runExperiment, type RunExperimentDeps } from './runner.js';

/** An experiment is the cross product of Configs and Tasks. */
export interface ExperimentSpec {
  configs: Config[];
  tasks: Task[];
}

/**
 * Run every `Config × Task` and collect a ResultRecord each. Sequential
 * in the MVP — each run owns a throwaway workspace and a fresh
 * SessionManager, so ordering is the only thing we trade away;
 * parallelism is a later, purely additive knob.
 *
 * A single run that throws is recorded as a failed ResultRecord rather
 * than aborting the whole matrix, so one bad cell never loses the rest.
 */
export async function runMatrix(
  spec: ExperimentSpec,
  deps: RunExperimentDeps,
  onResult?: (record: ResultRecord) => void,
): Promise<ResultRecord[]> {
  const records: ResultRecord[] = [];
  for (const task of spec.tasks) {
    for (const config of spec.configs) {
      const record = await runExperiment(config, task, deps).catch(
        (error): ResultRecord => failedRecord(config, task, error),
      );
      records.push(record);
      onResult?.(record);
    }
  }
  return records;
}

function failedRecord(config: Config, task: Task, error: unknown): ResultRecord {
  const now = Date.now();
  return {
    taskId: task.id,
    configId: config.id,
    sessionId: '',
    runId: '',
    status: 'failed',
    passed: false,
    exitCode: null,
    steps: 0,
    durationMs: 0,
    startedAt: now,
    finishedAt: now,
    error: error instanceof Error ? error.message : String(error),
  };
}
