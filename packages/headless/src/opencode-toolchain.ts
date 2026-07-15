import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const OPENCODE_TOOLCHAIN_CONTAINER_PATH = '/opt/maka-opencode-toolchain';

export const OPENCODE_TOOLCHAIN_SPEC = {
  schemaVersion: 1,
  platform: 'linux',
  arch: 'x64',
  node: {
    version: '22.23.1',
    archiveUrl: 'https://nodejs.org/dist/v22.23.1/node-v22.23.1-linux-x64.tar.gz',
    archiveSha256: '7a8cb04b4a1df4eaf432125324b81b29a088e73570a23259a8de1c65d07fc129',
    binarySha256: '93956de2e59480474a7b46571da1651180b1a050cdf32641ebec4ce6e478e068',
  },
  opencode: {
    version: '1.17.18',
    archiveUrl: 'https://registry.npmjs.org/opencode-linux-x64/-/opencode-linux-x64-1.17.18.tgz',
    archiveIntegrity: 'sha512-8BmT22yp7pCXXu/HvAMaJsNNd6xhmlUrGs5YZSfU0neZfkSZg+Dkf9IGsuOugOtL0x2erDg2/6rRBpcJAGmTrA==',
    binarySha256: '0cbfb6de55aa4ce3c74da12d8516376033693a88abca6238c5be32bf98130636',
  },
} as const;

export const OPENCODE_TOOLCHAIN_FINGERPRINT = `sha256:${createHash('sha256')
  .update(JSON.stringify(OPENCODE_TOOLCHAIN_SPEC))
  .digest('hex')}`;

export interface PreparedOpenCodeToolchain {
  path: string;
  fingerprint: typeof OPENCODE_TOOLCHAIN_FINGERPRINT;
}

interface OpenCodeToolchainManifest {
  schemaVersion: 1;
  fingerprint: typeof OPENCODE_TOOLCHAIN_FINGERPRINT;
  spec: typeof OPENCODE_TOOLCHAIN_SPEC;
}

export async function validatePreparedOpenCodeToolchain(path: string): Promise<PreparedOpenCodeToolchain> {
  const manifest = parseManifest(await readFile(join(path, 'manifest.json'), 'utf8'));
  if (manifest.fingerprint !== OPENCODE_TOOLCHAIN_FINGERPRINT) {
    throw new Error(`OpenCode toolchain fingerprint mismatch: ${manifest.fingerprint}`);
  }
  if (JSON.stringify(manifest.spec) !== JSON.stringify(OPENCODE_TOOLCHAIN_SPEC)) {
    throw new Error('OpenCode toolchain spec does not match the pinned contract');
  }
  const pinnedFiles = {
    'bin/node': OPENCODE_TOOLCHAIN_SPEC.node.binarySha256,
    'bin/opencode': OPENCODE_TOOLCHAIN_SPEC.opencode.binarySha256,
  } as const;
  const checksums: string[] = [];
  for (const relativePath of ['bin/node', 'bin/opencode'] as const) {
    const expected = pinnedFiles[relativePath];
    const actual = await sha256File(join(path, relativePath));
    if (actual !== expected) {
      throw new Error(`OpenCode toolchain ${relativePath} SHA-256 mismatch`);
    }
    checksums.push(`${expected}  ${relativePath}\n`);
  }
  if (await readFile(join(path, 'checksums.sha256'), 'utf8') !== checksums.join('')) {
    throw new Error('OpenCode toolchain checksums.sha256 does not match its manifest');
  }
  return { path, fingerprint: OPENCODE_TOOLCHAIN_FINGERPRINT };
}

export async function prepareOpenCodeToolchain(
  path: string,
  options: { fetchFn?: typeof fetch } = {},
): Promise<PreparedOpenCodeToolchain> {
  if (await exists(join(path, 'manifest.json'))) {
    return validatePreparedOpenCodeToolchain(path);
  }
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = await mkdtemp(join(dirname(path), `.${basename(path)}-`));
  try {
    const nodeArchive = join(temporaryPath, 'node.tar.gz');
    const opencodeArchive = join(temporaryPath, 'opencode.tgz');
    await downloadVerified({
      url: OPENCODE_TOOLCHAIN_SPEC.node.archiveUrl,
      path: nodeArchive,
      algorithm: 'sha256',
      expected: OPENCODE_TOOLCHAIN_SPEC.node.archiveSha256,
      fetchFn: options.fetchFn ?? fetch,
    });
    await downloadVerified({
      url: OPENCODE_TOOLCHAIN_SPEC.opencode.archiveUrl,
      path: opencodeArchive,
      algorithm: 'sha512',
      expected: OPENCODE_TOOLCHAIN_SPEC.opencode.archiveIntegrity.slice('sha512-'.length),
      encoding: 'base64',
      fetchFn: options.fetchFn ?? fetch,
    });

    const binDir = join(temporaryPath, 'bin');
    await mkdir(binDir);
    await execFileAsync('tar', [
      '-xzf', nodeArchive,
      '-C', binDir,
      '--strip-components=2',
      `node-v${OPENCODE_TOOLCHAIN_SPEC.node.version}-linux-x64/bin/node`,
    ]);
    await execFileAsync('tar', [
      '-xzf', opencodeArchive,
      '-C', binDir,
      '--strip-components=2',
      'package/bin/opencode',
    ]);
    await chmod(join(binDir, 'node'), 0o755);
    await chmod(join(binDir, 'opencode'), 0o755);

    const files = {
      'bin/node': OPENCODE_TOOLCHAIN_SPEC.node.binarySha256,
      'bin/opencode': OPENCODE_TOOLCHAIN_SPEC.opencode.binarySha256,
    };
    const manifest: OpenCodeToolchainManifest = {
      schemaVersion: 1,
      fingerprint: OPENCODE_TOOLCHAIN_FINGERPRINT,
      spec: OPENCODE_TOOLCHAIN_SPEC,
    };
    await writeFile(join(temporaryPath, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await writeFile(
      join(temporaryPath, 'checksums.sha256'),
      Object.entries(files).map(([relativePath, hash]) => `${hash}  ${relativePath}\n`).join(''),
      'utf8',
    );
    await rm(nodeArchive);
    await rm(opencodeArchive);
    await validatePreparedOpenCodeToolchain(temporaryPath);
    try {
      await rename(temporaryPath, path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' && code !== 'ENOTEMPTY') throw error;
      await validatePreparedOpenCodeToolchain(path);
    }
    return { path, fingerprint: OPENCODE_TOOLCHAIN_FINGERPRINT };
  } finally {
    await rm(temporaryPath, { recursive: true, force: true });
  }
}

function parseManifest(raw: string): OpenCodeToolchainManifest {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error('OpenCode toolchain manifest is not valid JSON', { cause: error });
  }
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.spec)) {
    throw new Error('OpenCode toolchain manifest has an invalid shape');
  }
  return value as unknown as OpenCodeToolchainManifest;
}

async function downloadVerified(input: {
  url: string;
  path: string;
  algorithm: 'sha256' | 'sha512';
  expected: string;
  encoding?: 'hex' | 'base64';
  fetchFn: typeof fetch;
}): Promise<void> {
  const response = await input.fetchFn(input.url);
  if (!response.ok) throw new Error(`failed to download ${input.url}: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const actual = createHash(input.algorithm).update(bytes).digest(input.encoding ?? 'hex');
  if (actual !== input.expected) throw new Error(`archive checksum mismatch for ${input.url}`);
  await writeFile(input.path, bytes);
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
