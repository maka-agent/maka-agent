// HIGH-FIDELITY CLI: drives the REAL desktop-side computer-use path end to end —
// the runtime `computer` tool impl (S12 TCC recheck + adaptToCuAction) → the REAL
// overlay hook (declared-px → screen transform) → the REAL cua-driver backend
// (window resolution + no-warp click). Everything EXCEPT the Electron overlay
// window and the LLM. This is what the app runs; only the BrowserWindow render and
// the model are stubbed (a fake overlay controller records screen coords; the
// action args are what a model would emit). ~6s.
//
// Run: node scripts/cu-tool-cli.mjs
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildComputerUseTools } from '../packages/runtime/dist/index.js';
import { createCuaDriverBackend } from '../packages/computer-use/dist/index.js';
import { createComputerUseOverlayHook } from '../packages/computer-use/dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const binary = process.argv[2] || join(here, '..', 'apps', 'desktop', 'resources', 'bin', 'cua-driver');
const osa = (s) => { try { return execFileSync('osascript', ['-e', s], { encoding: 'utf8' }).trim(); } catch { return 'err'; } };

// Real backend.
const backend = createCuaDriverBackend({ binaryPath: binary, hostBundleId: 'com.maka.desktop', timeoutMs: 8000 });

// Real overlay hook, driven by a fake controller (records what the overlay WOULD
// be told) + a fake Electron screen (Retina 2×, like the real display).
const moves = [];
const controller = { ensure: () => {}, move: (m) => moves.push(m), clearForSession: () => {}, abort: () => {}, destroyAll: () => {}, isActive: () => false, getSessionId: () => null };
const screen = { getPrimaryDisplay: () => ({ bounds: { x: 0, y: 0, width: 1512, height: 982 }, scaleFactor: 2 }) };
const overlay = createComputerUseOverlayHook(controller, screen);

// Real runtime tool.
const [computer] = buildComputerUseTools({ backend, overlay });
const ctx = { abortSignal: new AbortController().signal, sessionId: 'cli-session', toolCallId: 'call-1', turnId: 't', cwd: process.cwd(), emitOutput() {} };
const call = async (args) => {
  const before = moves.length;
  const res = await computer.impl(args, ctx);
  const move = moves[before]; // the overlay move this action produced (if any)
  return { text: res.text, move };
};

const main = async () => {
  console.log('driving the REAL computer tool impl → hook → backend\n');
  let r = await call({ action: 'screenshot' });
  console.log('screenshot :', r.text.slice(0, 80));

  osa('tell application "TextEdit" to activate'); osa('tell application "TextEdit" to make new document');
  await new Promise((res) => setTimeout(res, 800));

  r = await call({ action: 'mouse_move', coordinate: [1000, 700] });
  console.log('mouse_move :', r.text.slice(0, 60), '| overlay→', r.move ? `(${Math.round(r.move.screenX)},${Math.round(r.move.screenY)}) ${r.move.kind}` : 'none');

  r = await call({ action: 'left_click', coordinate: [1500, 1000] });
  console.log('left_click :', r.text.slice(0, 60), '| overlay→', r.move ? `(${Math.round(r.move.screenX)},${Math.round(r.move.screenY)}) ${r.move.kind}` : 'none');

  r = await call({ action: 'scroll', coordinate: [1500, 1000], scroll_direction: 'down', scroll_amount: 3 });
  console.log('scroll     :', r.text.slice(0, 60), '| overlay→', r.move ? `(${Math.round(r.move.screenX)},${Math.round(r.move.screenY)}) ${r.move.kind}` : 'none');

  r = await call({ action: 'key', text: 'Escape' });
  console.log('key        :', r.text.slice(0, 90));

  osa('tell application "TextEdit" to close every document saving no');
  backend.dispose();
  console.log(`\ntotal overlay moves recorded: ${moves.length}`);
  process.exit(0);
};
main().catch((e) => { console.error(e); backend.dispose(); process.exit(1); });
