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
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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

function destinationPath() {
  return join(binDir, cua.binaryName);
}

function markerPath() {
  return join(binDir, '.cua-driver.json');
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
    return marker.version === cua.version && marker.sha256 === cua.sha256;
  } catch {
    return false;
  }
}

export async function prepareCuaDriver(targetPlatform = process.platform) {
  if (!cuaDriverSupported(targetPlatform)) {
    return { skipped: true, reason: `cua-driver is macOS-only; skipping ${targetPlatform}` };
  }
  if (await alreadyPrepared()) {
    return { skipped: true, reason: 'up-to-date', destination: destinationPath(), version: cua.version };
  }

  const url = cuaDriverDownloadUrl(cua.tag, cua.asset);
  const data = await fetchBytes(url);
  const actual = sha256(data);
  if (!cua.sha256 || cua.sha256.startsWith('<')) {
    throw new Error(
      `bundled-tools.json cuaDriver.sha256 is not pinned. Downloaded ${cua.asset} has sha256 ${actual}. ` +
      `Verify it against the release page, then set cuaDriver.sha256 to this value.`,
    );
  }
  if (actual !== cua.sha256) {
    throw new Error(`Checksum mismatch for ${cua.asset}: expected ${cua.sha256}, got ${actual}`);
  }

  // Extract the tarball to a temp dir, then copy out the single `cua-driver`
  // Mach-O. Tarball internal layout is not assumed — we locate the binary.
  const workDir = await mkdtemp(join(tmpdir(), 'maka-cua-driver-'));
  const tarPath = join(workDir, cua.asset);
  await writeFile(tarPath, Buffer.from(data));
  await execFileAsync('tar', ['-xzf', tarPath, '-C', workDir]);
  const { stdout } = await execFileAsync('find', [workDir, '-name', cua.binaryName, '-type', 'f']);
  const found = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  if (found.length === 0) {
    throw new Error(`Extracted archive ${cua.asset} did not contain a '${cua.binaryName}' binary`);
  }

  await mkdir(binDir, { recursive: true });
  const destination = destinationPath();
  await rm(destination, { force: true });
  await writeFile(destination, await readFile(found[0]));
  await chmod(destination, 0o755);
  // Best-effort: clear the download quarantine xattr so the dev Electron process
  // can spawn it without a Gatekeeper prompt. Non-fatal if xattr is absent.
  try {
    await execFileAsync('xattr', ['-d', 'com.apple.quarantine', destination]);
  } catch {
    /* no quarantine attr — fine */
  }
  await writeFile(markerPath(), `${JSON.stringify({ version: cua.version, sha256: cua.sha256 }, null, 2)}\n`);
  await rm(workDir, { recursive: true, force: true });

  return { skipped: false, destination, version: cua.version };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await prepareCuaDriver();
  if (result.skipped) {
    process.stdout.write(`cua-driver: ${result.reason}\n`);
  } else {
    process.stdout.write(`Prepared cua-driver ${result.version}: ${result.destination}\n`);
  }
}
