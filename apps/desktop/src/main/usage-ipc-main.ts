import { ipcMain } from 'electron';
import type { UsageRange } from '@maka/core';
import type {
  UsageGroupBy,
  UsageQuery,
} from '@maka/core/usage-stats/types';
import {
  normalizePricingConfig,
  normalizePricingModelKey,
} from '@maka/core/usage-stats/pricing';
import { tryResult } from '@maka/core/result';
import type { createSettingsStore, createTelemetryRepo } from '@maka/storage';
import type { createMainWindowController } from './main-window.js';

type SettingsStore = ReturnType<typeof createSettingsStore>;
type TelemetryRepo = ReturnType<typeof createTelemetryRepo>;
type MainWindowController = ReturnType<typeof createMainWindowController>;

interface UsageIpcDeps {
  settingsStore: SettingsStore;
  telemetryRepo: TelemetryRepo;
  refreshPricingLookup: () => void;
  sendToRenderer: MainWindowController['send'];
}

export function registerUsageIpc(deps: UsageIpcDeps): void {
  ipcMain.handle('settings:usageStats', (_event, range?: UsageRange) =>
    deps.settingsStore.usageStats(range),
  );
  ipcMain.handle('usage:summary', (_event, query: UsageQuery) =>
    tryResult(async () => deps.telemetryRepo.summary(query), 'USAGE_SUMMARY_FAILED'),
  );
  ipcMain.handle('usage:buckets', (_event, query: UsageQuery & { groupBy: UsageGroupBy }) =>
    tryResult(async () => deps.telemetryRepo.buckets(query, query.groupBy), 'USAGE_BUCKETS_FAILED'),
  );
  ipcMain.handle('usage:logs', (_event, query: UsageQuery & { offset?: number; limit?: number }) =>
    tryResult(async () => deps.telemetryRepo.logs(query, query.offset, query.limit), 'USAGE_LOGS_FAILED'),
  );
  ipcMain.handle('usage:pricing:list', () =>
    tryResult(async () => deps.telemetryRepo.listPricingOverrides(), 'USAGE_PRICING_LIST_FAILED'),
  );
  ipcMain.handle('usage:pricing:put', (_event, pricing: unknown) =>
    tryResult(async () => {
      const normalized = normalizePricingConfig(pricing);
      if (!normalized.ok) {
        throw new Error(normalized.error);
      }
      await deps.telemetryRepo.upsertPricing(normalized.value);
      deps.refreshPricingLookup();
      deps.sendToRenderer('usage:pricing:changed');
      return normalized.value;
    }, 'USAGE_PRICING_PUT_FAILED'),
  );
  ipcMain.handle('usage:pricing:reset', (_event, modelKey: unknown) =>
    tryResult(async () => {
      const keyResult = normalizePricingModelKey(modelKey);
      if (!keyResult.ok) {
        throw new Error(keyResult.error);
      }
      await deps.telemetryRepo.deletePricing(keyResult.value);
      deps.refreshPricingLookup();
      deps.sendToRenderer('usage:pricing:changed');
    }, 'USAGE_PRICING_RESET_FAILED'),
  );
}
