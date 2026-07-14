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

function scenario(overrides = {}) {
  return {
    id: 'click',
    label: 'Owned fixture click',
    prompt: 'Click blue once',
    fixtureSetup: {
      layout: 'single',
      windows: [{ id: 'target', title: 'Fixture', kind: 'single-click' }],
    },
    expectedState: [
      { windowId: 'target', path: 'blue', equals: 1 },
      { windowId: 'target', path: 'red', equals: 0 },
    ],
    forbiddenEffects: [
      { windowId: 'target', path: 'red', equals: 0, description: 'red stays zero' },
    ],
    allowedActions: ['observe', 'click_element'],
    minimumActionCounts: { observe: 1, click_element: 1 },
    maxActionCounts: { observe: 2, click_element: 1 },
    maxTotalActions: 3,
    ...overrides,
  };
}

function realReport(overrides = {}) {
  return {
    schemaVersion: 1,
    scenarioId: 'click',
    evidenceClass: 'real-runtime',
    producer: 'cu-real-model-launcher',
    transportClass: 'live-network',
    policyMode: 'enforced',
    provider: 'openai',
    model: 'gpt-5.4',
    status: 'pass',
    terminal: { type: 'complete', stopReason: 'end_turn' },
    actions: [
      { type: 'observe', success: true, targetOwned: true, durationMs: 20 },
      { type: 'click_element', success: true, targetOwned: true, durationMs: 30 },
    ],
    actionCount: 2,
    minimumActionsPassed: true,
    actionsWithinBudget: true,
    dispatchPathPassed: true,
    fixtureState: { target: { blue: 1, red: 0 } },
    forbiddenEffects: { status: 'pass', violations: [] },
    driverTraces: [
      {
        type: 'dispatch',
        actionType: 'click_element',
        tool: 'click',
        address: 'ax',
      },
    ],
    ...overrides,
  };
}

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
    fixtureState: { target: { blue: 1, red: 0 } },
  }, scenario());

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
    ['/reports/claude-click.json', realReport({
      provider: 'claude',
      model: 'claude-sonnet',
      actions: [
        { type: 'observe', success: true, targetOwned: true, modelLatencyMs: 100, toolLatencyMs: 25, displayLagMs: 5 },
        { type: 'click_element', success: true, targetOwned: true, durationMs: 30 },
      ],
    })],
    ['/reports/openai-click.json', realReport({
      status: 'fail',
      fixtureState: { target: { blue: 1, red: 1 } },
      forbiddenEffects: {
        status: 'fail',
        violations: [{ windowId: 'target', path: 'red', actual: 1, pass: false }],
      },
    })],
  ]);
  const scenarios = [scenario()];
  const providers = [
    {
      id: 'claude',
      label: 'Claude',
      readiness: 'real',
      model: 'claude-sonnet',
      commandTemplate: ['npm', 'run', 'e2e:computer-use:model', '--', '{scenarioId}'],
      reportTemplate: '/reports/{providerId}-{scenarioId}.json',
    },
    {
      id: 'openai',
      label: 'OpenAI',
      readiness: 'real',
      model: 'gpt-5.4',
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
    'invalid-report': 1,
    'contract-only': 1,
    unsupported: 1,
  });
  assert.equal(matrix.rows[0].command, 'npm run e2e:computer-use:model -- click');
  assert.equal(matrix.rows[0].modelLatency.p50Ms, 100);
  assert.equal(matrix.rows[1].status, 'invalid-report');
  assert.match(matrix.rows[1].reportError, /status must be pass/);
  assert.equal(matrix.rows[2].actionCount, null);
  assert.equal(matrix.rows[3].status, 'unsupported');

  const markdown = renderMarkdown(matrix);
  assert.match(markdown, /Claude \| Owned fixture click \| real \| real-runtime \| enforced \| pass/);
  assert.match(markdown, /OpenAI \| Owned fixture click \| real \| - \| - \| invalid-report/);
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
    writeFile(scenariosPath, JSON.stringify({ scenarios: [scenario()] })),
    writeFile(providersPath, JSON.stringify({
      providers: [
        {
          id: 'claude',
          readiness: 'real',
          model: 'gpt-5.4',
          commandTemplate: `${process.execPath} -e "require('node:fs').writeFileSync('${marker}','bad')"`,
          reportTemplate: '{providerId}-{scenarioId}.json',
        },
        { id: 'openai', readiness: 'contract', commandTemplate: 'openai {scenarioId}' },
        { id: 'kimi', readiness: 'contract', commandTemplate: 'kimi {scenarioId}' },
        { id: 'minimax', readiness: 'unsupported' },
      ],
    })),
    writeFile(reportPath, JSON.stringify(realReport({
      provider: 'claude',
      model: 'gpt-5.4',
    }))),
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
    scenarios: [scenario({ id: 'l0-observe-only' })],
    providers: [{
      id: 'openai',
      readiness: 'real',
      report: 'report.json',
    }],
    loadReport: async () => realReport({ scenarioId: 'l1-single-click' }),
  });
  assert.equal(matrix.rows[0].status, 'invalid-report');
  assert.match(matrix.rows[0].reportError, /scenarioId mismatch/);
});

test('a hermetic or unlabeled report cannot satisfy real-provider readiness', async () => {
  for (const evidenceClass of [undefined, 'hermetic-protocol']) {
    const matrix = await buildProviderMatrix({
      scenarios: [scenario()],
      providers: [{ id: 'openai', readiness: 'real', model: 'gpt-5.4', report: 'report.json' }],
      loadReport: async () => realReport({ evidenceClass }),
    });
    assert.equal(matrix.rows[0].status, 'invalid-report');
    assert.match(matrix.rows[0].reportError, /real-runtime/);
  }
});

test('a bypassed real run remains explicitly labeled', async () => {
  const matrix = await buildProviderMatrix({
    scenarios: [scenario()],
    providers: [{ id: 'openai', readiness: 'real', model: 'gpt-5.4', report: 'report.json' }],
    loadReport: async () => realReport({ policyMode: 'bypassed' }),
  });
  assert.equal(matrix.rows[0].status, 'pass-policy-bypassed');
});

for (const [label, patch, pattern] of [
  ['inconclusive status', { status: 'inconclusive' }, /status must be pass/],
  ['wrong provider', { provider: 'claude' }, /provider mismatch/],
  ['wrong model', { model: 'other' }, /model mismatch/],
  ['bad terminal', { terminal: { type: 'complete', stopReason: 'max_tokens' } }, /complete\/end_turn/],
  ['failed action', {
    actions: [
      { type: 'observe', success: false, targetOwned: true },
      { type: 'click_element', success: true, targetOwned: true },
    ],
  }, /successful, owned, and allowed/],
  ['wrong target', {
    actions: [
      { type: 'observe', success: true, targetOwned: false },
      { type: 'click_element', success: true, targetOwned: true },
    ],
  }, /successful, owned, and allowed/],
  ['missing dispatch', { driverTraces: [] }, /dispatch evidence missing/],
]) {
  test(`real report rejects ${label}`, async () => {
    const report = realReport(patch);
    report.actionCount = report.actions.length;
    const matrix = await buildProviderMatrix({
      scenarios: [scenario()],
      providers: [{
        id: 'openai',
        readiness: 'real',
        model: 'gpt-5.4',
        report: 'report.json',
      }],
      loadReport: async () => report,
    });
    assert.equal(matrix.rows[0].status, 'invalid-report');
    assert.match(matrix.rows[0].reportError, pattern);
  });
}

test('missing forbidden-effect evidence is inconclusive', () => {
  const metrics = normalizeReport(
    realReport({ fixtureState: { target: { blue: 1 } } }),
    scenario(),
  );
  assert.equal(metrics.forbiddenEffects.status, 'unknown');
});

test('malformed reported violations do not crash normalization', () => {
  const metrics = normalizeReport(realReport({
    forbiddenEffects: { status: 'fail', violations: 'bad' },
  }), scenario());
  assert.equal(metrics.forbiddenEffects.status, 'fail');
  assert.ok(Array.isArray(metrics.forbiddenEffects.violations));
});

test('over-budget action sequence is invalid', async () => {
  const report = realReport({
    actions: [
      { type: 'observe', success: true, targetOwned: true },
      { type: 'observe', success: true, targetOwned: true },
      { type: 'observe', success: true, targetOwned: true },
      { type: 'click_element', success: true, targetOwned: true },
    ],
    actionCount: 4,
  });
  const matrix = await buildProviderMatrix({
    scenarios: [scenario()],
    providers: [{ id: 'openai', readiness: 'real', model: 'gpt-5.4', report: 'r' }],
    loadReport: async () => report,
  });
  assert.equal(matrix.rows[0].status, 'invalid-report');
  assert.match(matrix.rows[0].reportError, /budget exceeded/);
});
