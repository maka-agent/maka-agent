// Systematic row-alignment auditor (design governance tool).
//
// For every visual-smoke fixture, finds horizontal clusters of interactive
// controls and reports:
//   - height mismatch  (same control type sharing a row)
//   - centerline drift (mixed control types sharing a row)
//   - radius mismatch  (same-row controls on different radius families;
//                       role=switch is pill by design and exempt)
// Usage: node scripts/audit-alignment.mjs   (expects a built renderer)
// Rule of thumb: mixed types align CENTERS; same types also match heights.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DESKTOP_DIR = join(ROOT, 'apps', 'desktop');
const FIXTURES = [
  'module-skills',
  'module-mcp',
  'module-daily-review',
  'plan-reminders',
  'settings-general',
  'fetched-empty',
  'settings-data',
  'settings-gateway',
  'turn-narrative',
  'settings-permissions',
];
const BOOT_TIMEOUT_MS = Number(process.env.AUDIT_BOOT_TIMEOUT_MS ?? 30_000);
const SETTLE_MS = Number(process.env.AUDIT_SETTLE_MS ?? 2_500);
let port = Number(process.env.AUDIT_PORT_BASE ?? 14_600);
let totalIssues = 0;
let fixtureErrors = 0;

// Resolve via the electron package export so Linux CI gets
// `electron/dist/electron` and macOS gets `Electron.app/.../Electron`.
// Hardcoding the .app path is what broke the ubuntu-latest e2e job in #695.
async function resolveElectronBin() {
  try {
    const bin = (await import('electron')).default;
    if (typeof bin === 'string') return bin;
  } catch (err) {
    console.error('[audit-alignment] electron not resolvable (run `npm install`):', err);
    process.exit(2);
  }
  console.error(
    '[audit-alignment] electron resolved but exposed no binary path; run `npm install`.',
  );
  process.exit(2);
}

function launchArgs(debugPort, userDataDir) {
  // Chromium/Electron switches must come before the app path. Mirror the
  // capture-screenshots / Playwright e2e launch: cwd=apps/desktop, app='.'.
  const args = [`--remote-debugging-port=${debugPort}`, `--user-data-dir=${userDataDir}`];
  // Headless Linux runners (GitHub Actions) need these; macOS/Windows e2e
  // already pass without them. Playwright's chromium launcher adds the same
  // set — raw electron spawn does not.
  if (process.platform === 'linux') {
    args.push('--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage');
  }
  args.push('.');
  return args;
}

function tail(buf, n = 600) {
  const s = buf.toString();
  return s.length <= n ? s : s.slice(-n);
}

/** Poll CDP until a page target appears, or the process exits / times out. */
async function waitForPageTarget(debugPort, child, stderrBuf, stdoutBuf) {
  const started = Date.now();
  while (Date.now() - started < BOOT_TIMEOUT_MS) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `electron exited code=${child.exitCode} signal=${child.signalCode}` +
          ` stderr=${JSON.stringify(tail(stderrBuf))}` +
          ` stdout=${JSON.stringify(tail(stdoutBuf))}`,
      );
    }
    try {
      const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `CDP timeout after ${BOOT_TIMEOUT_MS}ms` +
      ` stderr=${JSON.stringify(tail(stderrBuf))}` +
      ` stdout=${JSON.stringify(tail(stdoutBuf))}`,
  );
}

function cdpSend(ws) {
  let id = 0;
  return (method, params) =>
    new Promise((res, rej) => {
      const i = ++id;
      const onMessage = (e) => {
        let d;
        try {
          d = JSON.parse(e.data);
        } catch (err) {
          rej(err);
          return;
        }
        if (d.id !== i) return;
        ws.removeEventListener('message', onMessage);
        if (d.error) rej(new Error(d.error.message ?? JSON.stringify(d.error)));
        else res(d.result);
      };
      ws.addEventListener('message', onMessage);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
}

const EXPR = `(()=>{
  const controls=[...document.querySelectorAll('button,[role=button],[role=switch],input,select,[role=combobox],[role=tab]')].filter(e=>{
    const r=e.getBoundingClientRect();
    const cs=getComputedStyle(e);
    return r.width>0 && r.height>8 && cs.visibility!=='hidden' && cs.display!=='none';
  });
  const clusters=new Map();
  for(const e of controls){
    const p=e.parentElement; if(!p) continue;
    if(!clusters.has(p)) clusters.set(p,[]);
    clusters.get(p).push(e);
  }
  const issues=[];
  for(const [p,els] of clusters){
    if(els.length<2) continue;
    const rects=els.map(e=>({e,r:e.getBoundingClientRect(),cs:getComputedStyle(e)}));
    // horizontal cluster: vertical ranges overlap pairwise with the first
    const base=rects[0].r;
    const horiz=rects.filter(({r})=>Math.min(r.bottom,base.bottom)-Math.max(r.top,base.top) > Math.min(r.height,base.height)*0.5);
    if(horiz.length<2) continue;
    const type=(e)=>e.getAttribute('role')||e.tagName;
    const sameType=new Set(horiz.map(({e})=>type(e))).size===1;
    const hs=horiz.map(({r})=>+r.height.toFixed(1));
    const cys=horiz.map(({r})=>+(r.top+r.height/2).toFixed(1));
    const rads=horiz.map(({cs})=>cs.borderRadius);
    const label=(e)=>((e.getAttribute('aria-label')||e.textContent||e.className||'').trim().slice(0,16));
    const hSpread=Math.max(...hs)-Math.min(...hs);
    const cySpread=Math.max(...cys)-Math.min(...cys);
    const radSet=[...new Set(horiz.filter(({e})=>e.getAttribute('role')!=='switch').map(({cs})=>cs.borderRadius).filter(x=>!x.includes('%')&&parseFloat(x)<100))];
    if(hSpread>2.5 && sameType) issues.push({kind:'height',parent:p.className.split(' ')[0]||p.tagName,spread:+hSpread.toFixed(1),items:horiz.map(({e,r})=>label(e)+':'+r.height.toFixed(0))});
    if(cySpread>1.5 && (!sameType || hSpread<=2.5)) issues.push({kind:'center',parent:p.className.split(' ')[0]||p.tagName,spread:+cySpread.toFixed(1),items:horiz.map(({e,r})=>label(e)+':'+(r.top+r.height/2).toFixed(0))});
    if(radSet.length>1 && hSpread<=2.5) issues.push({kind:'radius',parent:p.className.split(' ')[0]||p.tagName,items:horiz.map(({e,cs})=>label(e)+':'+cs.borderRadius)});
  }
  return JSON.stringify(issues.slice(0,12));
})()`;

const ELECTRON = await resolveElectronBin();

for (const fx of FIXTURES) {
  const P = port++;
  const userDataDir = join(tmpdir(), `maka-audit-${P}-${process.pid}`);
  const stderrBuf = {
    s: '',
    toString() {
      return this.s;
    },
  };
  const stdoutBuf = {
    s: '',
    toString() {
      return this.s;
    },
  };
  const child = spawn(ELECTRON, launchArgs(P, userDataDir), {
    cwd: DESKTOP_DIR,
    env: {
      ...process.env,
      MAKA_VISUAL_SMOKE_FIXTURE: fx,
      MAKA_VISUAL_SMOKE_THEME: 'light',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr?.on('data', (d) => {
    stderrBuf.s += d;
    if (stderrBuf.s.length > 8_000) stderrBuf.s = stderrBuf.s.slice(-4_000);
  });
  child.stdout?.on('data', (d) => {
    stdoutBuf.s += d;
    if (stdoutBuf.s.length > 8_000) stdoutBuf.s = stdoutBuf.s.slice(-4_000);
  });
  // Surface spawn failures (ENOENT etc.) into the try/catch instead of an
  // unhandled 'error' event that crashes the process before fixtureErrors++.
  const launchError = new Promise((_, rej) => child.once('error', rej));
  try {
    const page = await Promise.race([
      waitForPageTarget(P, child, stderrBuf, stdoutBuf),
      launchError,
    ]);
    // Fixture paint settles after the page target appears; fixed 8.5s was both
    // slow on warm macOS and still insufficient when boot itself never finished.
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r, j) => {
      ws.addEventListener('open', r, { once: true });
      ws.addEventListener('error', () => j(new Error('cdp websocket error')), { once: true });
    });
    const send = cdpSend(ws);
    const r = await send('Runtime.evaluate', { expression: EXPR, returnByValue: true });
    console.log('==', fx, '==');
    const arr = JSON.parse(r.result.value);
    for (const i of arr) console.log(JSON.stringify(i));
    totalIssues += arr.length;
    if (!arr.length) console.log('(clean)');
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  } catch (e) {
    console.log('==', fx, '== ERROR', e.message);
    fixtureErrors++;
  }
  child.kill('SIGKILL');
}

// CI semantics: alignment findings fail the run; fixture-level launch errors
// fail too (a fixture that can't boot means the audit didn't actually cover it).
if (totalIssues > 0 || fixtureErrors > 0) {
  console.log(`FAIL: ${totalIssues} alignment issue(s), ${fixtureErrors} fixture error(s)`);
  process.exit(1);
}
console.log('alignment audit: all fixtures clean');
process.exit(0);
