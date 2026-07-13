import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { createCuaDriverBackend, createComputerUseOverlayHook } from '../packages/computer-use/dist/index.js';
import { buildComputerUseTools } from '../packages/runtime/dist/index.js';

const repoRoot = new URL('..', import.meta.url).pathname;
const binaryPath = join(repoRoot, 'apps/desktop/resources/bin/cua-driver');
const labRoot = '/Users/haoqing/Documents/Learning/codex-computer-use-lab';
const expectedAppPath = join(labRoot, 'test-app/build/Codex CUA Lab.app');
const statePath = join(labRoot, 'test-app/runtime/state.json');
const temporaryDirectory = process.env.MAKA_CU_REAL_E2E_TEMP_DIR;
const e2eMode = process.env.MAKA_CU_REAL_E2E_MODE ?? 'isolated';
const concurrentUserMode = e2eMode === 'concurrent_user';
const expectedBinarySha256 =
  '683dad5cccb47dd0a8bb5d534d62fbb9e6edfb1cded232509cf4c2b190066040';

const resolvedTemporaryDirectory = resolve(temporaryDirectory ?? '');
const temporaryRelativePath = relative(resolve(tmpdir()), resolvedTemporaryDirectory);
if (
  !temporaryDirectory
  || temporaryRelativePath.startsWith('..')
  || temporaryRelativePath === ''
) {
  throw new Error('real E2E requires a launcher-owned temporary directory');
}
const reportPath = join(resolvedTemporaryDirectory, 'report.json');
const screenshotPath = join(resolvedTemporaryDirectory, 'observation.png');
const concurrentPreparedPath = join(
  resolvedTemporaryDirectory,
  'concurrent-prepared.json',
);
const concurrentProceedPath = join(
  resolvedTemporaryDirectory,
  'concurrent-proceed.json',
);

const exec = (file, args) => new Promise((resolve, reject) => {
  execFile(file, args, { encoding: 'utf8' }, (error, stdout, stderr) => {
    if (error) reject(new Error(`${file} failed: ${stderr || error.message}`));
    else resolve(stdout.trim());
  });
});
const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
const waitForJson = async (path, label, timeoutMs = 10_000) => {
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
};

const baseline = JSON.parse(process.env.MAKA_CU_REAL_E2E_BASELINE ?? '{}');
if (
  !Number.isInteger(baseline.frontmostPID)
  || !Number.isFinite(baseline.pointer?.x)
  || !Number.isFinite(baseline.pointer?.y)
  || typeof baseline.bundleIdentifier !== 'string'
  || typeof baseline.canonicalAppPath !== 'string'
  || baseline.mode !== e2eMode
  || !Number.isInteger(baseline.fixturePID)
) {
  throw new Error('invalid safety baseline');
}

const overlayEvents = [];
const invalidations = [];
const traces = [];
const idFlow = [];
let latestObservationGeometry;
const overlay = createComputerUseOverlayHook({
  ensure() {},
  move(input) {
    overlayEvents.push({ phase: 'move', actionId: input.actionId });
    return {
      readyForInteraction: Promise.resolve(),
      finished: Promise.resolve(),
    };
  },
  complete(input) {
    overlayEvents.push({ phase: 'complete', actionId: input.actionId });
  },
  cancel(input) {
    overlayEvents.push({ phase: 'cancel', actionId: input.actionId });
  },
});
const backend = createCuaDriverBackend({
  binaryPath,
  hostBundleId: 'com.maka.desktop',
  expectedBinarySha256,
  expectedServerName: 'cua-driver',
  expectedServerVersion: '0.7.1',
  expectedProtocolVersion: '2025-06-18',
  timeoutMs: 10_000,
  allowCompatibilityInputDispatch: !concurrentUserMode,
  onSessionInvalidated(event) {
    invalidations.push(event);
  },
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
      sessionId: context.sessionId,
      turnId: context.turnId,
    });
    return observation;
  },
  async runSemantic(action, signal, context) {
    idFlow.push({
      phase: 'runSemantic',
      observationId: action.observationId,
      sessionId: context.sessionId,
      turnId: context.turnId,
    });
    const result = await backend.runSemantic(action, signal, context);
    idFlow.push({
      phase: 'runSemanticResult',
      ok: result.outcome.ok,
      ...(!result.outcome.ok
        ? { error: result.outcome.error, message: result.outcome.message }
        : {}),
    });
    return result;
  },
  async run(action, signal, context) {
    idFlow.push({
      phase: 'run',
      actionType: action.type,
      sessionId: context.sessionId,
      turnId: context.turnId,
    });
    const result = await backend.run(action, signal, context);
    idFlow.push({
      phase: 'runResult',
      ok: result.outcome.ok,
      ...(!result.outcome.ok
        ? { error: result.outcome.error, message: result.outcome.message }
        : {}),
    });
    return result;
  },
};
const tools = buildComputerUseTools({ backend: instrumentedBackend, overlay });
const [tool] = tools;
const context = (
  toolCallId,
  turnId = 'turn-1',
  sessionId = 'real-e2e',
) => ({
  sessionId,
  turnId,
  toolCallId,
  cwd: repoRoot,
  abortSignal: new AbortController().signal,
  emitOutput() {},
});

const readState = async () => JSON.parse(await readFile(statePath, 'utf8'));
const call = (input, toolCallId, turnId, sessionId) =>
  tool.impl(input, context(toolCallId, turnId, sessionId));
const parseModel = (result) => JSON.parse(result.modelText ?? '{}');
const findOccurrence = (observation, label, occurrence = 0) => {
  const matches = observation.elements
    .filter((element) => element.label === label)
    .sort((left, right) => Number(left.element_id) - Number(right.element_id));
  const selected = matches[occurrence];
  if (!selected) {
    throw new Error(
      `${label} occurrence ${occurrence} missing; candidates=${matches.length}`,
    );
  }
  return { selected, candidateCount: matches.length, occurrence };
};
const discoverFixture = async (turnId = 'turn-1') => {
  if (concurrentUserMode) {
    return {
      appId: `pid:${baseline.fixturePID}`,
      pid: baseline.fixturePID,
    };
  }
  const listed = parseModel(await call(
    { action: 'list_apps' },
    `list-apps-${turnId}`,
    turnId,
  ));
  const matches = listed.apps.filter((candidate) =>
    candidate.name === 'Codex CUA Lab'
    || candidate.windows?.some((window) => window.title === 'Codex CUA Lab'));
  if (matches.length !== 1) {
    throw new Error(`expected one synthetic fixture app, got ${matches.length}`);
  }
  const app = matches[0];
  const windows = app.windows?.filter((window) => window.title === 'Codex CUA Lab') ?? [];
  if (windows.length !== 1) throw new Error(`expected one fixture window, got ${windows.length}`);
  return { appId: app.app_id, windowId: windows[0].window_id, pid: app.pid };
};
const observe = async (fixture, id, turnId, sessionId) => {
  const result = await call({
    action: 'observe',
    app: fixture.appId,
    ...(fixture.windowId !== undefined ? { window_id: fixture.windowId } : {}),
    include_screenshot: true,
  }, id, turnId, sessionId);
  if (result.error || !result.modelText) {
    throw new Error(`observe failed: ${result.error ?? result.text}`);
  }
  return {
    result,
    model: parseModel(result),
    persisted: JSON.parse(result.text),
    geometry: latestObservationGeometry,
  };
};
const coordinateForElement = (observed, element) => {
  const screenshot = observed.persisted.screenshot;
  const frame = element.frame;
  const window = observed.geometry?.windowBounds;
  if (!screenshot || !frame || !window) {
    throw new Error('coordinate conversion evidence is incomplete');
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
};
const screenCoordinateForElement = (element) => {
  if (!element.frame) throw new Error('element has no screen frame');
  return {
    x: Math.round(element.frame.x + element.frame.width / 2),
    y: Math.round(element.frame.y + element.frame.height / 2),
  };
};
const validateFixtureIdentity = async (fixture, state) => {
  if (
    state.synthetic !== true
    || state.syntheticMarker !== 'CUA Lab Synthetic Surface'
    || state.bundleIdentifier !== 'com.openai.codex.cualab'
    || state.appPath !== expectedAppPath
    || state.oop.hostPID !== fixture.pid
    || fixture.pid !== baseline.fixturePID
    || (!concurrentUserMode && baseline.frontmostPID !== fixture.pid)
    || (!concurrentUserMode && baseline.bundleIdentifier !== 'com.openai.codex.cualab')
    || (!concurrentUserMode && baseline.canonicalAppPath !== expectedAppPath)
    || (concurrentUserMode && baseline.frontmostPID === fixture.pid)
  ) {
    throw new Error('synthetic fixture provenance mismatch');
  }
};
const fixtureCoordinateMutation = async (observed, label) => {
  const target = findOccurrence(observed.model, label);
  const coordinate = screenCoordinateForElement(target.selected);
  const winner = await backend.inspectWindowAt(
    coordinate,
    new AbortController().signal,
  );
  if (!winner || winner.pid !== observed.model.pid || winner.windowId !== observed.model.window_id) {
    throw new Error(`fixture mutation point is not owned by the fixture: ${label}`);
  }
  const result = await backend.run(
    { type: 'left_click', coordinate },
    new AbortController().signal,
    {
      sessionId: 'fixture-mutation',
      turnId: 'mutation',
      toolCallId: `mutate-${label}`,
    },
  );
  if (!result.outcome.ok) {
    throw new Error(`fixture mutation failed: ${result.outcome.message}`);
  }
};
const writeReport = async (report) => {
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
};

const report = {
  schemaVersion: 2,
  fixture: {
    bundleIdentifier: 'com.openai.codex.cualab',
    canonicalAppPath: expectedAppPath,
  },
  cases: [],
  safety: {
    mode: e2eMode,
    frontmostPID: baseline.frontmostPID,
    pointer: baseline.pointer,
    targetPolicy: 'exact synthetic bundle, path, pid, and window only',
    lockedComputerUse: false,
  },
};

try {
  const fixture = await discoverFixture();
  const initial = await readState();
  await validateFixtureIdentity(fixture, initial);
  report.fixture = { ...report.fixture, pid: fixture.pid, windowId: fixture.windowId };

  const observed = await observe(fixture, 'observe-oop', 'turn-oop');
  const concurrentSemanticObserved = concurrentUserMode
    ? await observe(
        fixture,
        'observe-concurrent-semantic',
        'turn-concurrent-semantic',
        'real-e2e-semantic',
      )
    : undefined;
  if (observed.result.screenshot?.base64) {
    await writeFile(
      screenshotPath,
      Buffer.from(observed.result.screenshot.base64, 'base64'),
      { flag: 'wx', mode: 0o600 },
    );
  }
  if (concurrentUserMode) {
    await writeFile(
      concurrentPreparedPath,
      `${JSON.stringify({
        observationId: observed.model.observation_id,
        fixturePID: fixture.pid,
      })}\n`,
      { flag: 'wx', mode: 0o600 },
    );
    const concurrentBaseline = await waitForJson(
      concurrentProceedPath,
      'concurrent E2E proceed',
    );
    if (
      concurrentBaseline.mode !== 'concurrent_user'
      || concurrentBaseline.fixturePID !== fixture.pid
      || concurrentBaseline.frontmostPID === fixture.pid
    ) {
      throw new Error('invalid concurrent execution baseline');
    }
    report.safety = {
      ...report.safety,
      frontmostPID: concurrentBaseline.frontmostPID,
      pointer: concurrentBaseline.pointer,
    };
  }
  if (concurrentUserMode) {
    const blockedTarget = findOccurrence(
      observed.model,
      'CUA Lab Coordinate Target',
    );
    const blockedCoordinate = coordinateForElement(
      observed,
      blockedTarget.selected,
    );
    const blockedToolCallId = 'concurrent-coordinate-policy';
    const blockedAttempt = await call({
      action: 'left_click',
      observation_id: observed.model.observation_id,
      coordinate: blockedCoordinate,
    }, blockedToolCallId, 'turn-oop');
    await delay(150);
    const afterBlocked = await readState();
    const blockedFlow = idFlow.findLast(
      (event) => event.phase === 'runResult',
    );
    const blockedDispatch = traces.find(
      (event) => event.type === 'dispatch'
        && event.toolCallId === blockedToolCallId,
    );
    if (
      blockedFlow?.error !== 'unsupported_action'
      || blockedDispatch
      || afterBlocked.coordinate.clickCount !== initial.coordinate.clickCount
      || afterBlocked.coordinate.decoyClickCount
        !== initial.coordinate.decoyClickCount
    ) {
      throw new Error('concurrent coordinate policy did not fail closed');
    }
    report.cases.push({
      id: 'concurrent-coordinate-policy-fail-closed',
      ok: true,
      runtimeError: blockedAttempt.error,
      backendError: blockedFlow.error,
      dispatchAddress: blockedDispatch?.address,
      oracle: {
        target: [
          initial.coordinate.clickCount,
          afterBlocked.coordinate.clickCount,
        ],
        decoy: [
          initial.coordinate.decoyClickCount,
          afterBlocked.coordinate.decoyClickCount,
        ],
      },
    });

    const semanticTarget = findOccurrence(
      concurrentSemanticObserved.model,
      'CUA Lab Coordinate Target',
    );
    let semanticAttempt;
    let semanticFailure;
    try {
      semanticAttempt = await call({
        action: 'click_element',
        observation_id: concurrentSemanticObserved.model.observation_id,
        element_id: semanticTarget.selected.element_id,
      }, 'concurrent-semantic-click', 'turn-concurrent-semantic', 'real-e2e-semantic');
    } catch (error) {
      semanticFailure = error instanceof Error ? error.message : String(error);
    }
    await delay(150);
    const afterSemantic = await readState();
    const semanticFlow = idFlow.findLast(
      (event) => event.phase === 'runSemanticResult',
    );
    const semanticOccluded = semanticFlow?.error === 'target_occluded';
    const semanticHidden =
      /invalidApp: no visible window matched/.test(semanticFailure ?? '');
    const semanticSucceeded = semanticFlow?.ok === true
      && afterSemantic.coordinate.clickCount
        === initial.coordinate.clickCount + 1
      && afterSemantic.coordinate.decoyClickCount
        === initial.coordinate.decoyClickCount;
    if (
      (!semanticSucceeded && !semanticOccluded && !semanticHidden)
      || ((semanticOccluded || semanticHidden) && (
        afterSemantic.coordinate.clickCount !== initial.coordinate.clickCount
        || afterSemantic.coordinate.decoyClickCount
          !== initial.coordinate.decoyClickCount
      ))
    ) {
      throw new Error('concurrent semantic action violated its oracle');
    }
    report.cases.push({
      id: 'concurrent-background-semantic',
      ok: true,
      outcome: semanticOccluded
        ? 'fail_closed_occluded'
        : semanticHidden
          ? 'fail_closed_hidden'
        : 'semantic_background_succeeded',
      runtimeError: semanticAttempt?.error,
      runtimeFailure: semanticFailure,
      backendError: semanticFlow?.error,
      oracle: {
        target: [
          initial.coordinate.clickCount,
          afterSemantic.coordinate.clickCount,
        ],
        decoy: [
          initial.coordinate.decoyClickCount,
          afterSemantic.coordinate.decoyClickCount,
        ],
      },
    });

    report.ok = true;
    report.claimBoundary =
      'concurrent mode keeps compatibility input disabled and proves only safe semantic background action or fail-closed occlusion';
    report.evidence = {
      invalidations,
      traceTypes: traces.map((event) => event.type),
      idFlow,
    };
    await writeReport(report);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = 0;
  } else {
    const oop = findOccurrence(observed.model, 'CUA Lab OOP Button');
    const oopCoordinate = coordinateForElement(observed, oop.selected);
    const clicked = await call({
      action: 'left_click',
      observation_id: observed.model.observation_id,
      coordinate: oopCoordinate,
    }, 'click-oop', 'turn-oop');
    await delay(250);
    const afterClick = await readState();
    const dispatch = traces.find(
      (event) => event.type === 'dispatch' && event.toolCallId === 'click-oop',
    );
    const clickSucceeded = !clicked?.error
      && afterClick.oop.clickCount === initial.oop.clickCount + 1;
    if (
      !clickSucceeded
      || afterClick.oop.lastEventTrusted !== true
      || afterClick.oop.webContentPID <= 0
      || afterClick.oop.webContentPID === afterClick.oop.hostPID
      || afterClick.oop.hostLocalMouseDownCount
        <= initial.oop.hostLocalMouseDownCount
      || afterClick.oop.hostLocalMouseUpCount
        <= initial.oop.hostLocalMouseUpCount
      || afterClick.oop.hostLocalMouseDownCount
        - initial.oop.hostLocalMouseDownCount
        !== afterClick.oop.hostLocalMouseUpCount
          - initial.oop.hostLocalMouseUpCount
      || dispatch?.address !== 'px'
    ) {
      throw new Error('isolated OOP coordinate oracle did not prove trusted pixel dispatch');
    }
    report.cases.push({
      id: 'isolated-oop-webcontent-coordinate-click',
      ok: true,
      outcome: 'isolated_compatibility_dispatch_succeeded',
      dispatchAddress: dispatch.address,
      coordinate: oopCoordinate,
      oracle: {
        clickCount: [initial.oop.clickCount, afterClick.oop.clickCount],
        lastEventTrusted: afterClick.oop.lastEventTrusted,
        hostPID: afterClick.oop.hostPID,
        webContentPID: afterClick.oop.webContentPID,
      },
    });

    tools.clearSession('real-e2e');
    const duplicateObserved = await observe(fixture, 'observe-duplicate', 'turn-duplicate');
    const duplicate = findOccurrence(
      duplicateObserved.model,
      'CUA Lab Duplicate Action',
    );
    if (duplicate.candidateCount < 2) {
      throw new Error('duplicate semantic fixture is not ambiguous');
    }
    const duplicateAttempt = await call({
      action: 'click_element',
      observation_id: duplicateObserved.model.observation_id,
      element_id: duplicate.selected.element_id,
    }, 'semantic-duplicate', 'turn-duplicate');
    const afterDuplicate = await readState();
    const duplicateFlow = idFlow.findLast((event) => event.phase === 'runSemanticResult');
    if (
      duplicateFlow?.error !== 'stale_frame'
      || !/ambiguous/.test(duplicateFlow.message ?? '')
      || afterDuplicate.ambiguous.clickCount !== initial.ambiguous.clickCount
    ) {
      throw new Error('ambiguous semantic action did not fail closed in backend refetch');
    }
    report.cases.push({
      id: 'semantic-duplicate-fail-closed',
      ok: true,
      runtimeError: duplicateAttempt.error,
      backendError: duplicateFlow.error,
      backendMessage: duplicateFlow.message,
      candidateCount: duplicate.candidateCount,
      oracle: [initial.ambiguous.clickCount, afterDuplicate.ambiguous.clickCount],
    });

    report.ok = report.cases.every((entry) => entry.ok);
    report.claimBoundary =
      'stale-missing, process restart, and canonical live-process identity require native or driver follow-up';
    report.evidence = {
      invalidations,
      traceTypes: traces.map((event) => event.type),
      idFlow,
    };
    await writeReport(report);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }
} catch (error) {
  const failureReport = {
    ...report,
    ok: false,
    failure: error instanceof Error ? error.message : String(error),
    evidence: {
      invalidations,
      traces,
      idFlow,
      overlayEvents,
    },
  };
  await writeReport(failureReport).catch(() => {});
  process.stderr.write(`${JSON.stringify(failureReport, null, 2)}\n`);
  throw error;
} finally {
  tools.clearSession('real-e2e');
  backend.dispose();
}
