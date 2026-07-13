import { _electron as electron, chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evaluateCuE2eScenarioState,
  getCuE2eScenario,
} from './cu-e2e-scenarios.mjs';
import {
  sanitizeCuActionRecord,
  sanitizeCuTrace,
} from './cu-report-sanitize.mjs';
import {
  createAgentRunStore,
  createConnectionStore,
  createFileCredentialStore,
} from '../packages/storage/dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const sourceWorkspace = join(
  homedir(),
  'Library',
  'Application Support',
  'Maka',
  'workspaces',
  'default',
);
const scenario = getCuE2eScenario(
  process.env.MAKA_CU_E2E_SCENARIO ?? 'l0-observe-only',
);
if (!scenario.realRunEnabled) {
  throw new Error(`scenario ${scenario.id} is not enabled for real-model runs`);
}

const timeoutMs = Number(process.env.MAKA_CU_REAL_MODEL_TIMEOUT_MS ?? 180_000);
const keepProfile = process.env.MAKA_CU_KEEP_PROFILE === '1';
const providerOverride = process.env.MAKA_CU_PROVIDER;
const reportPath = process.env.MAKA_CU_REAL_MODEL_REPORT
  ?? join(
    repoRoot,
    '.agents-workspace-data',
    'cu-real-model',
    `report-${Date.now()}.json`,
  );
const runPrompt =
  'Use the maka_computer tool to complete this task. '
  + scenario.prompt;

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  if (!port) throw new Error('failed to reserve loopback port');
  return port;
}

async function copyProfileFile(name, workspace) {
  await cp(join(sourceWorkspace, name), join(workspace, name), {
    errorOnExist: true,
  });
}

async function prepareProviderProfile(workspace) {
  if (!providerOverride) {
    await Promise.all([
      copyProfileFile('llm-connections.json', workspace),
      copyProfileFile('credentials.json', workspace),
      copyProfileFile('settings.json', workspace),
    ]);
    return;
  }
  if (providerOverride !== 'openai') {
    throw new Error(`unsupported MAKA_CU_PROVIDER ${providerOverride}`);
  }
  await copyProfileFile('settings.json', workspace);
  const connections = createConnectionStore(workspace);
  const credentials = createFileCredentialStore(workspace);
  const slug = 'cu-real-openai';
  await connections.create({
    slug,
    name: 'Computer Use real-model OpenAI',
    providerType: 'openai',
    baseUrl: process.env.MAKA_CU_OPENAI_BASE_URL ?? 'http://127.0.0.1:8538/v1',
    defaultModel: process.env.MAKA_CU_OPENAI_MODEL ?? 'gpt-5.4',
  });
  await credentials.setSecret(
    slug,
    'api_key',
    process.env.MAKA_CU_OPENAI_API_KEY ?? 'local-bridge',
  );
  await connections.setDefault(slug);
}

async function waitForLine(child, marker, timeout) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for ${marker}`)),
      timeout,
    );
    const onData = (chunk) => {
      stdout += String(chunk);
      process.stdout.write(chunk);
      if (stdout.includes(marker)) {
        clearTimeout(timer);
        child.stdout.off('data', onData);
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`fixture exited before ready: ${signal ?? `code ${code}`}`));
    });
  });
}

function actionRecords(events) {
  const starts = new Map();
  const records = [];
  for (const event of events) {
    if (event.type === 'tool_start' && event.toolName === 'maka_computer') {
      starts.set(event.toolUseId, event);
    }
    if (event.type === 'tool_result' && starts.has(event.toolUseId)) {
      const start = starts.get(event.toolUseId);
      records.push(sanitizeCuActionRecord({
        action: start.args,
        durationMs: event.durationMs,
        text: event.content?.kind === 'text' ? event.content.text : undefined,
      }));
    }
  }
  return records;
}

function safeEvent(event) {
  if (event.type === 'tool_start') {
    const safeToolName = event.toolName === 'load_tools'
      || event.toolName === 'maka_computer'
      ? event.toolName
      : 'other';
    return {
      type: event.type,
      toolName: safeToolName,
      ...(event.toolName === 'maka_computer'
        ? { actionType: event.args?.action ?? 'unknown' }
        : {}),
      ts: event.ts,
    };
  }
  if (event.type === 'tool_result') {
    return {
      type: event.type,
      isError: event.isError,
      durationMs: event.durationMs,
      ts: event.ts,
    };
  }
  if (
    event.type === 'complete'
    || event.type === 'abort'
    || event.type === 'error'
  ) {
    const safeCode = [event.code, event.reason].find((value) =>
      typeof value === 'string'
      && /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(value));
    return {
      type: event.type,
      ...(event.stopReason ? { stopReason: event.stopReason } : {}),
      ...(safeCode ? { code: safeCode } : {}),
      ts: event.ts,
    };
  }
  return null;
}

function safeFailureMetadata(message) {
  if (typeof message !== 'string') return undefined;
  const status = message.match(/\b([45]\d\d)\b/)?.[1];
  const errorName = message.match(/\b([A-Z][A-Za-z]+Error)\b/)?.[1];
  const providerType = message.match(
    /\b(api_error|authentication_error|billing_error|invalid_request_error|overloaded_error|permission_error|rate_limit_error)\b/i,
  )?.[1]?.toLowerCase();
  const result = {
    ...(status ? { httpStatus: Number(status) } : {}),
    ...(errorName ? { errorName } : {}),
    ...(providerType ? { providerErrorType: providerType } : {}),
  };
  return Object.keys(result).length > 0 ? result : undefined;
}

async function run() {
  const userData = await mkdtemp(join(tmpdir(), 'maka-cu-real-model-'));
  const workspace = join(userData, 'workspaces', 'default');
  const tracePath = join(userData, 'computer-use-trace.jsonl');
  const fixturePort = await reservePort();
  const electronBinary = join(repoRoot, 'node_modules', '.bin', 'electron');
  let fixture;
  let desktop;
  let fixtureBrowser;
  try {
    await mkdir(workspace, { recursive: true });
    await mkdir(dirname(reportPath), { recursive: true });
    await prepareProviderProfile(workspace);

    fixture = spawn(electronBinary, [
      `--remote-debugging-port=${fixturePort}`,
      '--remote-allow-origins=*',
      join(here, 'cu-real-model-fixture.mjs'),
    ], {
      cwd: repoRoot,
      env: {
        ...process.env,
        MAKA_CU_E2E_SCENARIO: scenario.id,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitForLine(fixture, 'CU_FIXTURE_READY', 30_000);

    desktop = await electron.launch({
      args: ['apps/desktop'],
      cwd: repoRoot,
      env: {
        ...process.env,
        MAKA_CU_REAL_MODEL_E2E: '1',
        MAKA_E2E_USER_DATA_DIR: userData,
        MAKA_CU_REAL_MODEL_POLICY: JSON.stringify({
          allowedActions: scenario.allowedActions,
          maxTotalActions: scenario.maxTotalActions,
        }),
        MAKA_CU_REAL_MODEL_TRACE: tracePath,
      },
      timeout: 30_000,
    });
    const page = await desktop.firstWindow();
    await page.waitForFunction(() => Boolean(window.maka?.sessions));

    const runResult = await page.evaluate(async ({ prompt, timeout }) => {
      const connections = await window.maka.connections.list();
      const defaultSlug = await window.maka.connections.getDefault();
      const connection = connections.find((entry) => entry.slug === defaultSlug);
      if (!connection?.defaultModel) {
        throw new Error('isolated profile has no ready default model');
      }
      const session = await window.maka.sessions.create({
        backend: 'ai-sdk',
        llmConnectionSlug: connection.slug,
        model: connection.defaultModel,
        permissionMode: 'bypass',
        name: 'Computer Use real-model E2E',
        labels: ['computer-use', 'real-model-e2e'],
      });
      const events = [];
      const terminal = new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('real-model turn timed out')),
          timeout,
        );
        const unsubscribe = window.maka.sessions.subscribeEvents(
          session.id,
          (event) => {
            events.push(event);
            if (
              event.type === 'complete'
              || event.type === 'abort'
              || event.type === 'error'
            ) {
              clearTimeout(timer);
              unsubscribe();
              resolve(event);
            }
          },
        );
      });
      const turnId = crypto.randomUUID();
      await window.maka.sessions.send(session.id, {
        type: 'send',
        turnId,
        text: prompt,
      });
      const terminalEvent = await terminal;
      return {
        connection: {
          slug: connection.slug,
          providerType: connection.providerType,
          model: connection.defaultModel,
        },
        sessionId: session.id,
        turnId,
        events,
        terminalEvent,
      };
    }, { prompt: runPrompt, timeout: timeoutMs });

    fixtureBrowser = await chromium.connectOverCDP(
      `http://127.0.0.1:${fixturePort}`,
    );
    const fixturePages = fixtureBrowser.contexts().flatMap((context) => context.pages());
    const fixtureState = {};
    for (const windowSpec of scenario.fixtureSetup.windows) {
      const pageForTitle = await Promise.all(
        fixturePages.map(async (candidate) => ({
          candidate,
          title: await candidate.title(),
        })),
      ).then((entries) =>
        entries.find((entry) => entry.title === windowSpec.title)?.candidate);
      if (!pageForTitle) throw new Error(`missing fixture page ${windowSpec.title}`);
      fixtureState[windowSpec.id] = await pageForTitle.evaluate(
        () => globalThis.__makaCuFixtureState?.() ?? null,
      );
    }
    const evaluation = evaluateCuE2eScenarioState(scenario, fixtureState);
    const events = runResult.events.map(safeEvent).filter(Boolean);
    const actions = actionRecords(runResult.events);
    const driverTraces = await readFile(tracePath, 'utf8')
      .then((text) => text.split('\n').filter(Boolean).map((line) => JSON.parse(line)))
      .catch((error) => {
        if (error?.code === 'ENOENT') return [];
        throw error;
      });
    const runStore = createAgentRunStore(workspace);
    const runHeaders = await runStore.listSessionRuns(runResult.sessionId);
    const runHeader = runHeaders.find((entry) =>
      entry.turnId === runResult.turnId);
    const actionCounts = Object.fromEntries(
      scenario.allowedActions.map((action) => [
        action,
        actions.filter((record) => record.type === action).length,
      ]),
    );
    const minimumActionsPassed = Object.entries(
      scenario.minimumActionCounts ?? {},
    ).every(([action, minimum]) => (actionCounts[action] ?? 0) >= minimum);
    const terminalPassed =
      runResult.terminalEvent.type === 'complete'
      && runResult.terminalEvent.stopReason !== 'user_stop';
    const qualified = terminalPassed && minimumActionsPassed && evaluation.pass;
    const report = {
      schemaVersion: 1,
      evidenceClass: 'real-runtime',
      policyMode: 'bypassed',
      toolExposure: 'direct-e2e',
      scenarioId: scenario.id,
      producer: 'cu-real-model-launcher',
      transportClass: 'live-network',
      provider: runResult.connection.providerType,
      model: runResult.connection.model,
      terminal: safeEvent(runResult.terminalEvent),
      run: runHeader
        ? {
            status: runHeader.status,
            failureClass: runHeader.failureClass,
            failure: safeFailureMetadata(runHeader.failureMessage),
            durationMs: runHeader.completedAt !== undefined
              ? Math.max(0, runHeader.completedAt - runHeader.createdAt)
              : undefined,
          }
        : undefined,
      actionCount: actions.length,
      actionCounts,
      minimumActionsPassed,
      actions,
      fixtureState,
      expectedState: evaluation.expected,
      forbiddenEffects: {
        status: evaluation.forbidden.every((entry) => entry.pass)
          ? 'pass'
          : 'fail',
        violations: evaluation.forbidden.filter((entry) => !entry.pass),
      },
      status: qualified
        ? 'pass'
        : terminalPassed && minimumActionsPassed
          ? 'fail'
          : 'inconclusive',
      traces: events.map(sanitizeCuTrace).filter(Boolean),
      driverTraces: driverTraces.map(sanitizeCuTrace).filter(Boolean),
    };
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    process.stdout.write(`Real-model Computer Use report: ${reportPath}\n`);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!qualified) process.exitCode = 1;
  } finally {
    await fixtureBrowser?.close().catch(() => {});
    await desktop?.close().catch(() => {});
    if (fixture && fixture.exitCode === null) fixture.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (fixture && fixture.exitCode === null) fixture.kill('SIGKILL');
    if (keepProfile) {
      process.stderr.write(`Retained isolated debug profile: ${userData}\n`);
    } else {
      await rm(userData, { recursive: true, force: true });
    }
  }
}

run().catch(async (error) => {
  const failure = {
    schemaVersion: 1,
    evidenceClass: 'real-runtime',
    scenarioId: scenario.id,
    producer: 'cu-real-model-launcher',
    status: 'inconclusive',
    failure: error instanceof Error ? error.message : String(error),
  };
  await mkdir(dirname(reportPath), { recursive: true }).catch(() => {});
  await writeFile(reportPath, `${JSON.stringify(failure, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  }).catch(() => {});
  console.error('Real-model Computer Use E2E failed:', failure.failure);
  process.exitCode = 1;
});
