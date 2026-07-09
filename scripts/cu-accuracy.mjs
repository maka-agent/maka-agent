// CLI coordinate-accuracy probe (~6s, no Electron/LLM). Replicates the backend's
// window-resolution + click transform against the real cua-driver on a scratch
// TextEdit, using debug_image_out to draw a crosshair where the click LANDED, then
// reads that PNG (PIL) to confirm it's where we intended. Verifies the full
// device-px → window-local transform end to end. Cleans up.
import { spawn, execFileSync } from 'node:child_process';
const BIN = process.argv[2] || '/Users/haoqing/Documents/Github/maka-agent/apps/desktop/resources/bin/cua-driver';
const DBG = '/Users/haoqing/.claude/jobs/9821c7cd/tmp/cu-acc.png';
const child = spawn(BIN, ['mcp', '--embedded', '--no-daemon-relaunch', '--no-overlay', '--host-bundle-id', 'com.maka.desktop'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, CUA_DRIVER_EMBEDDED: '1', CUA_DRIVER_RS_TELEMETRY_ENABLED: 'false', CUA_DRIVER_RS_UPDATE_CHECK: 'false', CUA_DRIVER_RS_MCP_NO_RELAUNCH: '1' } });
let buf = ''; const pending = new Map(); let nextId = 1;
child.stdout.setEncoding('utf8');
child.stdout.on('data', (c) => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!l) continue; let m; try { m = JSON.parse(l); } catch { continue; } if (typeof m.id === 'number' && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } });
child.stderr.resume();
const req = (method, params, t = 9000) => { const id = nextId++; return new Promise((res) => { const to = setTimeout(() => { pending.delete(id); res({ __timeout: true }); }, t); pending.set(id, (m) => { clearTimeout(to); res(m); }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); }); };
const notify = (m, p) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: m, params: p }) + '\n');
const call = async (n, a = {}) => (await req('tools/call', { name: n, arguments: a }))?.result;
const sc = (r) => r?.structuredContent ?? {};
const osa = (s) => { try { return execFileSync('osascript', ['-e', s], { encoding: 'utf8' }).trim(); } catch { return 'err'; } };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Find the crosshair as the intersection of its red vertical + horizontal lines
// (peak red column × peak red row) — robust vs a centroid, which the spanning
// lines pull toward center. Returns "cx cy w h".
const findCross = (png) => {
  const out = execFileSync('python3', ['-c', `
import sys,numpy as np
from PIL import Image
im=np.asarray(Image.open(sys.argv[1]).convert('RGB')).astype(int)
r,g,b=im[:,:,0],im[:,:,1],im[:,:,2]
mask=(r>200)&(g<60)&(b<60)
h,w=im.shape[0],im.shape[1]
if mask.sum()==0: print(f'NONE {w} {h}')
else: print(f'{int(np.argmax(mask.sum(axis=0)))} {int(np.argmax(mask.sum(axis=1)))} {w} {h}')
`, png], { encoding: 'utf8' }).trim();
  return out;
};

const main = async () => {
  await req('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'acc', version: '0' } });
  notify('notifications/initialized');
  const ds = await call('get_desktop_state', {});
  const deviceW = sc(ds).screenshot_width || 0;
  const logicalW = sc(await call('get_screen_size')).width || 0;
  const scale = deviceW && logicalW ? deviceW / logicalW : 2;
  console.log(`deviceW=${deviceW} logicalW=${logicalW} scale=${scale}`);

  osa('tell application "TextEdit" to activate'); osa('tell application "TextEdit" to make new document'); await delay(900);
  const te = (sc(await call('list_windows')).windows || []).filter((w) => /TextEdit|文本编辑/i.test(String(w.app_name || '')) && w.layer === 0 && w.bounds && w.bounds.height > 200)[0];
  if (!te) { console.log('no TextEdit document window (only chrome?):', (sc(await call('list_windows')).windows || []).filter((w) => /TextEdit|文本编辑/i.test(String(w.app_name || ''))).map((w) => `${w.bounds?.width}x${w.bounds?.height}`)); child.kill('SIGKILL'); process.exit(1); }
  const b = te.bounds;
  console.log(`window bounds(logical)=(${b.x},${b.y} ${b.width}x${b.height})`);

  // Test a few fractional points inside the window.
  for (const [fx, fy, name] of [[0.5, 0.5, 'center'], [0.25, 0.25, 'upper-left Q'], [0.75, 0.6, 'lower-right']]) {
    // window-local DEVICE px the backend would send for a click at this window fraction:
    const localX = Math.round(b.width * scale * fx);
    const localY = Math.round(b.height * scale * fy);
    execFileSync('rm', ['-f', DBG]);
    await call('click', { pid: te.pid, window_id: te.window_id, x: localX, y: localY, debug_image_out: DBG });
    await delay(200);
    let res = 'no-debug-image';
    try { res = findCross(DBG); } catch (e) { res = 'read-fail: ' + e.message.split('\n')[0]; }
    const [cx, cy, pw, ph] = res.split(' ');
    if (cx === 'NONE' || res.startsWith('read')) { console.log(`${name.padEnd(14)} local=(${localX},${localY}) → crosshair ${res}`); continue; }
    // Expected crosshair pos = the fraction of the debug PNG (which is the window PNG, device px).
    const exX = Math.round(Number(pw) * fx), exY = Math.round(Number(ph) * fy);
    const err = Math.round(Math.hypot(Number(cx) - exX, Number(cy) - exY));
    console.log(`${name.padEnd(14)} local=(${localX},${localY}) png=${pw}x${ph} crosshair=(${cx},${cy}) expected≈(${exX},${exY}) err=${err}px`);
  }

  await call('kill_app', { pid: te.pid });
  child.kill('SIGKILL'); process.exit(0);
};
main().catch((e) => { console.error(e); try { child.kill('SIGKILL'); } catch {} process.exit(1); });
