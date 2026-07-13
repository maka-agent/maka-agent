import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  buildProviderMatrix,
  normalizeReport,
  renderMarkdown,
  summarizeLatency,
} from './cu-provider-matrix.mjs';

test('summarizeLatency reports stable aggregate latency metrics', () => {
  assert.deepEqual(summarizeLatency([40, 10, 30, 20]), {
    samples: 4,
    averageMs: 25,
    p50Ms: 20,
    p95Ms: 40,
    maxMs: 40,
  });
  assert.equal(summarizeLatency([null, undefined, Number.NaN]), null);
});

test('normalizeReport unifies real-model and direct-provider report fields', () => {
  const metrics = normalizeReport({
    actions: [
      { modelLatencyMs: 120, toolLatencyMs: 40, displayLagMs: 8 },
      { modelLatencyMs: 80, durationMs: 20, displayLagMs: 4, retry: true },
    ],
    fixtureState: { blue: 1, red: 0, note: '' },
    forbiddenEffects: [],
  }, {
    fixture: { expected: { blue: 1, red: 0 } },
    forbiddenEffects: [
      'foreground-focus',
      { id: 'red-click', path: 'fixtureState.red', equals: 0 },
    ],
  });

  assert.equal(metrics.modelLatency.averageMs, 100);
  assert.equal(metrics.toolLatency.averageMs, 30);
  assert.equal(metrics.displayLag.p50Ms, 4);
  assert.equal(metrics.actionCount, 2);
  assert.equal(metrics.retries, 1);
  assert.equal(metrics.fixture.status, 'pass');
  assert.equal(metrics.forbiddenEffects.status, 'pass');
});

test('buildProviderMatrix covers Claude, OpenAI, Kimi, and MiniMax readiness', async () => {
  const reports = new Map([
    ['/reports/claude-click.json', {
      scenarioId: 'click',
      evidenceClass: 'real-runtime',
      policyMode: 'enforced',
      actions: [{ modelLatencyMs: 100, toolLatencyMs: 25, displayLagMs: 5 }],
      fixtureState: { blue: 1, red: 0 },
      forbiddenEffects: [],
    }],
    ['/reports/openai-click.json', {
      scenarioId: 'click',
      evidenceClass: 'real-runtime',
      policyMode: 'enforced',
      actions: [{ durationMs: 30 }, { durationMs: 50 }],
      actionCount: 2,
      retries: 0,
      state: { blue: 1, red: 1 },
      forbiddenEffects: ['red-click'],
    }],
  ]);
  const scenarios = [{
    id: 'click',
    label: 'Owned fixture click',
    prompt: 'Click blue once',
    fixture: { expected: { blue: 1, red: 0 } },
    forbiddenEffects: ['red-click'],
  }];
  const providers = [
    {
      id: 'claude',
      label: 'Claude',
      readiness: 'real',
      commandTemplate: ['npm', 'run', 'e2e:computer-use:model', '--', '{scenarioId}'],
      reportTemplate: '/reports/{providerId}-{scenarioId}.json',
    },
    {
      id: 'openai',
      label: 'OpenAI',
      readiness: 'real',
      commandTemplate: 'npm run e2e:computer-use:openai -- {scenarioId}',
      reportTemplate: '/reports/{providerId}-{scenarioId}.json',
    },
    { id: 'kimi', label: 'Kimi', readiness: 'contract', commandTemplate: 'node kimi.mjs {scenarioId}' },
    { id: 'minimax', label: 'MiniMax', readiness: 'unsupported' },
  ];
  const matrix = await buildProviderMatrix({
    scenarios,
    providers,
    generatedAt: '2026-07-12T00:00:00.000Z',
    loadReport: async (path) => {
      if (!reports.has(path)) {
        const error = new Error('missing');
        error.code = 'ENOENT';
        throw error;
      }
      return reports.get(path);
    },
  });

  assert.deepEqual(matrix.summary.readiness, { real: 2, contract: 1, unsupported: 1 });
  assert.deepEqual(matrix.summary.status, {
    pass: 1,
    fail: 1,
    'contract-only': 1,
    unsupported: 1,
  });
  assert.equal(matrix.rows[0].command, 'npm run e2e:computer-use:model -- click');
  assert.equal(matrix.rows[0].modelLatency.p50Ms, 100);
  assert.equal(matrix.rows[1].forbiddenEffects.status, 'fail');
  assert.equal(matrix.rows[2].actionCount, null);
  assert.equal(matrix.rows[3].status, 'unsupported');

  const markdown = renderMarkdown(matrix);
  assert.match(markdown, /Claude \| Owned fixture click \| real \| real-runtime \| enforced \| pass/);
  assert.match(markdown, /OpenAI \| Owned fixture click \| real \| real-runtime \| enforced \| fail/);
  assert.match(markdown, /Kimi \| Owned fixture click \| contract \| - \| - \| contract-only/);
  assert.match(markdown, /MiniMax \| Owned fixture click \| unsupported \| - \| - \| unsupported/);
});

test('CLI writes JSON and Markdown without executing provider command templates', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cu-provider-matrix-'));
  const marker = join(dir, 'provider-command-ran');
  const scenariosPath = join(dir, 'scenarios.json');
  const providersPath = join(dir, 'providers.json');
  const reportPath = join(dir, 'claude-click.json');
  const jsonPath = join(dir, 'output', 'matrix.json');
  const markdownPath = join(dir, 'output', 'matrix.md');
  await Promise.all([
    writeFile(scenariosPath, JSON.stringify({
      scenarios: [{
        id: 'click',
        fixture: { expected: { blue: 1, red: 0 } },
        forbiddenEffects: ['red-click'],
      }],
    })),
    writeFile(providersPath, JSON.stringify({
      providers: [
        {
          id: 'claude',
          readiness: 'real',
          commandTemplate: `${process.execPath} -e "require('node:fs').writeFileSync('${marker}','bad')"`,
          reportTemplate: '{providerId}-{scenarioId}.json',
        },
        { id: 'openai', readiness: 'contract', commandTemplate: 'openai {scenarioId}' },
        { id: 'kimi', readiness: 'contract', commandTemplate: 'kimi {scenarioId}' },
        { id: 'minimax', readiness: 'unsupported' },
      ],
    })),
    writeFile(reportPath, JSON.stringify({
      scenarioId: 'click',
      evidenceClass: 'real-runtime',
      policyMode: 'enforced',
      actions: [{ modelLatencyMs: 50, toolLatencyMs: 10, displayLagMs: 2 }],
      fixtureState: { blue: 1, red: 0 },
      forbiddenEffects: [],
    })),
  ]);

  const result = spawnSync(process.execPath, [
    new URL('./cu-provider-matrix.mjs', import.meta.url).pathname,
    '--scenarios', scenariosPath,
    '--providers', providersPath,
    '--json', jsonPath,
    '--markdown', markdownPath,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  await assert.rejects(readFile(marker, 'utf8'), { code: 'ENOENT' });

  const json = JSON.parse(await readFile(jsonPath, 'utf8'));
  const markdown = await readFile(markdownPath, 'utf8');
  assert.equal(json.rows.length, 4);
  assert.equal(json.rows[0].status, 'pass');
  assert.match(markdown, /# Computer Use Provider E2E Matrix/);
});

test('invalid readiness fails closed', async () => {
  await assert.rejects(
    buildProviderMatrix({
      scenarios: [{ id: 'click' }],
      providers: [{ id: 'claude', readiness: 'maybe' }],
    }),
    /invalid readiness/,
  );
});

test('a real report from another scenario is invalid instead of a fixture failure', async () => {
  const matrix = await buildProviderMatrix({
    scenarios: [{
      id: 'l0-observe-only',
      fixture: { expected: { interactions: 0 } },
      forbiddenEffects: [],
    }],
    providers: [{
      id: 'openai',
      readiness: 'real',
      report: 'report.json',
    }],
    loadReport: async () => ({
      scenarioId: 'l1-single-click',
      evidenceClass: 'real-runtime',
      policyMode: 'enforced',
      fixtureState: { interactions: 0 },
    }),
  });
  assert.equal(matrix.rows[0].status, 'invalid-report');
  assert.match(matrix.rows[0].reportError, /scenario mismatch/);
});

test('a hermetic or unlabeled report cannot satisfy real-provider readiness', async () => {
  for (const evidenceClass of [undefined, 'hermetic-protocol']) {
    const matrix = await buildProviderMatrix({
      scenarios: [{ id: 'click' }],
      providers: [{ id: 'openai', readiness: 'real', report: 'report.json' }],
      loadReport: async () => ({
        scenarioId: 'click',
        evidenceClass,
      }),
    });
    assert.equal(matrix.rows[0].status, 'invalid-report');
    assert.match(matrix.rows[0].reportError, /real-runtime/);
  }
});

test('a bypassed real run is labeled instead of reported as an unqualified pass', async () => {
  const matrix = await buildProviderMatrix({
    scenarios: [{ id: 'click' }],
    providers: [{ id: 'openai', readiness: 'real', report: 'report.json' }],
    loadReport: async () => ({
      scenarioId: 'click',
      evidenceClass: 'real-runtime',
      policyMode: 'bypassed',
    }),
  });
  assert.equal(matrix.rows[0].status, 'pass-policy-bypassed');
});
