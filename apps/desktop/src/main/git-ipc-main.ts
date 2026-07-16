import { ipcMain } from 'electron';
import { checkoutBranch, listLocalBranches } from './git-branch.js';

export interface GitIpcDeps {
  getProjectRoot(sessionId: unknown): Promise<string>;
}

export function registerGitIpc(deps: GitIpcDeps): void {
  ipcMain.handle('app:listGitBranches', async (_event, sessionId: unknown) => {
    const projectPath = await deps.getProjectRoot(sessionId);
    return listLocalBranches(projectPath);
  });
  ipcMain.handle(
    'app:checkoutGitBranch',
    async (
      _event,
      branch: unknown,
      sessionId: unknown,
    ): Promise<{ ok: boolean; branch?: string; reason?: string; message?: string }> => {
      if (typeof branch !== 'string' || !branch) {
        return { ok: false, reason: 'failed', message: '无效的分支名' };
      }
      const projectPath = await deps.getProjectRoot(sessionId);
      return checkoutBranch(projectPath, branch);
    },
  );
}
