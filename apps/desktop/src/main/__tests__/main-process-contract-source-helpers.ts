import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');

export const MAIN_PROCESS_SOURCE_REPO_PATHS: readonly string[] = [
  'apps/desktop/src/main/main.ts',
  'apps/desktop/src/main/app-ipc-main.ts',
  'apps/desktop/src/main/bot-incoming-main.ts',
  'apps/desktop/src/main/browser-ipc-main.ts',
  'apps/desktop/src/main/config-ipc-main.ts',
  'apps/desktop/src/main/create-connection-with-credential.ts',
  'apps/desktop/src/main/connections-ipc-main.ts',
  'apps/desktop/src/main/daily-review-ipc-main.ts',
  'apps/desktop/src/main/daily-review-main.ts',
  'apps/desktop/src/main/gateway-ipc-main.ts',
  'apps/desktop/src/main/git-ipc-main.ts',
  'apps/desktop/src/main/main-window.ts',
  'apps/desktop/src/main/memory-ipc-main.ts',
  'apps/desktop/src/main/mcp-ipc-main.ts',
  'apps/desktop/src/main/notifications-ipc-main.ts',
  'apps/desktop/src/main/oauth-model-connections-main.ts',
  'apps/desktop/src/main/onboarding-ipc-main.ts',
  'apps/desktop/src/main/permission-mode-default.ts',
  'apps/desktop/src/main/permissions-ipc-main.ts',
  'apps/desktop/src/main/plan-reminders-ipc-main.ts',
  'apps/desktop/src/main/plan-reminders-main.ts',
  'apps/desktop/src/main/project-context-root.ts',
  'apps/desktop/src/main/project-root-controller.ts',
  'apps/desktop/src/main/session-entry-ipc-main.ts',
  'apps/desktop/src/main/session-branch.ts',
  'apps/desktop/src/main/sessions-ipc-main.ts',
  'apps/desktop/src/main/settings-ipc-main.ts',
  'apps/desktop/src/main/subscription-model-fetch.ts',
  'apps/desktop/src/main/subscription-ipc-main.ts',
  'apps/desktop/src/main/system-prompt-main.ts',
  'apps/desktop/src/main/usage-ipc-main.ts',
  'apps/desktop/src/main/web-search-ipc-main.ts',
  'apps/desktop/src/main/workspace-instructions-ipc-main.ts',
  'apps/desktop/src/main/workspace-resources-ipc-main.ts',
  'apps/desktop/src/main/workspace-search-ipc-main.ts',
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

/** Read just apps/desktop/src/main/main.ts. Use this for assertions that
 *  target main.ts specifically and must not be matched by another main
 *  module that the combined source folds in (e.g. the extracted resolver
 *  module's own `export async function resolveDefaultPermissionMode`). */
export async function readMainTsSource(): Promise<string> {
  return readFile(resolve(REPO_ROOT, 'apps/desktop/src/main/main.ts'), 'utf8');
}
