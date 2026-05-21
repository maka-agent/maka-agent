#!/usr/bin/env node
/**
 * PR-IR-01: Visual smoke screenshot driver.
 *
 * Spawns `electron .` once per (scenario × variant) combination using
 * env vars from `MAKA_VISUAL_SMOKE_FIXTURE` / `MAKA_VISUAL_SMOKE_REDUCED_MOTION`
 * / `MAKA_VISUAL_SMOKE_AUTO_CAPTURE`. The renderer auto-captures after
 * the fixture settles; main process logs a stdout marker; this script
 * watches for the marker, kills the subprocess, then copies the PNG
 * from the fixture's isolated workspace into the canonical
 * `apps/desktop/tests/screenshots/<scenario>/<variant>.png` location
 * inside the repo.
 *
 * Why subprocess + stdout instead of CDP / Playwright: minimal new
 * dependencies. Electron itself is the only runtime; this script
 * orchestrates plain Node 22 child_process + filesystem.
 *
 * Usage:
 *
 *   # Single scenario × variant (smoke test)
 *   node scripts/capture-screenshots.mjs --scenario artifact-pane --variant light
 *
 *   # All variants for one scenario
 *   node scripts/capture-screenshots.mjs --scenario artifact-pane
 *
 *   # All scenarios × all variants (CI / regression baseline)
 *   node scripts/capture-screenshots.mjs --all
 *
 * Variants are derived as the cross product of:
 *   theme:      'light' | 'dark'           (TODO: requires settings preset; for now only one)
 *   motion:     'motion' | 'reduced-motion'
 *   viewport:   '1280' | '990'              (wide vs narrow gate from UI plan §1)
 *
 * Naming: `<theme>-<viewport>-<motion>.png`. Example
 * `light-1280-motion.png` is the default UI surface; `dark-990-reduced-motion.png`
 * is dark + narrow + reduced.
 *
 * Boundaries (per @kenji review):
 *  - dev-only — packaged builds will reject the fixture env vars
 *  - script refuses to run unless invoked from the repo root
 *  - canonical output path under `apps/desktop/tests/screenshots/`
 *  - variant + scenario names sanitized in main (defense in depth)
 *  - per-capture subprocess has a hard 60s timeout
 *  - stale screenshots from previous runs are NOT deleted (we only
 *    overwrite — reviewers diff PNGs explicitly when updating baseline)
 */

import { spawn } from 'node:child_process';
import { mkdir, copyFile, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DESKTOP_DIR = join(REPO_ROOT, 'apps', 'desktop');
const SCREENSHOTS_DIR = join(DESKTOP_DIR, 'tests', 'screenshots');

const ALL_SCENARIOS = [
  'first-run',
  'provider-workspace',
  'fallback-source',
  'fetched-empty',
  'connection-error',
  'turn-narrative',
  'artifact-pane',
  'artifact-errors',
  'streaming-sidebar',
  'permission-destructive',
  'stale-sessions',
];

const VARIANTS = [
  // Theme × viewport × reduced-motion = 8 variants per scenario. Theme
  // override (PR-IR-01b) lets us capture dark variants without per-
  // fixture seed configuration — driver sets `MAKA_VISUAL_SMOKE_THEME`
  // and the renderer applies it BEFORE persisted user pref.
  { name: 'light-1280-motion', theme: 'light', viewport: { width: 1280, height: 820 } },
  { name: 'light-990-motion', theme: 'light', viewport: { width: 990, height: 820 } },
  { name: 'light-1280-reduced-motion', theme: 'light', viewport: { width: 1280, height: 820 }, reducedMotion: true },
  { name: 'light-990-reduced-motion', theme: 'light', viewport: { width: 990, height: 820 }, reducedMotion: true },
  { name: 'dark-1280-motion', theme: 'dark', viewport: { width: 1280, height: 820 } },
  { name: 'dark-990-motion', theme: 'dark', viewport: { width: 990, height: 820 } },
  { name: 'dark-1280-reduced-motion', theme: 'dark', viewport: { width: 1280, height: 820 }, reducedMotion: true },
  { name: 'dark-990-reduced-motion', theme: 'dark', viewport: { width: 990, height: 820 }, reducedMotion: true },
];

const CAPTURE_TIMEOUT_MS = 60_000;
const MARKER_RE = /\[visual-smoke\] captured scenario=(\S+) variant=(\S+) path=(\S+)/;

function parseArgs(argv) {
  const args = { scenario: null, variant: null, all: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--all') args.all = true;
    else if (a === '--scenario') args.scenario = argv[++i];
    else if (a === '--variant') args.variant = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log(readFileSyncOrEmpty(new URL(import.meta.url).pathname));
      process.exit(0);
    } else {
      console.error(`[capture-screenshots] unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

function readFileSyncOrEmpty(path) {
  try {
    // synchronous read for --help only
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('node:fs').readFileSync(path, 'utf8').slice(0, 4096);
  } catch {
    return 'See script source for usage notes.';
  }
}

async function ensureRepoRoot() {
  const pkg = join(REPO_ROOT, 'package.json');
  if (!existsSync(pkg)) {
    console.error(`[capture-screenshots] cannot locate repo root (no package.json at ${pkg})`);
    process.exit(2);
  }
  const root = JSON.parse(await readFile(pkg, 'utf8'));
  if (!root.workspaces || !Array.isArray(root.workspaces)) {
    console.error('[capture-screenshots] expected npm workspaces root; aborting.');
    process.exit(2);
  }
}

async function captureSingle(scenario, variant) {
  const env = {
    ...process.env,
    MAKA_VISUAL_SMOKE_FIXTURE: scenario,
    MAKA_VISUAL_SMOKE_AUTO_CAPTURE: variant.name,
  };
  if (variant.reducedMotion) env.MAKA_VISUAL_SMOKE_REDUCED_MOTION = '1';
  if (variant.theme) env.MAKA_VISUAL_SMOKE_THEME = variant.theme;
  // Force the BrowserWindow size via env so the bounds-restore path uses
  // the size we want for this variant. Falls back to default if absent.
  env.MAKA_VISUAL_SMOKE_WIDTH = String(variant.viewport.width);
  env.MAKA_VISUAL_SMOKE_HEIGHT = String(variant.viewport.height);

  const electronBin = await resolveElectronBin();
  const child = spawn(electronBin, ['.'], {
    cwd: DESKTOP_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let capturedPath = null;
  const stdoutHandler = (chunk) => {
    const text = chunk.toString();
    for (const line of text.split('\n')) {
      const m = MARKER_RE.exec(line);
      if (m) {
        capturedPath = m[3];
      }
    }
  };
  child.stdout.on('data', stdoutHandler);
  child.stderr.on('data', () => { /* suppressed; toggle to debug */ });

  const timeoutHandle = setTimeout(() => {
    console.error(`[capture-screenshots] timed out for ${scenario}/${variant.name}, killing`);
    child.kill('SIGKILL');
  }, CAPTURE_TIMEOUT_MS);

  await new Promise((resolveExit) => {
    const onExit = () => {
      clearTimeout(timeoutHandle);
      resolveExit();
    };
    child.on('exit', onExit);
    // Poll for marker every 250ms; once captured, kill subprocess.
    const poll = setInterval(() => {
      if (capturedPath) {
        clearInterval(poll);
        child.kill('SIGTERM');
      }
    }, 250);
  });

  if (!capturedPath) {
    return { ok: false, reason: 'capture_marker_not_seen' };
  }
  if (!existsSync(capturedPath)) {
    return { ok: false, reason: 'capture_file_missing' };
  }
  const destDir = join(SCREENSHOTS_DIR, scenario);
  await mkdir(destDir, { recursive: true });
  const destPath = join(destDir, `${variant.name}.png`);
  await copyFile(capturedPath, destPath);
  const sz = (await stat(destPath)).size;
  return { ok: true, destPath, sourcePath: capturedPath, bytes: sz };
}

async function resolveElectronBin() {
  // Use the locally-resolved electron binary so we don't depend on a
  // global install.
  const electronModule = join(REPO_ROOT, 'node_modules', 'electron');
  if (!existsSync(electronModule)) {
    console.error('[capture-screenshots] electron not installed; run `npm install` first.');
    process.exit(2);
  }
  // Node's `require.resolve('electron')` returns a string with the path
  // to the binary; we read package.json + use main field.
  try {
    const exportPath = (await import('electron')).default;
    if (typeof exportPath === 'string') return exportPath;
  } catch (err) {
    console.error('[capture-screenshots] failed to resolve electron:', err);
    process.exit(2);
  }
  return null;
}

async function main() {
  await ensureRepoRoot();
  const args = parseArgs(process.argv);

  if (!args.all && !args.scenario) {
    console.error('[capture-screenshots] specify either --all or --scenario <name>');
    process.exit(2);
  }

  const scenarios = args.all ? ALL_SCENARIOS : [args.scenario];
  const variants = args.variant
    ? VARIANTS.filter((v) => v.name.startsWith(args.variant))
    : VARIANTS;

  if (variants.length === 0) {
    console.error(`[capture-screenshots] no variants match --variant ${args.variant}`);
    process.exit(2);
  }

  console.log(`[capture-screenshots] scenarios=${scenarios.length} variants=${variants.length}`);
  console.log(`[capture-screenshots] output dir: ${SCREENSHOTS_DIR}`);
  console.log(`[capture-screenshots] platform: ${os.platform()} ${os.arch()}`);

  let succeeded = 0;
  let failed = 0;
  for (const scenario of scenarios) {
    if (!ALL_SCENARIOS.includes(scenario)) {
      console.error(`[capture-screenshots] unknown scenario: ${scenario}`);
      failed += 1;
      continue;
    }
    for (const variant of variants) {
      process.stdout.write(`  ${scenario}/${variant.name} ... `);
      const t0 = Date.now();
      try {
        const result = await captureSingle(scenario, variant);
        const dt = ((Date.now() - t0) / 1000).toFixed(1);
        if (result.ok) {
          console.log(`OK (${dt}s, ${(result.bytes / 1024).toFixed(1)} KB) → ${relPath(result.destPath)}`);
          succeeded += 1;
        } else {
          console.log(`FAILED (${dt}s, ${result.reason})`);
          failed += 1;
        }
      } catch (err) {
        const dt = ((Date.now() - t0) / 1000).toFixed(1);
        console.log(`ERROR (${dt}s, ${err.message ?? err})`);
        failed += 1;
      }
    }
  }

  console.log('');
  console.log(`[capture-screenshots] done: ${succeeded} succeeded, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

function relPath(p) {
  return p.startsWith(REPO_ROOT) ? p.slice(REPO_ROOT.length + 1) : p;
}

main().catch((err) => {
  console.error('[capture-screenshots] fatal:', err);
  process.exit(2);
});
