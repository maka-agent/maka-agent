import { ipcMain, shell } from 'electron';
import {
  createWorkspaceInstructionFile,
  getWorkspaceInstructionsState,
  resolveWorkspaceInstructionFileForOpen,
  type WorkspaceInstructionCreateFailureReason,
  type WorkspaceInstructionOpenFailureReason,
} from './workspace-instructions.js';

export interface WorkspaceInstructionsIpcDeps {
  getCurrentProjectRoot: () => Promise<string>;
}

function workspaceInstructionOpenFailureCopy(
  reason: WorkspaceInstructionOpenFailureReason | 'open-failed',
): string {
  switch (reason) {
    case 'unknown-file':
      return '只能打开 AGENTS.md / CLAUDE.md / GEMINI.md。';
    case 'missing':
      return '项目指令文件不存在。';
    case 'blocked':
      return '项目指令文件不在当前工作区范围内。';
    case 'not-a-file':
      return '项目指令路径不是普通文件。';
    case 'open-failed':
      return '系统未能打开这个文件。';
  }
}

function workspaceInstructionCreateFailureCopy(reason: WorkspaceInstructionCreateFailureReason): string {
  switch (reason) {
    case 'unknown-file':
      return '只能创建 AGENTS.md / CLAUDE.md / GEMINI.md。';
    case 'exists':
      return '项目指令文件已经存在。';
    case 'blocked':
      return '当前工作区路径不可写或不在允许范围内。';
    case 'write-failed':
      return '写入项目指令文件失败。';
  }
}

export function registerWorkspaceInstructionsIpc(deps: WorkspaceInstructionsIpcDeps): void {
  const currentProjectRoot = deps.getCurrentProjectRoot;

  ipcMain.handle('workspaceInstructions:getState', async () => getWorkspaceInstructionsState(await currentProjectRoot()));
  ipcMain.handle(
    'workspaceInstructions:openFile',
    async (_event, file: unknown): Promise<{ ok: true } | { ok: false; message: string }> => {
      const resolved = await resolveWorkspaceInstructionFileForOpen(await currentProjectRoot(), typeof file === 'string' ? file : '');
      if (!resolved.ok) return { ok: false, message: workspaceInstructionOpenFailureCopy(resolved.reason) };
      const error = await shell.openPath(resolved.path);
      return error ? { ok: false, message: workspaceInstructionOpenFailureCopy('open-failed') } : { ok: true };
    },
  );
  ipcMain.handle(
    'workspaceInstructions:createFile',
    async (_event, file: unknown): Promise<{ ok: true } | { ok: false; message: string }> => {
      const created = await createWorkspaceInstructionFile(await currentProjectRoot(), typeof file === 'string' ? file : '');
      if (!created.ok) return { ok: false, message: workspaceInstructionCreateFailureCopy(created.reason) };
      return { ok: true };
    },
  );
}
