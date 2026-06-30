import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');
const RENDERER_ROOT = resolve(REPO_ROOT, 'apps', 'desktop', 'src', 'renderer');

const sourcePaths = [
  'main.tsx',
  'app.tsx',
  'app-shell.tsx',
  'cached-theme-bootstrap.ts',
  'conversation-markdown.ts',
  'nav-selection.ts',
  'session-list-layout.ts',
] as const;

export const RENDERER_SHELL_SOURCE_REPO_PATHS: readonly string[] = sourcePaths.map(
  (sourcePath) => `apps/desktop/src/renderer/${sourcePath}`,
);

export async function readRendererShellCombinedSource(): Promise<string> {
  const sources = await Promise.all(
    sourcePaths.map((sourcePath) => readFile(resolve(RENDERER_ROOT, sourcePath), 'utf8')),
  );
  return sources.join('\n');
}

export function readRendererShellCombinedSourceSync(): string {
  return sourcePaths
    .map((sourcePath) => readFileSync(resolve(RENDERER_ROOT, sourcePath), 'utf8'))
    .join('\n');
}
