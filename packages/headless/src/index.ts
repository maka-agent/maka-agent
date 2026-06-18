// Public surface of @maka/headless. Deliberately curated — the workspace copy
// (sandbox.ts), the verification runner (evaluator.ts), and the backend wiring
// (backends.ts) are internals the runner owns, not part of the API. Minimal
// usage is `runExperiment(config, task, { storageRoot })`.
export type { Config, Task, TaskVerification, ResultRecord } from './contracts.js';
export type {
  AutonomousDecision,
  AutonomousResultTaxonomy,
  FeedbackObservation,
  ResultTaxonomy,
  ScoreResult,
  SelfCheckObservation,
  TaskAttempt,
  TaskAttemptStatus,
  TaskDefinition,
  TaskEvent,
  TaskEventCorrupt,
  TaskRunAbortedEvent,
  TaskRunBlockedEvent,
  TaskRunBudgetExhaustedEvent,
  TaskRunCancelledEvent,
  TaskRunCompletedEvent,
  TaskRunCreatedEvent,
  TaskRunFailedEvent,
  TaskRunIncompleteEvent,
  TaskRunPolicyDeniedEvent,
  TaskRunQueuedEvent,
  TaskRunStartedEvent,
  TaskRunVerifyingEvent,
  TaskRun,
  TaskRunError,
  TaskRunResult,
  TaskRunStatus,
  VerifierResult,
} from './task-contracts.js';
export {
  TASK_RUN_TERMINAL_STATUSES,
  isFailureTaxonomy,
  isTerminalTaskRunStatus,
  taxonomyFromResultRecord,
} from './task-contracts.js';
export type { TaskRunProjection, TaskRunStore } from './task-run-store.js';
export { createInMemoryTaskRunStore, createTaskRunStore, projectTaskRun } from './task-run-store.js';
export type { TaskEventsFromResultRecordOptions } from './task-run-adapter.js';
export {
  resultRecordFromTaskRunProjection,
  taskDefinitionFromTask,
  taskEventsFromResultRecord,
} from './task-run-adapter.js';
export type { RunTaskOnceDeps, RunTaskOnceResult } from './task-agent-controller.js';
export { runTaskOnce, TaskAgentController } from './task-agent-controller.js';
export { runExperiment, type RunExperimentDeps } from './runner.js';
export { runMatrix, type ExperimentSpec } from './matrix.js';
export { readResults, writeResults, toComparisonTable } from './results.js';
export type {
  HeadlessBackendContext,
  IsolatedCommandInput,
  IsolatedCommandResult,
  IsolatedToolExecutor,
  RealBackendIsolation,
} from './isolation.js';
export { buildIsolatedBashTool, buildIsolatedHeadlessTools } from './tools.js';
