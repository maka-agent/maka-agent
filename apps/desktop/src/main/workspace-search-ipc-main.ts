import { ipcMain } from 'electron';
import { searchWorkspaceFiles } from './workspace-file-search.js';

export interface WorkspaceSearchIpcDeps {
  getCurrentProjectRoot: () => Promise<string>;
}

export function registerWorkspaceSearchIpc(deps: WorkspaceSearchIpcDeps): void {
  // Composer `@` mention popup: list workspace files under the same project
  // root that app:info reports. Git repos honor .gitignore + untracked via
  // `git ls-files`; other trees fall back to a bounded walk. See
  // workspace-file-search.ts.
  ipcMain.handle('workspace:searchFiles', async (_event, input: unknown) => {
    const request = (input ?? {}) as { query?: unknown; limit?: unknown };
    const projectPath = await deps.getCurrentProjectRoot();
    return searchWorkspaceFiles(projectPath, { query: request.query, limit: request.limit });
  });
}
