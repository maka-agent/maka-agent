#!/usr/bin/env node
// Acquire + verify + extract the pinned cua-driver compatibility release for
// bundling into Maka.app. The source patch remains published in hqhq1025/cua
// and proposed upstream; Maka only consumes an immutable, provenance-carrying
// release artifact. Mirrors scripts/prepare-officecli.mjs: single-source version pin in
// apps/desktop/bundled-tools.json, checksum verified fail-closed, extracted to a
// pinned repo path (resources/bin/cua-driver), idempotent via a marker file.
//
// cua-driver ships ONE darwin-universal tarball (arm64 + x64), so unlike
// OfficeCLI there is no per-arch asset. This tool is macOS-only (the Tier-2
// coordinate-injection backend); on other platforms this is a no-op.
//
// Dev usage: `npm run prepare:cua-driver`. The extracted binary is spawned as a
// DIRECT child by cua-driver-backend.ts. This script verifies that the release
// artifact has a valid code signature, but it does not claim Developer ID,
// notarization, Gatekeeper, or final Maka.app nested-signature readiness.
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
const licenseDir = join(repoRoot, 'apps', 'desktop', 'resources', 'licenses', 'cua-driver');
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
  for (const field of ['archiveSha256', 'binarySha256', 'licenseSha256', 'sourceSha256']) {
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
  if (
    typeof entry?.expectedVersion !== 'string'
    || typeof entry?.expectedProtocolVersion !== 'string'
    || typeof entry?.sourceCommit !== 'string'
    || typeof entry?.upstreamCommit !== 'string'
    || typeof entry?.upstreamMergeCommit !== 'string'
    || typeof entry?.cargoLockSha256 !== 'string'
    || !Array.isArray(entry?.architectures)
    || entry.architectures.length === 0
  ) {
    throw new Error('bundled-tools.json cuaDriver must pin version, protocol, source commits, Cargo.lock, and architectures.');
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
    expectedVersion: cua.expectedVersion,
    expectedProtocolVersion: cua.expectedProtocolVersion,
    sourceCommit: cua.sourceCommit,
    upstreamCommit: cua.upstreamCommit,
    upstreamMergeCommit: cua.upstreamMergeCommit,
    archiveSha256: cua.archiveSha256,
    binarySha256: cua.binarySha256,
    licenseSha256: cua.licenseSha256,
    sourceSha256: cua.sourceSha256,
  };
}

function markerMatches(marker) {
  const expected = expectedMarker();
  return marker?.version === expected.version
    && marker?.expectedVersion === expected.expectedVersion
    && marker?.expectedProtocolVersion === expected.expectedProtocolVersion
    && marker?.sourceCommit === expected.sourceCommit
    && marker?.upstreamCommit === expected.upstreamCommit
    && marker?.upstreamMergeCommit === expected.upstreamMergeCommit
    && marker?.archiveSha256 === expected.archiveSha256
    && marker?.binarySha256 === expected.binarySha256
    && marker?.licenseSha256 === expected.licenseSha256
    && marker?.sourceSha256 === expected.sourceSha256;
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
    const actualLicenseSha256 = sha256(await readFile(join(licenseDir, 'LICENSE.md')));
    const actualSourceSha256 = sha256(await readFile(join(licenseDir, 'SOURCE.json')));
    return actualBinarySha256 === cua.binarySha256
      && actualLicenseSha256 === cua.licenseSha256
      && actualSourceSha256 === cua.sourceSha256;
  } catch {
    return false;
  }
}

async function verifyBinary(binaryPath) {
  const { stdout } = await execFileAsync(binaryPath, ['--version']);
  if (stdout.trim() !== `cua-driver ${cua.expectedVersion}`) {
    throw new Error(
      `Unexpected cua-driver version: expected ${cua.expectedVersion}, got ${JSON.stringify(stdout.trim())}`,
    );
  }
  await execFileAsync('lipo', [binaryPath, '-verify_arch', ...cua.architectures]);
  await execFileAsync('codesign', ['--verify', '--strict', '--verbose=2', binaryPath]);
}

export function assertSafeTarEntries(entries) {
  for (const rawEntry of entries) {
    const entry = rawEntry.trim();
    if (!entry) continue;
    if (
      entry.startsWith('/')
      || entry.split('/').includes('..')
      || entry.includes('\\')
    ) {
      throw new Error(`Unsafe cua-driver archive entry: ${JSON.stringify(entry)}`);
    }
  }
}

export function assertSafeTarListing(lines) {
  for (const line of lines) {
    if (!line.trim()) continue;
    const type = line[0];
    if (type !== '-' && type !== 'd') {
      throw new Error(`Unsupported cua-driver archive entry type: ${JSON.stringify(line)}`);
    }
  }
}

function assertSourceProvenance(source) {
  const expected = {
    repository: cua.repo,
    upstreamTag: cua.upstreamTag,
    upstreamCommit: cua.upstreamCommit,
    sourceCommit: cua.sourceCommit,
    patchPullRequest: cua.patchPullRequest,
    cargoLockSha256: cua.cargoLockSha256,
    signature: cua.signature,
  };
  for (const [field, value] of Object.entries(expected)) {
    if (source?.[field] !== value) {
      throw new Error(
        `cua-driver SOURCE.json ${field} mismatch: expected ${JSON.stringify(value)}, got ${JSON.stringify(source?.[field])}`,
      );
    }
  }
  if (
    !Array.isArray(source?.architectures)
    || source.architectures.length !== cua.architectures.length
    || !cua.architectures.every((arch) => source.architectures.includes(arch))
  ) {
    throw new Error('cua-driver SOURCE.json architectures do not match bundled-tools.json.');
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
    const listed = await execFileAsync('tar', ['-tzf', tarPath]);
    assertSafeTarEntries(listed.stdout.split('\n'));
    const verboseListing = await execFileAsync('tar', ['-tvzf', tarPath]);
    assertSafeTarListing(verboseListing.stdout.split('\n'));
    await execFileAsync('tar', ['-xzf', tarPath, '-C', workDir]);
    const { stdout } = await execFileAsync('find', [workDir, '-name', cua.binaryName, '-type', 'f']);
    const found = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
    if (found.length !== 1) {
      throw new Error(
        `Extracted archive ${cua.asset} must contain exactly one '${cua.binaryName}' binary (found ${found.length})`,
      );
    }

    const binaryBytes = await readFile(found[0]);
    const actualBinarySha256 = sha256(binaryBytes);
    if (actualBinarySha256 !== cua.binarySha256) {
      throw new Error(
        `Checksum mismatch for extracted ${cua.binaryName}: expected ${cua.binarySha256}, got ${actualBinarySha256}`,
      );
    }
    await verifyBinary(found[0]);

    const licensePaths = await execFileAsync('find', [workDir, '-name', 'LICENSE.md', '-type', 'f']);
    const sourcePaths = await execFileAsync('find', [workDir, '-name', 'SOURCE.json', '-type', 'f']);
    const licenses = licensePaths.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
    const sources = sourcePaths.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
    if (licenses.length !== 1 || sources.length !== 1) {
      throw new Error(
        `Extracted archive ${cua.asset} must contain exactly one LICENSE.md and SOURCE.json`,
      );
    }
    const licenseBytes = await readFile(licenses[0]);
    const sourceBytes = await readFile(sources[0]);
    if (sha256(licenseBytes) !== cua.licenseSha256) {
      throw new Error(`Checksum mismatch for extracted cua-driver LICENSE.md`);
    }
    if (sha256(sourceBytes) !== cua.sourceSha256) {
      throw new Error(`Checksum mismatch for extracted cua-driver SOURCE.json`);
    }
    assertSourceProvenance(JSON.parse(sourceBytes.toString('utf8')));

    await mkdir(binDir, { recursive: true });
    await mkdir(licenseDir, { recursive: true });
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
      await writeFile(join(licenseDir, 'LICENSE.md'), licenseBytes);
      await writeFile(join(licenseDir, 'SOURCE.json'), sourceBytes);
    } finally {
      await rm(stagedBinary, { force: true });
      await rm(stagedMarker, { force: true });
    }

    return {
      skipped: false,
      destination,
      version: cua.version,
      signatureMode: cua.signature,
      releaseSigningReady: false,
    };
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
