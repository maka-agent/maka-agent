import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');
const SESSION_LIST_PANEL_PATH = resolve(REPO_ROOT, 'packages', 'ui', 'src', 'session-list-panel.tsx');

async function readLocalModuleSource(importerPath: string, specifier: string): Promise<string> {
  assert.match(specifier, /^\.\.?\//, `${specifier} must be a local UI owner import`);
  const importedPath = resolve(dirname(importerPath), specifier);
  const sourcePaths = specifier.endsWith('.js')
    ? [importedPath.replace(/\.js$/, '.tsx'), importedPath.replace(/\.js$/, '.ts')]
    : [`${importedPath}.tsx`, `${importedPath}.ts`, importedPath];

  for (const sourcePath of sourcePaths) {
    try {
      return await readFile(sourcePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  throw new Error(`Could not resolve local UI owner import ${specifier} from ${importerPath}`);
}

export async function readRenderedSessionHistorySource(): Promise<string> {
  const sessionListPanel = await readFile(SESSION_LIST_PANEL_PATH, 'utf8');

  assert.match(
    sessionListPanel,
    /<SessionHistoryList\b/,
    'SessionListPanel must render SessionHistoryList for sidebar session rows',
  );

  const importMatch = sessionListPanel.match(
    /import\s+\{[\s\S]*?\bSessionHistoryList\b[\s\S]*?\}\s+from\s+['"]([^'"]+)['"]/,
  );
  assert.ok(importMatch, 'SessionListPanel must import the rendered SessionHistoryList owner');

  return readLocalModuleSource(SESSION_LIST_PANEL_PATH, importMatch[1]!);
}
