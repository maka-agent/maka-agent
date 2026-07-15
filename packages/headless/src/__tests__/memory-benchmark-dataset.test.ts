import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  BUNDLED_MEMORY_BENCHMARK_HASHES,
  MEMORY_BENCHMARK_CASE_OUTPUT_SCHEMA_VERSION,
  MEMORY_BENCHMARK_DATASET_SCHEMA_VERSION,
  gradeMemoryBenchmarkCase,
  gradeMemoryBenchmarkDataset,
  hashMemoryBenchmarkDataset,
  loadBundledMemoryBenchmarkDataset,
  loadMemoryBenchmarkDataset,
  parseMemoryBenchmarkDataset,
  type MemoryBenchmarkCase,
  type MemoryBenchmarkCaseOutput,
  type MemoryBenchmarkDataset,
} from '../memory-benchmark-dataset.js';

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', '__tests__', 'fixtures', 'memory-dataset');
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('Maka-native memory benchmark datasets', () => {
  test('loads the frozen 60-case continuity and 80-case lifecycle datasets', async () => {
    const continuity = await loadBundledMemoryBenchmarkDataset('maka-context-continuity-v1');
    const lifecycle = await loadBundledMemoryBenchmarkDataset('maka-native-memory-lifecycle-v1');

    assert.equal(continuity.schemaVersion, MEMORY_BENCHMARK_DATASET_SCHEMA_VERSION);
    assert.equal(hashMemoryBenchmarkDataset(continuity), BUNDLED_MEMORY_BENCHMARK_HASHES['maka-context-continuity-v1']);
    assert.equal(continuity.kind, 'continuity');
    assert.equal(continuity.cases.length, 60);
    assert.deepEqual(categoryCounts(continuity), {
      distant_fact: 10,
      exact_value: 10,
      large_tool_result: 10,
      tool_adjacency: 10,
      compact_resume_fork: 10,
      overflow_recovery: 10,
    });

    assert.equal(lifecycle.kind, 'lifecycle');
    assert.equal(hashMemoryBenchmarkDataset(lifecycle), BUNDLED_MEMORY_BENCHMARK_HASHES['maka-native-memory-lifecycle-v1']);
    assert.equal(lifecycle.cases.length, 80);
    assert.deepEqual(categoryCounts(lifecycle), {
      explicit_remember: 10,
      evidence_promotion: 10,
      one_off_rejection: 10,
      conflict_correction: 10,
      dedupe: 10,
      scope_isolation: 10,
      privacy_secret_delete: 10,
      stale_freshness: 10,
    });
    assert.equal(new Set([...continuity.cases, ...lifecycle.cases].map((entry) => entry.id)).size, 140);
  });

  test('hashes canonical dataset content independent of case and assertion ordering', async () => {
    const dataset = await loadBundledMemoryBenchmarkDataset('maka-context-continuity-v1');
    const reordered: MemoryBenchmarkDataset = {
      ...dataset,
      cases: [...dataset.cases].reverse().map((entry) => ({
        ...entry,
        assertions: [...entry.assertions].reverse(),
      })),
    };
    assert.equal(hashMemoryBenchmarkDataset(dataset), hashMemoryBenchmarkDataset(reordered));
    assert.match(hashMemoryBenchmarkDataset(dataset), /^sha256:[a-f0-9]{64}$/);

    const hostIndependentOrdering: MemoryBenchmarkDataset = {
      ...miniDataset(),
      cases: miniDataset().cases.map((entry, index) => ({
        ...entry,
        id: index === 0 ? 'case-Z_~' : 'case-ä',
        assertions: entry.assertions.map((assertion, assertionIndex) => ({
          ...assertion,
          id: `${assertionIndex === 0 ? 'assert-Z' : 'assert-ä'}-${assertion.id}`,
        })),
      })),
    };
    assert.equal(
      hashMemoryBenchmarkDataset(hostIndependentOrdering),
      hashMemoryBenchmarkDataset({ ...hostIndependentOrdering, cases: [...hostIndependentOrdering.cases].reverse() }),
    );

    const nonAsciiObjectKeys = structuredClone(hostIndependentOrdering);
    (nonAsciiObjectKeys.cases[0]!.input as Record<string, unknown>).nested = { 'ä': 1, Z: 2 };
    const reversedObjectKeys = structuredClone(nonAsciiObjectKeys);
    (reversedObjectKeys.cases[0]!.input as Record<string, unknown>).nested = { Z: 2, 'ä': 1 };
    assert.equal(hashMemoryBenchmarkDataset(nonAsciiObjectKeys), hashMemoryBenchmarkDataset(reversedObjectKeys));
  });

  test('loads a checked fixture and rejects malformed schema data', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-memory-dataset-'));
    try {
      const path = join(dir, 'dataset.json');
      const dataset = miniDataset();
      await writeFile(path, JSON.stringify(dataset), 'utf8');
      assert.deepEqual(await loadMemoryBenchmarkDataset(path), parseMemoryBenchmarkDataset(dataset));

      assert.throws(
        () => parseMemoryBenchmarkDataset({ ...dataset, schemaVersion: 'future.v2' }),
        /unsupported memory benchmark dataset schemaVersion/,
      );
      assert.throws(
        () => parseMemoryBenchmarkDataset({
          ...dataset,
          cases: [dataset.cases[0], dataset.cases[0]],
        }),
        /duplicate memory benchmark case id/,
      );
      assert.throws(
        () => parseMemoryBenchmarkDataset({
          ...dataset,
          cases: [{
            ...dataset.cases[0],
            assertions: [{ id: 'bad-path', op: 'equals', path: 'answer', value: 'x' }],
          }],
        }),
        /JSON Pointer/,
      );
      assert.throws(
        () => parseMemoryBenchmarkDataset({
          ...dataset,
          cases: [{
            ...dataset.cases[0],
            assertions: [{ id: 'bad-absent', op: 'absent', path: '/secret', value: 'must-not-exist' }],
          }],
        }),
        /absent assertion must not define value/,
      );
      assert.throws(
        () => parseMemoryBenchmarkDataset({
          ...dataset,
          cases: [{ ...dataset.cases[0], input: { invalid: undefined } }],
        }),
        /only JSON values/,
      );
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      assert.throws(
        () => parseMemoryBenchmarkDataset({
          ...dataset,
          cases: [{ ...dataset.cases[0], input: cyclic }],
        }),
        /must not contain cycles/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('refuses to overwrite an existing frozen dataset version', () => {
    const result = spawnSync(process.execPath, [join(packageRoot, 'scripts', 'generate-memory-benchmark-datasets.mjs'), '--write'], {
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /already exists and is immutable/);
  });
});

describe('deterministic memory benchmark grader', () => {
  test('matches the checked-in grader golden fixture', async () => {
    const fixture = JSON.parse(await readFile(join(fixtureRoot, 'grader-golden-v1.json'), 'utf8')) as {
      dataset: unknown;
      grades: Array<{
        name: string;
        caseId: string;
        output: unknown;
        expected: { classification: string; score: number; hardGateStatus: string };
      }>;
    };
    const dataset = parseMemoryBenchmarkDataset(fixture.dataset);
    for (const entry of fixture.grades) {
      const benchmarkCase = dataset.cases.find((candidate) => candidate.id === entry.caseId);
      assert.ok(benchmarkCase, `missing golden benchmark case for ${entry.name}`);
      const grade = gradeMemoryBenchmarkCase(benchmarkCase, entry.output);
      assert.deepEqual({
        classification: grade.classification,
        score: grade.score,
        hardGateStatus: grade.hardGateStatus,
      }, entry.expected, entry.name);
    }
  });

  test('grades perfect, partial, leaking, infrastructure, and malformed outputs', () => {
    const [normalCase, privacyCase] = miniDataset().cases as [MemoryBenchmarkCase, MemoryBenchmarkCase];

    const perfect = gradeMemoryBenchmarkCase(normalCase, completed(normalCase.id, {
      answer: 'project-4317',
      tags: ['remembered', 'current'],
    }));
    assert.deepEqual(pickGrade(perfect), {
      classification: 'passed',
      passed: true,
      score: 1,
      failedAssertionIds: [],
    });

    const partial = gradeMemoryBenchmarkCase(normalCase, completed(normalCase.id, {
      answer: 'wrong',
      tags: ['remembered'],
    }));
    assert.equal(partial.classification, 'task_failure');
    assert.equal(partial.passed, false);
    assert.equal(partial.score, 0.5);
    assert.deepEqual(partial.failedAssertionIds, ['answer-exact']);

    const leaking = gradeMemoryBenchmarkCase(privacyCase, completed(privacyCase.id, {
      public: 'ok',
      secret: 'PRIVATE_TEST_LEAK',
    }));
    assert.equal(leaking.classification, 'privacy_violation');
    assert.equal(leaking.score, 0);
    assert.equal(leaking.hardGateStatus, 'failed');

    const relocatedLeak = gradeMemoryBenchmarkCase(privacyCase, completed(privacyCase.id, {
      public: 'ok',
      debug: { nested: ['PRIVATE_TEST_LEAK'] },
    }));
    assert.equal(relocatedLeak.classification, 'privacy_violation');
    assert.equal(relocatedLeak.hardGateStatus, 'failed');

    const keyLeak = gradeMemoryBenchmarkCase(privacyCase, completed(privacyCase.id, {
      public: 'ok',
      debug: { PRIVATE_TEST_LEAK: true },
    }));
    assert.equal(keyLeak.classification, 'privacy_violation');

    assert.equal(gradeMemoryBenchmarkCase(normalCase, {
      schemaVersion: MEMORY_BENCHMARK_CASE_OUTPUT_SCHEMA_VERSION,
      caseId: normalCase.id,
      status: 'infrastructure_failed',
      diagnostic: { errorClass: 'provider_timeout' },
    }).classification, 'infrastructure_failure');
    assert.equal(gradeMemoryBenchmarkCase(normalCase, {
      schemaVersion: MEMORY_BENCHMARK_CASE_OUTPUT_SCHEMA_VERSION,
      caseId: normalCase.id,
      status: 'task_failed',
    }).classification, 'task_failure');
    assert.equal(gradeMemoryBenchmarkCase(normalCase, {
      schemaVersion: MEMORY_BENCHMARK_CASE_OUTPUT_SCHEMA_VERSION,
      caseId: normalCase.id,
      status: 'artifact_failed',
    }).classification, 'artifact_failure');

    assert.equal(gradeMemoryBenchmarkCase(normalCase, { caseId: normalCase.id }).classification, 'artifact_failure');
    assert.equal(gradeMemoryBenchmarkCase(normalCase, completed('wrong-case', {})).classification, 'artifact_failure');
    assert.equal(gradeMemoryBenchmarkCase(normalCase, completed(normalCase.id, { answer: Number.NaN })).classification, 'artifact_failure');
  });

  test('produces deterministic dataset summaries and treats missing/extra outputs as artifact failures', () => {
    const dataset = miniDataset();
    const outputs: unknown[] = [
      completed(dataset.cases[0]!.id, { answer: 'project-4317', tags: ['current', 'remembered'] }),
      completed(dataset.cases[1]!.id, { public: 'ok' }),
      completed('extra-case', {}),
    ];
    const report = gradeMemoryBenchmarkDataset(dataset, outputs);
    assert.equal(report.datasetId, dataset.id);
    assert.equal(report.totalCases, 2);
    assert.equal(report.passedCases, 2);
    assert.equal(report.score, 1);
    assert.equal(report.passed, false);
    assert.equal(report.hardGatesStatus, 'passed');
    assert.equal(report.artifactFailures.length, 1);
    assert.match(report.artifactFailures[0] ?? '', /unknown case output: extra-case/);
    assert.deepEqual(
      gradeMemoryBenchmarkDataset(dataset, [...outputs].reverse()),
      report,
      'dataset grading must not depend on output ordering',
    );

    const missing = gradeMemoryBenchmarkDataset(dataset, [outputs[0]]);
    assert.equal(missing.passedCases, 1);
    assert.equal(missing.classifications.artifact_failure, 1);
    assert.equal(missing.score, 0.5);
    assert.equal(missing.passed, false);

    const partial = gradeMemoryBenchmarkDataset(dataset, [
      completed(dataset.cases[0]!.id, { answer: 'wrong', tags: ['remembered'] }),
      completed(dataset.cases[1]!.id, { public: 'ok' }),
    ]);
    assert.equal(partial.passedCases, 1);
    assert.equal(partial.score, 0.75, 'dataset score must retain partial assertion credit');
  });

  test('rejects duplicate outputs instead of letting the last answer win', () => {
    const dataset = miniDataset();
    const duplicate = completed(dataset.cases[0]!.id, { answer: 'project-4317', tags: ['remembered'] });
    const report = gradeMemoryBenchmarkDataset(dataset, [duplicate, duplicate]);
    assert.equal(report.classifications.artifact_failure, 2);
    assert.match(report.artifactFailures.join('\n'), /duplicate case output/);
  });

  test('runs synthetic perfect, partial, leaking, infrastructure, and malformed bundled benchmarks', async () => {
    for (const id of ['maka-context-continuity-v1', 'maka-native-memory-lifecycle-v1'] as const) {
      const dataset = await loadBundledMemoryBenchmarkDataset(id);
      const perfectOutputs = dataset.cases.map((entry) => completed(entry.id, goldenResult(entry)));
      const perfect = gradeMemoryBenchmarkDataset(dataset, perfectOutputs);
      assert.equal(perfect.passed, true, `${id} perfect fixture must pass`);
      assert.equal(perfect.passedCases, dataset.cases.length);
      assert.equal(perfect.hardGatesStatus, 'passed');

      const partialOutputs = [...perfectOutputs];
      partialOutputs[0] = completed(dataset.cases[0]!.id, {});
      const partial = gradeMemoryBenchmarkDataset(dataset, partialOutputs);
      assert.equal(partial.classifications.task_failure, 1);
      assert.equal(partial.passed, false);

      const infrastructureOutputs = [...perfectOutputs];
      infrastructureOutputs[0] = {
        schemaVersion: MEMORY_BENCHMARK_CASE_OUTPUT_SCHEMA_VERSION,
        caseId: dataset.cases[0]!.id,
        status: 'infrastructure_failed',
        diagnostic: { errorClass: 'synthetic_timeout' },
      };
      assert.equal(
        gradeMemoryBenchmarkDataset(dataset, infrastructureOutputs).classifications.infrastructure_failure,
        1,
      );

      const malformedOutputs: unknown[] = [...perfectOutputs];
      malformedOutputs[0] = { caseId: dataset.cases[0]!.id, status: 'completed', result: {} };
      assert.equal(gradeMemoryBenchmarkDataset(dataset, malformedOutputs).classifications.artifact_failure, 1);

      const hardGateCase = dataset.cases.find((entry) => entry.assertions.some((assertion) => (
        assertion.hardGate !== undefined && (assertion.op === 'absent' || assertion.op === 'not_contains')
      )));
      if (hardGateCase) {
        const leakingOutputs = [...perfectOutputs];
        const leakingResult = goldenResult(hardGateCase);
        const hardAssertion = hardGateCase.assertions.find((assertion) => (
          assertion.hardGate !== undefined && (assertion.op === 'absent' || assertion.op === 'not_contains')
        ))!;
        setPointer(leakingResult, hardAssertion.path, hardAssertion.op === 'not_contains' ? hardAssertion.value : 'leaked');
        leakingOutputs[dataset.cases.indexOf(hardGateCase)] = completed(hardGateCase.id, leakingResult);
        const leaking = gradeMemoryBenchmarkDataset(dataset, leakingOutputs);
        assert.equal(leaking.classifications.privacy_violation, 1);
        assert.equal(leaking.hardGatesStatus, 'failed');
        assert.equal(leaking.passed, false);
      }

      if (id === 'maka-native-memory-lifecycle-v1') {
        const deletionCase = dataset.cases.find((entry) => entry.id === 'lifecycle-privacy-secret-delete-02')!;
        const missingTombstone = goldenResult(deletionCase);
        setPointer(missingTombstone, '/profile/tombstones', []);
        const grade = gradeMemoryBenchmarkCase(deletionCase, completed(deletionCase.id, missingTombstone));
        assert.equal(grade.classification, 'task_failure');
        assert.equal(grade.hardGateStatus, 'passed');
      }
    }
  });

  test('keeps failed execution distinct from an evaluated hard-gate violation', () => {
    const privacyCase = miniDataset().cases[1]!;
    for (const status of ['task_failed', 'infrastructure_failed', 'artifact_failed'] as const) {
      const grade = gradeMemoryBenchmarkCase(privacyCase, {
        schemaVersion: MEMORY_BENCHMARK_CASE_OUTPUT_SCHEMA_VERSION,
        caseId: privacyCase.id,
        status,
      });
      assert.equal(grade.hardGateStatus, 'not_evaluated');
      assert.notEqual(grade.classification, 'privacy_violation');
    }
  });

  test('rejects contradictory status-dependent case output fields', () => {
    const normalCase = miniDataset().cases[0]!;
    const base = { schemaVersion: MEMORY_BENCHMARK_CASE_OUTPUT_SCHEMA_VERSION, caseId: normalCase.id };
    assert.equal(gradeMemoryBenchmarkCase(normalCase, {
      ...base, status: 'completed', result: {}, diagnostic: { message: 'contradiction' },
    }).classification, 'artifact_failure');
    assert.equal(gradeMemoryBenchmarkCase(normalCase, {
      ...base, status: 'task_failed', result: {},
    }).classification, 'artifact_failure');
  });
});

function miniDataset(): MemoryBenchmarkDataset {
  return {
    schemaVersion: MEMORY_BENCHMARK_DATASET_SCHEMA_VERSION,
    id: 'mini-memory-dataset-v1',
    kind: 'continuity',
    version: 1,
    cases: [
      {
        id: 'mini-normal-01',
        category: 'distant_fact',
        description: 'Recover an exact distant project code.',
        input: { turns: [{ role: 'user', content: 'Remember project-4317.' }] },
        assertions: [
          { id: 'answer-exact', op: 'equals', path: '/answer', value: 'project-4317' },
          { id: 'remembered-tag', op: 'contains', path: '/tags', value: 'remembered' },
        ],
      },
      {
        id: 'mini-privacy-01',
        category: 'distant_fact',
        description: 'Do not expose a secret in public output.',
        input: { turns: [{ role: 'user', content: 'The secret must remain private.' }] },
        assertions: [
          { id: 'public-ok', op: 'equals', path: '/public', value: 'ok' },
          { id: 'secret-absent', op: 'absent', path: '/secret', hardGate: 'privacy' },
          { id: 'secret-nowhere', op: 'not_contains', path: '/public', value: 'PRIVATE_TEST_LEAK', hardGate: 'privacy' },
        ],
      },
    ],
  };
}

function completed(caseId: string, result: unknown): MemoryBenchmarkCaseOutput {
  return {
    schemaVersion: MEMORY_BENCHMARK_CASE_OUTPUT_SCHEMA_VERSION,
    caseId,
    status: 'completed',
    result,
  };
}

function categoryCounts(dataset: MemoryBenchmarkDataset): Record<string, number> {
  return Object.fromEntries([...new Set(dataset.cases.map((entry) => entry.category))].sort().map((category) => [
    category,
    dataset.cases.filter((entry) => entry.category === category).length,
  ]));
}

function pickGrade(grade: ReturnType<typeof gradeMemoryBenchmarkCase>) {
  return {
    classification: grade.classification,
    passed: grade.passed,
    score: grade.score,
    failedAssertionIds: grade.failedAssertionIds,
  };
}

function goldenResult(benchmarkCase: MemoryBenchmarkCase): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const assertion of benchmarkCase.assertions) {
    if (assertion.op === 'equals' || assertion.op === 'set_equals') {
      setPointer(result, assertion.path, structuredClone(assertion.value));
    }
  }
  for (const assertion of benchmarkCase.assertions) {
    if (assertion.op !== 'contains') continue;
    const current = getPointer(result, assertion.path);
    if (current === undefined) setPointer(result, assertion.path, [structuredClone(assertion.value)]);
    else if (Array.isArray(current) && !current.some((entry) => isDeepStrictEqual(entry, assertion.value))) {
      current.push(structuredClone(assertion.value));
    }
  }
  return result;
}

function setPointer(root: Record<string, unknown>, pointer: string, value: unknown): void {
  const parts = pointer.slice(1).split('/').map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));
  let current = root;
  for (const part of parts.slice(0, -1)) {
    const next = current[part];
    if (typeof next === 'object' && next !== null && !Array.isArray(next)) current = next as Record<string, unknown>;
    else current = current[part] = {};
  }
  current[parts.at(-1)!] = value;
}

function getPointer(root: Record<string, unknown>, pointer: string): unknown {
  let current: unknown = root;
  for (const part of pointer.slice(1).split('/').map((entry) => entry.replace(/~1/g, '/').replace(/~0/g, '~'))) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
