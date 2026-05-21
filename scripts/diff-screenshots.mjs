#!/usr/bin/env node
/**
 * PR-IR-02 v1: visual smoke screenshot diff gate (coarse SHA256).
 *
 * Compares newly captured screenshots against a committed baseline
 * directory. Reports per-scenario / per-variant matches + mismatches +
 * additions + removals.
 *
 * Why SHA256 and not pixelmatch (v1):
 *  - Adds no npm dependency. pixelmatch + pngjs would bring in ~200KB.
 *  - When fixtures are stable, any pixel difference is a meaningful
 *    UI change worth manual review — there's no useful "almost equal"
 *    threshold for screenshots that have been frozen by reduced-motion
 *    fixture + fixed clock (per PR-IR-04, @xuan's PR108k).
 *  - When fixtures are unstable, pixelmatch wouldn't help — the right
 *    fix is to stabilize the fixture, not raise the diff threshold.
 *
 * Future PR-IR-02 v2 may add pixelmatch for sub-region tolerance once
 * the baseline is solid and we want to catch specific localized
 * regressions.
 *
 * Usage:
 *
 *   # Compare against committed baseline
 *   node scripts/diff-screenshots.mjs
 *
 *   # Update baseline (after manual review of expected changes)
 *   node scripts/diff-screenshots.mjs --update-baseline
 *
 * Exit codes:
 *   0  — all screenshots match baseline (or no baseline exists yet)
 *   1  — at least one mismatch detected; review required
 *   2  — environment / setup error (no captures found, etc.)
 */

import { readdir, readFile, copyFile, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SCREENSHOTS_DIR = join(REPO_ROOT, 'apps', 'desktop', 'tests', 'screenshots');
const BASELINE_DIR = join(REPO_ROOT, 'apps', 'desktop', 'tests', 'screenshots-baseline');

function parseArgs(argv) {
  const args = { updateBaseline: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--update-baseline') args.updateBaseline = true;
    else if (a === '--help' || a === '-h') {
      console.log('Usage: diff-screenshots.mjs [--update-baseline]');
      process.exit(0);
    } else {
      console.error(`[diff-screenshots] unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

async function sha256(path) {
  const buf = await readFile(path);
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Recursively collect all .png files relative to `root`. Returns a
 * sorted array so `--update-baseline` is deterministic.
 */
async function collectPngs(root) {
  const out = [];
  async function visit(dir, prefix) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await visit(join(dir, entry.name), prefix ? `${prefix}/${entry.name}` : entry.name);
      } else if (entry.isFile() && entry.name.endsWith('.png')) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        out.push(rel);
      }
    }
  }
  await visit(root, '');
  return out.sort();
}

async function manifest(root) {
  if (!existsSync(root)) return new Map();
  const files = await collectPngs(root);
  const out = new Map();
  for (const rel of files) {
    const full = join(root, rel);
    const [hash, info] = await Promise.all([sha256(full), stat(full)]);
    out.set(rel, { hash, bytes: info.size });
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);

  if (!existsSync(SCREENSHOTS_DIR)) {
    console.error(`[diff-screenshots] no screenshots dir at ${relative(REPO_ROOT, SCREENSHOTS_DIR)}`);
    console.error('  Run `npm --workspace @maka/desktop run screenshots` first.');
    process.exit(2);
  }

  const current = await manifest(SCREENSHOTS_DIR);
  if (current.size === 0) {
    console.error(`[diff-screenshots] no PNGs in ${relative(REPO_ROOT, SCREENSHOTS_DIR)}`);
    process.exit(2);
  }

  if (args.updateBaseline) {
    await mkdir(BASELINE_DIR, { recursive: true });
    for (const rel of current.keys()) {
      const dest = join(BASELINE_DIR, rel);
      await mkdir(join(dest, '..'), { recursive: true });
      await copyFile(join(SCREENSHOTS_DIR, rel), dest);
    }
    console.log(`[diff-screenshots] baseline updated: ${current.size} PNGs copied to ${relative(REPO_ROOT, BASELINE_DIR)}`);
    process.exit(0);
  }

  const baseline = await manifest(BASELINE_DIR);
  if (baseline.size === 0) {
    console.error(`[diff-screenshots] no baseline at ${relative(REPO_ROOT, BASELINE_DIR)}`);
    console.error('  Run with `--update-baseline` to seed it from current captures.');
    process.exit(2);
  }

  const matches = [];
  const mismatches = [];
  const added = [];
  const removed = [];

  for (const [rel, info] of current.entries()) {
    const base = baseline.get(rel);
    if (!base) {
      added.push(rel);
      continue;
    }
    if (base.hash === info.hash) {
      matches.push(rel);
    } else {
      mismatches.push({ rel, baselineBytes: base.bytes, currentBytes: info.bytes });
    }
  }
  for (const rel of baseline.keys()) {
    if (!current.has(rel)) removed.push(rel);
  }

  console.log(`[diff-screenshots] baseline=${baseline.size} current=${current.size}`);
  console.log(`  matches:    ${matches.length}`);
  console.log(`  mismatches: ${mismatches.length}`);
  console.log(`  added:      ${added.length}`);
  console.log(`  removed:    ${removed.length}`);

  if (mismatches.length > 0) {
    console.log('');
    console.log('Mismatches:');
    for (const m of mismatches) {
      const delta = m.currentBytes - m.baselineBytes;
      const sign = delta >= 0 ? '+' : '';
      console.log(`  ${m.rel}  (baseline ${m.baselineBytes} → current ${m.currentBytes}, ${sign}${delta} bytes)`);
    }
  }
  if (added.length > 0) {
    console.log('');
    console.log('Added (no baseline yet):');
    for (const rel of added) console.log(`  ${rel}`);
  }
  if (removed.length > 0) {
    console.log('');
    console.log('Removed from current capture:');
    for (const rel of removed) console.log(`  ${rel}`);
  }

  if (mismatches.length === 0 && added.length === 0 && removed.length === 0) {
    console.log('');
    console.log('[diff-screenshots] OK — captured screenshots match baseline.');
    process.exit(0);
  }
  console.log('');
  console.log('Review the diffs manually (open the PNG pairs in an image viewer).');
  console.log('When the changes are intentional, run `node scripts/diff-screenshots.mjs --update-baseline`');
  console.log('to commit the new baseline.');
  process.exit(1);
}

main().catch((err) => {
  console.error('[diff-screenshots] fatal:', err);
  process.exit(2);
});
