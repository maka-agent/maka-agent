// Public surface of @maka/headless. Deliberately curated — the workspace copy
// (sandbox.ts), the verification runner (evaluator.ts), and the backend wiring
// (backends.ts) are internals the runner owns, not part of the API. Minimal
// usage is `runExperiment(config, task, { storageRoot })`.
export type { Config, Task, TaskVerification, ResultRecord } from './contracts.js';
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
