#!/usr/bin/env node
/**
 * Dev launcher with PARALLEL + INCREMENTAL builds.
 *
 * Uses `tsc --build` for library packages so the compiler skips
 * unchanged sub-projects via .tsbuildinfo (incremental).
 *
 * Dependency graph (→ compiles after):
 *   core ─┬→ storage
 *         ├→ runtime
 *         └→ ui
 *
 *   libs (tsc --build tsconfig.lib.json) ─── covers core+storage+runtime+ui
 *   preload (esbuild)                     ─── parallel, no tsc dependency
 *   main (esbuild)                        ─── fast app bundle for Electron
 *   Vite dev server + Electron            ─── fork
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { build as esbuildBuild } from 'esbuild';

const DESKTOP_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)));
const REPO_ROOT    = resolve(DESKTOP_DIR, '..', '..');
const ON_WINDOWS   = process.platform === 'win32';
const TSC_CLI      = join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');

// ── helpers ──────────────────────────────────────────────────────────────────

function log(label, msg) {
  const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  console.log(`[${ts}][${label}] ${msg}`);
}

function runNodeTool(dir, script, args) {
  return new Promise((resolve_, reject_) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: dir,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.on('exit', (code) => {
      if (code === 0) resolve_();
      else reject_(new Error(`"${script} ${args.join(' ')}" exited with code ${code}`));
    });
    child.on('error', reject_);
  });
}

function resolveElectronBin() {
  for (let dir = DESKTOP_DIR; ; dir = dirname(dir)) {
    const exe = ON_WINDOWS
      ? join(dir, 'node_modules', 'electron', 'dist', 'electron.exe')
      : join(dir, 'node_modules', '.bin', 'electron');
    if (existsSync(exe)) return exe;
    if (dirname(dir) === dir) return 'electron';
  }
}

// ── build phases ─────────────────────────────────────────────────────────────

const TIMER_START = Date.now();

// Phase 1: all library packages via `tsc --build` (single process, shared
// .tsbuildinfo, sub-project incremental detection).  Also runs preload
// (esbuild is fast) in parallel since it has no tsc dependency.
log('build', 'libraries — starting (tsc --build + preload)');
await Promise.all([
  runNodeTool(REPO_ROOT, TSC_CLI, ['--build', 'tsconfig.lib.json']).then(
    () => log('build', 'libraries (all) — done'),
    (e) => { log('build', `libraries — FAILED: ${e.message}`); throw e; },
  ),
  // esbuild via its JS API — NOT `node node_modules/esbuild/bin/esbuild`:
  // esbuild's postinstall swaps that file for a platform-native binary,
  // and executing a Mach-O file with node throws SyntaxError (broke
  // `npm run dev` on any machine where postinstall ran).
  esbuildBuild({
    absWorkingDir: DESKTOP_DIR,
    entryPoints: ['src/preload/preload.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: 'dist/preload/preload.cjs',
    external: ['electron'],
    logLevel: 'warning',
  }).then(
    () => log('build', 'preload — done'),
    (e) => { log('build', `preload — FAILED: ${e.message}`); throw e; },
  ),
]);

// Phase 2: main — esbuild bundle for dev startup. The full
// tsconfig.main.json still compiles tests for `npm test` and typechecks
// main-process code in verification commands.
log('build', 'main — starting');
await esbuildBuild({
  absWorkingDir: DESKTOP_DIR,
  entryPoints: ['src/main/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  outfile: 'dist/main/main.js',
  external: ['electron'],
  logLevel: 'warning',
});
log('build', 'main — done');

const BUILD_MS = Date.now() - TIMER_START;
log('build', `all builds finished in ${(BUILD_MS / 1000).toFixed(1)}s`);

// ── Vite dev server + Electron ───────────────────────────────────────────────

process.chdir(DESKTOP_DIR);
log('vite', 'starting dev server...');
const server = await createServer();
await server.listen();
server.printUrls();

const devUrl = server.resolvedUrls?.local?.[0]?.replace(/\/$/, '');
if (!devUrl) {
  console.error('[dev] vite did not report a local URL; aborting.');
  await server.close();
  process.exit(1);
}

log('electron', `launching against ${devUrl} (renderer HMR live)`);
const electron = spawn(resolveElectronBin(), ['.', ...process.argv.slice(2)], {
  cwd: DESKTOP_DIR,
  stdio: 'inherit',
  env: { ...process.env, VITE_DEV_SERVER_URL: devUrl },
});

let shuttingDown = false;
async function shutdown(code, options = {}) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (options.killElectron !== false) {
    await terminateProcessTree(electron);
  }
  await server.close().catch(() => {});
  process.exit(code);
}

function terminateProcessTree(child) {
  if (child.exitCode !== null || child.killed) return Promise.resolve();
  if (ON_WINDOWS && child.pid) {
    return new Promise((resolve_) => {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      killer.on('exit', () => resolve_());
      killer.on('error', () => resolve_());
    });
  }
  child.kill('SIGTERM');
  return Promise.resolve();
}

electron.on('exit', (code) => shutdown(code ?? 0, { killElectron: false }));
electron.on('error', (err) => {
  console.error(`[dev] failed to start Electron: ${err.message}`);
  shutdown(1);
});
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
