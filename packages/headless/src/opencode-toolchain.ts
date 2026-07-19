import { createHash } from 'node:crypto';
import {
  prepareNodeCliToolchain,
  validatePreparedNodeCliToolchain,
  type PinnedNodeCliToolchainDefinition,
} from './node-cli-toolchain.js';

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
    archiveIntegrity:
      'sha512-8BmT22yp7pCXXu/HvAMaJsNNd6xhmlUrGs5YZSfU0neZfkSZg+Dkf9IGsuOugOtL0x2erDg2/6rRBpcJAGmTrA==',
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

const DEFINITION: PinnedNodeCliToolchainDefinition<typeof OPENCODE_TOOLCHAIN_SPEC> = {
  label: 'OpenCode',
  fingerprint: OPENCODE_TOOLCHAIN_FINGERPRINT,
  spec: OPENCODE_TOOLCHAIN_SPEC,
  node: OPENCODE_TOOLCHAIN_SPEC.node,
  packageArchive: {
    url: OPENCODE_TOOLCHAIN_SPEC.opencode.archiveUrl,
    integrity: OPENCODE_TOOLCHAIN_SPEC.opencode.archiveIntegrity,
  },
  packageFiles: [
    {
      archivePath: 'package/bin/opencode',
      installedPath: 'bin/opencode',
      sha256: OPENCODE_TOOLCHAIN_SPEC.opencode.binarySha256,
      executable: true,
    },
  ],
};

export async function validatePreparedOpenCodeToolchain(
  path: string,
): Promise<PreparedOpenCodeToolchain> {
  await validatePreparedNodeCliToolchain(path, DEFINITION);
  return { path, fingerprint: OPENCODE_TOOLCHAIN_FINGERPRINT };
}

export async function prepareOpenCodeToolchain(
  path: string,
  options: { fetchFn?: typeof fetch } = {},
): Promise<PreparedOpenCodeToolchain> {
  await prepareNodeCliToolchain(path, DEFINITION, options);
  return { path, fingerprint: OPENCODE_TOOLCHAIN_FINGERPRINT };
}
