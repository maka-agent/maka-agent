#!/usr/bin/env node
/**
 * PR-IR-02 v2: visual smoke screenshot manifest sanity gate.
 *
 * Stage 1 of the screenshot regression pipeline. Verifies that every
 * expected (scenario × variant) PNG was actually captured, has the
 * right dimensions for its viewport variant, and is a valid non-empty
 * PNG file. Does NOT do pixel-level comparison — Electron/font
 * rasterization causes sub-pixel drift that would make byte-level
 * SHA256 too noisy (~70/88 PNGs change between runs per @xuan).
 *
 * Pixel-level diff with tolerance + ignored regions is deferred to
 * PR-IR-02 v3 (pixelmatch); we'll pilot on stable scenarios
 * (artifact-pane / first-run / artifact-errors) first per @kenji.
 *
 * Usage:
 *
 *   # Sanity-check current captures against expected scenario/variant
 *   # matrix. Exits 1 if any PNG is missing / wrong size / corrupt.
 *   node scripts/diff-screenshots.mjs
 *
 *   # Write a manifest file describing current captures (for review
 *   # before promoting to baseline).
 *   node scripts/diff-screenshots.mjs --manifest
 *
 *   # Update the committed baseline manifest from current captures.
 *   node scripts/diff-screenshots.mjs --update-baseline
 *
 * Exit codes:
 *   0  — all sanity checks pass
 *   1  — at least one PNG missing / wrong dimensions / corrupt
 *   2  — environment / setup error
 */

import { readdir, readFile, writeFile, copyFile, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SCREENSHOTS_DIR = join(REPO_ROOT, 'apps', 'desktop', 'tests', 'screenshots');
const BASELINE_DIR = join(REPO_ROOT, 'apps', 'desktop', 'tests', 'screenshots-baseline');
const MANIFEST_PATH = join(BASELINE_DIR, 'manifest.json');

/**
 * Expected variant matrix — mirrors `scripts/capture-screenshots.mjs`.
 * The driver and the sanity gate share this matrix shape; out-of-sync
 * matrices are themselves a regression we want to catch (e.g. driver
 * adds a viewport but forgets to update sanity expectations).
 */
const VARIANTS = [
  { name: 'light-1280-motion', theme: 'light', viewport: { width: 1280, height: 820 }, reducedMotion: false },
  { name: 'light-990-motion', theme: 'light', viewport: { width: 990, height: 820 }, reducedMotion: false },
  { name: 'light-1280-reduced-motion', theme: 'light', viewport: { width: 1280, height: 820 }, reducedMotion: true },
  { name: 'light-990-reduced-motion', theme: 'light', viewport: { width: 990, height: 820 }, reducedMotion: true },
  { name: 'dark-1280-motion', theme: 'dark', viewport: { width: 1280, height: 820 }, reducedMotion: false },
  { name: 'dark-990-motion', theme: 'dark', viewport: { width: 990, height: 820 }, reducedMotion: false },
  { name: 'dark-1280-reduced-motion', theme: 'dark', viewport: { width: 1280, height: 820 }, reducedMotion: true },
  { name: 'dark-990-reduced-motion', theme: 'dark', viewport: { width: 990, height: 820 }, reducedMotion: true },
];

const SCALE_FACTORS = [1, 2]; // Retina captures may be 2x or 3x; we accept 1x or 2x for now.
const MIN_BYTES = 1024; // truncated PNG safety net
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Per @kenji review: size tolerance split into two tiers. Standard
// scenarios (static UI) get ±15%; known-dynamic scenarios (streaming,
// permission popovers) get ±25%. Out-of-tolerance is a warning unless
// the scenario also reports `wrong_dimensions` — that's a hard fail.
const DEFAULT_SIZE_TOLERANCE = 0.15;
const DYNAMIC_SIZE_TOLERANCE = 0.25;
const DYNAMIC_SCENARIOS = new Set([
  'streaming-sidebar',
  'permission-destructive',
  // `all` scenario shows both streaming + permission overlays
  'all',
]);

function sizeTolerance(scenario) {
  return DYNAMIC_SCENARIOS.has(scenario) ? DYNAMIC_SIZE_TOLERANCE : DEFAULT_SIZE_TOLERANCE;
}

/**
 * Per @kenji review: "stability" is a policy decision, not a property
 * of any individual screenshot, so it lives in this script constant
 * (NOT in the manifest schema). The `--subset stable` shorthand
 * resolves to these scenarios — the staged baseline rollout starts
 * here. Other scenarios become eligible after fixture determinism
 * work + manual review.
 */
const STABLE_SCENARIOS = new Set(['artifact-pane', 'first-run', 'artifact-errors']);

function resolveSubset(rawSubset) {
  if (!rawSubset) return null;
  // Special keyword: --subset stable
  if (rawSubset.size === 1 && rawSubset.has('stable')) {
    return new Set(STABLE_SCENARIOS);
  }
  return rawSubset;
}

function parseArgs(argv) {
  const args = { manifest: false, updateBaseline: false, subset: null };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--manifest') args.manifest = true;
    else if (a === '--update-baseline') args.updateBaseline = true;
    else if (a === '--subset') {
      const value = argv[++i];
      if (!value) {
        console.error('[diff-screenshots] --subset requires a comma-separated list of scenarios');
        process.exit(2);
      }
      args.subset = new Set(value.split(',').map((s) => s.trim()).filter(Boolean));
    } else if (a === '--help' || a === '-h') {
      console.log('Usage: diff-screenshots.mjs [--manifest|--update-baseline] [--subset stable|s1,s2,...]');
      console.log('');
      console.log('Options:');
      console.log('  --subset stable       Only check the known-stable scenarios');
      console.log(`                        (${[...STABLE_SCENARIOS].join(', ')}).`);
      console.log('  --subset <scenarios>  Comma-separated explicit list (e.g. --subset');
      console.log('                        artifact-pane,first-run).');
      console.log('  --manifest            Write current manifest.json without comparing.');
      console.log('  --update-baseline     Promote current captures to baseline.');
      process.exit(0);
    } else {
      console.error(`[diff-screenshots] unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

/**
 * Read just the PNG header (24 bytes) to extract width + height
 * without loading the full pixel buffer. Returns null if the file
 * isn't a valid PNG.
 *
 * PNG layout:
 *   bytes 0–7   magic
 *   bytes 8–15  IHDR chunk length + type
 *   bytes 16–19 width  (big-endian u32)
 *   bytes 20–23 height (big-endian u32)
 */
async function readPngDimensions(path) {
  let buf;
  try {
    buf = await readFile(path);
  } catch {
    return null;
  }
  if (buf.length < 24) return null;
  if (buf.compare(PNG_MAGIC, 0, 8, 0, 8) !== 0) return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return { width, height, bytes: buf.length };
}

async function listScenarios(root) {
  if (!existsSync(root)) return [];
  const entries = await readdir(root, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

/**
 * Per (scenario, variant) sanity check. Returns one of:
 *   { ok: true, info }                  – passed all checks
 *   { ok: false, reason: '...', info? } – failed; info present if PNG
 *                                          was at least partially readable
 */
async function checkOne(root, scenario, variant) {
  const path = join(root, scenario, `${variant.name}.png`);
  if (!existsSync(path)) {
    return { ok: false, reason: 'missing' };
  }
  const dims = await readPngDimensions(path);
  if (!dims) {
    return { ok: false, reason: 'corrupt_png' };
  }
  if (dims.bytes < MIN_BYTES) {
    return { ok: false, reason: 'too_small', info: dims };
  }
  // Width/height match one of the scale factors (1x or 2x for Retina).
  const expectedWidths = SCALE_FACTORS.map((f) => variant.viewport.width * f);
  const expectedHeights = SCALE_FACTORS.map((f) => variant.viewport.height * f);
  if (!expectedWidths.includes(dims.width) || !expectedHeights.includes(dims.height)) {
    return {
      ok: false,
      reason: 'wrong_dimensions',
      info: {
        ...dims,
        expectedWidths,
        expectedHeights,
      },
    };
  }
  return { ok: true, info: dims };
}

async function buildManifest(root, subset) {
  const allScenarios = await listScenarios(root);
  const scenarios = subset
    ? allScenarios.filter((s) => subset.has(s))
    : allScenarios;
  if (subset && scenarios.length === 0) {
    console.error(`[diff-screenshots] --subset filtered out every scenario; nothing to compare.`);
    process.exit(2);
  }
  const entries = [];
  let mainSha = null;
  try {
    // Try to capture the main.ts dist file's hash so manifest also
    // tracks which build produced these screenshots.
    const { createHash } = await import('node:crypto');
    const mainBuf = await readFile(join(REPO_ROOT, 'apps', 'desktop', 'dist', 'main', 'main.js'));
    mainSha = createHash('sha256').update(mainBuf).digest('hex').slice(0, 12);
  } catch {
    // dist/main/main.js may not exist (fresh clone before build) — that's OK
  }
  for (const scenario of scenarios) {
    for (const variant of VARIANTS) {
      const result = await checkOne(root, scenario, variant);
      entries.push({
        scenario,
        variant: variant.name,
        theme: variant.theme,
        viewport: variant.viewport,
        reducedMotion: variant.reducedMotion,
        ok: result.ok,
        ...(result.info ? { dimensions: { width: result.info.width, height: result.info.height }, bytes: result.info.bytes } : {}),
        ...(result.reason ? { reason: result.reason } : {}),
      });
    }
  }
  return {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    mainSha,
    variants: VARIANTS.map((v) => v.name),
    entries,
  };
}

function summarize(manifest) {
  const total = manifest.entries.length;
  const failures = manifest.entries.filter((e) => !e.ok);
  return { total, ok: total - failures.length, failures };
}

async function main() {
  const args = parseArgs(process.argv);

  if (!existsSync(SCREENSHOTS_DIR)) {
    console.error(`[diff-screenshots] no screenshots dir at ${relative(REPO_ROOT, SCREENSHOTS_DIR)}`);
    console.error('  Run `npm --workspace @maka/desktop run screenshots` first.');
    process.exit(2);
  }

  const subset = resolveSubset(args.subset);
  const current = await buildManifest(SCREENSHOTS_DIR, subset);
  const summary = summarize(current);
  if (subset) {
    console.log(`[diff-screenshots] subset filter active: ${[...subset].join(', ')}`);
  }

  console.log(`[diff-screenshots] manifest sanity check`);
  console.log(`  scenarios:        ${new Set(current.entries.map((e) => e.scenario)).size}`);
  console.log(`  variants/scenario: ${VARIANTS.length}`);
  console.log(`  total expected:   ${current.entries.length}`);
  console.log(`  passed:           ${summary.ok}`);
  console.log(`  failed:           ${summary.failures.length}`);
  if (current.mainSha) console.log(`  main.js sha:      ${current.mainSha}`);

  if (args.manifest) {
    const out = JSON.stringify(current, null, 2);
    const path = join(SCREENSHOTS_DIR, 'manifest.json');
    await writeFile(path, out);
    console.log('');
    console.log(`Manifest written: ${relative(REPO_ROOT, path)}`);
  }

  if (args.updateBaseline) {
    await mkdir(BASELINE_DIR, { recursive: true });
    // Copy all current PNGs into the baseline dir
    for (const entry of current.entries) {
      if (!entry.ok) continue;
      const src = join(SCREENSHOTS_DIR, entry.scenario, `${entry.variant}.png`);
      const dest = join(BASELINE_DIR, entry.scenario, `${entry.variant}.png`);
      await mkdir(join(dest, '..'), { recursive: true });
      await copyFile(src, dest);
    }
    await writeFile(MANIFEST_PATH, JSON.stringify(current, null, 2));
    console.log('');
    console.log(`Baseline updated: ${summary.ok} PNGs + manifest at ${relative(REPO_ROOT, MANIFEST_PATH)}`);
    process.exit(summary.failures.length === 0 ? 0 : 1);
  }

  // Soft size-tolerance check against baseline (warning only). Per
  // @kenji: dimensions/existence/non-empty are hard blocks; size drift
  // is a warning — Electron rasterization noise routinely shifts bytes
  // by single digits.
  const sizeWarnings = [];
  if (existsSync(MANIFEST_PATH)) {
    try {
      const baseline = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
      const baselineByKey = new Map(
        baseline.entries.filter((e) => e.ok).map((e) => [`${e.scenario}/${e.variant}`, e.bytes]),
      );
      for (const entry of current.entries) {
        if (!entry.ok || entry.bytes === undefined) continue;
        const baseBytes = baselineByKey.get(`${entry.scenario}/${entry.variant}`);
        if (baseBytes === undefined) continue;
        const tolerance = sizeTolerance(entry.scenario);
        const drift = Math.abs(entry.bytes - baseBytes) / baseBytes;
        if (drift > tolerance) {
          sizeWarnings.push({
            scenario: entry.scenario,
            variant: entry.variant,
            baselineBytes: baseBytes,
            currentBytes: entry.bytes,
            driftPct: Math.round(drift * 1000) / 10,
            tolerancePct: Math.round(tolerance * 100),
          });
        }
      }
    } catch {
      // Baseline manifest unreadable — soft skip; sanity gate still
      // catches real regressions.
    }
  }

  if (summary.failures.length > 0) {
    console.log('');
    console.log('Failures (hard fail):');
    for (const entry of summary.failures) {
      const detail = entry.reason === 'wrong_dimensions'
        ? ` (got ${entry.dimensions?.width}×${entry.dimensions?.height})`
        : entry.reason === 'too_small'
        ? ` (${entry.bytes} bytes)`
        : '';
      console.log(`  ${entry.scenario}/${entry.variant}.png — ${entry.reason}${detail}`);
    }
    console.log('');
    console.log('Fix options:');
    console.log('  - missing:           re-run `npm --workspace @maka/desktop run screenshots`');
    console.log('  - corrupt_png:       capture pipeline produced an invalid file; re-run');
    console.log('  - too_small:         renderer didn\'t fully paint before capture; investigate fixture');
    console.log('  - wrong_dimensions:  fixture viewport bounds not honored; check main.ts read of MAKA_VISUAL_SMOKE_WIDTH/HEIGHT');
    if (sizeWarnings.length > 0) console.log('  - (size drift warnings reported below; not blocking)');
  }

  if (sizeWarnings.length > 0) {
    console.log('');
    console.log(`Size drift warnings (not blocking; ${sizeWarnings.length} entries):`);
    for (const w of sizeWarnings) {
      console.log(`  ${w.scenario}/${w.variant}.png  baseline ${w.baselineBytes} → current ${w.currentBytes}  (${w.driftPct}% > ${w.tolerancePct}% tolerance)`);
    }
    console.log('');
    console.log('Large drift is usually OK (Electron rasterization noise) but watch for cliff-edge UI');
    console.log('changes that produce a much larger / smaller PNG. Update baseline with `--update-baseline`');
    console.log('after manual review.');
  }

  if (summary.failures.length > 0) process.exit(1);

  console.log('');
  console.log('[diff-screenshots] OK — all expected PNGs present with valid headers + dimensions.');
  if (existsSync(MANIFEST_PATH)) {
    try {
      const baseline = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
      console.log(`  baseline captured: ${baseline.capturedAt} (main.js sha ${baseline.mainSha ?? 'n/a'})`);
    } catch {
      /* baseline manifest unreadable */
    }
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('[diff-screenshots] fatal:', err);
  process.exit(2);
});
