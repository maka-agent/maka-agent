import { ipcMain } from 'electron';
import { checkoutBranch, listLocalBranches } from './git-branch.js';

export interface GitIpcDeps {
  getCurrentProjectRoot: () => Promise<string>;
}

export function registerGitIpc(deps: GitIpcDeps): void {
  ipcMain.handle('app:listGitBranches', async () => {
    const projectPath = await deps.getCurrentProjectRoot();
    return listLocalBranches(projectPath);
  });
  ipcMain.handle(
    'app:checkoutGitBranch',
    async (_event, branch: unknown): Promise<{ ok: boolean; branch?: string; reason?: string; message?: string }> => {
      if (typeof branch !== 'string' || !branch) {
        return { ok: false, reason: 'failed', message: '无效的分支名' };
      }
      const projectPath = await deps.getCurrentProjectRoot();
      return checkoutBranch(projectPath, branch);
    },
  );
}
