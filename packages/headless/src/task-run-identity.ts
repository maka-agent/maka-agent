import { createHash } from 'node:crypto';

const TASK_RUN_LOCATOR_PATTERN = /^[0-9a-f]{64}$/;

export function taskRunLocator(taskRunId: string): string {
  if (taskRunId.length === 0) {
    throw new Error('taskRunId must not be empty');
  }
  try {
    encodeURIComponent(taskRunId);
  } catch {
    throw new Error('taskRunId must be well-formed Unicode');
  }
  return createHash('sha256').update(taskRunId, 'utf8').digest('hex');
}

export function isTaskRunLocator(value: string): boolean {
  return TASK_RUN_LOCATOR_PATTERN.test(value);
}
