import { ipcMain, shell } from 'electron';
import { copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ArtifactSaveResult } from '@maka/core';
import { createArtifactStore, resolveArtifactPath } from '@maka/storage';
import type { createMainWindowController } from './main-window.js';
import {
  createStarterSkill,
  listSkillEntries,
  resolveSkillOpenPath,
  toSkillEntry,
} from './skills.js';

type ArtifactStore = ReturnType<typeof createArtifactStore>;
type MainWindowController = ReturnType<typeof createMainWindowController>;

interface WorkspaceResourcesIpcDeps {
  workspaceRoot: string;
  artifactStore: ArtifactStore;
  mainWindowController: MainWindowController;
  sendToRenderer: MainWindowController['send'];
  /**
   * Resolves once background startup has finished copying the bundled
   * Office skills into the workspace (#456 moved that off the
   * first-paint path). skills:list awaits it so an early Skills-page
   * open cannot observe a half-bundled list. Already-settled after
   * startup, so steady-state reads pay nothing.
   */
  bundledSkillsReady?: Promise<unknown>;
}

export function registerWorkspaceResourcesIpc(deps: WorkspaceResourcesIpcDeps): void {
  ipcMain.handle(
    'app:openArtifactPath',
    async (
      _event,
      artifactId: string,
    ): Promise<
      | { ok: true; opened: string }
      | {
          ok: false;
          reason: 'unknown-key' | 'not-allowed' | 'missing' | 'not-a-directory' | 'open-failed';
        }
    > => {
      const record = await deps.artifactStore.get(artifactId);
      if (!record) return { ok: false, reason: 'missing' };
      if (record.status === 'deleted') return { ok: false, reason: 'missing' };
      const artifactRoot = join(deps.workspaceRoot, 'artifacts');
      const resolved = await resolveArtifactPath({
        artifactRoot,
        relativePath: record.relativePath,
      });
      if (!resolved.ok) {
        if (resolved.reason === 'not_allowed') return { ok: false, reason: 'not-allowed' };
        return { ok: false, reason: 'missing' };
      }
      shell.showItemInFolder(resolved.path);
      return { ok: true, opened: record.name };
    },
  );

  ipcMain.handle('app:saveArtifactAs', async (_event, artifactId: string): Promise<ArtifactSaveResult> => {
    const record = await deps.artifactStore.get(artifactId);
    if (!record) return { ok: false, reason: 'not_found' };
    if (record.status === 'deleted') return { ok: false, reason: 'deleted' };
    const resolved = await resolveArtifactPath({
      artifactRoot: join(deps.workspaceRoot, 'artifacts'),
      relativePath: record.relativePath,
    });
    if (!resolved.ok) {
      if (resolved.reason === 'not_allowed') return { ok: false, reason: 'not_allowed' };
      return { ok: false, reason: 'not_found' };
    }
    const result = await deps.mainWindowController.showSaveDialog({
      title: `另存为 ${record.name}`,
      defaultPath: record.name,
    });
    if (result.canceled || !result.filePath) return { ok: false, reason: 'canceled' };
    try {
      await copyFile(resolved.path, result.filePath);
      return { ok: true, saved: record.name };
    } catch {
      return { ok: false, reason: 'write_failed' };
    }
  });

  ipcMain.handle('artifacts:list', (_event, sessionId: string, opts?: { includeDeleted?: boolean }) =>
    deps.artifactStore.list(sessionId, opts),
  );
  ipcMain.handle('artifacts:get', (_event, artifactId: string) => deps.artifactStore.get(artifactId));
  ipcMain.handle('artifacts:readText', (_event, artifactId: string) => deps.artifactStore.readText(artifactId));
  ipcMain.handle('artifacts:readBinary', (_event, artifactId: string) => deps.artifactStore.readBinary(artifactId));
  ipcMain.handle('artifacts:delete', async (_event, artifactId: string) => {
    await deps.artifactStore.delete(artifactId);
    const artifact = await deps.artifactStore.get(artifactId);
    if (artifact) {
      deps.sendToRenderer('artifacts:changed', {
        reason: 'deleted',
        artifactId,
        sessionId: artifact.sessionId,
        ts: Date.now(),
      });
    }
  });

  ipcMain.handle('skills:list', async () => {
    await deps.bundledSkillsReady?.catch(() => {});
    return listSkillEntries(deps.workspaceRoot);
  });
  ipcMain.handle('skills:createStarter', async () => {
    const result = await createStarterSkill(deps.workspaceRoot);
    if (!result.ok) return result;
    return { ok: true as const, skill: toSkillEntry(result.skill), filePath: result.filePath };
  });
  ipcMain.handle('skills:open', async (_event, id: string, target: 'file' | 'directory' = 'file') => {
    const resolved = await resolveSkillOpenPath(deps.workspaceRoot, id, target);
    if (!resolved.ok) return resolved;
    const error = await shell.openPath(resolved.path);
    if (error) return { ok: false, reason: 'open_failed' as const };
    return { ok: true as const, target: resolved.target };
  });
}
