import { isAbsolute, join } from 'node:path';
import type { Task, TaskVerification, VerifierSpec } from './contracts.js';
import { runVerification, type EvaluationResult } from './evaluator.js';
import type { VerifierResult } from './task-contracts.js';
import { resolveBenchmarkAdapter, type BenchmarkAdapterRegistry, type BenchmarkVerifierOutput } from './benchmark-adapters.js';
import { runTerminalBenchTestCommand, terminalBenchDetails } from './terminal-bench-adapter.js';

export function normalizeVerifier(task: Task): VerifierSpec {
  const verifier = task.verifier ?? verifierFromLegacy(task.verification);
  if (!verifier) {
    throw new Error(`task "${task.id}": verifier or verification is required`);
  }

  switch (verifier.kind) {
    case 'command':
      if (typeof verifier.command !== 'string' || verifier.command.trim().length === 0) {
        throw new Error(`task "${task.id}": command verifier requires a non-empty command`);
      }
      validateProtectedPaths(task.id, verifier.protectedPaths);
      return {
        ...verifier,
        protectedPaths: [...verifier.protectedPaths],
        ...(verifier.env ? { env: { ...verifier.env } } : {}),
      };
    case 'terminal_bench':
      if (verifier.adapter !== 'terminal-bench' || !verifier.instanceId) {
        throw new Error(`task "${task.id}": terminal_bench verifier requires adapter and instanceId`);
      }
      validateOptionalString(task.id, verifier.dataset, 'dataset');
      validateOptionalString(task.id, verifier.datasetPath, 'datasetPath');
      validateOptionalString(task.id, verifier.taskDir, 'taskDir');
      validateOptionalString(task.id, verifier.taskDescriptionKey, 'taskDescriptionKey');
      validateOptionalString(task.id, verifier.testCommand, 'testCommand');
      validateOptionalPositiveInteger(task.id, verifier.maxAgentTimeoutSec, 'maxAgentTimeoutSec');
      validateOptionalPositiveInteger(task.id, verifier.maxTestTimeoutSec, 'maxTestTimeoutSec');
      if (verifier.testCommand !== undefined) {
        validateProtectedPaths(task.id, verifier.protectedPaths);
      } else {
        validateProtectedPaths(task.id, verifier.protectedPaths ?? []);
      }
      return { ...verifier, protectedPaths: verifier.protectedPaths ? [...verifier.protectedPaths] : undefined };
    case 'swe_bench':
      if (verifier.adapter !== 'swe-bench' || !verifier.instanceId) {
        throw new Error(`task "${task.id}": swe_bench verifier requires adapter and instanceId`);
      }
      validateProtectedPaths(task.id, verifier.protectedPaths ?? []);
      return { ...verifier, protectedPaths: verifier.protectedPaths ? [...verifier.protectedPaths] : undefined };
  }
}

export function verifierProtectedPaths(verifier: VerifierSpec): string[] {
  return verifier.protectedPaths ? [...verifier.protectedPaths] : [];
}

export async function runVerifier(input: {
  verifier: VerifierSpec;
  taskRunId: string;
  attemptId?: string;
  ts: number;
  id: string;
  workspaceDir: string;
  submittedSnapshotId?: string;
  scoringWorkspaceId?: string;
  benchmarkAdapters?: BenchmarkAdapterRegistry;
}): Promise<VerifierResult> {
  if (input.verifier.kind !== 'command') {
    const output = input.verifier.kind === 'terminal_bench' && input.verifier.testCommand
      ? await runTerminalBenchTestCommand({ verifier: input.verifier, workspaceDir: input.workspaceDir })
      : await resolveBenchmarkAdapter(input.benchmarkAdapters, input.verifier.adapter)?.runVerifier({
          verifier: input.verifier,
          workspaceDir: input.workspaceDir,
          taskRunId: input.taskRunId,
          attemptId: input.attemptId,
          submittedSnapshotId: input.submittedSnapshotId,
          scoringWorkspaceId: input.scoringWorkspaceId,
        });
    if (output) {
      return verifierResultFromBenchmarkOutput({
        output,
        id: input.id,
        taskRunId: input.taskRunId,
        attemptId: input.attemptId,
        ts: input.ts,
        submittedSnapshotId: input.submittedSnapshotId,
        scoringWorkspaceId: input.scoringWorkspaceId,
      });
    }

    return {
      id: input.id,
      taskRunId: input.taskRunId,
      ...(input.attemptId ? { attemptId: input.attemptId } : {}),
      ts: input.ts,
      kind: input.verifier.kind,
      passed: false,
      exitCode: null,
      error: `${input.verifier.kind} verifier adapter is not implemented`,
      errorClass: 'unsupported_adapter',
      details: input.verifier.kind === 'terminal_bench' ? terminalBenchDetails(input.verifier) : undefined,
      submittedSnapshotId: input.submittedSnapshotId,
      scoringWorkspaceId: input.scoringWorkspaceId,
    };
  }

  const startedAt = Date.now();
  const cwd = input.verifier.cwd ? join(input.workspaceDir, input.verifier.cwd) : input.workspaceDir;
  const evaluation = await runVerification(
    input.verifier.command,
    cwd,
    input.verifier.timeoutMs,
    input.verifier.env,
  );
  return verifierResultFromEvaluation({
    evaluation,
    command: input.verifier.command,
    id: input.id,
    taskRunId: input.taskRunId,
    attemptId: input.attemptId,
    ts: input.ts,
    durationMs: Date.now() - startedAt,
    submittedSnapshotId: input.submittedSnapshotId,
    scoringWorkspaceId: input.scoringWorkspaceId,
  });
}

function verifierResultFromBenchmarkOutput(input: {
  output: BenchmarkVerifierOutput;
  id: string;
  taskRunId: string;
  attemptId?: string;
  ts: number;
  submittedSnapshotId?: string;
  scoringWorkspaceId?: string;
}): VerifierResult {
  return {
    id: input.id,
    taskRunId: input.taskRunId,
    ...(input.attemptId ? { attemptId: input.attemptId } : {}),
    ts: input.ts,
    kind: input.output.kind,
    passed: input.output.passed,
    exitCode: input.output.exitCode,
    durationMs: input.output.durationMs,
    stdout: input.output.stdout,
    stderr: input.output.stderr,
    error: input.output.error,
    errorClass: input.output.errorClass,
    score: input.output.score,
    maxScore: input.output.maxScore,
    details: input.output.details,
    submittedSnapshotId: input.submittedSnapshotId,
    scoringWorkspaceId: input.scoringWorkspaceId,
  };
}

export function verifierResultFromEvaluation(input: {
  evaluation: EvaluationResult;
  command?: string;
  id: string;
  taskRunId: string;
  attemptId?: string;
  ts: number;
  durationMs?: number;
  submittedSnapshotId?: string;
  scoringWorkspaceId?: string;
}): VerifierResult {
  const errorClass = input.evaluation.timedOut || input.evaluation.exitCode === null
    ? 'verification_error'
    : input.evaluation.passed
      ? undefined
      : 'verification_failed';
  return {
    id: input.id,
    taskRunId: input.taskRunId,
    ...(input.attemptId ? { attemptId: input.attemptId } : {}),
    ts: input.ts,
    kind: 'command',
    passed: input.evaluation.passed,
    exitCode: input.evaluation.exitCode,
    command: input.command,
    durationMs: input.durationMs,
    stdout: input.evaluation.stdout,
    stderr: input.evaluation.stderr,
    timedOut: input.evaluation.timedOut,
    ...(errorClass ? { errorClass } : {}),
    ...(input.evaluation.timedOut ? { error: 'verification timed out' } : {}),
    submittedSnapshotId: input.submittedSnapshotId,
    scoringWorkspaceId: input.scoringWorkspaceId,
  };
}

function verifierFromLegacy(verification: TaskVerification | undefined): VerifierSpec | undefined {
  if (!verification) return undefined;
  return {
    kind: 'command',
    command: verification.command,
    ...(verification.timeoutMs === undefined ? {} : { timeoutMs: verification.timeoutMs }),
    protectedPaths: verification.protectedPaths,
  };
}

function validateProtectedPaths(taskId: string, protectedPaths: unknown): asserts protectedPaths is string[] {
  if (!Array.isArray(protectedPaths)) {
    throw new Error(
      `task "${taskId}": verification.protectedPaths is required (an array; use [] when the verification reads nothing the agent can forge)`,
    );
  }
  for (const rel of protectedPaths) {
    if (typeof rel !== 'string' || isAbsolute(rel) || rel.split(/[\\/]+/).includes('..')) {
      throw new Error(`task "${taskId}": protectedPaths entry must be a workspace-relative path: ${String(rel)}`);
    }
  }
}

function validateOptionalString(taskId: string, value: unknown, field: string): void {
  if (value !== undefined && typeof value !== 'string') {
    throw new Error(`task "${taskId}": terminal_bench verifier ${field} must be a string when provided`);
  }
}

function validateOptionalPositiveInteger(taskId: string, value: unknown, field: string): void {
  if (value !== undefined && (!Number.isInteger(value) || Number(value) < 1)) {
    throw new Error(`task "${taskId}": terminal_bench verifier ${field} must be a positive integer when provided`);
  }
}
