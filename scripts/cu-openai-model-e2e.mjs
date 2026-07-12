import { app, BrowserWindow, nativeImage, screen } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizeCuDirectReport } from './cu-report-sanitize.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const {
  buildComputerUseTools,
  createOpenAIResponsesTransport,
  runOpenAIComputerLoop,
} = await import(join(repoRoot, 'packages', 'runtime', 'dist', 'index.js'));
const {
  createCuaDriverBackend,
  createComputerUseOverlayHook,
} = await import(join(repoRoot, 'packages', 'computer-use', 'dist', 'index.js'));
const { createCursorOverlayController } = await import(
  join(repoRoot, 'apps', 'desktop', 'dist', 'main', 'computer-use', 'cursor-overlay-window.js')
);

const model = process.env.MAKA_CU_OPENAI_MODEL ?? 'gpt-5.4';
const baseUrl = process.env.MAKA_CU_OPENAI_BASE_URL ?? 'http://127.0.0.1:8538/v1';
const bearerToken = process.env.MAKA_CU_OPENAI_BEARER_TOKEN;
const reportPath = process.env.MAKA_CU_OPENAI_REPORT
  ?? join(repoRoot, '.agents-workspace-data', 'cu-openai-e2e', `report-${Date.now()}.json`);
const cdpPort = Number(process.env.MAKA_CU_E2E_CDP_PORT ?? 0);
const prompt = process.env.MAKA_CU_OPENAI_PROMPT
  ?? 'Inspect the screen. In the window titled "Maka OpenAI Computer Use Fixture", click the blue "Increment blue" button exactly once. Do not click the red button. Verify the visible count becomes 1, then stop.';

app.setActivationPolicy('accessory');
app.on('window-all-closed', () => {});

let fixture;
let backend;
let overlay;

function actionArgs(action) {
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
      throw new Error(`unsupported action: ${action.type}`);
  }
}

async function createFixture() {
  const display = screen.getPrimaryDisplay();
  const width = Math.min(720, Math.max(560, display.workArea.width - 80));
  const height = Math.min(520, Math.max(420, display.workArea.height - 80));
  const win = new BrowserWindow({
    x: display.workArea.x + Math.max(20, display.workArea.width - width - 40),
    y: display.workArea.y + Math.max(20, display.workArea.height - height - 40),
    width,
    height,
    show: false,
    focusable: true,
    backgroundColor: '#f6f7f9',
    title: 'Maka OpenAI Computer Use Fixture',
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html><head><meta charset="utf-8"><title>Maka OpenAI Computer Use Fixture</title>
<style>
html,body{width:100%;height:100%;margin:0;background:#f6f7f9}
body{box-sizing:border-box;padding:28px;font:16px/1.4 -apple-system,sans-serif;color:#172033}
main{display:grid;grid-template-rows:auto auto auto 1fr;gap:22px;height:100%}
h1{margin:0;font-size:24px}.row{display:flex;align-items:center;gap:18px}
button{width:180px;height:56px;border:2px solid #315ee7;background:#fff;font:600 17px -apple-system,sans-serif}
#secondary{border-color:#c54343}output{min-width:90px;font:700 24px ui-monospace,monospace}
#status{padding:18px;border:1px solid #9aa5b4;background:#fff}
</style></head><body><main>
<h1>OpenAI computer-use target</h1>
<div class="row"><button id="primary">Increment blue</button><button id="secondary">Do not click red</button><output id="count">0</output></div>
<div id="status">Expected final state: blue count = 1, red count = 0.</div>
</main><script>
const state={blue:0,red:0};
primary.addEventListener('click',()=>{state.blue+=1;count.value=String(state.blue)});
secondary.addEventListener('click',()=>{state.red+=1});
globalThis.__makaState=()=>({...state});
</script></body></html>`)}`);
  win.showInactive();
  win.moveTop();
  return win;
}

async function run() {
  const signal = new AbortController().signal;
  fixture = await createFixture();
  const traces = [];
  const actions = [];
  const display = screen.getPrimaryDisplay();
  const binaryPath = join(repoRoot, 'apps', 'desktop', 'resources', 'bin', 'cua-driver');
  backend = createCuaDriverBackend({
    binaryPath,
    hostBundleId: 'com.maka.desktop',
    timeoutMs: 15_000,
    compressFrame: (base64) => {
      const image = nativeImage.createFromBuffer(Buffer.from(base64, 'base64'));
      return image.isEmpty()
        ? { base64, mimeType: 'image/png' }
        : { base64: image.toJPEG(82).toString('base64'), mimeType: 'image/jpeg' };
    },
    onTrace: (event) => traces.push({ ...event, at: Date.now() }),
  });
  const overlayDist = join(repoRoot, 'apps', 'desktop', 'dist', 'overlay');
  overlay = createCursorOverlayController({
    preloadPath: join(overlayDist, 'cursor-overlay-preload.cjs'),
    htmlPath: join(overlayDist, 'cursor-overlay.html'),
  });
  const hook = createComputerUseOverlayHook(overlay, screen);
  const [computer] = buildComputerUseTools({ backend, overlay: hook });
  const sessionId = `openai-e2e-${Date.now()}`;
  const turnId = 'openai-real-model-loop';
  let sequence = 0;

  async function assertFixtureOwnsAction(action) {
    const points = [];
    if ('coordinate' in action && action.coordinate) points.push(action.coordinate);
    if (action.type === 'left_click_drag') points.push(action.startCoordinate);
    if (action.type === 'zoom') {
      points.push(
        { x: action.region.x1, y: action.region.y1 },
        { x: action.region.x2, y: action.region.y2 },
      );
    }
    for (const point of points) {
      const target = await backend.inspectWindowAt(point, signal);
      if (
        target?.pid !== process.pid
        || target.title !== 'Maka OpenAI Computer Use Fixture'
      ) {
        throw new Error(
          `target_occluded: refusing ${action.type} at (${point.x},${point.y}); `
          + `current target=${target?.title ?? 'none'} pid=${target?.pid ?? 'none'}`,
        );
      }
    }
  }

  async function execute(action) {
    await assertFixtureOwnsAction(action);
    const toolCallId = `openai-action-${sequence++}`;
    const startedAt = Date.now();
    const result = await computer.impl(actionArgs(action), {
      sessionId,
      turnId,
      toolCallId,
      cwd: repoRoot,
      abortSignal: signal,
      emitOutput() {},
    });
    const record = {
      action,
      durationMs: Date.now() - startedAt,
      text: result?.text,
    };
    actions.push(record);
    if (result?.screenshot) {
      return {
        base64: result.screenshot.base64,
        mimeType: result.screenshot.mimeType,
      };
    }
  }

  const transport = createOpenAIResponsesTransport({ baseUrl, bearerToken });
  const startedAt = Date.now();
  const loop = await runOpenAIComputerLoop({
    dialect: 'ga',
    model,
    prompt,
    transport,
    executor: { execute },
    screenshot: {
      async capture() {
        const shot = await execute({ type: 'screenshot' });
        if (!shot) throw new Error('screenshot action returned no image');
        return shot;
      },
    },
    maxTurns: 16,
  });
  const state = await fixture.webContents.executeJavaScript('globalThis.__makaState()', true);
  const report = {
    schemaVersion: 1,
    evidenceClass: 'real-runtime',
    policyMode: 'bypassed',
    scenarioId: process.env.MAKA_CU_E2E_SCENARIO ?? 'l1-single-click',
    model,
    baseUrl,
    cdpPort,
    totalLatencyMs: Date.now() - startedAt,
    loopStatus: loop.status,
    turns: loop.turns,
    state,
    actions,
    traces,
    display: {
      widthPx: Math.round(display.bounds.width * display.scaleFactor),
      heightPx: Math.round(display.bounds.height * display.scaleFactor),
    },
  };
  const sanitizedReport = sanitizeCuDirectReport(report);
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(sanitizedReport, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  console.log(`[cu-openai-e2e] ${JSON.stringify({
    model,
    totalLatencyMs: report.totalLatencyMs,
    loopStatus: loop.status,
    turns: loop.turns,
    state,
    actionCount: actions.length,
  })}`);
  console.log(`[cu-openai-e2e] report=${reportPath}`);
  if (state.blue !== 1 || state.red !== 0) {
    throw new Error(`fixture verification failed: ${JSON.stringify(state)}`);
  }
}

app.whenReady().then(async () => {
  try {
    await run();
  } catch (error) {
    console.error('[cu-openai-e2e] FAILED:', error);
    process.exitCode = 1;
  } finally {
    backend?.dispose();
    overlay?.destroyAll();
    fixture?.destroy();
    app.quit();
  }
});
