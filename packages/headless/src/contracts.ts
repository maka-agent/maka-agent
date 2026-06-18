/**
 * @maka/headless contracts — the walking-skeleton surface (issue #31).
 *
 * The lab treats an agent configuration as something testable: run a
 * `Config` against a `Task`, record what happened, score it. Keeping
 * `Config` and `Task` separable is the whole point — an experiment is
 * `Config × Task`.
 *
 * MVP scope only. Deliberately deferred as pure additions: a matrix /
 * compare layer, LLM/rule evaluators (MVP = command/test only), Docker
 * execution, network allowlist, `systemPrompt`/toolset overrides on
 * Config, and promoting these contracts into @maka/core once a second
 * consumer exists.
 */

import type { BackendKind } from '@maka/core';

/**
 * A unit of work the lab runs a Config against. Field names lean toward
 * the SWE-bench instance shape so a real benchmark instance maps in
 * later without reshaping.
 */
export interface Task {
  id: string;
  /** The prompt handed to the agent as the user turn. */
  instruction: string;
  /**
   * Absolute path to the initial workspace fixture. Copied per run and
   * never mutated — the agent only ever touches the throwaway copy.
   */
  workspaceDir: string;
  /** How the run is scored. Lives on the Task, never the Config, so a
   *  config under test cannot grade itself. */
  verification: TaskVerification;
}

export interface TaskVerification {
  /**
   * Shell command run in the throwaway workspace AFTER the agent
   * finishes. Exit code 0 = pass. (FAIL_TO_PASS / PASS_TO_PASS
   * semantics are a later addition.)
   */
  command: string;
  /** Hard timeout for the verification command. Defaults applied by the runner. */
  timeoutMs?: number;
  /**
   * Files/dirs (relative to the workspace) restored from the pristine
   * fixture AFTER the agent finishes and BEFORE the command runs — so a
   * config under test cannot rewrite its own grading to pass. List the
   * test / grading assets here; anything not listed is the agent's to edit.
   *
   * REQUIRED, not optional: the grading boundary must be a conscious choice,
   * never a silent omission. Declare `[]` only when the verification reads
   * nothing the agent can forge (e.g. a pure `test -f` against a fixture file).
   */
  protectedPaths: string[];
}

/**
 * The variable under test. References Maka's existing model/connection
 * selection — it does NOT invent a model format. The toolset is a
 * capability set, not an interactive permission policy.
 */
export interface Config {
  id: string;
  backend: BackendKind;
  llmConnectionSlug: string;
  /** Falls back to the connection's default model when omitted. */
  model?: string;
}

/** One row of canonical truth per run: did it run, did it pass, and how much it cost. */
export interface ResultRecord {
  taskId: string;
  configId: string;
  sessionId: string;
  runId: string;
  /** Did the agent invocation finish (vs. error out mid-run)? */
  status: 'completed' | 'failed';
  /** Did the Task's verification command pass? */
  passed: boolean;
  /** Verification command exit code (null if it never ran / errored to spawn). */
  exitCode: number | null;
  /** Trajectory length proxy: number of RuntimeEvents emitted. */
  steps: number;
  durationMs: number;
  startedAt: number;
  finishedAt: number;
  /** Present when the run threw before producing a result (matrix-level failure). */
  error?: string;
  /** Stable failure class from the runtime invocation when status is failed. */
  errorClass?: string;
}
