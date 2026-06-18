import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ResultRecord } from './contracts.js';
import type {
  AutonomousDecision,
  FeedbackObservation,
  ScoreResult,
  SelfCheckObservation,
  TaskAttempt,
  TaskEvent,
  TaskRun,
  TaskRunError,
  TaskRunResult,
  VerifierResult,
} from './task-contracts.js';

export interface TaskRunProjection extends TaskRun {
  events: TaskEvent[];
  attempts: TaskAttempt[];
  selfChecks: SelfCheckObservation[];
  feedback: FeedbackObservation[];
  decisions: AutonomousDecision[];
  verifierResults: VerifierResult[];
  scoreResults: ScoreResult[];
  warnings: string[];
  latestVerifierResult?: VerifierResult;
  latestScoreResult?: ScoreResult;
  sourceResultRecord?: ResultRecord;
}

export interface TaskRunStore {
  appendEvent(taskRunId: string, event: TaskEvent): Promise<void>;
  readEvents(taskRunId: string): Promise<TaskEvent[]>;
  project(taskRunId: string): Promise<TaskRunProjection>;
}

export function createInMemoryTaskRunStore(initialEvents: readonly TaskEvent[] = []): TaskRunStore {
  return new InMemoryTaskRunStore(initialEvents);
}

export function createTaskRunStore(storageRoot: string): TaskRunStore {
  return new FileTaskRunStore(storageRoot);
}

export function projectTaskRun(events: readonly TaskEvent[], taskRunId?: string): TaskRunProjection {
  const projectedTaskRunId = taskRunId ?? events[0]?.taskRunId ?? '';
  const projection: TaskRunProjection = {
    taskRunId: projectedTaskRunId,
    taskId: '',
    configId: '',
    status: 'queued',
    events: [],
    attempts: [],
    selfChecks: [],
    feedback: [],
    decisions: [],
    verifierResults: [],
    scoreResults: [],
    warnings: [],
  };
  const attempts = new Map<string, TaskAttempt>();
  let terminalEvents = 0;

  for (const event of events) {
    if (projectedTaskRunId && event.taskRunId !== projectedTaskRunId) {
      projection.warnings.push(`ignored event ${event.id}: taskRunId ${event.taskRunId} does not match ${projectedTaskRunId}`);
      continue;
    }
    projection.events.push(event);

    switch (event.type) {
      case 'task_run_created':
        projection.taskId = event.taskId;
        projection.configId = event.configId;
        projection.status = 'created';
        projection.sourceResultRecord = event.sourceResultRecord;
        break;
      case 'task_run_queued':
        projection.taskId = event.taskId;
        projection.configId = event.configId;
        projection.status = 'queued';
        break;
      case 'task_run_started':
        projection.status = 'running';
        projection.startedAt = event.startedAt ?? event.ts;
        setOptionalRefs(projection, event.sessionId, event.agentRunId);
        break;
      case 'task_run_verifying':
        projection.status = 'verifying';
        break;
      case 'task_attempt_started': {
        const attempt: TaskAttempt = {
          attemptId: event.attemptId,
          taskRunId: event.taskRunId,
          startedAt: event.startedAt ?? event.ts,
          status: 'running',
          ...(event.sessionId ? { sessionId: event.sessionId } : {}),
          ...(event.agentRunId ? { agentRunId: event.agentRunId } : {}),
        };
        attempts.set(event.attemptId, attempt);
        setOptionalRefs(projection, event.sessionId, event.agentRunId);
        break;
      }
      case 'self_check_observed':
        projection.selfChecks.push(event.observation);
        break;
      case 'feedback_observed':
        projection.feedback.push(event.observation);
        break;
      case 'autonomous_decision_recorded':
        projection.decisions.push(event.decision);
        break;
      case 'verifier_result_recorded':
        projection.verifierResults.push(event.result);
        projection.latestVerifierResult = event.result;
        break;
      case 'score_result_recorded':
        projection.scoreResults.push(event.result);
        projection.latestScoreResult = event.result;
        projection.result = resultFromScore(event.result, projection.latestVerifierResult);
        break;
      case 'task_attempt_completed':
        attempts.set(event.attemptId, {
          ...(attempts.get(event.attemptId) ?? {
            attemptId: event.attemptId,
            taskRunId: event.taskRunId,
            startedAt: event.ts,
          }),
          status: event.status,
          finishedAt: event.finishedAt ?? event.ts,
          ...(event.error ? { error: event.error } : {}),
        });
        break;
      case 'task_run_completed':
        terminalEvents = applyTerminalEvent(projection, terminalEvents);
        projection.status = 'completed';
        projection.finishedAt = event.finishedAt ?? event.ts;
        projection.result = event.result ?? projection.result ?? resultFromScore(projection.latestScoreResult, projection.latestVerifierResult);
        break;
      case 'task_run_failed':
        terminalEvents = applyTerminalEvent(projection, terminalEvents);
        projection.status = 'failed';
        projection.finishedAt = event.finishedAt ?? event.ts;
        projection.error = event.error;
        break;
      case 'task_run_incomplete':
        terminalEvents = applyTerminalEvent(projection, terminalEvents);
        projection.status = 'incomplete';
        projection.finishedAt = event.finishedAt ?? event.ts;
        projection.error = event.error ?? { message: 'task run incomplete', class: 'agent_incomplete' };
        break;
      case 'task_run_blocked':
        terminalEvents = applyTerminalEvent(projection, terminalEvents);
        projection.status = 'blocked';
        projection.finishedAt = event.finishedAt ?? event.ts;
        projection.error = event.error ?? { message: 'task run blocked', class: 'blocked' };
        break;
      case 'task_run_policy_denied':
        terminalEvents = applyTerminalEvent(projection, terminalEvents);
        projection.status = 'policy_denied';
        projection.finishedAt = event.finishedAt ?? event.ts;
        projection.error = event.error ?? { message: 'task run denied by policy', class: 'policy_denied' };
        break;
      case 'task_run_budget_exhausted':
        terminalEvents = applyTerminalEvent(projection, terminalEvents);
        projection.status = 'budget_exhausted';
        projection.finishedAt = event.finishedAt ?? event.ts;
        projection.error = event.error ?? { message: 'task run budget exhausted', class: 'budget_exhausted' };
        break;
      case 'task_run_aborted':
        terminalEvents = applyTerminalEvent(projection, terminalEvents);
        projection.status = 'aborted';
        projection.finishedAt = event.finishedAt ?? event.ts;
        projection.error = event.error ?? { message: 'task run aborted', class: 'aborted' };
        break;
      case 'task_run_cancelled':
        terminalEvents = applyTerminalEvent(projection, terminalEvents);
        projection.status = 'cancelled';
        projection.finishedAt = event.finishedAt ?? event.ts;
        projection.error = event.error ?? { message: 'task run cancelled', class: 'cancelled' };
        break;
      case 'event_corrupt':
        projection.warnings.push(`corrupt event ${event.id}: ${event.error}`);
        break;
    }
  }

  projection.attempts = [...attempts.values()];
  return projection;
}

class InMemoryTaskRunStore implements TaskRunStore {
  private readonly events = new Map<string, TaskEvent[]>();
  private readonly queues = new Map<string, Promise<void>>();

  constructor(initialEvents: readonly TaskEvent[]) {
    for (const event of initialEvents) {
      const events = this.events.get(event.taskRunId) ?? [];
      events.push(event);
      this.events.set(event.taskRunId, events);
    }
  }

  async appendEvent(taskRunId: string, event: TaskEvent): Promise<void> {
    if (event.taskRunId !== taskRunId) {
      throw new Error(`taskRunId mismatch: append target ${taskRunId}, event ${event.taskRunId}`);
    }

    const previous = this.queues.get(taskRunId) ?? Promise.resolve();
    const next = previous.then(() => {
      const events = this.events.get(taskRunId) ?? [];
      events.push(event);
      this.events.set(taskRunId, events);
    });
    this.queues.set(taskRunId, next.catch(() => undefined));
    await next;
  }

  async readEvents(taskRunId: string): Promise<TaskEvent[]> {
    return [...(this.events.get(taskRunId) ?? [])];
  }

  async project(taskRunId: string): Promise<TaskRunProjection> {
    return projectTaskRun(await this.readEvents(taskRunId), taskRunId);
  }
}

class FileTaskRunStore implements TaskRunStore {
  private readonly queues = new Map<string, Promise<void>>();

  constructor(private readonly storageRoot: string) {}

  async appendEvent(taskRunId: string, event: TaskEvent): Promise<void> {
    if (event.taskRunId !== taskRunId) {
      throw new Error(`taskRunId mismatch: append target ${taskRunId}, event ${event.taskRunId}`);
    }

    const previous = this.queues.get(taskRunId) ?? Promise.resolve();
    const next = previous.then(async () => {
      await mkdir(this.taskRunDir(), { recursive: true });
      await appendFile(this.taskRunPath(taskRunId), `${JSON.stringify(event)}\n`, 'utf8');
    });
    this.queues.set(taskRunId, next.catch(() => undefined));
    await next;
  }

  async readEvents(taskRunId: string): Promise<TaskEvent[]> {
    let content: string;
    try {
      content = await readFile(this.taskRunPath(taskRunId), 'utf8');
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }

    const lines = content.endsWith('\n') ? content.split('\n') : content.split('\n').slice(0, -1);
    const events: TaskEvent[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line) continue;
      try {
        events.push(JSON.parse(line) as TaskEvent);
      } catch (error) {
        events.push({
          type: 'event_corrupt',
          id: `corrupt-${i + 1}`,
          taskRunId,
          ts: 0,
          raw: line,
          error: errorMessage(error),
        });
      }
    }
    return events;
  }

  async project(taskRunId: string): Promise<TaskRunProjection> {
    return projectTaskRun(await this.readEvents(taskRunId), taskRunId);
  }

  private taskRunDir(): string {
    return join(this.storageRoot, 'task-runs');
  }

  private taskRunPath(taskRunId: string): string {
    return join(this.taskRunDir(), `${safeFileId(taskRunId)}.jsonl`);
  }
}

function setOptionalRefs(projection: TaskRunProjection, sessionId: string | undefined, agentRunId: string | undefined): void {
  if (sessionId) projection.sessionId = sessionId;
  if (agentRunId) projection.agentRunId = agentRunId;
}

function resultFromScore(score: ScoreResult | undefined, verifier: VerifierResult | undefined): TaskRunResult | undefined {
  if (!score) return undefined;
  return {
    passed: score.passed,
    taxonomy: score.taxonomy,
    ...(verifier ? { verifierResultId: verifier.id } : {}),
    scoreResultId: score.id,
  };
}

function applyTerminalEvent(projection: TaskRunProjection, terminalEvents: number): number {
  if (terminalEvents > 0) {
    projection.warnings.push('multiple terminal task run events observed; last terminal event wins');
  }
  return terminalEvents + 1;
}

function safeFileId(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_') || '_';
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
