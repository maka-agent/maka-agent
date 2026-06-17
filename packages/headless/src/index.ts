// Public surface of @maka/headless. Deliberately curated — the workspace
// copy (sandbox.ts) and the verification runner (evaluator.ts) are internals
// the runner owns, not part of the API.
export type { Config, Task, TaskVerification, ResultRecord } from './contracts.js';
export { runExperiment, type RunExperimentDeps } from './runner.js';
export { runMatrix, type ExperimentSpec } from './matrix.js';
export { readResults, writeResults, toComparisonTable } from './results.js';
export { registerFakeBackend } from './backends.js';
