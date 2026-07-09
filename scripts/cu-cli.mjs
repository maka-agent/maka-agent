// Fast CLI smoke for the cua-driver backend — no Electron, no LLM, ~5s.
// Drives the REAL createCuaDriverBackend against the real binary through a fixed
// action sequence and prints each outcome. Use this to iterate on backend logic
// (dispatch, no-warp resolution, screenshot size/compression) instead of booting
// the whole Maka app. (The overlay RENDER still needs the ~3s electron demo
// scripts/cursor-overlay-demo.mjs; a full real-agent turn still needs the app.)
//
// Run: node scripts/cu-cli.mjs [path-to-cua-driver]
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCuaDriverBackend } from '../apps/desktop/dist/main/computer-use/cua-driver-backend.js';

const here = dirname(fileURLToPath(import.meta.url));
const binary = process.argv[2] || join(here, '..', 'apps', 'desktop', 'resources', 'bin', 'cua-driver');
const backend = createCuaDriverBackend({ binaryPath: binary, hostBundleId: 'com.maka.desktop', timeoutMs: 8000 });
const sig = new AbortController().signal;
const osa = (s) => { try { return execFileSync('osascript', ['-e', s], { encoding: 'utf8' }).trim(); } catch { return 'err'; } };
const line = (label, r) => {
  const o = r.outcome;
  const shot = r.screenshot ? ` [img ${r.screenshot.mimeType} ${r.screenshot.widthPx}x${r.screenshot.heightPx} ${Math.round(Buffer.from(r.screenshot.base64, 'base64').byteLength / 1024)}KB]` : '';
  console.log(`${label.padEnd(26)} ${o.ok ? 'ok' : `FAIL ${o.error}`}${o.ok && 'verified' in o ? ` verified=${o.verified}` : ''}${o.message ? ` — ${String(o.message).slice(0, 90)}` : ''}${shot}`);
};

const main = async () => {
  const tcc = await backend.preflight(sig);
  console.log(`preflight: accessibility=${tcc.accessibility} screenRecording=${tcc.screenRecording}\n`);

  line('screenshot', await backend.run({ type: 'screenshot' }, sig));
  line('mouse_move (visual only)', await backend.run({ type: 'mouse_move', coordinate: { x: 1000, y: 700 } }, sig));

  // Scratch window so click/scroll resolve to a real window (no-warp path).
  osa('tell application "TextEdit" to activate'); osa('tell application "TextEdit" to make new document');
  await new Promise((r) => setTimeout(r, 800));
  // A device-px point near screen center is very likely over the scratch window.
  line('click @center (on window)', await backend.run({ type: 'left_click', coordinate: { x: 1500, y: 1000 } }, sig));
  line('scroll @center (on window)', await backend.run({ type: 'scroll', coordinate: { x: 1500, y: 1000 }, scrollDirection: 'down', scrollAmount: 3 }, sig));
  line('click @corner (empty?)', await backend.run({ type: 'left_click', coordinate: { x: 3020, y: 1960 } }, sig));
  line('key (fail-closed)', await backend.run({ type: 'key', text: 'Escape' }, sig));

  osa('tell application "TextEdit" to close every document saving no');
  backend.dispose();
  console.log('\ndone.');
  process.exit(0);
};
main().catch((e) => { console.error(e); backend.dispose(); process.exit(1); });
