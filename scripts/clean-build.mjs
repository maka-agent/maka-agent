#!/usr/bin/env node
/**
 * PR-BUILD-HYGIENE-0: remove every workspace's `dist` and incremental
 * tsbuildinfo so the next `npm run build` is forced to recompile from
 * source. Solves the recurring "tests pass on stale dist" foot-gun
 * that kept biting us during Phase 3 P0 fixups — every time we
 * removed/renamed an export, the old dist would survive and tests
 * would lie.
 *
 * Idempotent; missing paths are silently ignored.
 *
 * Run via `npm run clean` at the repo root.
 */

import { existsSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

const targets = [
  // Each workspace's compiled output + incremental info.
  'packages/core/dist',
  'packages/core/tsconfig.tsbuildinfo',
  'packages/storage/dist',
  'packages/storage/tsconfig.tsbuildinfo',
  'packages/runtime/dist',
  'packages/runtime/tsconfig.tsbuildinfo',
  'packages/headless/dist',
  'packages/headless/tsconfig.tsbuildinfo',
  'packages/ui/dist',
  'packages/ui/tsconfig.tsbuildinfo',
  'apps/desktop/dist',
  'apps/desktop/dist-renderer',
  'apps/desktop/tsconfig.tsbuildinfo',
  'apps/desktop/tsconfig.main.tsbuildinfo',
  'apps/desktop/tsconfig.renderer.tsbuildinfo',
];

let removed = 0;
for (const rel of targets) {
  const full = join(repoRoot, rel);
  if (existsSync(full)) {
    rmSync(full, { recursive: true, force: true });
    console.log(`cleaned ${rel}`);
    removed++;
  }
}

console.log(removed === 0 ? 'nothing to clean.' : `cleaned ${removed} path(s).`);
