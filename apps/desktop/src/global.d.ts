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
  VisualSmokeState,
  ArtifactBinaryReadResult,
  ArtifactChangedEvent,
  ArtifactRecord,
  ArtifactSaveResult,
  ArtifactTextReadResult,
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
        subscribeChanges(handler: (event: SessionChangedEvent) => void): () => void;
        archive(sessionId: string): Promise<void>;
        unarchive(sessionId: string): Promise<void>;
        setFlagged(sessionId: string, isFlagged: boolean): Promise<void>;
        rename(sessionId: string, name: string): Promise<void>;
        setPermissionMode(sessionId: string, mode: PermissionMode): Promise<SessionSummary>;
        remove(sessionId: string): Promise<void>;
      };
      connections: {
        list(): Promise<LlmConnection[]>;
        getDefault(): Promise<string | null>;
        setDefault(slug: string | null): Promise<void>;
        create(input: CreateConnectionInput): Promise<LlmConnection>;
        update(slug: string, patch: UpdateConnectionInput): Promise<LlmConnection>;
        delete(slug: string): Promise<void>;
        test(slug: string, opts?: { model?: string }): Promise<ConnectionTestResult>;
        fetchModels(slug: string): Promise<ModelDiscoveryResult>;
        hasSecret(slug: string): Promise<boolean>;
        subscribeEvents(handler: (event: ConnectionEvent) => void): () => void;
      };
      settings: {
        get(): Promise<AppSettings>;
        update(patch: UpdateAppSettingsInput): Promise<UpdateAppSettingsResult>;
        testNetworkProxy(input?: TestProxyInput): Promise<SettingsTestResult>;
        testBotChannel(provider: BotProvider): Promise<SettingsTestResult>;
        usageStats(range?: UsageRange): Promise<UsageStats>;
      };
      usage: {
        summary(query: UsageQuery): Promise<Result<UsageSummaryV2>>;
        buckets(query: UsageQuery & { groupBy: UsageGroupBy }): Promise<Result<UsageBucket[]>>;
        logs(query: UsageQuery & { offset?: number; limit?: number }): Promise<Result<{ rows: UsageLogRow[]; total: number }>>;
        listPricing(): Promise<Result<PricingConfig[]>>;
        putPricing(pricing: PricingConfig): Promise<Result<PricingConfig>>;
        resetPricing(modelKey: string): Promise<Result<void>>;
      };
      appWindow: {
        subscribeOpenSettings(handler: () => void): () => void;
      };
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
        }>;
        openPath(
          key: 'workspace' | 'skills',
        ): Promise<
          | { ok: true; opened: string }
          | {
              ok: false;
              reason:
                | 'unknown-key'
                | 'not-allowed'
                | 'missing'
                | 'not-a-directory'
                | 'open-failed';
            }
        >;
        openArtifactPath(
          artifactId: string,
        ): Promise<
          | { ok: true; opened: string }
          | {
              ok: false;
              reason:
                | 'unknown-key'
                | 'not-allowed'
                | 'missing'
                | 'not-a-directory'
                | 'open-failed';
            }
        >;
        saveArtifactAs(artifactId: string): Promise<ArtifactSaveResult>;
      };
      visualSmoke: {
        getState(): Promise<VisualSmokeState | null>;
      };
      artifacts: {
        list(sessionId: string, opts?: { includeDeleted?: boolean }): Promise<ArtifactRecord[]>;
        get(artifactId: string): Promise<ArtifactRecord | null>;
        readText(artifactId: string): Promise<ArtifactTextReadResult>;
        readBinary(artifactId: string): Promise<ArtifactBinaryReadResult>;
        delete(artifactId: string): Promise<void>;
        subscribeChanges(handler: (event: ArtifactChangedEvent) => void): () => void;
      };
      skills: {
        list(): Promise<Array<{ id: string; name: string; description: string; path: string; declaredTools: string[] }>>;
      };
    };
  }
}

export {};
