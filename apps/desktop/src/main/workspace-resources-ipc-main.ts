import { ipcMain, shell } from 'electron';
import { copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ArtifactSaveResult } from '@maka/core';
import type { HostCapabilities } from '@maka/runtime';
import { createArtifactStore, resolveArtifactPath } from '@maka/storage';
import type { createMainWindowController } from './main-window.js';
import { resolveDesktopSkillDiscoverySource } from './skill-discovery-main.js';
import {
  installBundledSkill,
  listBundledSkillCatalog,
  listSkillInventory,
  resolveDiscoveredSkillOpenPath,
  resolveSkillRepairOpenPath,
  toSkillEntry,
} from './skills.js';

type ArtifactStore = ReturnType<typeof createArtifactStore>;
type MainWindowController = ReturnType<typeof createMainWindowController>;

interface WorkspaceResourcesIpcDeps {
  workspaceRoot: string;
  skillHomeRoot?: string;
  getProjectRoot(sessionId?: string): Promise<string>;
  getSkillHost(sessionId?: string): { host: HostCapabilities; basis: 'session' | 'desktop_default' };
  artifactStore: ArtifactStore;
  mainWindowController: MainWindowController;
  sendToRenderer: MainWindowController['send'];
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

  ipcMain.handle('skills:list', async (_event, input?: { sessionId?: string }) => {
    const sessionId = typeof input?.sessionId === 'string' ? input.sessionId : undefined;
    const skillHost = deps.getSkillHost(sessionId);
    return listSkillInventory({
      workspaceRoot: deps.workspaceRoot,
      source: await resolveDesktopSkillDiscoverySource(deps, sessionId),
      host: skillHost.host,
      hostBasis: skillHost.basis,
    });
  });
  ipcMain.handle('skills:catalog:list', async () => {
    return listBundledSkillCatalog(deps.workspaceRoot);
  });
  ipcMain.handle('skills:catalog:activate', async (_event, id: string) => {
    const result = await installBundledSkill(deps.workspaceRoot, id);
    if (!result.ok) return result;
    return { ok: true as const, skill: toSkillEntry(result.skill) };
  });
  ipcMain.handle(
    'skills:openEntry',
    async (
      _event,
      input: { entryKey: string; sessionId?: string; target?: 'file' | 'directory' },
    ) => {
      const sessionId = typeof input?.sessionId === 'string' ? input.sessionId : undefined;
      const resolved = await resolveDiscoveredSkillOpenPath(
        await resolveDesktopSkillDiscoverySource(deps, sessionId),
        input?.entryKey,
        input?.target ?? 'file',
      );
      if (!resolved.ok) return resolved;
      const error = await shell.openPath(resolved.path);
      if (error) return { ok: false, reason: 'open_failed' as const };
      return { ok: true as const, target: resolved.target };
    },
  );
  ipcMain.handle(
    'skills:openRepairTarget',
    async (_event, input: { entryKey: string; sessionId?: string }) => {
      const sessionId = typeof input?.sessionId === 'string' ? input.sessionId : undefined;
      const resolved = await resolveSkillRepairOpenPath(
        await resolveDesktopSkillDiscoverySource(deps, sessionId),
        input?.entryKey,
      );
      if (!resolved.ok) return resolved;
      const error = await shell.openPath(resolved.path);
      if (error) return { ok: false, reason: 'open_failed' as const };
      return { ok: true as const, target: resolved.target };
    },
  );
}
