#!/usr/bin/env node
// Acquire + verify + extract trycua/cua-driver (v0.7.1, MIT) for bundling into
// Maka.app. Mirrors scripts/prepare-officecli.mjs: single-source version pin in
// apps/desktop/bundled-tools.json, checksum verified fail-closed, extracted to a
// pinned repo path (resources/bin/cua-driver), idempotent via a marker file.
//
// cua-driver ships ONE darwin-universal tarball (arm64 + x64), so unlike
// OfficeCLI there is no per-arch asset. This tool is macOS-only (the Tier-2
// coordinate-injection backend); on other platforms this is a no-op.
//
// Dev usage: `npm run prepare:cua-driver`. The extracted binary is spawned as a
// DIRECT child by cua-driver-backend.ts and inherits the dev Electron process's
// TCC grants (see EMBEDDING.md / cua-driver-backend.ts:5-9) — no signing needed
// in dev. Production re-signs it during packaging (see signing notes).
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const manifestPath = join(repoRoot, 'apps', 'desktop', 'bundled-tools.json');
const binDir = join(repoRoot, 'apps', 'desktop', 'resources', 'bin');
const DEFAULT_FETCH_TIMEOUT_MS = 300_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const cua = manifest.cuaDriver;
const FETCH_TIMEOUT_MS = readPositiveIntEnv('MAKA_CUA_DRIVER_FETCH_TIMEOUT_MS', DEFAULT_FETCH_TIMEOUT_MS);

export function cuaDriverSupported(platform = process.platform) {
  return platform === 'darwin';
}

export function cuaDriverDownloadUrl(tag, asset) {
  return `https://github.com/${cua.repo}/releases/download/${tag}/${asset}`;
}

export function sha256(data) {
  return createHash('sha256').update(Buffer.from(data)).digest('hex');
}

export function assertPinnedCuaDriverChecksums(entry) {
  for (const field of ['archiveSha256', 'binarySha256']) {
    if (!SHA256_PATTERN.test(entry?.[field] ?? '')) {
      throw new Error(
        `bundled-tools.json cuaDriver.${field} must be a pinned lowercase 64-character SHA-256 digest ` +
        `(received ${JSON.stringify(entry?.[field])}).`,
      );
    }
  }
  if (entry.archiveSha256 === entry.binarySha256) {
    throw new Error('bundled-tools.json must pin the cua-driver archive and extracted binary separately.');
  }
  if (Object.prototype.hasOwnProperty.call(entry, 'sha256')) {
    throw new Error('bundled-tools.json cuaDriver.sha256 is ambiguous; use archiveSha256 and binarySha256.');
  }
}

function destinationPath() {
  return join(binDir, cua.binaryName);
}

function markerPath() {
  return join(binDir, '.cua-driver.json');
}

function expectedMarker() {
  return {
    version: cua.version,
    archiveSha256: cua.archiveSha256,
    binarySha256: cua.binarySha256,
  };
}

function markerMatches(marker) {
  const expected = expectedMarker();
  return marker?.version === expected.version
    && marker?.archiveSha256 === expected.archiveSha256
    && marker?.binarySha256 === expected.binarySha256;
}

function readPositiveIntEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer timeout in milliseconds`);
  }
  return parsed;
}

function isTimeoutError(error) {
  return Boolean(error && typeof error === 'object' && (error.name === 'AbortError' || error.name === 'TimeoutError'));
}

function timeoutError(url) {
  return new Error(`Timed out downloading ${url} after ${FETCH_TIMEOUT_MS}ms`);
}

async function fetchBytes(url) {
  let response;
  try {
    response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (error) {
    if (isTimeoutError(error)) throw timeoutError(url);
    throw error;
  }
  if (!response.ok) throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
  try {
    return await response.arrayBuffer();
  } catch (error) {
    if (isTimeoutError(error)) throw timeoutError(url);
    throw error;
  }
}

// Idempotency: skip the network round-trip when the pinned version + checksum
// already match the on-disk marker AND the binary is present + executable.
async function alreadyPrepared() {
  try {
    await access(destinationPath(), constants.X_OK);
    const marker = JSON.parse(await readFile(markerPath(), 'utf8'));
    if (!markerMatches(marker)) return false;
    // Re-hash the actual binary so a corrupted/swapped file with an intact marker
    // is not silently trusted — on drift, fall through to re-download/re-verify.
    const actualBinarySha256 = sha256(await readFile(destinationPath()));
    return actualBinarySha256 === cua.binarySha256;
  } catch {
    return false;
  }
}

export async function prepareCuaDriver(targetPlatform = process.platform) {
  if (!cuaDriverSupported(targetPlatform)) {
    return { skipped: true, reason: `cua-driver is macOS-only; skipping ${targetPlatform}` };
  }
  assertPinnedCuaDriverChecksums(cua);
  if (await alreadyPrepared()) {
    return { skipped: true, reason: 'up-to-date', destination: destinationPath(), version: cua.version };
  }

  const url = cuaDriverDownloadUrl(cua.tag, cua.asset);
  const data = await fetchBytes(url);
  const actualArchiveSha256 = sha256(data);
  if (actualArchiveSha256 !== cua.archiveSha256) {
    throw new Error(`Checksum mismatch for ${cua.asset}: expected ${cua.archiveSha256}, got ${actualArchiveSha256}`);
  }

  // Extract the tarball to a temp dir, then copy out the single `cua-driver`
  // Mach-O. Tarball internal layout is not assumed — we locate the binary.
  const workDir = await mkdtemp(join(tmpdir(), 'maka-cua-driver-'));
  try {
    const tarPath = join(workDir, cua.asset);
    await writeFile(tarPath, Buffer.from(data));
    await execFileAsync('tar', ['-xzf', tarPath, '-C', workDir]);
    const { stdout } = await execFileAsync('find', [workDir, '-name', cua.binaryName, '-type', 'f']);
    const found = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
    if (found.length === 0) {
      throw new Error(`Extracted archive ${cua.asset} did not contain a '${cua.binaryName}' binary`);
    }

    const binaryBytes = await readFile(found[0]);
    const actualBinarySha256 = sha256(binaryBytes);
    if (actualBinarySha256 !== cua.binarySha256) {
      throw new Error(
        `Checksum mismatch for extracted ${cua.binaryName}: expected ${cua.binarySha256}, got ${actualBinarySha256}`,
      );
    }

    await mkdir(binDir, { recursive: true });
    const destination = destinationPath();
    const marker = markerPath();
    const installId = randomUUID();
    const stagedBinary = `${destination}.${installId}.tmp`;
    const stagedMarker = `${marker}.${installId}.tmp`;
    try {
      await writeFile(stagedBinary, binaryBytes);
      await chmod(stagedBinary, 0o755);
      // Best-effort: clear the download quarantine xattr so the dev Electron process
      // can spawn it without a Gatekeeper prompt. Non-fatal if xattr is absent.
      try {
        await execFileAsync('xattr', ['-d', 'com.apple.quarantine', stagedBinary]);
      } catch {
        /* no quarantine attr — fine */
      }
      await writeFile(stagedMarker, `${JSON.stringify(expectedMarker(), null, 2)}\n`);
      await rename(stagedBinary, destination);
      await rename(stagedMarker, marker);
    } finally {
      await rm(stagedBinary, { force: true });
      await rm(stagedMarker, { force: true });
    }

    return { skipped: false, destination, version: cua.version };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await prepareCuaDriver();
  if (result.skipped) {
    process.stdout.write(`cua-driver: ${result.reason}\n`);
  } else {
    process.stdout.write(`Prepared cua-driver ${result.version}: ${result.destination}\n`);
  }
}
