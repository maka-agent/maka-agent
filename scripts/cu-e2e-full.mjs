// Comprehensive real-machine Computer Use E2E.
//
// The fixture owns every surface it touches:
// - two BrowserWindows owned by this accessory Electron process and revealed
//   with showInactive(), never LaunchServices-launched or activated;
// - the Maka cursor overlay.
//
// Existing application windows and documents are never touched.
//
// Run through the root script:
//   npm run e2e:computer-use
//
// Requires Accessibility + Screen Recording for Electron.
import { app, BrowserWindow, nativeImage, screen } from 'electron';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const { createCuaDriverBackend, createComputerUseOverlayHook } = await import(
  join(here, '..', 'packages', 'computer-use', 'dist', 'index.js')
);
const { buildComputerUseTools } = await import(
  join(here, '..', 'packages', 'runtime', 'dist', 'index.js')
);
const { createCursorOverlayController } = await import(
  join(here, '..', 'apps', 'desktop', 'dist', 'main', 'computer-use', 'cursor-overlay-window.js')
);

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) {
    reject(signal.reason ?? new Error('Computer Use E2E aborted'));
    return;
  }
  const onAbort = () => {
    clearTimeout(timer);
    reject(signal.reason ?? new Error('Computer Use E2E aborted'));
  };
  const timer = setTimeout(() => {
    signal?.removeEventListener('abort', onAbort);
    resolve();
  }, ms);
  signal?.addEventListener('abort', onAbort, { once: true });
});

async function createFixtureWindow(label, slug, bounds, reveal = true) {
  const fixture = new BrowserWindow({
    ...bounds,
    show: false,
    focusable: true,
    backgroundColor: '#ffffff',
    title: `Maka Computer Use E2E ${label}`,
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  fixture.setMenuBarVisibility(false);
  fixture.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Maka Computer Use E2E ${label}</title>
    <style>
      html, body { width: 100%; height: 100%; margin: 0; background: #fff; }
      body { box-sizing: border-box; padding: 16px; font-family: -apple-system, sans-serif; }
      main { display: grid; grid-template-rows: 120px auto auto minmax(100px, 1fr); gap: 10px; height: 100%; }
      textarea {
        box-sizing: border-box;
        width: 100%;
        height: 120px;
        resize: none;
        border: 1px solid #777;
        border-radius: 4px;
        padding: 16px;
        font: 16px/1.5 ui-monospace, monospace;
      }
      .controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
      button, label { font: 15px -apple-system, sans-serif; }
      button { width: 120px; height: 40px; }
      input[type="range"] { width: min(180px, 100%); }
      #scrollbox { overflow: auto; border: 1px solid #999; height: 100%; }
      #scroll-content { height: 1200px; padding: 12px; background: linear-gradient(#fff, #dbeafe); }
      @media (max-height: 120px) {
        body { padding: 6px; }
        main {
          display: flex;
          align-items: center;
          gap: 10px;
          height: 100%;
          overflow: hidden;
        }
        textarea { flex: 0 0 240px; height: 42px; padding: 8px; }
        .controls { flex: 0 0 auto; flex-wrap: nowrap; }
        button { width: 110px; height: 38px; }
        input[type="range"] { width: 170px; }
        #scrollbox { flex: 1 1 160px; min-width: 140px; height: 42px; }
      }
    </style>
  </head>
  <body>
    <main>
      <textarea id="target" aria-label="Maka Computer Use E2E ${label} input"></textarea>
      <div class="controls">
        <button id="increment">Increment</button>
        <output id="count">0</output>
        <label><input id="enabled" type="checkbox"> Enabled</label>
      </div>
      <div class="controls">
        <label>Level <input id="level" type="range" min="0" max="100" value="10"></label>
        <output id="level-value">10</output>
      </div>
      <div id="scrollbox"><div id="scroll-content">Scrollable ${label}</div></div>
    </main>
    <script>
      const state = { count: 0, contextMenus: 0 };
      increment.addEventListener('click', () => {
        state.count += 1;
        count.value = String(state.count);
      });
      level.addEventListener('input', () => { document.querySelector('#level-value').value = level.value; });
      document.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        state.contextMenus += 1;
      });
      globalThis.__makaFixtureState = () => ({
        text: target.value,
        count: state.count,
        enabled: enabled.checked,
        level: Number(level.value),
        scrollTop: scrollbox.scrollTop,
        contextMenus: state.contextMenus,
        activeId: document.activeElement?.id || ''
      });
    </script>
  </body>
</html>`;
  const url = `data:text/html;charset=utf-8,${encodeURIComponent(html)}#maka-cu-e2e-${slug}`;
  await fixture.loadURL(url);
  if (reveal) {
    fixture.showInactive();
    fixture.moveTop();
  }
  return fixture;
}

async function readFixtureState(fixture) {
  if (fixture.isDestroyed()) throw new Error('fixture window was destroyed');
  return fixture.webContents.executeJavaScript(
    'globalThis.__makaFixtureState?.() ?? null',
    true,
  );
}

async function readFixtureScreenPoint(fixture, selector) {
  if (fixture.isDestroyed()) throw new Error('fixture window was destroyed');
  const rect = await fixture.webContents.executeJavaScript(
    `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
    })()`,
    true,
  );
  if (!rect || rect.width <= 0 || rect.height <= 0) {
    throw new Error(`fixture element has no visible rect: ${selector}`);
  }
  const bounds = fixture.getContentBounds();
  return {
    x: bounds.x + rect.x + rect.width / 2,
    y: bounds.y + rect.y + rect.height / 2,
  };
}

async function readFixtureScreenRect(fixture, selector) {
  if (fixture.isDestroyed()) throw new Error('fixture window was destroyed');
  const rect = await fixture.webContents.executeJavaScript(
    `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
    })()`,
    true,
  );
  if (!rect || rect.width <= 0 || rect.height <= 0) {
    throw new Error(`fixture element has no visible rect: ${selector}`);
  }
  const bounds = fixture.getContentBounds();
  return {
    x: bounds.x + rect.x,
    y: bounds.y + rect.y,
    width: rect.width,
    height: rect.height,
  };
}

function startSafetyMonitor(abortController) {
  const baselineRaw = process.env.MAKA_CU_E2E_BASELINE;
  if (!baselineRaw) throw new Error('MAKA_CU_E2E_BASELINE is required; use cu-e2e-launcher.mjs');
  const baseline = JSON.parse(baselineRaw);
  if (
    !Number.isInteger(baseline.originalFrontmostPid)
    || !Number.isFinite(baseline.originalPointerPosition?.x)
    || !Number.isFinite(baseline.originalPointerPosition?.y)
  ) {
    throw new Error(`invalid external safety monitor baseline: ${baselineRaw}`);
  }

  let failureError;
  let failureResolve;
  const failure = new Promise((resolve) => {
    failureResolve = resolve;
  });

  function fail(error) {
    if (failureError) return;
    failureError = error instanceof Error ? error : new Error(String(error));
    abortController.abort(failureError);
    failureResolve(failureError);
  }

  let stdinBuffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    stdinBuffer += chunk;
    const lines = stdinBuffer.split('\n');
    stdinBuffer = lines.pop() ?? '';
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      const [kind, ...fields] = line.split('\t');
      if (kind === 'ABORT') {
        fail(new Error(fields.join('\t') || 'external safety monitor aborted the E2E'));
      } else {
        fail(new Error(`unexpected launcher input: ${line}`));
      }
    }
  });

  return {
    ...baseline,
    assertStable(label) {
      if (failureError) {
        throw new Error(`${label}: ${failureError.message}`, { cause: failureError });
      }
    },
    async guard(label, operation) {
      this.assertStable(`before ${label}`);
      const operationPromise = Promise.resolve().then(operation);
      try {
        const result = await Promise.race([
          operationPromise,
          failure.then((error) => {
            throw error;
          }),
        ]);
        this.assertStable(`after ${label}`);
        return result;
      } catch (error) {
        if (failureError) await operationPromise.catch(() => {});
        throw error;
      }
    },
    async stop() {},
  };
}

function logicalPointToDeclared(point, display, scale) {
  return {
    x: Math.round((point.x - display.bounds.x) * scale),
    y: Math.round((point.y - display.bounds.y) * scale),
  };
}

app.setActivationPolicy('accessory');
app.on('window-all-closed', () => {});

let backend;
let freshBackend;
let overlay;
let safetyMonitor;
const fixtureWindows = new Set();
const results = [];
const overlayMoves = [];
const overlayCapturePromises = [];
const beginCaptureByAction = new Map();
const completeCaptureByAction = new Map();
const report = {
  version: 2,
  evidenceClass: 'real-runtime',
  runId: process.env.MAKA_CU_E2E_RUN_ID || `cu-e2e-${Date.now()}`,
  startedAt: new Date().toISOString(),
  cdpPort: Number(process.env.MAKA_CU_E2E_CDP_PORT || 0),
  baseline: null,
  steps: [],
  actions: [],
  cases: [],
  traces: [],
  summary: null,
  fatal: null,
};

function captureOverlayPhase(input, phase, eventAt, delayMs) {
  if (process.env.MAKA_CU_E2E_CAPTURE_OVERLAY !== '1') return undefined;
  const capture = (async () => {
    await sleep(delayMs);
    const captureDir = join(
      here,
      '..',
      '.agents-workspace-data',
      'cu-e2e',
      'captures',
      report.runId.replace(/[^A-Za-z0-9._-]/g, '_'),
    );
    await mkdir(captureDir, { recursive: true });
    const path = join(captureDir, `${input.actionId}-${phase}.png`);
    await new Promise((resolve, reject) => {
      execFile('/usr/sbin/screencapture', ['-x', path], (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    report.overlayCaptures ??= [];
    report.overlayCaptures.push({
      actionId: input.actionId,
      phase,
      target: { x: input.screenX, y: input.screenY },
      eventAt,
      capturedAt: Date.now(),
      path,
    });
  })();
  overlayCapturePromises.push(capture);
  return capture;
}

function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  report.steps.push({
    name,
    pass,
    detail,
    at: new Date().toISOString(),
  });
  console.log(`  ${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
}

function outcomeDetail(result) {
  return JSON.stringify(result.outcome);
}

function requireSuccess(label, result) {
  check(label, result.outcome.ok, outcomeDetail(result));
  if (!result.outcome.ok) throw new Error(`${label}: ${outcomeDetail(result)}`);
}

function requireSemanticSuccess(label, result) {
  const pass = isSemanticSuccess(result);
  check(label, pass, outcomeDetail(result));
  if (!pass) throw new Error(`${label}: ${outcomeDetail(result)}`);
}

function requireBackgroundKeyboardRefusal(label, result) {
  const pass = !result.outcome.ok
    && result.outcome.error === 'unsupported_action';
  check(label, pass, outcomeDetail(result));
  if (!pass) throw new Error(`${label}: ${outcomeDetail(result)}`);
}

function isSemanticSuccess(result) {
  return result.outcome.ok
    && result.outcome.tier === 'semantic-background'
    && result.outcome.verified === true
    && result.outcome.evidence?.path === 'cdp'
    && result.outcome.evidence?.effect === 'confirmed';
}

function observeSemanticAction(label, result) {
  const pass = isSemanticSuccess(result);
  check(label, pass, outcomeDetail(result));
  return pass;
}

function observeAction(label, result) {
  check(label, result.outcome.ok, outcomeDetail(result));
  return result.outcome.ok;
}

async function stateCheck(name, fixture, predicate) {
  const state = await readFixtureState(fixture);
  const pass = Boolean(state && predicate(state));
  check(name, pass, JSON.stringify(state));
  return state;
}

function numericDelta(before, after, key) {
  return Number(after?.[key] ?? 0) - Number(before?.[key] ?? 0);
}

async function runSemanticCase({
  caseId,
  fixture,
  action,
  actAction,
  signal,
  behaviorName,
  behavior,
}) {
  const before = await readFixtureState(fixture);
  const traceStart = report.traces.length;
  const result = await actAction(action);
  const actionRecord = report.actions.at(-1);
  const semanticPass = observeSemanticAction(`${caseId} semantic dispatch`, result);
  await sleep(100, signal);
  const after = await readFixtureState(fixture);
  const behaviorPass = Boolean(behavior(before, after));
  check(behaviorName, behaviorPass, JSON.stringify({ before, after }));
  const traces = report.traces.slice(traceStart);
  const route = traces
    .filter((event) => event.type === 'dispatch' || event.type === 'fallback')
    .map((event) => event.type === 'dispatch'
      ? `${event.address}:${event.tool}`
      : `${event.from}->${event.to}`);
  const fallback = traces.find((event) => event.type === 'fallback');
  report.cases.push({
    caseId,
    actionId: actionRecord?.context?.toolCallId,
    before,
    after,
    delta: {
      count: numericDelta(before, after, 'count'),
      contextMenus: numericDelta(before, after, 'contextMenus'),
      level: numericDelta(before, after, 'level'),
      scrollTop: numericDelta(before, after, 'scrollTop'),
      enabledChanged: before?.enabled !== after?.enabled,
    },
    route,
    fallbackReason: fallback?.reason,
    outcome: result.outcome,
    durationMs: actionRecord?.durationMs,
    semanticPass,
    behaviorPass,
    pass: semanticPass && behaviorPass,
  });
  return { result, before, after };
}

function requireLatestTargetPid(name, expectedPid) {
  const target = [...report.traces].reverse().find((event) => event.type === 'target');
  const pass = target?.pid === expectedPid;
  check(name, pass, JSON.stringify(target ?? null));
  if (!pass) {
    throw new Error(`${name}: expected pid=${expectedPid}, got ${target?.pid ?? 'none'}`);
  }
}

async function inspectFixtureTargets({
  probes,
  display,
  scale,
  signal,
}) {
  const results = [];
  for (const probe of probes) {
    const screenPoint = await readFixtureScreenPoint(probe.fixture, probe.selector);
    const declaredPoint = logicalPointToDeclared(screenPoint, display, scale);
    const target = await backend.inspectWindowAt(declaredPoint, signal);
    results.push({
      label: probe.label,
      selector: probe.selector,
      screenPoint,
      declaredPoint,
      target,
      ok: target?.pid === process.pid
        && target.title === `Maka Computer Use E2E ${probe.label}`,
    });
  }
  return {
    ok: results.every((result) => result.ok),
    probes: results,
  };
}

async function run() {
  try {
  console.log('=======================================================');
  console.log('  Maka Computer Use E2E - cua-driver + overlay');
  console.log('=======================================================\n');

  const abortController = new AbortController();
  const signal = abortController.signal;
  safetyMonitor = startSafetyMonitor(abortController);
  const { originalFrontmostPid, originalPointerPosition } = safetyMonitor;
  report.baseline = { originalFrontmostPid, originalPointerPosition };
  check(
    'user foreground and pointer baseline recorded',
    true,
    `pid=${originalFrontmostPid} pointer=(${originalPointerPosition.x},${originalPointerPosition.y})`,
  );

  const display = screen.getPrimaryDisplay();
  const binaryPath = join(here, '..', 'apps', 'desktop', 'resources', 'bin', 'cua-driver');
  backend = createCuaDriverBackend({
    binaryPath,
    hostBundleId: 'com.maka.desktop',
    timeoutMs: 15_000,
    compressFrame: (base64) => {
      try {
        const image = nativeImage.createFromBuffer(Buffer.from(base64, 'base64'));
        if (image.isEmpty()) return { base64, mimeType: 'image/png' };
        return {
          base64: image.toJPEG(82).toString('base64'),
          mimeType: 'image/jpeg',
        };
      } catch {
        return { base64, mimeType: 'image/png' };
      }
    },
    onTrace: (event) => {
      report.traces.push({
        ...event,
        at: new Date().toISOString(),
      });
    },
  });

  const distOverlay = join(here, '..', 'apps', 'desktop', 'dist', 'overlay');
  overlay = createCursorOverlayController({
    preloadPath: join(distOverlay, 'cursor-overlay-preload.cjs'),
    htmlPath: join(distOverlay, 'cursor-overlay.html'),
  });
  const sink = {
    ensure(sessionId) {
      overlay.ensure(sessionId);
    },
    move(input) {
      const eventAt = Date.now();
      overlayMoves.push({ phase: 'begin', ...input, ts: eventAt });
      overlay.move(input);
      const beginCapture = captureOverlayPhase(input, 'begin', eventAt, 20);
      if (beginCapture) beginCaptureByAction.set(input.actionId, beginCapture);
      if (input.kind === 'move') {
        captureOverlayPhase(input, 'move-mid', eventAt, 140);
      }
    },
    complete(input) {
      const completedAt = Date.now();
      overlayMoves.push({ phase: 'complete', ...input, ts: completedAt });
      overlay.complete(input);
      const completeCapture = captureOverlayPhase(input, 'complete', completedAt, 50);
      if (completeCapture) completeCaptureByAction.set(input.actionId, completeCapture);
    },
  };
  const hook = createComputerUseOverlayHook(sink, screen);
  const observedResults = new Map();
  const observedBackend = {
    preflight: (actionSignal) => backend.preflight(actionSignal),
    run: async (action, actionSignal, context) => {
      const beginCapture = beginCaptureByAction.get(context.toolCallId);
      if (beginCapture) {
        await beginCapture;
        beginCaptureByAction.delete(context.toolCallId);
      }
      const result = await backend.run(action, actionSignal, context);
      observedResults.set(context.toolCallId, result);
      return result;
    },
  };
  const [computerTool] = buildComputerUseTools({
    backend: observedBackend,
    overlay: hook,
  });
  const sessionId = `cu-e2e-${Date.now()}`;
  let actionSequence = 0;

  function modelArgs(action) {
    switch (action.type) {
      case 'screenshot':
      case 'cursor_position':
        return { action: action.type };
      case 'mouse_move':
      case 'left_click':
      case 'right_click':
      case 'middle_click':
      case 'double_click':
      case 'triple_click':
      case 'left_mouse_down':
      case 'left_mouse_up':
        return { action: action.type, coordinate: [action.coordinate.x, action.coordinate.y] };
      case 'left_click_drag':
        return {
          action: action.type,
          start_coordinate: [action.startCoordinate.x, action.startCoordinate.y],
          coordinate: [action.coordinate.x, action.coordinate.y],
        };
      case 'type':
      case 'key':
        return { action: action.type, text: action.text };
      case 'hold_key':
        return { action: action.type, text: action.text, duration: action.durationMs / 1000 };
      case 'scroll':
        return {
          action: action.type,
          coordinate: [action.coordinate.x, action.coordinate.y],
          scroll_direction: action.scrollDirection,
          scroll_amount: action.scrollAmount,
        };
      case 'wait':
        return { action: action.type, duration: action.durationMs / 1000 };
      case 'zoom':
        return {
          action: action.type,
          region: [action.region.x1, action.region.y1, action.region.x2, action.region.y2],
        };
      default:
        throw new Error(`unsupported E2E action: ${action.type}`);
    }
  }

  async function act(action, activeBackend = backend) {
    const context = {
      sessionId,
      turnId: 'real-machine-e2e',
      toolCallId: `e2e-${actionSequence++}`,
      cwd: process.cwd(),
      abortSignal: signal,
      emitOutput() {},
    };
    return safetyMonitor.guard(`computer.${action.type}`, async () => {
      const startedAt = Date.now();
      if (activeBackend !== backend) {
        const result = await activeBackend.run(action, signal, context);
        report.actions.push({
          action,
          context,
          startedAt,
          durationMs: Date.now() - startedAt,
          outcome: result.outcome,
          resolvedScreenPoint: result.resolvedScreenPoint,
          screenshot: result.screenshot
            ? {
                mimeType: result.screenshot.mimeType,
                widthPx: result.screenshot.widthPx,
                heightPx: result.screenshot.heightPx,
                byteLength: Buffer.from(result.screenshot.base64, 'base64').byteLength,
              }
            : undefined,
        });
        return result;
      }
      const toolResult = await computerTool.impl(modelArgs(action), context);
      const completeCapture = completeCaptureByAction.get(context.toolCallId);
      if (completeCapture) {
        await completeCapture;
        completeCaptureByAction.delete(context.toolCallId);
      }
      const result = observedResults.get(context.toolCallId);
      observedResults.delete(context.toolCallId);
      if (!result) throw new Error(`computer tool produced no observed backend result for ${context.toolCallId}`);
      report.actions.push({
        action,
        modelArgs: modelArgs(action),
        context: {
          sessionId: context.sessionId,
          turnId: context.turnId,
          toolCallId: context.toolCallId,
        },
        startedAt,
        durationMs: Date.now() - startedAt,
        outcome: result.outcome,
        resolvedScreenPoint: result.resolvedScreenPoint,
        modelText: toolResult?.text,
        screenshot: result.screenshot
          ? {
              mimeType: result.screenshot.mimeType,
              widthPx: result.screenshot.widthPx,
              heightPx: result.screenshot.heightPx,
              byteLength: Buffer.from(result.screenshot.base64, 'base64').byteLength,
            }
          : undefined,
      });
      return result;
    });
  }

  console.log('1. Safety monitor and preflight');
  const tcc = await safetyMonitor.guard(
    'preflight',
    () => backend.preflight(signal),
  );
  check('Accessibility granted', tcc.accessibility);
  check('Screen Recording granted', tcc.screenRecording);
  if (!tcc.accessibility || !tcc.screenRecording) {
    throw new Error('Computer Use E2E requires Accessibility and Screen Recording grants');
  }

  console.log('\n2. Screenshot and coordinate space');
  const screenshot = await act({ type: 'screenshot' });
  const frame = screenshot.screenshot;
  check('desktop screenshot captured', screenshot.outcome.ok && Boolean(frame), frame ? `${frame.widthPx}x${frame.heightPx}` : 'no frame');
  if (!frame || frame.widthPx <= 0 || frame.heightPx <= 0) {
    throw new Error('Cannot establish the declared coordinate space');
  }
  const scale = frame.widthPx / display.bounds.width;
  check('device/logical scale is finite', Number.isFinite(scale) && scale > 0, `scale=${scale}`);

  console.log('\n3. Fail-closed keyboard with no target');
  freshBackend = createCuaDriverBackend({
    binaryPath,
    hostBundleId: 'com.maka.desktop',
    timeoutMs: 8_000,
  });
  const noTarget = await act(
    { type: 'type', text: 'MUST-NOT-LAND' },
    freshBackend,
  );
  check(
    'type without prior target is refused',
    !noTarget.outcome.ok && noTarget.outcome.error === 'unsupported_action',
  );
  freshBackend.dispose();
  freshBackend = undefined;

  console.log('\n4. Self-owned inactive target windows');
  const usableWidth = display.bounds.width;
  const usableHeight = display.bounds.height;
  const fixtureWidth = Math.max(420, Math.floor(usableWidth * 0.42));
  const fixtureHeight = Math.max(280, Math.floor(usableHeight * 0.38));
  const leftX = display.bounds.x + 40;
  const rightX = display.bounds.x + usableWidth - fixtureWidth - 40;
  const pointerOnLeft = originalPointerPosition.x < display.bounds.x + usableWidth / 2;
  const candidateLayouts = [
    {
      name: pointerOnLeft ? 'wide-right' : 'wide-left',
      bounds: {
        x: pointerOnLeft ? rightX : leftX,
        y: display.bounds.y + 40,
        width: fixtureWidth,
        height: fixtureHeight,
      },
    },
    {
      name: pointerOnLeft ? 'wide-left' : 'wide-right',
      bounds: {
        x: pointerOnLeft ? leftX : rightX,
        y: display.bounds.y + 40,
        width: fixtureWidth,
        height: fixtureHeight,
      },
    },
    {
      name: 'compact-right-rail',
      bounds: {
        x: display.bounds.x + usableWidth - 240,
        y: display.bounds.y + 40,
        width: 220,
        height: usableHeight - 80,
      },
    },
    {
      name: 'compact-bottom-rail',
      bounds: {
        x: display.bounds.x + 40,
        y: display.bounds.y + usableHeight - 76,
        width: usableWidth - 80,
        height: 66,
      },
    },
  ];
  const initialBounds = candidateLayouts[0].bounds;
  const firstWindow = await safetyMonitor.guard(
    'first inactive fixture reveal',
    async () => {
      const fixture = await createFixtureWindow('A', 'a', initialBounds);
      fixtureWindows.add(fixture);
      return fixture;
    },
  );
  const secondWindow = await safetyMonitor.guard(
    'second inactive fixture reveal',
    async () => {
      const fixture = await createFixtureWindow('B', 'b', initialBounds, false);
      fixtureWindows.add(fixture);
      return fixture;
    },
  );
  if (firstWindow.id === secondWindow.id) {
    throw new Error(`Electron reused fixture window id ${firstWindow.id}`);
  }
  await safetyMonitor.guard('fixture setup settle', () => sleep(300, signal));
  check(
    'two separate inactive fixture windows revealed',
    fixtureWindows.size === 2,
    `windowIds=${firstWindow.id},${secondWindow.id}`,
  );

  report.windowTargeting = [];
  let selectedLayout;
  for (const candidate of candidateLayouts) {
    const bounds = candidate.bounds;
    firstWindow.setBounds(bounds);
    secondWindow.setBounds(bounds);
    secondWindow.hide();
    firstWindow.showInactive();
    firstWindow.moveTop();
    await safetyMonitor.guard('fixture layout settle', () => sleep(250, signal));
    const inspection = await inspectFixtureTargets({
      probes: [
        { fixture: firstWindow, label: 'A', selector: '#target' },
        { fixture: firstWindow, label: 'A', selector: '#increment' },
        { fixture: firstWindow, label: 'A', selector: '#enabled' },
        { fixture: firstWindow, label: 'A', selector: '#level' },
        { fixture: firstWindow, label: 'A', selector: '#scrollbox' },
      ],
      display,
      scale,
      signal,
    });
    report.windowTargeting.push({ layout: candidate.name, bounds, ...inspection });
    if (inspection.ok) {
      selectedLayout = firstWindow.getBounds();
      report.windowTargeting.at(-1).effectiveBounds = selectedLayout;
      break;
    }
  }
  check(
    'all fixture action points resolve to the intended fixture windows',
    Boolean(selectedLayout),
    JSON.stringify(report.windowTargeting),
  );
  if (!selectedLayout) {
    throw new Error('no unobscured fixture layout passed read-only window targeting');
  }

  const firstTextScreenPoint = await readFixtureScreenPoint(firstWindow, '#target');
  const firstPoint = logicalPointToDeclared(firstTextScreenPoint, display, scale);
  const minHorizontalDistance = Math.abs(firstTextScreenPoint.x - originalPointerPosition.x);
  check(
    'fixture action points are far from the real pointer baseline',
    minHorizontalDistance >= 300,
    `horizontalDistance=${minHorizontalDistance.toFixed(1)}px`,
  );
  if (minHorizontalDistance < 300) {
    throw new Error('fixture action points are too close to distinguish a cursor warp');
  }

  console.log('\n5. Semantic background text on first window');
  const firstClick = await act({ type: 'left_click', coordinate: firstPoint });
  requireSemanticSuccess('first semantic background click dispatched', firstClick);
  requireLatestTargetPid('first click resolved to the fixture process', process.pid);
  const firstMarker = 'MAKA-CUA-FIRST';
  const firstType = await act({ type: 'type', text: firstMarker });
  requireSuccess('first semantic background type dispatched', firstType);
  await safetyMonitor.guard('first fixture read-back settle', () => sleep(300, signal));
  await stateCheck('first marker landed in first document', firstWindow, (state) => state.text === firstMarker);
  await stateCheck('second document stayed untouched', secondWindow, (state) => state.text === '');

  console.log('\n6. Semantic target switches to second window');
  await safetyMonitor.guard('switch fixture visibility to B', async () => {
    let firstStageBounds = selectedLayout;
    let secondStageBounds = selectedLayout;
    let splitAxis = 'none';
    if (selectedLayout.width >= 520) {
      splitAxis = 'horizontal';
      const gap = 8;
      const secondWidth = Math.min(360, Math.max(260, Math.floor(selectedLayout.width * 0.35)));
      firstStageBounds = {
        ...selectedLayout,
        width: selectedLayout.width - secondWidth - gap,
      };
      secondStageBounds = {
        ...selectedLayout,
        x: selectedLayout.x + firstStageBounds.width + gap,
        width: secondWidth,
      };
    } else if (selectedLayout.height >= 500) {
      splitAxis = 'vertical';
      const gap = 8;
      const secondHeight = Math.min(240, Math.max(160, Math.floor(selectedLayout.height * 0.3)));
      firstStageBounds = {
        ...selectedLayout,
        height: selectedLayout.height - secondHeight - gap,
      };
      secondStageBounds = {
        ...selectedLayout,
        y: selectedLayout.y + firstStageBounds.height + gap,
        height: secondHeight,
      };
    }
    firstWindow.setBounds(firstStageBounds);
    secondWindow.setBounds(secondStageBounds);
    secondWindow.showInactive();
    secondWindow.moveAbove(firstWindow.getMediaSourceId());
    secondWindow.moveTop();
    await sleep(250, signal);
    if (splitAxis === 'horizontal') {
      const currentPoint = await readFixtureScreenPoint(secondWindow, '#target');
      const currentBounds = secondWindow.getBounds();
      secondWindow.setPosition(
        currentBounds.x,
        Math.round(currentBounds.y + firstTextScreenPoint.y - currentPoint.y),
        false,
      );
      secondWindow.moveAbove(firstWindow.getMediaSourceId());
      secondWindow.moveTop();
      await sleep(150, signal);
    }
  });
  const secondInspection = await inspectFixtureTargets({
    probes: [{ fixture: secondWindow, label: 'B', selector: '#target' }],
    display,
    scale,
    signal,
  });
  report.windowTargeting.push({ stage: 'second-window', ...secondInspection });
  check(
    'second fixture target is unobscured before input',
    secondInspection.ok,
    JSON.stringify(secondInspection),
  );
  if (!secondInspection.ok) {
    throw new Error('second fixture target is obscured after inactive visibility switch');
  }
  const secondTextScreenPoint = await readFixtureScreenPoint(secondWindow, '#target');
  const secondPoint = logicalPointToDeclared(secondTextScreenPoint, display, scale);
  const secondClick = await act({ type: 'left_click', coordinate: secondPoint });
  requireSemanticSuccess('second semantic background click dispatched', secondClick);
  requireLatestTargetPid('second click resolved to the fixture process', process.pid);
  const secondMarker = 'MAKA-CUA-SECOND';
  const secondType = await act({ type: 'type', text: secondMarker });
  requireSuccess('second semantic background type dispatched', secondType);
  await safetyMonitor.guard('second fixture read-back settle', () => sleep(300, signal));
  await stateCheck('second marker landed in second document', secondWindow, (state) => state.text === secondMarker);
  await stateCheck('first marker remained isolated', firstWindow, (state) => state.text === firstMarker);

  console.log('\n7. Unverified key chords fail closed');
  const selectAll = await act({ type: 'key', text: 'cmd+a' });
  requireBackgroundKeyboardRefusal('unverified cmd+a was refused', selectAll);

  console.log('\n8. Complex pointer task matrix');
  await safetyMonitor.guard('switch fixture visibility back to A', async () => {
    secondWindow.hide();
    firstWindow.setBounds(selectedLayout);
    firstWindow.showInactive();
    firstWindow.moveTop();
    await sleep(250, signal);
  });
  const firstInspection = await inspectFixtureTargets({
    probes: [
      { fixture: firstWindow, label: 'A', selector: '#increment' },
      { fixture: firstWindow, label: 'A', selector: '#enabled' },
      { fixture: firstWindow, label: 'A', selector: '#level' },
      { fixture: firstWindow, label: 'A', selector: '#scrollbox' },
    ],
    display,
    scale,
    signal,
  });
  report.windowTargeting.push({ stage: 'complex-matrix', ...firstInspection });
  check(
    'complex fixture targets are unobscured before input',
    firstInspection.ok,
    JSON.stringify(firstInspection),
  );
  if (!firstInspection.ok) {
    throw new Error('complex fixture targets are obscured after inactive visibility switch');
  }
  const buttonPoint = logicalPointToDeclared(
    await readFixtureScreenPoint(firstWindow, '#increment'),
    display,
    scale,
  );
  await runSemanticCase({
    caseId: 'button.left_click',
    fixture: firstWindow,
    action: { type: 'left_click', coordinate: buttonPoint },
    actAction: act,
    signal,
    behaviorName: 'button count incremented once',
    behavior: (before, after) => after.count - before.count === 1,
  });

  const checkboxPoint = logicalPointToDeclared(
    await readFixtureScreenPoint(firstWindow, '#enabled'),
    display,
    scale,
  );
  await runSemanticCase({
    caseId: 'checkbox.left_click',
    fixture: firstWindow,
    action: { type: 'left_click', coordinate: checkboxPoint },
    actAction: act,
    signal,
    behaviorName: 'checkbox toggled on',
    behavior: (before, after) => before.enabled === false && after.enabled === true,
  });

  const scrollPoint = logicalPointToDeclared(
    await readFixtureScreenPoint(firstWindow, '#scrollbox'),
    display,
    scale,
  );
  observeAction(
    'scrollbox scroll dispatched',
    await act({
      type: 'scroll',
      coordinate: scrollPoint,
      scrollDirection: 'down',
      scrollAmount: 6,
    }),
  );
  await sleep(100, signal);
  await stateCheck('scrollbox moved down', firstWindow, (state) => state.scrollTop > 0);

  const sliderRect = await readFixtureScreenRect(firstWindow, '#level');
  const sliderStart = logicalPointToDeclared(
    {
      x: sliderRect.x + sliderRect.width * 0.1,
      y: sliderRect.y + sliderRect.height / 2,
    },
    display,
    scale,
  );
  const sliderEnd = logicalPointToDeclared(
    {
      x: sliderRect.x + sliderRect.width * 0.8,
      y: sliderRect.y + sliderRect.height / 2,
    },
    display,
    scale,
  );
  await runSemanticCase({
    caseId: 'range.left_click_drag',
    fixture: firstWindow,
    action: {
      type: 'left_click_drag',
      startCoordinate: sliderStart,
      coordinate: sliderEnd,
    },
    actAction: act,
    signal,
    behaviorName: 'slider value increased',
    behavior: (before, after) => after.level > before.level && after.level >= 60,
  });

  await runSemanticCase({
    caseId: 'button.right_click',
    fixture: firstWindow,
    action: { type: 'right_click', coordinate: buttonPoint },
    actAction: act,
    signal,
    behaviorName: 'right click reached DOM contextmenu once',
    behavior: (before, after) => after.contextMenus - before.contextMenus === 1,
  });

  await runSemanticCase({
    caseId: 'button.double_click',
    fixture: firstWindow,
    action: { type: 'double_click', coordinate: buttonPoint },
    actAction: act,
    signal,
    behaviorName: 'button double click added two activations',
    behavior: (before, after) => after.count - before.count === 2,
  });

  console.log('\n9. Overlay and visual-only movement');
  const overlayCountBefore = overlayMoves.length;
  const move = await act({ type: 'mouse_move', coordinate: secondPoint });
  check('mouse_move acknowledged without real-pointer dispatch', move.outcome.ok);
  await safetyMonitor.guard('overlay settle', () => sleep(800, signal));
  const newOverlayMoves = overlayMoves.slice(overlayCountBefore);
  check('overlay received the visual move', newOverlayMoves.some((event) => event.kind === 'move'));
  const latestOverlayMove = newOverlayMoves.at(-1);
  if (latestOverlayMove) {
    const expected = secondTextScreenPoint;
    check(
      'overlay coordinate matches logical target',
      Math.hypot(latestOverlayMove.screenX - expected.x, latestOverlayMove.screenY - expected.y) < 1.5,
      `actual=(${latestOverlayMove.screenX},${latestOverlayMove.screenY}) expected=(${expected.x},${expected.y})`,
    );
    const finalCapture = captureOverlayPhase(
      latestOverlayMove,
      'move-final',
      Date.now(),
      0,
    );
    if (finalCapture) await finalCapture;
  }
  safetyMonitor.assertStable('overlay movement');

  console.log('\n10. Post-action screenshot and wait');
  const postScreenshot = await act({ type: 'screenshot' });
  check('post-action screenshot captured', postScreenshot.outcome.ok && Boolean(postScreenshot.screenshot));
  const waitStartedAt = Date.now();
  const wait = await act({ type: 'wait', durationMs: 500 });
  check('wait completed', wait.outcome.ok && Date.now() - waitStartedAt >= 450);

  const failed = results.filter((result) => !result.pass);
  console.log('\n=======================================================');
  console.log(`  RESULT: ${results.length - failed.length}/${results.length} passed`);
  for (const failure of failed) {
    console.log(`  FAIL ${failure.name}${failure.detail ? ` - ${failure.detail}` : ''}`);
  }
  console.log('=======================================================');
  process.exitCode = failed.length > 0 ? 1 : 0;
  } catch (error) {
    console.error('Computer Use E2E fatal:', error);
    report.fatal = error instanceof Error ? error.message : String(error);
    process.exitCode = 1;
  } finally {
    for (const fixture of fixtureWindows) {
      if (!fixture.isDestroyed()) fixture.destroy();
    }
    try {
      safetyMonitor?.assertStable('fixture teardown');
    } catch (error) {
      console.error('Computer Use E2E safety monitor failed:', error);
      process.exitCode = 1;
    }
    await safetyMonitor?.stop();
    freshBackend?.dispose();
    backend?.dispose();
    overlay?.destroyAll();
    await Promise.allSettled(overlayCapturePromises);
    const failed = results.filter((result) => !result.pass);
    report.summary = {
      passed: results.length - failed.length,
      failed: failed.length,
      total: results.length,
      exitCode: process.exitCode ?? 0,
      finishedAt: new Date().toISOString(),
    };
    try {
      const reportDir = join(here, '..', '.agents-workspace-data', 'cu-e2e');
      await mkdir(reportDir, { recursive: true });
      const reportText = JSON.stringify(report, null, 2);
      const requestedReportFile = process.env.MAKA_CU_E2E_REPORT_FILE;
      const runFile = requestedReportFile
        ? requestedReportFile
        : join(reportDir, `${report.runId.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
      await mkdir(dirname(runFile), { recursive: true });
      await writeFile(runFile, reportText, 'utf8');
      await writeFile(join(reportDir, 'latest.json'), reportText, 'utf8');
    } catch (error) {
      console.error('Computer Use E2E report write failed:', error);
      process.exitCode = 1;
    }
    app.exit(process.exitCode ?? 0);
  }
}

app.whenReady().then(run).catch((error) => {
  console.error('Computer Use E2E startup failed:', error);
  process.exitCode = 1;
  app.exit(1);
});
