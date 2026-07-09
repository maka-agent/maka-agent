import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app, dialog, ipcMain } from 'electron';
import type { ConnectionStore, CredentialStore, SettingsStore } from '@maka/storage';
import {
  type ConfigCategory,
  type ConnectionConflictStrategy,
  isConfigCategory,
  parseConfigBundle,
  serializeConfigBundle,
} from '@maka/storage';
import {
  applyConfigImport,
  gatherConfigExport,
  type ConfigTransferDeps,
} from './config-transfer-service.js';

export interface ConfigIpcDeps {
  connectionStore: ConnectionStore;
  settingsStore: SettingsStore;
  credentialStore: CredentialStore;
  workspaceRoot: string;
}

function sanitizeCategories(value: unknown): ConfigCategory[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(isConfigCategory))];
}

function sanitizeStrategy(value: unknown): ConnectionConflictStrategy {
  return value === 'overwrite' ? 'overwrite' : 'skip';
}

export function registerConfigIpc(deps: ConfigIpcDeps): void {
  const memoryPath = join(deps.workspaceRoot, 'MEMORY.md');
  const transferDeps: ConfigTransferDeps = {
    connectionStore: deps.connectionStore,
    settingsStore: deps.settingsStore,
    credentialStore: deps.credentialStore,
    readMemory: async () => {
      try {
        return await readFile(memoryPath, 'utf8');
      } catch {
        return null;
      }
    },
    writeMemory: async (content) => {
      await writeFile(memoryPath, content, 'utf8');
    },
    appVersion: app.getVersion(),
  };

  ipcMain.handle('config:export', async (_event, input: { categories?: unknown } = {}) => {
    const categories = sanitizeCategories(input?.categories);
    if (categories.length === 0) {
      return { ok: false as const, reason: 'no_categories' as const };
    }
    const bundle = await gatherConfigExport(categories, transferDeps);
    const today = new Date().toISOString().slice(0, 10);
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: '导出 Maka 配置',
      defaultPath: `maka-config-${today}.json`,
      filters: [{ name: 'Maka Config', extensions: ['json'] }],
    });
    if (canceled || !filePath) {
      return { ok: false as const, reason: 'canceled' as const };
    }
    await writeFile(filePath, serializeConfigBundle(bundle), 'utf8');
    return { ok: true as const, path: filePath, includedData: bundle.includedData };
  });

  ipcMain.handle('config:import', async (_event, input: { strategy?: unknown } = {}) => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: '导入 Maka 配置',
      properties: ['openFile'],
      filters: [{ name: 'Maka Config', extensions: ['json'] }],
    });
    const filePath = filePaths?.[0];
    if (canceled || !filePath) {
      return { ok: false as const, reason: 'canceled' as const };
    }
    const raw = await readFile(filePath, 'utf8');
    const parsed = parseConfigBundle(raw);
    if (!parsed.ok) {
      return { ok: false as const, reason: parsed.reason, message: parsed.message };
    }
    const result = await applyConfigImport(parsed.bundle, sanitizeStrategy(input?.strategy), transferDeps);
    return { ok: true as const, includedData: parsed.bundle.includedData, result };
  });
}
