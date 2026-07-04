import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');
const UI_SOURCE_ROOT = resolve(REPO_ROOT, 'packages', 'ui', 'src');
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);

async function readSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const entryPath = resolve(dir, entry.name);
    if (entry.isDirectory()) return readSourceFiles(entryPath);
    if (!SOURCE_EXTENSIONS.has(entryPath.slice(entryPath.lastIndexOf('.')))) return [];
    return [await readFile(entryPath, 'utf8')];
  }));
  return files.flat();
}

export async function readUiSourceTree(): Promise<string> {
  return (await readSourceFiles(UI_SOURCE_ROOT)).join('\n');
}
