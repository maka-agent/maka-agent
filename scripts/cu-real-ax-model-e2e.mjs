import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

import {
  AiSdkBackend,
  PermissionEngine,
  buildComputerUseTools,
  getAIModel,
} from '../packages/runtime/dist/index.js';
import { createCuaDriverBackend } from '../packages/computer-use/dist/index.js';
import { sanitizeCuDirectReport } from './cu-report-sanitize.mjs';

const repoRoot = new URL('..', import.meta.url).pathname;
const binaryPath = join(repoRoot, 'apps/desktop/resources/bin/cua-driver');
const labRoot = '/Users/haoqing/Documents/Learning/codex-computer-use-lab';
const expectedAppPath = join(labRoot, 'test-app/build/Codex CUA Lab.app');
const statePath = join(labRoot, 'test-app/runtime/state.json');
const fixturePID = Number(process.env.MAKA_CU_AX_MODEL_FIXTURE_PID);
const inputAgeProbe = process.env.MAKA_CU_AX_MODEL_INPUT_AGE_PROBE;
const temporaryDirectory = process.env.MAKA_CU_AX_MODEL_TEMP_DIR;
const provider = process.env.MAKA_CU_MODEL_PROVIDER ?? 'openai';
const baseUrl = process.env.MAKA_CU_MODEL_BASE_URL
  ?? (provider === 'anthropic'
    ? 'http://127.0.0.1:8537'
    : 'http://127.0.0.1:8538/v1');
const modelId = process.env.MAKA_CU_MODEL_ID
  ?? (provider === 'anthropic' ? 'claude-sonnet-4-6' : 'gpt-5.6-sol');
const apiKey = process.env.MAKA_CU_MODEL_API_KEY
  ?? (provider === 'anthropic' ? 'coproxy' : 'bridge-managed');
const scenario = process.env.MAKA_CU_AX_MODEL_SCENARIO ?? 'set-value';
const targetValue = 'model-real-ax';
const expectedBinarySha256 =
  '683dad5cccb47dd0a8bb5d534d62fbb9e6edfb1cded232509cf4c2b190066040';
const resolvedTemporaryDirectory = resolve(temporaryDirectory ?? '');
const relativeTemporaryDirectory = relative(resolve(tmpdir()), resolvedTemporaryDirectory);

if (
  !Number.isInteger(fixturePID)
  || fixturePID <= 0
  || !inputAgeProbe
  || !temporaryDirectory
  || relativeTemporaryDirectory.startsWith('..')
  || relativeTemporaryDirectory === ''
) {
  throw new Error('real AX model E2E requires launcher-owned inputs');
}

const startedAt = Date.now();
const traces = [];
const actions = [];
const messages = [];
const telemetry = [];
const semanticOutcomes = [];
let freshAxValue;
let injectedIntervention = false;
let restartRequested = false;
let staleRecoveryObserved = false;
let ambiguousRecoveryObserved = false;
let semanticStructureChangeRejected = false;
let ambiguityFixtureMutated = false;
let nextId = 0;
let now = Date.now();

async function physicalInputRecentlyActive() {
  const output = await new Promise((resolvePromise, reject) => {
    execFile(inputAgeProbe, [], {
      encoding: 'utf8',
      timeout: 1_000,
    }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message));
      else resolvePromise(stdout.trim());
    });
  });
  const ageSeconds = Number(output);
  if (!Number.isFinite(ageSeconds)) {
    throw new Error(`invalid physical input age: ${output}`);
  }
  return ageSeconds < 1;
}

const backend = createCuaDriverBackend({
  binaryPath,
  hostBundleId: 'com.maka.desktop',
  expectedBinarySha256,
  expectedServerName: 'cua-driver',
  expectedServerVersion: '0.7.1',
  expectedProtocolVersion: '2025-06-18',
  timeoutMs: 10_000,
  physicalInputRecentlyActive,
  allowCompatibilityInputDispatch: false,
  onTrace(event) {
    traces.push(event);
  },
});

const appSummaries = await backend.listApps(new AbortController().signal);
const fixtureMatches = appSummaries.filter((app) =>
  app.pid === fixturePID
  && (
    app.name === 'Codex CUA Lab'
    || app.windows?.some((window) => window.title === 'Codex CUA Lab')
  ));
if (fixtureMatches.length !== 1) {
  throw new Error(`expected one exact fixture app, got ${fixtureMatches.length}`);
}
let fixture = fixtureMatches[0];
const windows = fixture.windows?.filter((window) => window.title === 'Codex CUA Lab') ?? [];
if (windows.length !== 1) {
  throw new Error(`expected one exact fixture window, got ${windows.length}`);
}
let fixtureWindowId = windows[0].windowId;

const instrumentedBackend = {
  ...backend,
  async observeApp(input, signal, context) {
    const observation = await backend.observeApp(input, signal, context);
    if (
      scenario === 'ambiguity'
      && context.sessionId === 'real-ax-model-e2e'
      && !ambiguityFixtureMutated
    ) {
      ambiguityFixtureMutated = true;
      const setupContext = {
        sessionId: 'real-ax-model-ambiguity-setup',
        turnId: 'setup',
        toolCallId: 'fixture-mutate-ambiguity',
      };
      const setupObservation = await backend.observeApp({
        app: fixture.appId,
        windowId: fixtureWindowId,
        includeScreenshot: true,
      }, signal, setupContext);
      const mutation = setupObservation.elements.find(
        (element) => element.label === 'CUA Lab Duplicate Stale Target',
      );
      if (!mutation) throw new Error('ambiguity mutation control is missing');
      const setupResult = await backend.runSemantic({
        type: 'click_element',
        observationId: setupObservation.observationId,
        elementId: mutation.elementId,
        elementIdentity: mutation.identity,
      }, signal, setupContext);
      if (!setupResult.outcome.ok) {
        throw new Error(`ambiguity fixture mutation failed: ${setupResult.outcome.message}`);
      }
    }
    if (scenario === 'restart-recovery' && !restartRequested) {
      restartRequested = true;
      await writeFile(
        join(resolvedTemporaryDirectory, 'restart-request.json'),
        `${JSON.stringify({ oldPID: observation.pid })}\n`,
        { flag: 'wx', mode: 0o600 },
      );
      const completePath = join(resolvedTemporaryDirectory, 'restart-complete.json');
      const deadline = Date.now() + 15_000;
      let completed;
      while (Date.now() < deadline) {
        try {
          completed = JSON.parse(await readFile(completePath, 'utf8'));
          break;
        } catch (error) {
          if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      }
      if (!completed) throw new Error('restart completion timeout');
      const apps = await backend.listApps(signal);
      const currentMatches = apps.filter((app) =>
        app.pid === completed.newPID
        && (
          app.name === 'Codex CUA Lab'
          || app.windows?.some((window) => window.title === 'Codex CUA Lab')
        ));
      if (currentMatches.length !== 1) {
        throw new Error(`expected one restarted fixture, got ${currentMatches.length}`);
      }
      fixture = currentMatches[0];
      const currentWindows = fixture.windows?.filter(
        (window) => window.title === 'Codex CUA Lab',
      ) ?? [];
      if (currentWindows.length !== 1) {
        throw new Error(`expected one restarted fixture window, got ${currentWindows.length}`);
      }
      fixtureWindowId = currentWindows[0].windowId;
    }
    return observation;
  },
  async runSemantic(action, signal, context) {
    if (
      scenario === 'intervention-recovery'
      && action.type === 'set_value'
      && !injectedIntervention
    ) {
      injectedIntervention = true;
      return {
        outcome: {
          ok: false,
          error: 'user_intervened',
          message: 'synthetic intervention gate requires a fresh observation',
        },
      };
    }
    const result = await backend.runSemantic(action, signal, context);
    semanticOutcomes.push({
      actionType: action.type,
      ok: result.outcome.ok,
      ...(!result.outcome.ok
        ? {
            error: result.outcome.error,
            ambiguous: /ambiguous/i.test(result.outcome.message),
          }
        : {}),
    });
    if (
      scenario === 'restart-recovery'
      && !result.outcome.ok
      && result.outcome.error === 'target_missing'
    ) {
      staleRecoveryObserved = true;
    }
    if (
      scenario === 'ambiguity'
      && action.type === 'click_element'
      && !result.outcome.ok
      && result.outcome.error === 'stale_frame'
      && /ambiguous/.test(result.outcome.message)
    ) {
      ambiguousRecoveryObserved = true;
    }
    if (
      scenario === 'ambiguity'
      && action.type === 'click_element'
      && !result.outcome.ok
      && result.outcome.error === 'target_changed'
    ) {
      semanticStructureChangeRejected = true;
    }
    if (action.type === 'set_value' && result.outcome.ok) {
      const field = result.observation?.elements.find(
        (element) => element.label === 'CUA Lab Set Value Field',
      );
      freshAxValue = field?.value;
    }
    return result;
  },
};
const [rawComputerTool] = buildComputerUseTools({ backend: instrumentedBackend });
const computerTool = {
  ...rawComputerTool,
  async impl(args, context) {
    const action = args?.action;
    const allowed = scenario === 'observe-only'
      ? new Set(['list_apps', 'observe', 'wait'])
      : scenario === 'ax-click' || scenario === 'ambiguity'
        ? new Set(['list_apps', 'observe', 'click_element', 'wait'])
        : scenario === 'ax-multi-step'
          ? new Set(['list_apps', 'observe', 'set_value', 'click_element', 'wait'])
        : new Set(['list_apps', 'observe', 'set_value', 'wait']);
    if (typeof action !== 'string' || !allowed.has(action)) {
      throw new Error(`model action '${String(action)}' is outside the AX-only scenario budget`);
    }
    if (actions.length >= 8) {
      throw new Error('AX-only scenario action budget exceeded');
    }
    if (
      action === 'observe'
      && (
        args.app !== fixture.appId
        || args.window_id !== fixtureWindowId
      )
    ) {
      throw new Error('model observe target does not match the exact fixture identity');
    }
    const actionStartedAt = Date.now();
    const result = await rawComputerTool.impl(args, context);
    actions.push({
      action: { type: action },
      durationMs: Date.now() - actionStartedAt,
      text: result?.text,
    });
    return result;
  },
};

const connection = {
  slug: provider === 'anthropic' ? 'coproxy' : 'azure-bridge',
  name: provider === 'anthropic' ? 'Anthropic Coproxy' : 'Azure Bridge',
  providerType: provider,
  baseUrl,
  defaultModel: modelId,
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
};
const runtime = new AiSdkBackend({
  sessionId: 'real-ax-model-e2e',
  header: {
    id: 'real-ax-model-e2e',
    workspaceRoot: repoRoot,
    cwd: repoRoot,
    createdAt: now,
    lastUsedAt: now,
    name: 'Real AX Model E2E',
    isFlagged: false,
    labels: [],
    isArchived: false,
    status: 'active',
    statusUpdatedAt: now,
    hasUnread: false,
    backend: 'ai-sdk',
    llmConnectionSlug: connection.slug,
    connectionLocked: true,
    model: modelId,
    permissionMode: 'bypass',
    schemaVersion: 1,
  },
  appendMessage: async (message) => { messages.push(message); },
  connection,
  apiKey,
  modelId,
  permissionEngine: new PermissionEngine({
    newId: () => `permission-${++nextId}`,
    now: () => ++now,
  }),
  modelFactory: (input) => getAIModel(input),
  tools: [computerTool],
  maxSteps: 8,
  newId: () => `id-${++nextId}`,
  now: () => ++now,
  recordToolInvocation: (record) => {
    telemetry.push({
      toolName: record.toolName,
      status: record.status,
      errorClass: record.errorClass,
      argsSummary: record.argsSummary,
    });
  },
});

const events = [];
try {
  const task = scenario === 'observe-only'
    ? 'Use Maka Computer to inspect "Codex CUA Lab". Start with list_apps, observe '
      + 'the exact app/window, report that "CUA Lab Set Value Field" is visible, '
      + 'do not mutate anything, then finish.'
      : scenario === 'ax-click'
        ? 'Use Maka Computer to click the element labeled "CUA Lab Primary Button" exactly '
        + 'once in "Codex CUA Lab". Start with list_apps and observe, use click_element '
        + 'with IDs from that observation, verify the fresh state, then finish. Never use coordinates.'
      : scenario === 'ax-multi-step'
        ? `Use Maka Computer in "Codex CUA Lab" to complete two semantic actions in order. `
          + `First set "CUA Lab Set Value Field" to "${targetValue}" with set_value. `
          + 'Then use the fresh observation returned by that action to click '
          + '"CUA Lab Primary Button" exactly once with click_element. Verify both fresh '
          + 'results, then finish. Never use coordinates, scroll, drag, type, or key actions.'
      : scenario === 'ambiguity'
        ? 'Use Maka Computer to click the observed element labeled "CUA Lab Stale Target" '
          + 'exactly once in "Codex CUA Lab". Start with list_apps and observe, then use '
          + 'click_element with the exact observation_id and element_id. If the tool rejects '
          + 'the target, report the failure and stop rather than guessing or using coordinates.'
        : `Use Maka Computer to set "CUA Lab Set Value Field" in "Codex CUA Lab" `
      + `to "${targetValue}". Start with list_apps, observe the exact app/window, `
      + 'use set_value with the observation_id and element_id from that observation, '
      + 'verify the fresh observation value, then finish. If user_intervened is returned, '
      + 'observe again before retrying. If target_missing or stale_frame is returned, '
      + 'list apps and observe the current process again before retrying. Never use '
      + 'coordinate, click, scroll, drag, type, or key actions.';
  for await (const event of runtime.send({
    turnId: 'turn-real-ax-model',
    text: task,
    context: [],
  })) {
    events.push(event.type);
  }

  const fixtureState = JSON.parse(await readFile(statePath, 'utf8'));
  const setValueDispatches = traces.filter(
    (trace) => trace.type === 'dispatch'
      && trace.actionType === 'set_value'
      && trace.address === 'ax',
  );
  const clickDispatches = traces.filter(
    (trace) => trace.type === 'dispatch'
      && trace.actionType === 'click_element'
      && trace.address === 'ax',
  );
  const modelClickDispatches = clickDispatches.filter(
    (trace) => trace.toolCallId !== 'fixture-mutate-ambiguity',
  );
  const setupClickDispatches = clickDispatches.filter(
    (trace) => trace.toolCallId === 'fixture-mutate-ambiguity',
  );
  const forbiddenDispatches = traces.filter(
    (trace) => trace.type === 'dispatch' && trace.address === 'px',
  );
  if (
    !['observe-only', 'ax-click', 'ambiguity'].includes(scenario)
    && freshAxValue !== targetValue
  ) {
    throw new Error(`fresh AX value mismatch: ${String(freshAxValue)}`);
  }
  const expectedSetValueDispatches = (
    scenario === 'observe-only'
    || scenario === 'ax-click'
    || scenario === 'ambiguity'
  ) ? 0 : 1;
  if (setValueDispatches.length !== expectedSetValueDispatches) {
    throw new Error(
      `expected ${expectedSetValueDispatches} AX set_value dispatches, got ${setValueDispatches.length}`,
    );
  }
  const expectedClickDispatches = (
    scenario === 'ax-click' || scenario === 'ax-multi-step'
  ) ? 1 : 0;
  if (modelClickDispatches.length !== expectedClickDispatches) {
    throw new Error(
      `expected ${expectedClickDispatches} model AX click dispatches, got ${modelClickDispatches.length}`,
    );
  }
  if (scenario === 'ambiguity' && setupClickDispatches.length !== 1) {
    throw new Error(`expected one ambiguity setup AX dispatch, got ${setupClickDispatches.length}`);
  }
  if (forbiddenDispatches.length !== 0) {
    throw new Error(`forbidden pixel dispatch count: ${forbiddenDispatches.length}`);
  }
  if (scenario === 'restart-recovery' && !staleRecoveryObserved) {
    throw new Error('model restart scenario did not observe target_missing');
  }
  if (
    scenario === 'ambiguity'
    && !ambiguousRecoveryObserved
    && !semanticStructureChangeRejected
  ) {
    const safelyDeclined = actions.some((record) => record.action.type === 'observe')
      && !actions.some((record) => record.action.type === 'click_element')
      && modelClickDispatches.length === 0;
    if (!safelyDeclined) {
      throw new Error(
        `model ambiguity scenario neither failed closed nor safely declined: ${
          JSON.stringify({
            actionTypes: actions.map((record) => record.action.type),
            semanticOutcomes,
            setupClickDispatches: setupClickDispatches.length,
            modelClickDispatches: modelClickDispatches.length,
          })
        }`,
      );
    }
  }
  if (
    (scenario === 'ax-click' || scenario === 'ax-multi-step')
    && fixtureState.controls.buttonClickCount !== 1
  ) {
    throw new Error(`primary button count mismatch: ${fixtureState.controls.buttonClickCount}`);
  }
  if (
    scenario === 'ambiguity'
    && (
      fixtureState.hierarchy.mode !== 'ambiguous'
      || fixtureState.hierarchy.staleTargetClickCount !== 0
      || fixtureState.hierarchy.wrongTargetClickCount !== 0
    )
  ) {
    throw new Error(`ambiguous stale target mutated: ${JSON.stringify(fixtureState.hierarchy)}`);
  }
  if (
    fixtureState.synthetic !== true
    || fixtureState.appPath !== expectedAppPath
    || fixtureState.oop?.hostPID !== fixture.pid
  ) {
    throw new Error('fixture identity changed during model execution');
  }
  if (events.at(-1) !== 'complete') {
    throw new Error(`model Runtime did not complete: ${events.at(-1)}`);
  }

  const sanitized = sanitizeCuDirectReport({
    schemaVersion: 1,
    evidenceClass: 'real-runtime',
    scenarioId: scenario === 'observe-only'
      ? 'appkit-ax-observe-only'
      : scenario === 'intervention-recovery'
        ? 'appkit-ax-intervention-recovery'
        : scenario === 'restart-recovery'
          ? 'appkit-ax-restart-recovery'
          : scenario === 'ax-click'
            ? 'appkit-ax-click'
            : scenario === 'ax-multi-step'
              ? 'appkit-ax-multi-step'
            : scenario === 'ambiguity'
              ? 'appkit-ax-ambiguity'
              : 'appkit-ax-set-value',
    policyMode: 'enforced',
    producer: 'cu-real-ax-model-e2e',
    model: modelId,
    provider,
    baseUrl,
    totalLatencyMs: Date.now() - startedAt,
    loopStatus: 'completed',
    state: {
      fixtureIdentityValid: true,
      freshAxValueMatched: scenario === 'observe-only'
        || scenario === 'ax-click'
        || scenario === 'ambiguity'
          ? undefined
          : freshAxValue === targetValue,
      injectedIntervention,
      staleRecoveryObserved,
      ambiguousRecoveryObserved,
      semanticStructureChangeRejected,
      ambiguitySafelyDeclined: scenario === 'ambiguity'
        && !ambiguousRecoveryObserved
        && !semanticStructureChangeRejected,
      ambiguityFixtureMutated,
      setValueDispatches: setValueDispatches.length,
      clickDispatches: modelClickDispatches.length,
      setupClickDispatches: setupClickDispatches.length,
      pixelDispatches: forbiddenDispatches.length,
      primaryButtonClicks: fixtureState.controls.buttonClickCount,
      ambiguousClicks: fixtureState.hierarchy.staleTargetClickCount,
      terminalEvent: events.at(-1),
      toolCallsPersisted: messages.filter((message) => message.type === 'tool_call').length,
      toolResultsPersisted: messages.filter((message) => message.type === 'tool_result').length,
      telemetrySuccesses: telemetry.filter((record) => record.status === 'success').length,
      telemetryErrors: telemetry.filter((record) => record.status === 'error').length,
      telemetryErrorClasses: [
        ...new Set(
          telemetry
            .filter((record) => record.status === 'error')
            .map((record) => record.errorClass)
            .filter(Boolean),
        ),
      ],
      telemetryErrorActions: telemetry
        .filter((record) => record.status === 'error')
        .flatMap((record) => {
          try {
            const summary = JSON.parse(record.argsSummary ?? '{}');
            return typeof summary.action === 'string' ? [summary.action] : [];
          } catch {
            return [];
          }
        }),
      semanticFailures: semanticOutcomes.filter((outcome) => !outcome.ok).length,
      semanticFailureCode: semanticOutcomes.find((outcome) => !outcome.ok)?.error,
      ambiguousSemanticFailures: semanticOutcomes.filter(
        (outcome) => !outcome.ok && outcome.ambiguous,
      ).length,
    },
    actions,
    traces: traces.filter(
      (trace) => trace.toolCallId !== 'fixture-mutate-ambiguity',
    ),
  });
  const reportPath = join(resolvedTemporaryDirectory, 'real-ax-model-report.json');
  await writeFile(reportPath, `${JSON.stringify(sanitized, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  process.stdout.write(`${JSON.stringify(sanitized, null, 2)}\n`);
} finally {
  await runtime.dispose();
  backend.dispose();
}
