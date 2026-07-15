import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';

export const MEMORY_BENCHMARK_DATASET_SCHEMA_VERSION = 'maka.memory_benchmark.dataset.v1' as const;
export const MEMORY_BENCHMARK_CASE_OUTPUT_SCHEMA_VERSION = 'maka.memory_benchmark.case_output.v1' as const;

export const MEMORY_BENCHMARK_DATASET_IDS = [
  'maka-context-continuity-v1',
  'maka-native-memory-lifecycle-v1',
] as const;
export type BundledMemoryBenchmarkDatasetId = typeof MEMORY_BENCHMARK_DATASET_IDS[number];

export const BUNDLED_MEMORY_BENCHMARK_HASHES: Readonly<Record<BundledMemoryBenchmarkDatasetId, string>> = Object.freeze({
  'maka-context-continuity-v1': 'sha256:a4e9df1bf8785b2e711956d57ffec7625ed0a98ade8843b724b5b81e1158ed7e',
  'maka-native-memory-lifecycle-v1': 'sha256:c7561ebaa64d0625db4387ac91e34badc195ac816309fd2078b2f63724bec0b8',
});

export const BUNDLED_MEMORY_BENCHMARK_CATEGORY_COUNTS = Object.freeze({
  'maka-context-continuity-v1': Object.freeze({
    distant_fact: 10,
    exact_value: 10,
    large_tool_result: 10,
    tool_adjacency: 10,
    compact_resume_fork: 10,
    overflow_recovery: 10,
  }),
  'maka-native-memory-lifecycle-v1': Object.freeze({
    explicit_remember: 10,
    evidence_promotion: 10,
    one_off_rejection: 10,
    conflict_correction: 10,
    dedupe: 10,
    scope_isolation: 10,
    privacy_secret_delete: 10,
    stale_freshness: 10,
  }),
} as const);

export type MemoryBenchmarkDatasetKind = 'continuity' | 'lifecycle';
export type MemoryBenchmarkHardGate = 'privacy' | 'scope' | 'deletion';
export type MemoryBenchmarkAssertionOp = 'equals' | 'contains' | 'absent' | 'not_contains' | 'set_equals';

export interface MemoryBenchmarkAssertion {
  readonly id: string;
  readonly op: MemoryBenchmarkAssertionOp;
  readonly path: string;
  readonly value?: unknown;
  readonly hardGate?: MemoryBenchmarkHardGate;
}

export interface MemoryBenchmarkCase {
  readonly id: string;
  readonly category: string;
  readonly description: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly assertions: readonly MemoryBenchmarkAssertion[];
}

export interface MemoryBenchmarkDataset {
  readonly schemaVersion: typeof MEMORY_BENCHMARK_DATASET_SCHEMA_VERSION;
  readonly id: string;
  readonly kind: MemoryBenchmarkDatasetKind;
  readonly version: number;
  readonly cases: readonly MemoryBenchmarkCase[];
}

interface MemoryBenchmarkCaseOutputBase {
  readonly schemaVersion: typeof MEMORY_BENCHMARK_CASE_OUTPUT_SCHEMA_VERSION;
  readonly caseId: string;
}

export type MemoryBenchmarkCaseOutput = MemoryBenchmarkCaseOutputBase & (
  | Readonly<{ status: 'completed'; result: unknown; diagnostic?: never }>
  | Readonly<{
    status: 'task_failed' | 'infrastructure_failed' | 'artifact_failed';
    result?: never;
    diagnostic?: Readonly<{ errorClass?: string; message?: string }>;
  }>
);

export type MemoryBenchmarkGradeClassification =
  | 'passed'
  | 'task_failure'
  | 'infrastructure_failure'
  | 'privacy_violation'
  | 'artifact_failure';
export type MemoryBenchmarkHardGateStatus = 'passed' | 'failed' | 'not_evaluated';

export interface MemoryBenchmarkCaseGrade {
  readonly caseId: string;
  readonly classification: MemoryBenchmarkGradeClassification;
  readonly passed: boolean;
  readonly score: number;
  readonly assertionsPassed: number;
  readonly assertionsTotal: number;
  readonly failedAssertionIds: string[];
  readonly hardGateStatus: MemoryBenchmarkHardGateStatus;
  readonly diagnostic?: Readonly<{ errorClass?: string; message?: string }>;
}

export interface MemoryBenchmarkDatasetGrade {
  readonly schemaVersion: 'maka.memory_benchmark.grade.v1';
  readonly datasetId: string;
  readonly datasetHash: string;
  readonly totalCases: number;
  readonly passedCases: number;
  readonly passed: boolean;
  readonly score: number;
  readonly hardGatesStatus: MemoryBenchmarkHardGateStatus;
  readonly classifications: Record<MemoryBenchmarkGradeClassification, number>;
  readonly cases: MemoryBenchmarkCaseGrade[];
  readonly artifactFailures: string[];
}

export async function loadBundledMemoryBenchmarkDataset(
  id: BundledMemoryBenchmarkDatasetId,
): Promise<MemoryBenchmarkDataset> {
  if (!(MEMORY_BENCHMARK_DATASET_IDS as readonly string[]).includes(id)) {
    throw new Error(`unknown bundled memory benchmark dataset: ${String(id)}`);
  }
  const dataset = await loadMemoryBenchmarkDataset(new URL(`../datasets/${id}.json`, import.meta.url));
  assertBundledDatasetContract(id, dataset);
  const actualHash = hashMemoryBenchmarkDataset(dataset);
  if (actualHash !== BUNDLED_MEMORY_BENCHMARK_HASHES[id]) {
    throw new Error(`bundled memory benchmark dataset ${id} hash mismatch: expected ${BUNDLED_MEMORY_BENCHMARK_HASHES[id]}, received ${actualHash}`);
  }
  return dataset;
}

export async function loadMemoryBenchmarkDataset(path: string | URL): Promise<MemoryBenchmarkDataset> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`failed to load memory benchmark dataset: ${errorMessage(error)}`);
  }
  return parseMemoryBenchmarkDataset(value);
}

export function parseMemoryBenchmarkDataset(value: unknown): MemoryBenchmarkDataset {
  const dataset = strictRecord(value, 'memory benchmark dataset', [
    'schemaVersion', 'id', 'kind', 'version', 'cases',
  ]);
  if (dataset.schemaVersion !== MEMORY_BENCHMARK_DATASET_SCHEMA_VERSION) {
    throw new Error(`unsupported memory benchmark dataset schemaVersion: ${String(dataset.schemaVersion ?? 'missing')}`);
  }
  const id = nonEmptyString(dataset.id, 'memory benchmark dataset id');
  if (dataset.kind !== 'continuity' && dataset.kind !== 'lifecycle') {
    throw new Error('memory benchmark dataset kind must be continuity or lifecycle');
  }
  if (!Number.isSafeInteger(dataset.version) || Number(dataset.version) < 1) {
    throw new Error('memory benchmark dataset version must be a positive integer');
  }
  if (!Array.isArray(dataset.cases) || dataset.cases.length === 0) {
    throw new Error('memory benchmark dataset cases must be a non-empty array');
  }
  const cases = dataset.cases.map((entry, index) => parseCase(entry, index));
  assertUnique(cases.map((entry) => entry.id), 'duplicate memory benchmark case id');
  return deepFreeze({
    schemaVersion: MEMORY_BENCHMARK_DATASET_SCHEMA_VERSION,
    id,
    kind: dataset.kind,
    version: Number(dataset.version),
    cases,
  });
}

export function hashMemoryBenchmarkDataset(dataset: MemoryBenchmarkDataset): string {
  const parsed = parseMemoryBenchmarkDataset(dataset);
  return deterministicFingerprint({
    schemaVersion: parsed.schemaVersion,
    id: parsed.id,
    kind: parsed.kind,
    version: parsed.version,
    cases: [...parsed.cases]
      .sort((left, right) => compareCodeUnits(left.id, right.id))
      .map((entry) => ({
        ...entry,
        assertions: [...entry.assertions].sort((left, right) => compareCodeUnits(left.id, right.id)),
      })),
  });
}

export function gradeMemoryBenchmarkCase(
  benchmarkCase: MemoryBenchmarkCase,
  outputValue: unknown,
): MemoryBenchmarkCaseGrade {
  const output = parseCaseOutput(outputValue);
  if (!output.ok) return failedGrade(benchmarkCase, 'artifact_failure', output.error);
  if (output.value.caseId !== benchmarkCase.id) {
    return failedGrade(benchmarkCase, 'artifact_failure', `case output id mismatch: expected ${benchmarkCase.id}, received ${output.value.caseId}`);
  }
  if (output.value.status === 'artifact_failed') {
    return failedGrade(benchmarkCase, 'artifact_failure', diagnosticMessage(output.value));
  }
  if (output.value.status === 'infrastructure_failed') {
    return failedGrade(benchmarkCase, 'infrastructure_failure', diagnosticMessage(output.value));
  }
  if (output.value.status === 'task_failed') {
    return failedGrade(benchmarkCase, 'task_failure', diagnosticMessage(output.value));
  }

  const evaluations = benchmarkCase.assertions.map((assertion) => ({
    assertion,
    passed: evaluateAssertion(assertion, output.value.result),
  }));
  const failed = evaluations.filter((entry) => !entry.passed);
  const hardGateStatus: MemoryBenchmarkHardGateStatus = failed.some((entry) => entry.assertion.hardGate !== undefined)
    ? 'failed'
    : 'passed';
  const passed = failed.length === 0;
  return {
    caseId: benchmarkCase.id,
    classification: passed ? 'passed' : hardGateStatus === 'passed' ? 'task_failure' : 'privacy_violation',
    passed,
    score: passed ? 1 : hardGateStatus === 'passed' ? (evaluations.length - failed.length) / evaluations.length : 0,
    assertionsPassed: evaluations.length - failed.length,
    assertionsTotal: evaluations.length,
    failedAssertionIds: failed.map((entry) => entry.assertion.id),
    hardGateStatus,
  };
}

export function gradeMemoryBenchmarkDataset(
  datasetValue: MemoryBenchmarkDataset,
  outputValues: readonly unknown[],
): MemoryBenchmarkDatasetGrade {
  const dataset = parseMemoryBenchmarkDataset(datasetValue);
  const caseById = new Map(dataset.cases.map((entry) => [entry.id, entry]));
  const outputByCase = new Map<string, unknown>();
  const duplicateIds = new Set<string>();
  const artifactFailures: string[] = [];

  for (const outputValue of outputValues) {
    const caseId = outputCaseId(outputValue);
    if (!caseId) {
      artifactFailures.push('malformed case output without a caseId');
      continue;
    }
    if (!caseById.has(caseId)) {
      artifactFailures.push(`unknown case output: ${caseId}`);
      continue;
    }
    if (outputByCase.has(caseId)) duplicateIds.add(caseId);
    else outputByCase.set(caseId, outputValue);
  }

  const cases = dataset.cases.map((benchmarkCase) => {
    if (duplicateIds.has(benchmarkCase.id)) {
      artifactFailures.push(`duplicate case output: ${benchmarkCase.id}`);
      return failedGrade(benchmarkCase, 'artifact_failure', `duplicate case output: ${benchmarkCase.id}`);
    }
    const output = outputByCase.get(benchmarkCase.id);
    if (output === undefined) {
      artifactFailures.push(`missing case output: ${benchmarkCase.id}`);
      return failedGrade(benchmarkCase, 'artifact_failure', `missing case output: ${benchmarkCase.id}`);
    }
    const grade = gradeMemoryBenchmarkCase(benchmarkCase, output);
    if (grade.classification === 'artifact_failure') {
      artifactFailures.push(grade.diagnostic?.message ?? `artifact failure: ${benchmarkCase.id}`);
    }
    return grade;
  });
  const classifications = emptyClassifications();
  for (const grade of cases) classifications[grade.classification] += 1;
  const passedCases = classifications.passed;
  return {
    schemaVersion: 'maka.memory_benchmark.grade.v1',
    datasetId: dataset.id,
    datasetHash: hashMemoryBenchmarkDataset(dataset),
    totalCases: dataset.cases.length,
    passedCases,
    passed: passedCases === dataset.cases.length && artifactFailures.length === 0,
    score: cases.reduce((sum, entry) => sum + entry.score, 0) / dataset.cases.length,
    hardGatesStatus: aggregateHardGateStatus(cases),
    classifications,
    cases,
    artifactFailures: artifactFailures.sort(),
  };
}

function parseCase(value: unknown, index: number): MemoryBenchmarkCase {
  const benchmarkCase = strictRecord(value, `memory benchmark case ${index}`, [
    'id', 'category', 'description', 'input', 'assertions',
  ]);
  const id = nonEmptyString(benchmarkCase.id, `memory benchmark case ${index} id`);
  const category = nonEmptyString(benchmarkCase.category, `memory benchmark case ${id} category`);
  const description = nonEmptyString(benchmarkCase.description, `memory benchmark case ${id} description`);
  const input = strictRecord(benchmarkCase.input, `memory benchmark case ${id} input`);
  assertJsonValue(input, `memory benchmark case ${id} input`);
  if (!Array.isArray(benchmarkCase.assertions) || benchmarkCase.assertions.length === 0) {
    throw new Error(`memory benchmark case ${id} assertions must be a non-empty array`);
  }
  const assertions = benchmarkCase.assertions.map((entry, assertionIndex) => parseAssertion(entry, id, assertionIndex));
  assertUnique(assertions.map((entry) => entry.id), `duplicate assertion id in memory benchmark case ${id}`);
  return { id, category, description, input, assertions };
}

function assertBundledDatasetContract(
  id: BundledMemoryBenchmarkDatasetId,
  dataset: MemoryBenchmarkDataset,
): void {
  if (dataset.id !== id) throw new Error(`bundled memory benchmark dataset id mismatch: expected ${id}, received ${dataset.id}`);
  const expectedKind: MemoryBenchmarkDatasetKind = id === 'maka-context-continuity-v1' ? 'continuity' : 'lifecycle';
  if (dataset.kind !== expectedKind) {
    throw new Error(`bundled memory benchmark dataset ${id} must have kind ${expectedKind}`);
  }
  const expected = BUNDLED_MEMORY_BENCHMARK_CATEGORY_COUNTS[id];
  const expectedCategories = Object.keys(expected).sort();
  const actualCategories = [...new Set(dataset.cases.map((entry) => entry.category))].sort();
  if (!isDeepStrictEqual(actualCategories, expectedCategories)) {
    throw new Error(`bundled memory benchmark dataset ${id} category set is invalid`);
  }
  for (const category of expectedCategories) {
    const actual = dataset.cases.filter((entry) => entry.category === category).length;
    const required = expected[category as keyof typeof expected];
    if (actual !== required) {
      throw new Error(`bundled memory benchmark dataset ${id} requires ${required} ${category} cases, received ${actual}`);
    }
  }
}

function parseAssertion(value: unknown, caseId: string, index: number): MemoryBenchmarkAssertion {
  const assertion = strictRecord(value, `memory benchmark case ${caseId} assertion ${index}`, [
    'id', 'op', 'path', 'value', 'hardGate',
  ]);
  const id = nonEmptyString(assertion.id, `memory benchmark case ${caseId} assertion id`);
  if (!['equals', 'contains', 'absent', 'not_contains', 'set_equals'].includes(String(assertion.op))) {
    throw new Error(`unsupported memory benchmark assertion op: ${String(assertion.op)}`);
  }
  const op = assertion.op as MemoryBenchmarkAssertionOp;
  const path = nonEmptyString(assertion.path, `memory benchmark assertion ${id} path`);
  validateJsonPointer(path);
  const hasValue = Object.hasOwn(assertion, 'value');
  if (op === 'absent' && hasValue) throw new Error('absent assertion must not define value');
  if (op !== 'absent' && !hasValue) throw new Error(`${op} assertion must define value`);
  if (hasValue) assertJsonValue(assertion.value, `memory benchmark assertion ${id} value`);
  if (assertion.hardGate !== undefined && !['privacy', 'scope', 'deletion'].includes(String(assertion.hardGate))) {
    throw new Error(`unsupported memory benchmark hard gate: ${String(assertion.hardGate)}`);
  }
  return {
    id,
    op,
    path,
    ...(hasValue ? { value: assertion.value } : {}),
    ...(assertion.hardGate !== undefined ? { hardGate: assertion.hardGate as MemoryBenchmarkHardGate } : {}),
  };
}

function parseCaseOutput(value: unknown): { ok: true; value: MemoryBenchmarkCaseOutput } | { ok: false; error: string } {
  try {
    const output = strictRecord(value, 'memory benchmark case output', [
      'schemaVersion', 'caseId', 'status', 'result', 'diagnostic',
    ]);
    if (output.schemaVersion !== MEMORY_BENCHMARK_CASE_OUTPUT_SCHEMA_VERSION) {
      throw new Error(`unsupported case output schemaVersion: ${String(output.schemaVersion ?? 'missing')}`);
    }
    const caseId = nonEmptyString(output.caseId, 'memory benchmark case output caseId');
    if (!['completed', 'task_failed', 'infrastructure_failed', 'artifact_failed'].includes(String(output.status))) {
      throw new Error(`unsupported case output status: ${String(output.status)}`);
    }
    const status = output.status as MemoryBenchmarkCaseOutput['status'];
    if (status === 'completed' && !Object.hasOwn(output, 'result')) {
      throw new Error('completed case output must define result');
    }
    if (status === 'completed' && Object.hasOwn(output, 'diagnostic')) {
      throw new Error('completed case output must not define diagnostic');
    }
    if (status !== 'completed' && Object.hasOwn(output, 'result')) {
      throw new Error(`${status} case output must not define result`);
    }
    if (Object.hasOwn(output, 'result')) assertJsonValue(output.result, 'memory benchmark case output result');
    let diagnostic: MemoryBenchmarkCaseOutput['diagnostic'];
    if (output.diagnostic !== undefined) {
      const parsed = strictRecord(output.diagnostic, 'memory benchmark case output diagnostic', ['errorClass', 'message']);
      diagnostic = {
        ...(parsed.errorClass !== undefined
          ? { errorClass: nonEmptyString(parsed.errorClass, 'case output diagnostic errorClass') }
          : {}),
        ...(parsed.message !== undefined
          ? { message: nonEmptyString(parsed.message, 'case output diagnostic message') }
          : {}),
      };
    }
    if (status === 'completed') {
      return { ok: true, value: {
        schemaVersion: MEMORY_BENCHMARK_CASE_OUTPUT_SCHEMA_VERSION,
        caseId,
        status,
        result: output.result,
      } };
    }
    return { ok: true, value: {
      schemaVersion: MEMORY_BENCHMARK_CASE_OUTPUT_SCHEMA_VERSION,
      caseId,
      status,
      ...(diagnostic ? { diagnostic } : {}),
    } };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

function evaluateAssertion(assertion: MemoryBenchmarkAssertion, result: unknown): boolean {
  if (assertion.hardGate !== undefined && assertion.op === 'not_contains') {
    return !recursiveContains(result, assertion.value);
  }
  const resolved = resolveJsonPointer(result, assertion.path);
  switch (assertion.op) {
    case 'absent':
      return !resolved.found;
    case 'equals':
      return resolved.found && isDeepStrictEqual(resolved.value, assertion.value);
    case 'contains':
      return resolved.found && contains(resolved.value, assertion.value);
    case 'not_contains':
      return !resolved.found || !contains(resolved.value, assertion.value);
    case 'set_equals':
      return resolved.found && setEquals(resolved.value, assertion.value);
  }
}

function recursiveContains(value: unknown, expected: unknown): boolean {
  if (contains(value, expected) || isDeepStrictEqual(value, expected)) return true;
  if (Array.isArray(value)) return value.some((entry) => recursiveContains(entry, expected));
  if (isRecord(value)) {
    return Object.entries(value).some(([key, entry]) => (
      recursiveContains(key, expected) || recursiveContains(entry, expected)
    ));
  }
  return false;
}

function resolveJsonPointer(value: unknown, pointer: string): { found: boolean; value?: unknown } {
  let current = value;
  for (const rawPart of pointer.slice(1).split('/')) {
    const part = rawPart.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(part) || Number(part) >= current.length) return { found: false };
      current = current[Number(part)];
      continue;
    }
    if (!isRecord(current) || !Object.hasOwn(current, part)) return { found: false };
    current = current[part];
  }
  return { found: true, value: current };
}

function contains(container: unknown, expected: unknown): boolean {
  if (typeof container === 'string' && typeof expected === 'string') return container.includes(expected);
  if (Array.isArray(container)) return container.some((entry) => isDeepStrictEqual(entry, expected));
  return false;
}

function setEquals(actual: unknown, expected: unknown): boolean {
  if (!Array.isArray(actual) || !Array.isArray(expected)) return false;
  const normalized = (entries: unknown[]): string[] => entries.map((entry) => deterministicFingerprint(entry)).sort(compareCodeUnits);
  return isDeepStrictEqual(normalized(actual), normalized(expected));
}

function failedGrade(
  benchmarkCase: MemoryBenchmarkCase,
  classification: Exclude<MemoryBenchmarkGradeClassification, 'passed'>,
  message?: string,
): MemoryBenchmarkCaseGrade {
  const hasHardGate = benchmarkCase.assertions.some((assertion) => assertion.hardGate !== undefined);
  return {
    caseId: benchmarkCase.id,
    classification,
    passed: false,
    score: 0,
    assertionsPassed: 0,
    assertionsTotal: benchmarkCase.assertions.length,
    failedAssertionIds: benchmarkCase.assertions.map((assertion) => assertion.id),
    hardGateStatus: hasHardGate ? 'not_evaluated' : 'passed',
    ...(message ? { diagnostic: { message } } : {}),
  };
}

function aggregateHardGateStatus(cases: readonly MemoryBenchmarkCaseGrade[]): MemoryBenchmarkHardGateStatus {
  if (cases.some((entry) => entry.hardGateStatus === 'failed')) return 'failed';
  if (cases.some((entry) => entry.hardGateStatus === 'not_evaluated')) return 'not_evaluated';
  return 'passed';
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deterministicFingerprint(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  if (isRecord(value)) {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => compareCodeUnits(left, right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function outputCaseId(value: unknown): string | undefined {
  return isRecord(value) && typeof value.caseId === 'string' && value.caseId.trim().length > 0
    ? value.caseId.trim()
    : undefined;
}

function diagnosticMessage(output: MemoryBenchmarkCaseOutput): string | undefined {
  return output.diagnostic?.message ?? output.diagnostic?.errorClass;
}

function emptyClassifications(): Record<MemoryBenchmarkGradeClassification, number> {
  return {
    passed: 0,
    task_failure: 0,
    infrastructure_failure: 0,
    privacy_violation: 0,
    artifact_failure: 0,
  };
}

function strictRecord(value: unknown, label: string, allowedKeys?: readonly string[]): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  if (allowedKeys) {
    const allowed = new Set(allowedKeys);
    const unknown = Object.keys(value).filter((key) => !allowed.has(key));
    if (unknown.length > 0) throw new Error(`${label} contains unknown field: ${unknown.sort()[0]}`);
  }
  return value;
}

function assertJsonValue(value: unknown, label: string, seen = new WeakSet<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${label} must contain only finite JSON numbers`);
    return;
  }
  if (typeof value !== 'object') throw new Error(`${label} must contain only JSON values`);
  if (Object.getOwnPropertySymbols(value).length > 0) throw new Error(`${label} must not contain symbol keys`);
  if (seen.has(value)) throw new Error(`${label} must not contain cycles`);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertJsonValue(entry, `${label}[${index}]`, seen));
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} must contain only plain JSON objects`);
    for (const [key, entry] of Object.entries(value)) assertJsonValue(entry, `${label}.${key}`, seen);
  }
  seen.delete(value);
}

function validateJsonPointer(value: string): void {
  if (!value.startsWith('/')) throw new Error(`memory benchmark assertion path must be a JSON Pointer: ${value}`);
  if (/~(?:[^01]|$)/.test(value)) throw new Error(`memory benchmark assertion path contains invalid JSON Pointer escape: ${value}`);
}

function assertUnique(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`${label}: ${value}`);
    seen.add(value);
  }
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null) return value;
  Object.freeze(value);
  for (const entry of Object.values(value)) deepFreeze(entry);
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
