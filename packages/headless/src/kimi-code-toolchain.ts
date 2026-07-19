import { createHash } from 'node:crypto';
import {
  prepareNodeCliToolchain,
  validatePreparedNodeCliToolchain,
  type PinnedNodeCliToolchainDefinition,
} from './node-cli-toolchain.js';

export const KIMI_CODE_TOOLCHAIN_CONTAINER_PATH = '/opt/maka-kimi-code-toolchain';

const REQUEST_TIMEOUT_PATCH_SEARCH = 'OpenAI.DEFAULT_TIMEOUT = 6e5;';
const REQUEST_TIMEOUT_PATCH_REPLACEMENT =
  'OpenAI.DEFAULT_TIMEOUT = Number(process.env["KIMI_MODEL_REQUEST_TIMEOUT_MS"] ?? 6e5);';
const REQUEST_TIMEOUT_PATCH_REPLACEMENTS = 1;

export function applyKimiCodeRequestTimeoutPatch(source: string): string {
  const replacements = source.split(REQUEST_TIMEOUT_PATCH_SEARCH).length - 1;
  if (replacements !== REQUEST_TIMEOUT_PATCH_REPLACEMENTS) {
    throw new Error(
      `expected ${REQUEST_TIMEOUT_PATCH_REPLACEMENTS} OpenAI SDK timeout default, found ${replacements}`,
    );
  }
  return source.split(REQUEST_TIMEOUT_PATCH_SEARCH).join(REQUEST_TIMEOUT_PATCH_REPLACEMENT);
}

export const KIMI_CODE_TOOLCHAIN_SPEC = {
  schemaVersion: 1,
  platform: 'linux',
  arch: 'x64',
  node: {
    version: '22.23.1',
    archiveUrl: 'https://nodejs.org/dist/v22.23.1/node-v22.23.1-linux-x64.tar.gz',
    archiveSha256: '7a8cb04b4a1df4eaf432125324b81b29a088e73570a23259a8de1c65d07fc129',
    binarySha256: '93956de2e59480474a7b46571da1651180b1a050cdf32641ebec4ce6e478e068',
  },
  kimiCode: {
    version: '0.26.0',
    archiveUrl: 'https://registry.npmjs.org/@moonshot-ai/kimi-code/-/kimi-code-0.26.0.tgz',
    archiveIntegrity:
      'sha512-GadxPxbCYOfkMgX8sF6VyuligSTLU81sxJswMtzM5D0vmB7/ZGM7PBmUn6YF2fV/nKcx1JgPIHEc3vgKCQgqsQ==',
    sourceEntrypointSha256: 'bc310a7d2f0c3c2cb1367fa7b2092375351efff51c6d4a358b8681b4a01fb7b0',
    entrypointSha256: '58f48c418f446e525f2b60765a27221ed7ac771bebed45375a289d1172aa96c6',
    packageJsonSha256: '65dfa318a882d834e356828d0f371f349f2dcfc99585cb01412f7c0a9e6ae52a',
    patch: {
      id: 'request-timeout-env-v1',
      env: 'KIMI_MODEL_REQUEST_TIMEOUT_MS',
      search: REQUEST_TIMEOUT_PATCH_SEARCH,
      replacement: REQUEST_TIMEOUT_PATCH_REPLACEMENT,
      expectedReplacements: REQUEST_TIMEOUT_PATCH_REPLACEMENTS,
    },
  },
} as const;

export const KIMI_CODE_TOOLCHAIN_FINGERPRINT = `sha256:${createHash('sha256')
  .update(JSON.stringify(KIMI_CODE_TOOLCHAIN_SPEC))
  .digest('hex')}`;

export interface PreparedKimiCodeToolchain {
  path: string;
  fingerprint: typeof KIMI_CODE_TOOLCHAIN_FINGERPRINT;
}

const DEFINITION: PinnedNodeCliToolchainDefinition<typeof KIMI_CODE_TOOLCHAIN_SPEC> = {
  label: 'Kimi Code',
  fingerprint: KIMI_CODE_TOOLCHAIN_FINGERPRINT,
  spec: KIMI_CODE_TOOLCHAIN_SPEC,
  node: KIMI_CODE_TOOLCHAIN_SPEC.node,
  packageArchive: {
    url: KIMI_CODE_TOOLCHAIN_SPEC.kimiCode.archiveUrl,
    integrity: KIMI_CODE_TOOLCHAIN_SPEC.kimiCode.archiveIntegrity,
  },
  packageFiles: [
    {
      archivePath: 'package/dist/main.mjs',
      installedPath: 'lib/kimi-code/main.mjs',
      sourceSha256: KIMI_CODE_TOOLCHAIN_SPEC.kimiCode.sourceEntrypointSha256,
      sha256: KIMI_CODE_TOOLCHAIN_SPEC.kimiCode.entrypointSha256,
      transform: applyKimiCodeRequestTimeoutPatch,
    },
    {
      archivePath: 'package/package.json',
      installedPath: 'lib/kimi-code/package.json',
      sha256: KIMI_CODE_TOOLCHAIN_SPEC.kimiCode.packageJsonSha256,
      stripComponents: 1,
    },
  ],
};

export async function validatePreparedKimiCodeToolchain(
  path: string,
): Promise<PreparedKimiCodeToolchain> {
  await validatePreparedNodeCliToolchain(path, DEFINITION);
  return { path, fingerprint: KIMI_CODE_TOOLCHAIN_FINGERPRINT };
}

export async function prepareKimiCodeToolchain(
  path: string,
  options: { fetchFn?: typeof fetch } = {},
): Promise<PreparedKimiCodeToolchain> {
  await prepareNodeCliToolchain(path, DEFINITION, options);
  return { path, fingerprint: KIMI_CODE_TOOLCHAIN_FINGERPRINT };
}
