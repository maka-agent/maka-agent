import { contextBridge, ipcRenderer } from 'electron';
import type {
  ConnectionEvent,
  ConnectionTestResult,
  CreateConnectionInput,
  AppSettings,
  BotProvider,
  LlmConnection,
  ModelInfo,
  PermissionResponse,
  SettingsTestResult,
  SessionCommand,
  SessionEvent,
  SessionListFilter,
  SessionSummary,
  StoredMessage,
  UpdateConnectionInput,
  UpdateAppSettingsInput,
  UsageRange,
  UsageStats,
} from '@maka/core';
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
    fetchModels(slug: string): Promise<ModelInfo[]> {
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
    update(patch: UpdateAppSettingsInput): Promise<AppSettings> {
      return ipcRenderer.invoke('settings:update', patch);
    },
    testNetworkProxy(): Promise<SettingsTestResult> {
      return ipcRenderer.invoke('settings:testNetworkProxy');
    },
    testBotChannel(provider: BotProvider): Promise<SettingsTestResult> {
      return ipcRenderer.invoke('settings:testBotChannel', provider);
    },
    usageStats(range?: UsageRange): Promise<UsageStats> {
      return ipcRenderer.invoke('settings:usageStats', range);
    },
  },
  appWindow: {
    subscribeOpenSettings(handler: () => void): () => void {
      const listener = () => handler();
      ipcRenderer.on('window:openSettings', listener);
      return () => ipcRenderer.off('window:openSettings', listener);
    },
  },
});
