#!/usr/bin/env node
// Release gate: assert the cua-driver binary is present, non-empty, executable,
// and matches the pinned checksum before packaging. Analogous to
// scripts/check-officecli-bundle.mjs. macOS-only; a no-op elsewhere.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertPinnedCuaDriverChecksums,
  cuaDriverSupported,
} from './prepare-cua-driver.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const manifestPath = join(repoRoot, 'apps', 'desktop', 'bundled-tools.json');
const binDir = join(repoRoot, 'apps', 'desktop', 'resources', 'bin');

export async function checkCuaDriverBundle(targetPlatform = process.platform) {
  if (!cuaDriverSupported(targetPlatform)) {
    return { skipped: true };
  }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const cua = manifest.cuaDriver;
  assertPinnedCuaDriverChecksums(cua);
  const binaryPath = join(binDir, cua.binaryName);
  const markerPath = join(binDir, '.cua-driver.json');

  try {
    await access(binaryPath, constants.R_OK);
  } catch {
    throw new Error(
      `cua-driver bundle missing (${cua.asset}). Run \`npm run prepare:cua-driver\` before packaging.`,
    );
  }
  const info = await stat(binaryPath);
  if (!info.isFile() || info.size <= 0) {
    throw new Error(`cua-driver bundle is not a non-empty file: ${binaryPath}`);
  }
  await access(binaryPath, constants.X_OK);

  // Authoritative check: re-hash the actual binary bytes and fail closed unless
  // they match the pinned checksum. The plaintext marker is trusted only as a
  // secondary signal (below), never on its own.
  const bytes = await readFile(binaryPath);
  const actualBinarySha256 = createHash('sha256').update(bytes).digest('hex');
  if (actualBinarySha256 !== cua.binarySha256) {
    throw new Error(
      `cua-driver bundle checksum mismatch: expected ${cua.binarySha256}, got ${actualBinarySha256} (${binaryPath}). ` +
      `Re-run \`npm run prepare:cua-driver\`.`,
    );
  }

  let marker;
  try {
    marker = JSON.parse(await readFile(markerPath, 'utf8'));
  } catch {
    throw new Error(
      `cua-driver bundle marker is missing or invalid: ${markerPath}. ` +
      `Re-run \`npm run prepare:cua-driver\`.`,
    );
  }
  if (
    marker.version !== cua.version
    || marker.archiveSha256 !== cua.archiveSha256
    || marker.binarySha256 !== cua.binarySha256
  ) {
    throw new Error(
      `cua-driver bundle marker mismatch: manifest ${cua.version}/${cua.archiveSha256}/${cua.binarySha256}, ` +
      `on disk ${marker.version}/${marker.archiveSha256}/${marker.binarySha256}. Re-run \`npm run prepare:cua-driver\`.`,
    );
  }
  return { skipped: false, binaryPath, version: cua.version };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await checkCuaDriverBundle();
  if (result.skipped) {
    process.stdout.write('cua-driver bundle check skipped (non-macOS)\n');
  } else {
    process.stdout.write(`Verified cua-driver ${result.version} bundle: ${result.binaryPath}\n`);
  }
}
