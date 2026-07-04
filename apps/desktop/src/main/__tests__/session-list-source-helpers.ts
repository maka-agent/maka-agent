import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');
const UI_ROOT = resolve(REPO_ROOT, 'packages', 'ui', 'src');

export const SESSION_LIST_SOURCE_REPO_PATHS = [
  'packages/ui/src/session-list-panel.tsx',
  'packages/ui/src/session-sidebar-nav.tsx',
  'packages/ui/src/session-history-list.tsx',
] as const;

const sourcePaths = [
  'session-list-panel.tsx',
  'session-sidebar-nav.tsx',
  'session-history-list.tsx',
] as const;

export async function readSessionListCombinedSource(): Promise<string> {
  const sources = await Promise.all(
    sourcePaths.map((sourcePath) => readFile(resolve(UI_ROOT, sourcePath), 'utf8')),
  );
  return sources.join('\n');
}
