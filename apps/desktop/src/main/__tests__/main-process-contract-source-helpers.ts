import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');

export const MAIN_PROCESS_SOURCE_REPO_PATHS: readonly string[] = [
  'apps/desktop/src/main/main.ts',
  'apps/desktop/src/main/bot-incoming-main.ts',
  'apps/desktop/src/main/daily-review-main.ts',
  'apps/desktop/src/main/main-window.ts',
  'apps/desktop/src/main/plan-reminders-main.ts',
];

export async function readMainProcessCombinedSource(): Promise<string> {
  const sources = await Promise.all(
    MAIN_PROCESS_SOURCE_REPO_PATHS.map((sourcePath) =>
      readFile(resolve(REPO_ROOT, sourcePath), 'utf8')
    ),
  );
  return sources.join('\n');
}

export function readMainProcessCombinedSourceSync(): string {
  return MAIN_PROCESS_SOURCE_REPO_PATHS
    .map((sourcePath) => readFileSync(resolve(REPO_ROOT, sourcePath), 'utf8'))
    .join('\n');
}
