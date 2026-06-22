#!/usr/bin/env node
/**
 * Dev HMR launcher: start the Vite dev server in-process and point Electron
 * at it, so renderer edits (apps/desktop/src/renderer/**) hot-reload without
 * a rebuild. The main process already honors `VITE_DEV_SERVER_URL`
 * (apps/desktop/src/main/main.ts): it `loadURL`s the dev server when set,
 * otherwise it `loadFile`s the built renderer.
 *
 * Prerequisite builds (workspace libs + main + preload) run in the `dev:hmr`
 * npm script BEFORE this launcher; this file only runs the dev server and
 * Electron and tears them down together. Extra args are forwarded to
 * Electron, e.g. `npm run dev:hmr -- --remote-debugging-port=9230`.
 *
 * Scope: HMR covers the desktop renderer only. Main/preload changes need an
 * Electron restart, and `@maka/*` package edits need that package rebuilt —
 * neither is a Vite concern.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

// This script lives in apps/desktop/scripts/, so `vite` resolves from the
// package that declares it (rather than relying on hoisting to the repo root).
const DESKTOP_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)));

// In a git worktree the electron binary lives in the main checkout's
// node_modules (an ancestor dir), not the worktree's own — so walk up to the
// nearest node_modules/.bin rather than assuming a fixed location.
function resolveElectronBin() {
  for (let dir = DESKTOP_DIR; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', '.bin', 'electron');
    if (existsSync(candidate)) return candidate;
    if (dirname(dir) === dir) return 'electron'; // fall back to PATH
  }
}

// Run from the desktop package so Vite loads apps/desktop/vite.config.ts and
// resolves its `root` (src/renderer) exactly as the `vite` CLI would.
process.chdir(DESKTOP_DIR);
const server = await createServer();
await server.listen();
server.printUrls();

const devUrl = server.resolvedUrls?.local?.[0]?.replace(/\/$/, '');
if (!devUrl) {
  console.error('[dev:hmr] vite did not report a local URL; aborting.');
  await server.close();
  process.exit(1);
}

console.log(`[dev:hmr] launching Electron against ${devUrl} (renderer HMR live)`);
const electron = spawn(resolveElectronBin(), ['.', ...process.argv.slice(2)], {
  cwd: DESKTOP_DIR,
  stdio: 'inherit',
  env: { ...process.env, VITE_DEV_SERVER_URL: devUrl },
});

let shuttingDown = false;
async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (!electron.killed) electron.kill('SIGTERM');
  await server.close().catch(() => {});
  process.exit(code);
}

electron.on('exit', (code) => shutdown(code ?? 0));
electron.on('error', (err) => {
  console.error(`[dev:hmr] failed to start Electron: ${err.message}`);
  shutdown(1);
});
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
