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

declare global {
  interface Window {
    maka: {
      sessions: {
        list(filter?: SessionListFilter): Promise<SessionSummary[]>;
        create(input?: Partial<CreateSessionInput>): Promise<SessionSummary>;
        send(sessionId: string, command: SessionCommand): Promise<void>;
        stop(sessionId: string): Promise<void>;
        readMessages(sessionId: string): Promise<StoredMessage[]>;
        respondToPermission(sessionId: string, response: PermissionResponse): Promise<void>;
        subscribeEvents(sessionId: string, handler: (event: SessionEvent) => void): () => void;
      };
      connections: {
        list(): Promise<LlmConnection[]>;
        getDefault(): Promise<string | null>;
        setDefault(slug: string | null): Promise<void>;
        create(input: CreateConnectionInput): Promise<LlmConnection>;
        update(slug: string, patch: UpdateConnectionInput): Promise<LlmConnection>;
        delete(slug: string): Promise<void>;
        test(slug: string, opts?: { model?: string }): Promise<ConnectionTestResult>;
        fetchModels(slug: string): Promise<ModelInfo[]>;
        hasSecret(slug: string): Promise<boolean>;
        subscribeEvents(handler: (event: ConnectionEvent) => void): () => void;
      };
      settings: {
        get(): Promise<AppSettings>;
        update(patch: UpdateAppSettingsInput): Promise<AppSettings>;
        testNetworkProxy(): Promise<SettingsTestResult>;
        testBotChannel(provider: BotProvider): Promise<SettingsTestResult>;
        usageStats(range?: UsageRange): Promise<UsageStats>;
      };
      appWindow: {
        subscribeOpenSettings(handler: () => void): () => void;
      };
    };
  }
}

export {};
