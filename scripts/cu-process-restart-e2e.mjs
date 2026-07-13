import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { createCuaDriverBackend } from '../packages/computer-use/dist/index.js';
import { buildComputerUseTools } from '../packages/runtime/dist/index.js';

const repoRoot = new URL('..', import.meta.url).pathname;
const binaryPath = join(repoRoot, 'apps/desktop/resources/bin/cua-driver');
const labRoot = '/Users/haoqing/Documents/Learning/codex-computer-use-lab';
const expectedAppPath = join(labRoot, 'test-app/build/Codex CUA Lab.app');
const statePath = join(labRoot, 'test-app/runtime/state.json');
const temporaryDirectory = process.env.MAKA_CU_RESTART_TEMP_DIR;
const oldPID = Number(process.env.MAKA_CU_RESTART_OLD_PID);
const soakRounds = Number(process.env.MAKA_CU_RESTART_SOAK_ROUNDS);
const expectedBinarySha256 =
  '683dad5cccb47dd0a8bb5d534d62fbb9e6edfb1cded232509cf4c2b190066040';

const resolvedTemporaryDirectory = resolve(temporaryDirectory ?? '');
const temporaryRelativePath = relative(resolve(tmpdir()), resolvedTemporaryDirectory);
if (
  !temporaryDirectory
  || temporaryRelativePath.startsWith('..')
  || temporaryRelativePath === ''
  || !Number.isInteger(oldPID)
  || oldPID <= 0
  || !Number.isInteger(soakRounds)
  || soakRounds < 1
  || soakRounds > 20
) {
  throw new Error('process restart E2E requires launcher-owned inputs');
}

const reportPath = join(resolvedTemporaryDirectory, 'report.json');
const restartRequestPath = (round) =>
  join(resolvedTemporaryDirectory, `restart-request-${round}.json`);
const restartCompletePath = (round) =>
  join(resolvedTemporaryDirectory, `restart-complete-${round}.json`);
const delay = (milliseconds) =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

async function waitForJson(path, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    await delay(50);
  }
  throw new Error(`${label} timeout`);
}

const traces = [];
const idFlow = [];
let latestObservationGeometry;
const backend = createCuaDriverBackend({
  binaryPath,
  hostBundleId: 'com.maka.desktop',
  expectedBinarySha256,
  expectedServerName: 'cua-driver',
  expectedServerVersion: '0.7.1',
  expectedProtocolVersion: '2025-06-18',
  timeoutMs: 10_000,
  onTrace(event) {
    traces.push(event);
  },
});
const instrumentedBackend = {
  ...backend,
  async observeApp(input, signal, context) {
    const observation = await backend.observeApp(input, signal, context);
    latestObservationGeometry = {
      windowBounds: observation.windowBounds,
      sourceBoundsPx: observation.sourceBoundsPx,
    };
    idFlow.push({
      phase: 'observe',
      observationId: observation.observationId,
      pid: observation.pid,
      sessionId: context.sessionId,
      turnId: context.turnId,
    });
    return observation;
  },
  async run(action, signal, context) {
    const result = await backend.run(action, signal, context);
    idFlow.push({
      phase: 'runResult',
      toolCallId: context.toolCallId,
      ok: result.outcome.ok,
      ...(!result.outcome.ok
        ? { error: result.outcome.error, message: result.outcome.message }
        : {}),
    });
    return result;
  },
};
const tools = buildComputerUseTools({ backend: instrumentedBackend });
const [tool] = tools;
const context = (toolCallId, turnId) => ({
  sessionId: 'process-restart-e2e',
  turnId,
  toolCallId,
  cwd: repoRoot,
  abortSignal: new AbortController().signal,
  emitOutput() {},
});
const call = (input, toolCallId, turnId) =>
  tool.impl(input, context(toolCallId, turnId));
const parseModel = (result) => JSON.parse(result.modelText ?? '{}');
const readState = async () => JSON.parse(await readFile(statePath, 'utf8'));

async function observe(pid, toolCallId, turnId) {
  const result = await call({
    action: 'observe',
    app: `pid:${pid}`,
    include_screenshot: true,
  }, toolCallId, turnId);
  if (result.error || !result.modelText) {
    throw new Error(`observe failed: ${result.error ?? result.text}`);
  }
  return {
    result,
    model: parseModel(result),
    persisted: JSON.parse(result.text),
    geometry: latestObservationGeometry,
  };
}

async function observeUntilElement(pid, label, toolCallPrefix, turnId, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  let lastObserved;
  let lastObservationError;
  while (Date.now() < deadline) {
    try {
      lastObserved = await observe(
        pid,
        `${toolCallPrefix}-${Date.now()}`,
        turnId,
      );
      lastObservationError = undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/invalidApp: no visible window matched/.test(message)) throw error;
      lastObservationError = message;
      await delay(200);
      continue;
    }
    const matches = lastObserved.model.elements
      .filter((element) => element.label === label)
      .sort((left, right) => Number(left.element_id) - Number(right.element_id));
    if (matches.length > 0) {
      return {
        observed: lastObserved,
        element: matches[0],
        candidateCount: matches.length,
      };
    }
    await delay(200);
  }
  const labels = lastObserved?.model.elements
    ?.map((element) => element.label)
    .filter(Boolean)
    .slice(0, 30) ?? [];
  throw new Error(
    `${label} did not appear before timeout; `
    + `lastObservationError=${lastObservationError ?? 'none'}; `
    + `labels=${JSON.stringify(labels)}`,
  );
}

function coordinateForElement(observed, element) {
  const screenshot = observed.persisted.screenshot;
  const frame = element.frame;
  const window = observed.geometry?.windowBounds;
  if (!screenshot || !frame || !window) {
    throw new Error('restart coordinate evidence is incomplete');
  }
  return [
    Math.round(
      (frame.x + frame.width / 2 - window.x)
        / window.width * screenshot.width_px,
    ),
    Math.round(
      (frame.y + frame.height / 2 - window.y)
        / window.height * screenshot.height_px,
    ),
  ];
}

async function writeReport(report) {
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
}

const report = {
  schemaVersion: 1,
  soakRounds,
  fixture: {
    bundleIdentifier: 'com.openai.codex.cualab',
    canonicalAppPath: expectedAppPath,
    oldPID,
  },
  cases: [],
};

try {
  const seenHostPIDs = new Set();
  const seenWebContentPIDs = new Set();
  let currentPID = oldPID;
  let serviceGenerations;
  for (let round = 1; round <= soakRounds; round += 1) {
    const currentState = await readState();
    if (
      currentState.synthetic !== true
      || currentState.syntheticMarker !== 'CUA Lab Synthetic Surface'
      || currentState.appPath !== expectedAppPath
      || currentState.oop.hostPID !== currentPID
      || !Number.isInteger(currentState.oop.webContentPID)
      || currentState.oop.webContentPID <= 0
    ) {
      throw new Error(`round ${round} fixture provenance mismatch`);
    }
    const currentWebContentPID = currentState.oop.webContentPID;
    if (
      seenHostPIDs.has(currentPID)
      || seenWebContentPIDs.has(currentWebContentPID)
    ) {
      throw new Error(`round ${round} reused a prior process identity`);
    }
    seenHostPIDs.add(currentPID);
    seenWebContentPIDs.add(currentWebContentPID);

    const oldReady = await observeUntilElement(
      currentPID,
      'CUA Lab Coordinate Target',
      `observe-old-process-r${round}`,
      `turn-old-r${round}`,
    );
    const oldObserved = oldReady.observed;
    const oldCoordinate = coordinateForElement(
      oldObserved,
      oldReady.element,
    );
    await writeFile(
      restartRequestPath(round),
      `${JSON.stringify({
        round,
        oldPID: currentPID,
        oldWebContentPID: currentWebContentPID,
        observationId: oldObserved.model.observation_id,
        candidateCount: oldReady.candidateCount,
      })}\n`,
      { flag: 'wx', mode: 0o600 },
    );

    const restart = await waitForJson(
      restartCompletePath(round),
      `fixture restart ${round}`,
    );
    const newPID = restart.newPID;
    const newWebContentPID = restart.newWebContentPID;
    if (
      restart.round !== round
      || restart.oldPID !== currentPID
      || !Number.isInteger(newPID)
      || newPID <= 0
      || currentPID === newPID
      || !Number.isInteger(newWebContentPID)
      || newWebContentPID <= 0
      || currentWebContentPID === newWebContentPID
      || seenHostPIDs.has(newPID)
      || seenWebContentPIDs.has(newWebContentPID)
    ) {
      throw new Error(`round ${round} restart identity did not advance`);
    }

    const staleToolCallId = `old-observation-after-restart-r${round}`;
    const staleAttempt = await call({
      action: 'left_click',
      observation_id: oldObserved.model.observation_id,
      coordinate: oldCoordinate,
    }, staleToolCallId, `turn-old-r${round}`);
    await delay(150);
    const newState = await readState();
    const oldRunResult = idFlow.find(
      (event) => event.phase === 'runResult'
        && event.toolCallId === staleToolCallId,
    );
    const staleDispatch = traces.find(
      (event) => event.type === 'dispatch'
        && event.toolCallId === staleToolCallId,
    );
    if (
      oldRunResult?.error !== 'target_missing'
      || !/target_missing/.test(staleAttempt.modelText ?? '')
      || staleDispatch
      || newState.coordinate.clickCount !== 0
      || newState.coordinate.decoyClickCount !== 0
    ) {
      throw new Error(`round ${round} old observation crossed process restart`);
    }

    tools.clearSession('process-restart-e2e');
    const freshReady = await observeUntilElement(
      newPID,
      'CUA Lab Coordinate Target',
      `observe-new-process-r${round}`,
      `turn-new-r${round}`,
    );
    const freshCoordinate = coordinateForElement(
      freshReady.observed,
      freshReady.element,
    );
    const freshToolCallId = `fresh-process-coordinate-click-r${round}`;
    const freshClick = await call({
      action: 'left_click',
      observation_id: freshReady.observed.model.observation_id,
      coordinate: freshCoordinate,
    }, freshToolCallId, `turn-new-r${round}`);
    await delay(150);
    const newStateAfterClick = await readState();
    const dispatch = traces.find(
      (event) => event.type === 'dispatch'
        && event.toolCallId === freshToolCallId,
    );
    const freshRunResult = idFlow.find(
      (event) => event.phase === 'runResult'
        && event.toolCallId === freshToolCallId,
    );
    const freshOccluded = freshRunResult?.error === 'target_occluded';
    const freshSucceeded = !freshClick.error
      && dispatch?.address === 'px'
      && newStateAfterClick.coordinate.clickCount === 1
      && newStateAfterClick.coordinate.decoyClickCount === 0;
    if (
      (!freshSucceeded && !freshOccluded)
      || (freshOccluded && (
        dispatch
        || newStateAfterClick.coordinate.clickCount !== 0
        || newStateAfterClick.coordinate.decoyClickCount !== 0
      ))
      || newStateAfterClick.oop.hostPID !== newPID
      || newStateAfterClick.oop.webContentPID !== newWebContentPID
    ) {
      throw new Error(`round ${round} fresh process action violated its oracle`);
    }

    const serviceState = backend.serviceState();
    for (const role of ['action', 'capture']) {
      if (serviceState[role].restartAttempts !== 0) {
        throw new Error(`round ${round} ${role} service consumed restart budget`);
      }
    }
    const generations = {
      action: serviceState.action.generation,
      capture: serviceState.capture.generation,
    };
    if (!serviceGenerations) {
      serviceGenerations = generations;
    } else if (
      generations.action !== serviceGenerations.action
      || generations.capture !== serviceGenerations.capture
    ) {
      throw new Error(`round ${round} unexpectedly restarted cua-driver services`);
    }

    report.cases.push({
      round,
      oldPID: currentPID,
      oldWebContentPID: currentWebContentPID,
      newPID,
      newWebContentPID,
      stale: {
        error: oldRunResult.error,
        mutation: [0, newState.coordinate.clickCount],
        dispatch: false,
      },
      fresh: {
        outcome: freshOccluded
          ? 'fail_closed_occluded'
          : 'background_dispatch_succeeded',
        dispatchAddress: dispatch?.address,
        mutation: [
          newState.coordinate.clickCount,
          newStateAfterClick.coordinate.clickCount,
        ],
        decoyMutation: [
          newState.coordinate.decoyClickCount,
          newStateAfterClick.coordinate.decoyClickCount,
        ],
      },
      serviceGenerations: generations,
    });
    currentPID = newPID;
    tools.clearSession('process-restart-e2e');
  }

  report.ok = true;
  report.claim =
    'old observations never cross repeated real app-process restarts; fresh background actions either dispatch to the new process or fail occluded without side effects';
  report.evidence = {
    seenHostPIDs: [...seenHostPIDs],
    seenWebContentPIDs: [...seenWebContentPIDs],
    serviceGenerations,
    idFlow,
    traceTypes: traces.map((event) => event.type),
  };
  await writeReport(report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  const failureReport = {
    ...report,
    ok: false,
    failure: error instanceof Error ? error.message : String(error),
    evidence: { idFlow, traces },
  };
  await writeReport(failureReport).catch(() => {});
  process.stderr.write(`${JSON.stringify(failureReport, null, 2)}\n`);
  throw error;
} finally {
  tools.clearSession('process-restart-e2e');
  backend.dispose();
}
