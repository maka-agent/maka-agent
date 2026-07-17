import type { IpcMain } from 'electron';
import type { McpConfigFile, McpServerConfig, McpServerStatus } from '@maka/core/mcp';
import type { McpClientManager } from '@maka/mcp';
import type { McpConfigStore } from '@maka/storage';

export interface McpIpcMainDeps {
  ipcMain: Pick<IpcMain, 'handle'>;
  store: McpConfigStore;
  manager: Pick<McpClientManager, 'sync' | 'statuses' | 'test' | 'reconnect'>;
  ensureReady(): Promise<void>;
  refreshIdleBackends(): Promise<void>;
  emitChanged(statuses: McpServerStatus[]): void;
}

export function registerMcpIpcMain(deps: McpIpcMainDeps): void {
  deps.ipcMain.handle('mcp:getConfig', async () => {
    await deps.ensureReady();
    return deps.store.get();
  });
  deps.ipcMain.handle('mcp:listStatuses', async () => {
    await deps.ensureReady();
    return deps.manager.statuses();
  });
  deps.ipcMain.handle('mcp:setConfig', async (_event, config: McpConfigFile) => {
    const next = await deps.store.set(config);
    await deps.manager.sync(next);
    await changed(deps);
    return next;
  });
  deps.ipcMain.handle('mcp:upsert', async (_event, serverId: string, config: McpServerConfig) => {
    const next = await deps.store.upsert(serverId, config);
    await deps.manager.sync(next);
    await changed(deps);
    return next;
  });
  deps.ipcMain.handle('mcp:remove', async (_event, serverId: string) => {
    const next = await deps.store.remove(serverId);
    await deps.manager.sync(next);
    await changed(deps);
    return next;
  });
  deps.ipcMain.handle('mcp:test', async (_event, serverId: string) => {
    await deps.ensureReady();
    const result = await deps.manager.test(serverId);
    deps.emitChanged(deps.manager.statuses());
    return result;
  });
  deps.ipcMain.handle('mcp:reconnect', async (_event, serverId: string) => {
    await deps.ensureReady();
    const result = await deps.manager.reconnect(serverId);
    await changed(deps);
    return result;
  });
}

async function changed(deps: McpIpcMainDeps): Promise<void> {
  await deps.refreshIdleBackends();
  deps.emitChanged(deps.manager.statuses());
}
