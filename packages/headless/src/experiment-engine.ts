/**
 * Shared run-root scaffold for the Harbor A/B experiment scripts
 * (`run-prompt-ab`, `run-runtime-policy-ab`, `run-harness-ab`). Every one of
 * those `main()` bodies hand-rolled the same sequence: create the standard
 * `controller` / `jobs` / `prompts` directories, materialize the prompt files,
 * run the comparison, then persist the result/report artifacts. `runExperiment`
 * owns exactly that scaffold and nothing else.
 *
 * The engine deliberately does NOT own manifest construction, resume-manifest
 * ensuring, fingerprinting, task-runner creation, or the console summary: those
 * differ per experiment (and their placement is contract-pinned in the scripts),
 * so the caller performs them and passes the experiment-specific pieces in as
 * the config's `prompts` / `run` / `artifacts` callbacks. Harness-only extras
 * (its run lock, background journal, Oracle evidence, and CSV report) stay in
 * the caller too — the CSV is just one more entry in `artifacts`, and the lock
 * and journal wrap the caller's own manifest build, which happens before the
 * scaffold runs.
 *
 * The real comparison engines already exist and are tested
 * (`runAbComparison`, `runFixedPromptController`, `buildAbRunManifest`); this
 * module is only the thin orchestration shell around them.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** The standard directory layout materialized under an experiment's run root. */
export interface ExperimentRunLayout {
  runRoot: string;
  controllerDir: string;
  jobsDir: string;
  promptsDir: string;
  /** Append-only WAL the fixed-prompt controller writes each attempt into. */
  resultsJsonlPath: string;
}

/** A file the engine writes verbatim; callers pre-serialize `content`. */
export interface ExperimentFile {
  path: string;
  content: string;
}

export interface RunExperimentConfig<Summary> {
  runRoot: string;
  /**
   * Prompt (and any other) files materialized into the run before the
   * comparison starts, written after the standard directories exist.
   */
  prompts: (layout: ExperimentRunLayout) => readonly ExperimentFile[];
  /** Execute the comparison against the prepared layout and return its summary. */
  run: (layout: ExperimentRunLayout) => Promise<Summary>;
  /** Result/report files persisted after the comparison completes. */
  artifacts: (
    summary: Summary,
    layout: ExperimentRunLayout,
  ) => readonly ExperimentFile[] | Promise<readonly ExperimentFile[]>;
}

/** Resolve the standard `controller` / `jobs` / `prompts` layout for a run root. */
export function experimentRunLayout(runRoot: string): ExperimentRunLayout {
  const controllerDir = join(runRoot, 'controller');
  return {
    runRoot,
    controllerDir,
    jobsDir: join(runRoot, 'jobs'),
    promptsDir: join(runRoot, 'prompts'),
    resultsJsonlPath: join(controllerDir, 'results.jsonl'),
  };
}

/**
 * Materialize the run layout, write the prompt files, run the comparison, and
 * persist its artifacts. Returns the comparison summary so the caller can emit
 * its own (experiment-specific, contract-pinned) console summary.
 */
export async function runExperiment<Summary>(
  config: RunExperimentConfig<Summary>,
): Promise<Summary> {
  const layout = experimentRunLayout(config.runRoot);
  await Promise.all([
    mkdir(layout.controllerDir, { recursive: true }),
    mkdir(layout.jobsDir, { recursive: true }),
    mkdir(layout.promptsDir, { recursive: true }),
  ]);
  for (const file of config.prompts(layout)) {
    await writeFile(file.path, file.content, 'utf8');
  }
  const summary = await config.run(layout);
  for (const file of await config.artifacts(summary, layout)) {
    await writeFile(file.path, file.content, 'utf8');
  }
  return summary;
}
