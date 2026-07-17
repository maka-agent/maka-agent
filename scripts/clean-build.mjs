#!/usr/bin/env node
/**
 * PR-BUILD-HYGIENE-0: remove every workspace's `dist` and incremental
 * tsbuildinfo so the next `npm run build` is forced to recompile from
 * source. Solves the recurring "tests pass on stale dist" foot-gun
 * that kept biting us during Phase 3 P0 fixups — every time we
 * removed/renamed an export, the old dist would survive and tests
 * would lie.
 *
 * Workspace list is derived from root package.json so it cannot drift
 * from npm workspaces (e.g. packages/computer-use). Desktop keeps a
 * few extra outputs (renderer bundle + multi-tsconfig build info).
 *
 * Idempotent; missing paths are silently ignored.
 *
 * Run via `npm run clean` at the repo root.
 */

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

const rootPkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const workspaceDirs = Array.isArray(rootPkg.workspaces) ? rootPkg.workspaces : [];

const targets = [];
for (const dir of workspaceDirs) {
  targets.push(`${dir}/dist`, `${dir}/tsconfig.tsbuildinfo`);
}

// Desktop has additional build outputs beyond the standard package layout.
targets.push(
  'apps/desktop/dist-renderer',
  'apps/desktop/tsconfig.main.tsbuildinfo',
  'apps/desktop/tsconfig.renderer.tsbuildinfo',
);

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
