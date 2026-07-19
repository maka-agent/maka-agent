#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { access, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  assetForTarget,
  binaryNameForPlatform,
  officeCliVersionMatches,
} from './prepare-officecli.mjs';

const execFileAsync = promisify(execFile);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const manifestPath = join(repoRoot, 'apps', 'desktop', 'bundled-tools.json');
const toolsDir = join(repoRoot, 'apps', 'desktop', 'resources', 'tools');

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function verifyRunnableVersion(binaryPath, expectedVersion) {
  const { stdout } = await execFileAsync(binaryPath, ['--version'], {
    env: { ...process.env, OFFICECLI_SKIP_UPDATE: '1' },
  });
  if (!officeCliVersionMatches(stdout, expectedVersion)) {
    throw new Error(
      `OfficeCLI bundle version mismatch: expected ${expectedVersion}, got ${stdout.trim()}`,
    );
  }
}

export async function checkOfficeCliBundle(
  targetPlatform = process.platform,
  targetArch = process.arch,
) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const asset = assetForTarget(targetPlatform, targetArch);
  const binaryName = binaryNameForPlatform(targetPlatform);
  const binaryPath = join(toolsDir, binaryName);
  const expectedVersion = manifest.officecli.version;

  try {
    await access(binaryPath, constants.R_OK);
  } catch {
    throw new Error(
      `OfficeCLI bundle missing for ${targetPlatform}-${targetArch} (${asset}). ` +
        `Run \`npm run prepare:officecli -- --platform ${targetPlatform} --arch ${targetArch}\` before packaging.`,
    );
  }

  const info = await stat(binaryPath);
  if (!info.isFile() || info.size <= 0) {
    throw new Error(`OfficeCLI bundle is not a non-empty file: ${binaryPath}`);
  }

  if (targetPlatform !== 'win32') {
    await access(binaryPath, constants.X_OK);
  }

  if (targetPlatform === process.platform && targetArch === process.arch) {
    await verifyRunnableVersion(binaryPath, expectedVersion);
  }

  return { asset, binaryPath, version: expectedVersion };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const platform = readArg('--platform') ?? process.platform;
  const arch = readArg('--arch') ?? process.arch;
  const result = await checkOfficeCliBundle(platform, arch);
  process.stdout.write(
    `Verified OfficeCLI ${result.version} bundle for ${platform}-${arch}: ${result.binaryPath}\n`,
  );
}
