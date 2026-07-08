// Runtime resolver for the bundled cua-driver binary. Mirrors officecli-env.ts:
//   - prod: process.resourcesPath is set by Electron → <Resources>/bin/cua-driver
//     (electron-builder extraResources maps resources/bin → Resources/bin).
//   - dev:  process.resourcesPath is empty → fall back to the repo path the
//     `npm run prepare:cua-driver` script writes:
//     apps/desktop/resources/bin/cua-driver, computed relative to the COMPILED
//     main file. This file compiles to dist/main/computer-use/cua-driver-path.js,
//     so apps/desktop is three levels up (../../../ from dist/main/computer-use).
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BINARY_NAME = 'cua-driver';

function currentResourcesPath(): string {
  return (process as unknown as { resourcesPath?: string }).resourcesPath ?? '';
}

function devBinaryPath(): string {
  return resolve(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    'resources',
    'bin',
    BINARY_NAME,
  );
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
 * Resolve the cua-driver binary, returning the first existing candidate. In prod
 * only the packaged path is checked; in dev only the repo path. Returns null
 * when the binary is absent so callers can fail closed with a typed CU error
 * (permission/availability) rather than spawning a missing path.
 */
export function resolveCuaDriverBinaryPath(resourcesPath = currentResourcesPath()): string | null {
  const candidate = cuaDriverBinaryPath(resourcesPath);
  return existsSync(candidate) ? candidate : null;
}
