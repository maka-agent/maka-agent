import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import type { StorybookConfig } from '@storybook/react-vite';
import { mergeConfig, type UserConfig } from 'vite';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const UI_SRC = resolve(REPO_ROOT, 'packages/ui/src');

const config: StorybookConfig = {
  stories: [
    '../../../packages/ui/src/**/*.stories.@(ts|tsx)',
  ],
  framework: {
    name: '@storybook/react-vite',
    options: {},
  },
  core: {
    disableTelemetry: true,
  },
  async viteFinal(baseConfig) {
    return mergeConfig(baseConfig, {
      plugins: [tailwindcss()],
      resolve: {
        alias: [
          { find: '@maka/ui/icons', replacement: resolve(UI_SRC, 'icons.tsx') },
          { find: '@maka/ui/artifact-preview-registry', replacement: resolve(UI_SRC, 'artifact-preview-registry.ts') },
          { find: '@maka/ui/assistant-stream', replacement: resolve(UI_SRC, 'assistant-stream.ts') },
          { find: '@maka/ui/maka-uri', replacement: resolve(UI_SRC, 'maka-uri.ts') },
          { find: '@maka/ui/smooth-stream', replacement: resolve(UI_SRC, 'smooth-stream.ts') },
          { find: /^@maka\/ui$/, replacement: resolve(UI_SRC, 'index.ts') },
        ],
      },
    } satisfies UserConfig);
  },
};

export default config;
