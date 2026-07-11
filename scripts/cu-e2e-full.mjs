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
import { app, BrowserWindow, screen } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const { createCuaDriverBackend, createComputerUseOverlayHook } = await import(
  join(here, '..', 'packages', 'computer-use', 'dist', 'index.js')
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

async function createFixtureWindow(label, bounds) {
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
  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Maka Computer Use E2E ${label}</title>
    <style>
      html, body { width: 100%; height: 100%; margin: 0; background: #fff; }
      body { box-sizing: border-box; padding: 24px; font-family: -apple-system, sans-serif; }
      textarea {
        box-sizing: border-box;
        width: 100%;
        height: 100%;
        resize: none;
        border: 1px solid #777;
        border-radius: 4px;
        padding: 16px;
        font: 16px/1.5 ui-monospace, monospace;
      }
    </style>
  </head>
  <body>
    <textarea id="target" aria-label="Maka Computer Use E2E ${label} input"></textarea>
  </body>
</html>`;
  await fixture.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  fixture.showInactive();
  return fixture;
}

async function readFixtureText(fixture) {
  if (fixture.isDestroyed()) throw new Error('fixture window was destroyed');
  return fixture.webContents.executeJavaScript(
    'document.querySelector("#target")?.value ?? ""',
    true,
  );
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

function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
}

function outcomeDetail(result) {
  return JSON.stringify(result.outcome);
}

function requireSuccess(label, result) {
  check(label, result.outcome.ok, outcomeDetail(result));
  if (!result.outcome.ok) throw new Error(`${label}: ${outcomeDetail(result)}`);
}

function requireBackgroundKeyboardRefusal(label, result) {
  const pass = !result.outcome.ok
    && result.outcome.error === 'unsupported_action';
  check(label, pass, outcomeDetail(result));
  if (!pass) throw new Error(`${label}: ${outcomeDetail(result)}`);
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
      overlayMoves.push({ ...input, ts: Date.now() });
      overlay.move(input);
    },
  };
  const hook = createComputerUseOverlayHook(sink, screen);
  const sessionId = `cu-e2e-${Date.now()}`;
  let actionSequence = 0;

  async function act(action, activeBackend = backend) {
    const context = {
      sessionId,
      turnId: 'real-machine-e2e',
      toolCallId: `e2e-${actionSequence++}`,
    };
    return safetyMonitor.guard(`computer.${action.type}`, async () => {
      try {
        hook.onActionBegin(action, context);
        return await activeBackend.run(action, signal, context);
      } finally {
        hook.onActionEnd?.(context);
      }
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
  const pointerOnLeft = originalPointerPosition.x < display.bounds.x + usableWidth / 2;
  const fixtureX = pointerOnLeft
    ? display.bounds.x + usableWidth - fixtureWidth - 40
    : display.bounds.x + 40;
  const requestedFirstBounds = {
    x: fixtureX,
    y: display.bounds.y + 40,
    width: fixtureWidth,
    height: fixtureHeight,
  };
  const requestedSecondBounds = {
    x: fixtureX,
    y: display.bounds.y + usableHeight - fixtureHeight - 40,
    width: fixtureWidth,
    height: fixtureHeight,
  };
  const firstWindow = await safetyMonitor.guard(
    'first inactive fixture reveal',
    async () => {
      const fixture = await createFixtureWindow('A', requestedFirstBounds);
      fixtureWindows.add(fixture);
      return fixture;
    },
  );
  const secondWindow = await safetyMonitor.guard(
    'second inactive fixture reveal',
    async () => {
      const fixture = await createFixtureWindow('B', requestedSecondBounds);
      fixtureWindows.add(fixture);
      return fixture;
    },
  );
  if (firstWindow.id === secondWindow.id) {
    throw new Error(`Electron reused fixture window id ${firstWindow.id}`);
  }
  await safetyMonitor.guard('fixture setup settle', () => sleep(300, signal));
  const firstBounds = firstWindow.getContentBounds();
  const secondBounds = secondWindow.getContentBounds();
  check(
    'two separate inactive fixture windows revealed',
    fixtureWindows.size === 2,
    `windowIds=${firstWindow.id},${secondWindow.id}`,
  );

  const textBodyPoint = (bounds) => ({
    x: bounds.x + Math.round(bounds.width / 2),
    y: bounds.y + Math.min(bounds.height - 80, 180),
  });
  const firstPoint = logicalPointToDeclared(textBodyPoint(firstBounds), display, scale);
  const secondPoint = logicalPointToDeclared(textBodyPoint(secondBounds), display, scale);
  const minHorizontalDistance = Math.min(
    Math.abs(textBodyPoint(firstBounds).x - originalPointerPosition.x),
    Math.abs(textBodyPoint(secondBounds).x - originalPointerPosition.x),
  );
  check(
    'fixture action points are far from the real pointer baseline',
    minHorizontalDistance >= 300,
    `horizontalDistance=${minHorizontalDistance.toFixed(1)}px`,
  );
  if (minHorizontalDistance < 300) {
    throw new Error('fixture action points are too close to distinguish a cursor warp');
  }

  console.log('\n5. Target-bound click/type on first background window');
  const firstClick = await act({ type: 'left_click', coordinate: firstPoint });
  requireSuccess('first background click dispatched', firstClick);
  const firstMarker = 'MAKA-CUA-FIRST';
  const firstType = await act({ type: 'type', text: firstMarker });
  requireBackgroundKeyboardRefusal('unverified first background type was refused', firstType);
  await safetyMonitor.guard('first fixture read-back settle', () => sleep(300, signal));
  const [firstTextAfterFirstType, secondTextAfterFirstType] = await safetyMonitor.guard(
    'first fixture read-back',
    () => Promise.all([
      readFixtureText(firstWindow),
      readFixtureText(secondWindow),
    ]),
  );
  check('first document stayed untouched after refused type', firstTextAfterFirstType.length === 0);
  check('second document stayed untouched', secondTextAfterFirstType.length === 0);

  console.log('\n6. Target switches with the second background window');
  const secondClick = await act({ type: 'left_click', coordinate: secondPoint });
  requireSuccess('second background click dispatched', secondClick);
  const secondMarker = 'MAKA-CUA-SECOND';
  const secondType = await act({ type: 'type', text: secondMarker });
  requireBackgroundKeyboardRefusal('unverified second background type was refused', secondType);
  await safetyMonitor.guard('second fixture read-back settle', () => sleep(300, signal));
  const [firstTextAfterSecondType, secondTextAfterSecondType] = await safetyMonitor.guard(
    'second fixture read-back',
    () => Promise.all([
      readFixtureText(firstWindow),
      readFixtureText(secondWindow),
    ]),
  );
  check('second document stayed untouched after refused type', secondTextAfterSecondType.length === 0);
  check('first document remained untouched', firstTextAfterSecondType.length === 0);

  console.log('\n7. Unverified key chords fail closed');
  const selectAll = await act({ type: 'key', text: 'cmd+a' });
  requireBackgroundKeyboardRefusal('unverified cmd+a was refused', selectAll);

  console.log('\n8. Pointer action coverage');
  const doubleClick = await act({ type: 'double_click', coordinate: firstPoint });
  check('double click dispatched', doubleClick.outcome.ok);
  const scroll = await act({
    type: 'scroll',
    coordinate: firstPoint,
    scrollDirection: 'down',
    scrollAmount: 3,
  });
  check('scroll dispatched', scroll.outcome.ok);
  const dragStart = logicalPointToDeclared(
    { x: firstBounds.x + 120, y: firstBounds.y + 180 },
    display,
    scale,
  );
  const dragEnd = logicalPointToDeclared(
    { x: firstBounds.x + Math.min(firstBounds.width - 80, 360), y: firstBounds.y + 180 },
    display,
    scale,
  );
  const drag = await act({
    type: 'left_click_drag',
    startCoordinate: dragStart,
    coordinate: dragEnd,
  });
  check('same-window drag dispatched', drag.outcome.ok);

  console.log('\n9. Overlay and visual-only movement');
  const overlayCountBefore = overlayMoves.length;
  const move = await act({ type: 'mouse_move', coordinate: secondPoint });
  check('mouse_move acknowledged without real-pointer dispatch', move.outcome.ok);
  await safetyMonitor.guard('overlay settle', () => sleep(800, signal));
  const newOverlayMoves = overlayMoves.slice(overlayCountBefore);
  check('overlay received the visual move', newOverlayMoves.some((event) => event.kind === 'move'));
  const latestOverlayMove = newOverlayMoves.at(-1);
  if (latestOverlayMove) {
    const expected = textBodyPoint(secondBounds);
    check(
      'overlay coordinate matches logical target',
      Math.hypot(latestOverlayMove.screenX - expected.x, latestOverlayMove.screenY - expected.y) < 1.5,
      `actual=(${latestOverlayMove.screenX},${latestOverlayMove.screenY}) expected=(${expected.x},${expected.y})`,
    );
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
    app.exit(process.exitCode ?? 0);
  }
}

app.whenReady().then(run).catch((error) => {
  console.error('Computer Use E2E startup failed:', error);
  process.exitCode = 1;
  app.exit(1);
});
