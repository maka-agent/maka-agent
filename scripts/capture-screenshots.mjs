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
 *   theme:      'light' | 'dark'
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
import { mkdir, copyFile, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
  'streaming-answer',
  // #646: "正在处理…" model-wait indicator + composer Stop, in the
  // connect-to-first-token state.
  'model-processing',
  'permission-destructive',
  'stale-sessions',
  'settings-data',
  // PR-SETTINGS-IA-CONSOLIDATE-0 + PR-SETTINGS-REVIEW-0: memory split out.
  'settings-appearance',
  'settings-bots',
  'settings-about',
  'settings-general',
  'settings-memory',
  'settings-daily-review',
  'module-skills',
  'module-daily-review',
  'workstation-statuses',
  // PR-PLAN-REMINDER-MVP-0: first non-placeholder 计划 surface.
  // Opens the Automations module with scheduled / paused / completed
  // local reminders seeded on disk, so screenshot review can verify
  // the form + list are real product UI.
  'plan-reminders',
  // PR109f (g): turn-control-history state family. Three scenarios
  // share one on-disk seed and only differ in active session, so
  // capture produces three deterministic screenshots covering primary
  // (lineage / aborted / failed), visible-parent branch (banner), and
  // orphan branch (no banner).
  'turn-control-history',
  'turn-control-branch-visible',
  'turn-control-branch-orphan',
  // PR-UI-RENDER-3a-smoke: registry-driven artifact preview fixtures.
  // Each writes a SINGLE artifact to ARTIFACT_SESSION_ID so the
  // ArtifactPane default selection deterministically shows the one we
  // want to baseline.
  'artifact-preview-image',
  'artifact-preview-unsupported',
  'artifact-preview-oversize',
  // PR-SIDEBAR-IA-0 Phase 1 (xuan msg `c253abe0`): hard gate fixture
  // for sidebar scroll fix. 60 deterministic sessions; baseline must
  // show the list scrolling without pushing the footer (Settings /
  // future Update placeholder) off-screen. Variant matrix (light /
  // dark × 990 / 1280) doubles as the CI regression check that
  // .maka-session-list scroll container did not regress.
  'sidebar-long-sessions',
  // PR-SIDEBAR-IA-0 Phase 2 fixup v3 (xuan msg `dce5a6fb` #2 +
  // WAWQAQ msg `4259bf8c`): baseline gate for the SearchModal shell.
  // Reuses the 60-session sidebar seed and sets
  // `VisualSmokeState.searchModalOpen=true` so the renderer auto-opens
  // the modal at mount; no click required. Without this scenario
  // there is no screenshot evidence that 搜索 opens a modal (the
  // default sidebar capture only shows the nav row).
  'sidebar-search-modal-open',
  // PR-shared primitive-COMMAND-INPUT-0: baseline for CommandPalette's shared primitive
  // InputGroup input shell; reuses the 60-session sidebar seed.
  'command-palette-open',
  // PR-SIDEBAR-IA-0 Phase 3 P0 fixup v4 (WAWQAQ msg `5dd1c348`,
  // kenji `b3d156e9`): baseline gate proving the row action trigger
  // does NOT overlap the time meta / unread dot on the focused
  // (or active) row. Reuses the 60-session seed and sets
  // `VisualSmokeState.focusActiveRow=true` so the renderer focuses
  // the active row's button after mount, making `:focus-within`
  // trigger and the `.maka-list-row-menu-trigger` become visible.
  // Reviewers should see the single overflow trigger cleanly painted with
  // NO `Nm ago` peeking through and NO unread dot stacked behind.
  'sidebar-row-actions-visible',
  // #819: BrowserPanel renderer-chrome fixture. Seeds
  // `liveBrowserSessionIds` with the active turn session so the panel
  // mounts; with no native WebContentsView in visual-smoke mode,
  // browser.getState resolves null → EMPTY_STATE → the empty-state
  // chrome (toolbar all-nav-disabled + <Empty> strip) the #818
  // narrow-layout defect regressed against. 1280/990 × light/dark
  // variants baseline the chrome layout at wide + narrow gates.
  'browser-empty',
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
const MARKER_RE = /\[visual-smoke\] captured scenario=(\S+) variant=(\S+) path=(.+)$/;

/**
 * PR-UI-VISUAL-SMOKE-LOCALE: capture entrypoint default. Every
 * spawned Electron gets a deterministic UI locale unless the caller
 * explicitly overrides `MAKA_VISUAL_SMOKE_LOCALE`. Without this
 * default the parser is fail-closed but the capture path is fail-
 * open to `navigator.language`, which makes baselines drift between
 * hosts. Default `zh` because the canonical baseline locale today
 * is zh; set the env to `en` to override. Manifest records the
 * resolved value per capture so reviewers can verify (see
 * `diff-screenshots.mjs` manifest builder).
 */
const DEFAULT_CAPTURE_LOCALE = 'zh';

export function resolveCaptureLocale(processEnv = process.env) {
  const raw = processEnv.MAKA_VISUAL_SMOKE_LOCALE;
  if (typeof raw !== 'string') return DEFAULT_CAPTURE_LOCALE;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'zh' || normalized === 'en') return normalized;
  // Caller passed something the main-process parser would also
  // reject (regional variant, garbage). We force the deterministic
  // default rather than silently falling through to navigator.
  return DEFAULT_CAPTURE_LOCALE;
}

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
    return readFileSync(path, 'utf8').slice(0, 4096);
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
  // PR-UI-VISUAL-SMOKE-LOCALE: resolve the locale BEFORE spawning so
  // we control what gets injected into the child. `resolveCaptureLocale`
  // reads `MAKA_VISUAL_SMOKE_LOCALE` from the current process env and
  // falls back to the canonical default (`zh`); the child then sees a
  // deterministic value even if the host shell didn't set one.
  const locale = resolveCaptureLocale(process.env);
  const env = {
    ...process.env,
    MAKA_VISUAL_SMOKE_FIXTURE: scenario,
    MAKA_VISUAL_SMOKE_AUTO_CAPTURE: variant.name,
    MAKA_VISUAL_SMOKE_LOCALE: locale,
  };
  if (variant.reducedMotion) env.MAKA_VISUAL_SMOKE_REDUCED_MOTION = '1';
  if (variant.theme) env.MAKA_VISUAL_SMOKE_THEME = variant.theme;
  // Force the BrowserWindow size via env so the bounds-restore path uses
  // the size we want for this variant. Falls back to default if absent.
  env.MAKA_VISUAL_SMOKE_WIDTH = String(variant.viewport.width);
  env.MAKA_VISUAL_SMOKE_HEIGHT = String(variant.viewport.height);

  const electronBin = await resolveElectronBin();
  // Isolate Electron's singleton lock + persisted state per spawn so
  // a developer Maka window (or a previous capture's stuck Electron)
  // doesn't block us from starting. Each `(scenario, variant)` gets
  // its own user-data dir under tmpdir. Without this, Electron's
  // singleton path collides on `~/Library/Application Support/Maka`
  // and the spawned Electron exits before printing the auto-capture
  // marker, producing a `capture_marker_not_seen` timeout.
  const userDataDir = join(
    os.tmpdir(),
    `maka-visual-smoke-${scenario}-${variant.name}-${process.pid}`,
  );
  const child = spawn(electronBin, ['.', `--user-data-dir=${userDataDir}`], {
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
    return { ok: false, reason: 'capture_marker_not_seen', locale };
  }
  if (!existsSync(capturedPath)) {
    return { ok: false, reason: 'capture_file_missing', locale };
  }
  const destDir = join(SCREENSHOTS_DIR, scenario);
  await mkdir(destDir, { recursive: true });
  const destPath = join(destDir, `${variant.name}.png`);
  await copyFile(capturedPath, destPath);
  const sz = (await stat(destPath)).size;
  // PR-UI-VISUAL-SMOKE-LOCALE: locale included in the result so the
  // calling loop can stamp it into the per-capture sidecar that
  // `diff-screenshots.mjs` reads when building the baseline manifest.
  return { ok: true, destPath, sourcePath: capturedPath, bytes: sz, locale };
}

async function resolveElectronBin() {
  // Resolve the electron binary via Node's module resolution, which walks
  // up the directory tree from this script. A git worktree's node_modules
  // holds only the workspace's own @maka/* packages, so electron lives in
  // the parent checkout's node_modules — the upward walk finds it there.
  // We intentionally do NOT hard-require `REPO_ROOT/node_modules/electron`,
  // which a worktree legitimately lacks; `import('electron')` returns the
  // resolved binary path string regardless of which ancestor provides it.
  try {
    const exportPath = (await import('electron')).default;
    if (typeof exportPath === 'string') return exportPath;
    console.error('[capture-screenshots] electron resolved but exposed no binary path; run `npm install`.');
    process.exit(2);
  } catch (err) {
    console.error('[capture-screenshots] electron not resolvable (run `npm install` in the repo root):', err);
    process.exit(2);
  }
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
          // PR-UI-VISUAL-SMOKE-LOCALE: write a tiny sidecar JSON next
          // to the PNG recording the locale used for this capture.
          // `diff-screenshots.mjs` reads these when building the
          // manifest so reviewers can verify each baseline came from
          // a deterministic locale (and not from `navigator.language`
          // leaking the host OS preference).
          await writeCaptureSidecar(result.destPath, { locale: result.locale });
          console.log(`OK (${dt}s, ${(result.bytes / 1024).toFixed(1)} KB, locale=${result.locale}) → ${relPath(result.destPath)}`);
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

/**
 * Write a `.meta.json` sidecar next to the captured PNG so the
 * baseline manifest can record what locale (and any future
 * deterministic dimensions) produced the screenshot. Reviewers can
 * eyeball the sidecar to confirm a baseline wasn't captured with
 * stale env. Sidecar is a flat JSON object so future fields can
 * extend it without schema migration.
 */
async function writeCaptureSidecar(pngPath, meta) {
  const sidecarPath = pngPath.replace(/\.png$/, '.meta.json');
  await writeFile(sidecarPath, JSON.stringify(meta, null, 2) + '\n', 'utf8');
}

/**
 * PR-UI-VISUAL-SMOKE-LOCALE follow-up (@xuan merge gate
 * msg af4d60e3): standard Node.js entrypoint guard so importing
 * exported helpers (e.g. `resolveCaptureLocale`) from this module
 * doesn't unconditionally trigger the CLI `main()`. Without this
 * guard, any test or sibling script that imports the helper hits
 * the script's "specify either --all or --scenario <name>" arg
 * check and exits with code 2. `main()` now only runs when the
 * module is invoked directly via `node scripts/capture-screenshots.mjs`.
 */
const isDirectInvocation =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectInvocation) {
  main().catch((err) => {
    console.error('[capture-screenshots] fatal:', err);
    process.exit(2);
  });
}
