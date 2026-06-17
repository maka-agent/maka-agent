import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { ResultRecord } from '../contracts.js';
import { readResults, toComparisonTable, writeResults } from '../results.js';

function record(taskId: string, configId: string, passed: boolean, extra: Partial<ResultRecord> = {}): ResultRecord {
  return {
    taskId,
    configId,
    sessionId: `s-${taskId}-${configId}`,
    runId: `r-${taskId}-${configId}`,
    status: 'completed',
    passed,
    exitCode: passed ? 0 : 1,
    steps: 3,
    durationMs: 100,
    startedAt: 0,
    finishedAt: 100,
    ...extra,
  };
}

describe('results JSONL', () => {
  test('round-trips records through JSONL', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-headless-res-'));
    try {
      const path = join(dir, 'nested', 'results.jsonl');
      const records = [record('t1', 'a', true), record('t1', 'b', false)];
      await writeResults(path, records);
      assert.deepEqual(await readResults(path), records);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('toComparisonTable', () => {
  test('renders tasks × configs with a pass-rate footer', () => {
    const table = toComparisonTable([
      record('t1', 'a', true),
      record('t1', 'b', false),
      record('t2', 'a', true),
      record('t2', 'b', true),
    ]);
    const lines = table.trimEnd().split('\n');
    assert.equal(lines[0], '| Task | a | b |');
    assert.equal(lines[1], '| --- | --- | --- |');
    assert.equal(lines[2], '| t1 | ✅ | ❌ |');
    assert.equal(lines[3], '| t2 | ✅ | ✅ |');
    assert.equal(lines[4], '| **pass rate** | 2/2 | 1/2 |');
  });

  test('marks errored cells distinctly from plain failures', () => {
    const table = toComparisonTable([record('t1', 'a', false, { status: 'failed', error: 'boom' })]);
    assert.match(table, /\| t1 \| ⚠️ \|/);
  });

  test('a failed run renders ⚠️ and is excluded from the pass count', () => {
    const table = toComparisonTable([
      record('t1', 'a', true, { status: 'failed' }), // crashed; stale passed flag
      record('t1', 'b', true),
    ]);
    const lines = table.trimEnd().split('\n');
    assert.equal(lines[2], '| t1 | ⚠️ | ✅ |');
    assert.equal(lines[3], '| **pass rate** | 0/1 | 1/1 |');
  });

  test('escapes pipe characters in ids so they cannot break the table', () => {
    const table = toComparisonTable([record('a|b', 'c|d', true)]);
    assert.match(table, /a\\\|b/);
    assert.match(table, /c\\\|d/);
  });
});
