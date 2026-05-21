import { contextBridge, ipcRenderer } from 'electron';
import type {
  ConnectionEvent,
  ConnectionTestResult,
  CreateConnectionInput,
  AppSettings,
  BotProvider,
  LlmConnection,
  ModelDiscoveryResult,
  ModelInfo,
  PermissionResponse,
  PermissionMode,
  SettingsTestResult,
  SessionCommand,
  SessionChangedEvent,
  SessionEvent,
  SessionListFilter,
  SessionSummary,
  StoredMessage,
  UpdateConnectionInput,
  UpdateAppSettingsInput,
  UpdateAppSettingsResult,
  UsageRange,
  UsageStats,
} from '@maka/core';
import type {
  PricingConfig,
  UsageBucket,
  UsageGroupBy,
  UsageLogRow,
  UsageQuery,
  UsageSummaryV2,
} from '@maka/core/usage-stats/types';
import type { TestProxyInput } from '@maka/core/settings/network-settings';
import type { Result } from '@maka/core/settings/result';
import type { CreateSessionInput } from '@maka/core';

contextBridge.exposeInMainWorld('maka', {
  sessions: {
    list(filter?: SessionListFilter): Promise<SessionSummary[]> {
      return ipcRenderer.invoke('sessions:list', filter);
    },
    create(input?: Partial<CreateSessionInput>): Promise<SessionSummary> {
      return ipcRenderer.invoke('sessions:create', input);
    },
    send(sessionId: string, command: SessionCommand): Promise<void> {
      return ipcRenderer.invoke('sessions:send', sessionId, command);
    },
    stop(sessionId: string): Promise<void> {
      return ipcRenderer.invoke('sessions:stop', sessionId);
    },
    readMessages(sessionId: string): Promise<StoredMessage[]> {
      return ipcRenderer.invoke('sessions:readMessages', sessionId);
    },
    respondToPermission(sessionId: string, response: PermissionResponse): Promise<void> {
      return ipcRenderer.invoke('sessions:respondToPermission', sessionId, response);
    },
    subscribeEvents(sessionId: string, handler: (event: SessionEvent) => void): () => void {
      const channel = `sessions:event:${sessionId}`;
      const listener = (_event: Electron.IpcRendererEvent, payload: SessionEvent) => handler(payload);
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.off(channel, listener);
    },
    subscribeChanges(handler: (event: SessionChangedEvent) => void): () => void {
      const listener = (_event: Electron.IpcRendererEvent, payload: SessionChangedEvent) => handler(payload);
      ipcRenderer.on('sessions:changed', listener);
      return () => ipcRenderer.off('sessions:changed', listener);
    },
    archive(sessionId: string): Promise<void> {
      return ipcRenderer.invoke('sessions:archive', sessionId);
    },
    unarchive(sessionId: string): Promise<void> {
      return ipcRenderer.invoke('sessions:unarchive', sessionId);
    },
    setFlagged(sessionId: string, isFlagged: boolean): Promise<void> {
      return ipcRenderer.invoke('sessions:setFlagged', sessionId, isFlagged);
    },
    rename(sessionId: string, name: string): Promise<void> {
      return ipcRenderer.invoke('sessions:rename', sessionId, name);
    },
    setPermissionMode(sessionId: string, mode: PermissionMode): Promise<SessionSummary> {
      return ipcRenderer.invoke('sessions:setPermissionMode', sessionId, mode);
    },
    remove(sessionId: string): Promise<void> {
      return ipcRenderer.invoke('sessions:remove', sessionId);
    },
  },
  connections: {
    list(): Promise<LlmConnection[]> {
      return ipcRenderer.invoke('connections:list');
    },
    getDefault(): Promise<string | null> {
      return ipcRenderer.invoke('connections:getDefault');
    },
    setDefault(slug: string | null): Promise<void> {
      return ipcRenderer.invoke('connections:setDefault', slug);
    },
    create(input: CreateConnectionInput): Promise<LlmConnection> {
      return ipcRenderer.invoke('connections:create', input);
    },
    update(slug: string, patch: UpdateConnectionInput): Promise<LlmConnection> {
      return ipcRenderer.invoke('connections:update', slug, patch);
    },
    delete(slug: string): Promise<void> {
      return ipcRenderer.invoke('connections:delete', slug);
    },
    test(slug: string, opts?: { model?: string }): Promise<ConnectionTestResult> {
      return ipcRenderer.invoke('connections:test', slug, opts);
    },
    fetchModels(slug: string): Promise<ModelDiscoveryResult> {
      return ipcRenderer.invoke('connections:fetchModels', slug);
    },
    hasSecret(slug: string): Promise<boolean> {
      return ipcRenderer.invoke('connections:hasSecret', slug);
    },
    subscribeEvents(handler: (event: ConnectionEvent) => void): () => void {
      const listener = (_event: Electron.IpcRendererEvent, payload: ConnectionEvent) => handler(payload);
      ipcRenderer.on('connections:event', listener);
      return () => ipcRenderer.off('connections:event', listener);
    },
  },
  settings: {
    get(): Promise<AppSettings> {
      return ipcRenderer.invoke('settings:get');
    },
    update(patch: UpdateAppSettingsInput): Promise<UpdateAppSettingsResult> {
      return ipcRenderer.invoke('settings:update', patch);
    },
    testNetworkProxy(input?: TestProxyInput): Promise<SettingsTestResult> {
      return ipcRenderer.invoke('settings:testNetworkProxy', input);
    },
    testBotChannel(provider: BotProvider): Promise<SettingsTestResult> {
      return ipcRenderer.invoke('settings:testBotChannel', provider);
    },
    usageStats(range?: UsageRange): Promise<UsageStats> {
      return ipcRenderer.invoke('settings:usageStats', range);
    },
  },
  usage: {
    summary(query: UsageQuery): Promise<Result<UsageSummaryV2>> {
      return ipcRenderer.invoke('usage:summary', query);
    },
    buckets(query: UsageQuery & { groupBy: UsageGroupBy }): Promise<Result<UsageBucket[]>> {
      return ipcRenderer.invoke('usage:buckets', query);
    },
    logs(query: UsageQuery & { offset?: number; limit?: number }): Promise<Result<{ rows: UsageLogRow[]; total: number }>> {
      return ipcRenderer.invoke('usage:logs', query);
    },
    listPricing(): Promise<Result<PricingConfig[]>> {
      return ipcRenderer.invoke('usage:pricing:list');
    },
    putPricing(pricing: PricingConfig): Promise<Result<PricingConfig>> {
      return ipcRenderer.invoke('usage:pricing:put', pricing);
    },
    resetPricing(modelKey: string): Promise<Result<void>> {
      return ipcRenderer.invoke('usage:pricing:reset', modelKey);
    },
  },
  appWindow: {
    subscribeOpenSettings(handler: () => void): () => void {
      const listener = () => handler();
      ipcRenderer.on('window:openSettings', listener);
      return () => ipcRenderer.off('window:openSettings', listener);
    },
  },
  app: {
    info(): Promise<{
      appVersion: string;
      electronVersion: string;
      nodeVersion: string;
      chromeVersion: string;
      platform: string;
      arch: string;
      osRelease: string;
      workspacePath: string;
    }> {
      return ipcRenderer.invoke('app:info');
    },
    openPath(
      key: 'workspace' | 'skills',
    ): Promise<
      | { ok: true; opened: string }
      | {
          ok: false;
          reason: 'unknown-key' | 'not-allowed' | 'missing' | 'not-a-directory' | 'open-failed';
        }
    > {
      return ipcRenderer.invoke('app:openPath', key);
    },
  },
  skills: {
    list(): Promise<Array<{ id: string; name: string; description: string; path: string; declaredTools: string[] }>> {
      return ipcRenderer.invoke('skills:list');
    },
  },
});
