// Runtime resolver for the bundled cua-driver binary. Mirrors officecli-env.ts:
//   - prod: process.resourcesPath is set by Electron → <Resources>/bin/cua-driver
//     (electron-builder extraResources maps resources/bin → Resources/bin).
//   - dev:  process.resourcesPath is empty → fall back to the repo path the
//     `npm run prepare:cua-driver` script writes:
//     apps/desktop/resources/bin/cua-driver, computed relative to the COMPILED
//     main file. This file compiles to dist/main/computer-use/cua-driver-path.js,
//     so apps/desktop is three levels up (../../../ from dist/main/computer-use).
import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BINARY_NAME = 'cua-driver';

function currentResourcesPath(): string {
  return (process as unknown as { resourcesPath?: string }).resourcesPath ?? '';
}

function devBinaryPath(): string {
  // Robust to BOTH build layouts: prod tsc emits dist/main/computer-use/*.js,
  // while `npm run dev` esbuild-bundles into dist/main/main.js — either way the
  // repo binary lives at <desktop>/resources/bin. Walk up to the 'dist' root,
  // whose parent is <desktop>, then join resources/bin. (A naive fixed-depth
  // `../../../` is wrong for the bundled layout and silently hides the binary.)
  const start = dirname(fileURLToPath(import.meta.url));
  let dir = start;
  for (let i = 0; i < 6; i++) {
    if (basename(dir) === 'dist') return join(dirname(dir), 'resources', 'bin', BINARY_NAME);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(start, '..', '..', '..', 'resources', 'bin', BINARY_NAME);
}

/**
 * Absolute path where the cua-driver binary is expected. Prefers the packaged
 * location (resourcesPath/bin) and falls back to the dev repo path. Does not
 * check existence — use {@link resolveCuaDriverBinaryPath} when you need the
 * path to actually exist.
 */
export function cuaDriverBinaryPath(resourcesPath = currentResourcesPath()): string {
  if (resourcesPath) return join(resourcesPath, 'bin', BINARY_NAME);
  return devBinaryPath();
}

/**
 * Resolve the cua-driver binary, returning the first existing candidate. Tries
 * the packaged location (resourcesPath/bin) AND the dev repo path, because in an
 * unpackaged dev run `process.resourcesPath` is set to Electron's OWN Resources
 * dir (not Maka's) — so a resourcesPath-only check would look in the wrong place
 * and silently hide the binary, dropping the whole `computer` capability. Returns
 * null when absent so callers fail closed with a typed CU error.
 */
export function resolveCuaDriverBinaryPath(resourcesPath = currentResourcesPath()): string | null {
  const candidates: string[] = [];
  if (resourcesPath) candidates.push(join(resourcesPath, 'bin', BINARY_NAME));
  const dev = devBinaryPath();
  if (!candidates.includes(dev)) candidates.push(dev);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
