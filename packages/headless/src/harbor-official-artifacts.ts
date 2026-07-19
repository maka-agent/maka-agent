import { readFile } from 'node:fs/promises';
import type { VerifierSpec } from './contracts.js';
import type { BenchmarkVerifierOutput } from './benchmark-adapters.js';
import type { TaskRunArtifactDescriptor } from './task-contracts.js';

export interface HarborOfficialArtifactInput {
  kind?: Exclude<VerifierSpec['kind'], 'command'>;
  resultJson?: unknown;
  rewardText?: string;
  ctrfJson?: unknown;
  stdout?: string;
  stderr?: string;
  durationMs?: number;
  artifacts?: TaskRunArtifactDescriptor[];
  details?: Record<string, unknown>;
}

export interface ReadHarborOfficialArtifactInput
  extends Omit<HarborOfficialArtifactInput, 'resultJson' | 'rewardText' | 'ctrfJson'> {
  resultJsonPath?: string;
  rewardPath?: string;
  ctrfJsonPath?: string;
}

export async function readHarborOfficialVerifierOutput(
  input: ReadHarborOfficialArtifactInput,
): Promise<BenchmarkVerifierOutput> {
  return harborOfficialVerifierOutputFromArtifacts({
    ...input,
    ...(input.resultJsonPath ? { resultJson: await readJsonFile(input.resultJsonPath) } : {}),
    ...(input.rewardPath ? { rewardText: await readFile(input.rewardPath, 'utf8') } : {}),
    ...(input.ctrfJsonPath ? { ctrfJson: await readJsonFile(input.ctrfJsonPath) } : {}),
  });
}

export function harborOfficialVerifierOutputFromArtifacts(
  input: HarborOfficialArtifactInput,
): BenchmarkVerifierOutput {
  const result = recordValue(input.resultJson) ? input.resultJson : undefined;
  const ctrf = ctrfSummary(input.ctrfJson);
  const score =
    numericPath(result, ['reward']) ??
    numericPath(result, ['score']) ??
    numericPath(result, ['metrics', 'reward']) ??
    numericPath(result, ['metrics', 'score']) ??
    numericPath(result, ['verifier_result', 'rewards', 'reward']) ??
    numericPath(result, ['verifier_result', 'rewards', 'score']) ??
    numericReward(input.rewardText) ??
    ctrf?.score;
  const maxScore =
    numericPath(result, ['maxScore']) ??
    numericPath(result, ['max_score']) ??
    numericPath(result, ['metrics', 'maxScore']) ??
    numericPath(result, ['metrics', 'max_score']) ??
    ctrf?.maxScore ??
    1;
  const explicitPassed =
    booleanPath(result, ['passed']) ??
    booleanPath(result, ['success']) ??
    booleanPath(result, ['verifier_result', 'passed']);
  const passed = explicitPassed ?? ctrf?.passed ?? (score !== undefined ? score > 0 : false);
  const error =
    stringPath(result, ['error']) ??
    stringPath(result, ['message']) ??
    stringPath(result, ['verifier_result', 'error']);

  if (
    score === undefined &&
    explicitPassed === undefined &&
    error === undefined &&
    ctrf === undefined
  ) {
    return {
      kind: input.kind ?? 'terminal_bench',
      passed: false,
      exitCode: null,
      ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
      ...(input.stdout ? { stdout: input.stdout } : {}),
      ...(input.stderr ? { stderr: input.stderr } : {}),
      error:
        'Harbor official verifier output did not include a reward, score, pass flag, error, or CTRF summary',
      errorClass: 'missing_official_verifier',
      maxScore,
      authority: {
        source: 'system',
        authoritative: false,
        label: 'missing Harbor official verifier output',
      },
      ...(input.artifacts ? { artifacts: input.artifacts } : {}),
      details: {
        source: 'harbor',
        official: false,
        missingOfficialVerifier: true,
        ...(input.details ?? {}),
      },
    };
  }

  return {
    kind: input.kind ?? 'terminal_bench',
    passed,
    exitCode: passed ? 0 : 1,
    ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
    ...(input.stdout ? { stdout: input.stdout } : {}),
    ...(input.stderr ? { stderr: input.stderr } : {}),
    ...(error ? { error } : {}),
    ...(passed ? {} : { errorClass: 'verification_failed' }),
    ...(score !== undefined ? { score } : {}),
    maxScore,
    authority: {
      source: 'official_harbor_verifier',
      authoritative: true,
      label: 'Harbor official verifier',
    },
    ...(input.artifacts ? { artifacts: input.artifacts } : {}),
    details: {
      source: 'harbor',
      official: true,
      ...(input.details ?? {}),
      ...(score !== undefined ? { reward: score } : {}),
      ...(ctrf ? { ctrf } : {}),
    },
  };
}

async function readJsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'));
}

function ctrfSummary(
  value: unknown,
):
  | { passed: boolean; score: number; maxScore: number; tests?: number; failed?: number }
  | undefined {
  if (!recordValue(value) || !recordValue(value.results) || !recordValue(value.results.summary))
    return undefined;
  const summary = value.results.summary;
  const tests = numericField(summary, 'tests');
  const failed = numericField(summary, 'failed') ?? 0;
  const passedTests = numericField(summary, 'passed');
  if (tests === undefined && passedTests === undefined) return undefined;
  const maxScore = tests ?? (passedTests ?? 0) + failed;
  const passed = failed === 0 && maxScore > 0;
  return {
    passed,
    score: passed ? 1 : 0,
    maxScore: 1,
    ...(tests !== undefined ? { tests } : {}),
    failed,
  };
}

function numericReward(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}

function numericPath(
  value: Record<string, unknown> | undefined,
  path: string[],
): number | undefined {
  const leaf = pathValue(value, path);
  return typeof leaf === 'number' && Number.isFinite(leaf) ? leaf : undefined;
}

function booleanPath(
  value: Record<string, unknown> | undefined,
  path: string[],
): boolean | undefined {
  const leaf = pathValue(value, path);
  return typeof leaf === 'boolean' ? leaf : undefined;
}

function stringPath(
  value: Record<string, unknown> | undefined,
  path: string[],
): string | undefined {
  const leaf = pathValue(value, path);
  return typeof leaf === 'string' && leaf.length > 0 ? leaf : undefined;
}

function pathValue(value: Record<string, unknown> | undefined, path: string[]): unknown {
  let current: unknown = value;
  for (const segment of path) {
    if (!recordValue(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function numericField(value: Record<string, unknown>, key: string): number | undefined {
  const field = value[key];
  return typeof field === 'number' && Number.isFinite(field) ? field : undefined;
}

function recordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
