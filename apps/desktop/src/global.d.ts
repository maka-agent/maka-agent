import type {
  ConnectionEvent,
  ConnectionTestResult,
  CreateConnectionInput,
  AppSettings,
  BotProvider,
  HealthSnapshot,
  LlmConnection,
  ModelDiscoveryResult,
  ModelInfo,
  PermissionResponse,
  PermissionMode,
  SearchErrorReason,
  SearchRequest,
  SearchResult,
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
  BranchFromTurnInput,
  CapabilitySnapshotCollection,
  RegenerateTurnInput,
  RetryTurnInput,
  TurnRecord,
  PermissionSnapshot,
  OpenGatewayRuntimeStatus,
  LocalMemoryState,
  AuthorizationUrlPayload,
  SubscriptionAccountState,
  SubscriptionActionResult,
  PlanReminder,
  PlanReminderDeliveryTarget,
  PlanReminderRecurrence,
  DailyReviewSummary,
  WebSearchProvider,
  WebSearchResponse,
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
import type { BotStatus } from '@maka/runtime';
import type {
  OnboardingMilestone,
  OnboardingMilestoneId,
  OnboardingState,
  QuickChatMode,
} from '@maka/core';

// PR110b: shared union used by `quickChat:start`. Renderer pattern-
// matches on `ok` + `reason` to route to the correct UI surface.
//
// @xuan PR110b review: success branch is `{ ok: true; sessionId }`
// only. No turn / message anchor — PR110c will add `firstTurnId` if
// needed.
export type QuickChatResult =
  | { ok: true; sessionId: string }
  | { ok: false; reason: 'setup_required'; state: OnboardingState }
  | { ok: false; reason: 'send_failed'; message: string };

export interface OnboardingSnapshot {
  state: OnboardingState;
  milestones: OnboardingMilestone[];
}

export type WorkspaceInstructionFileStatus =
  | 'available'
  | 'missing'
  | 'blocked'
  | 'empty'
  | 'unreadable';

export interface WorkspaceInstructionFileState {
  file: string;
  status: WorkspaceInstructionFileStatus;
  chars: number;
  truncated: boolean;
}

export interface WorkspaceInstructionsState {
  files: WorkspaceInstructionFileState[];
  detectedCount: number;
  fileCharLimit: number;
  promptCharLimit: number;
}

export type TextFileImportResult =
  | { ok: true; name: string; bytes: number; files: number; truncated: boolean; prompt: string }
  | { ok: false; reason: 'cancelled' | 'missing' | 'too-large' | 'binary' | 'too-many-files' | 'read-failed'; message: string };

export type FolderOutlineImportResult =
  | { ok: true; name: string; folders: number; entries: number; truncated: boolean; prompt: string }
  | { ok: false; reason: 'cancelled' | 'missing' | 'read-failed' | 'too-many-folders' | 'empty'; message: string };

declare global {
  interface Window {
    maka: {
      sessions: {
        list(filter?: SessionListFilter): Promise<SessionSummary[]>;
        create(input?: Partial<CreateSessionInput>): Promise<SessionSummary>;
        send(sessionId: string, command: SessionCommand): Promise<void>;
        stop(sessionId: string): Promise<void>;
        readMessages(sessionId: string): Promise<StoredMessage[]>;
        listTurns(sessionId: string): Promise<TurnRecord[]>;
        retryTurn(sessionId: string, input: RetryTurnInput): Promise<void>;
        regenerateTurn(sessionId: string, input: RegenerateTurnInput): Promise<void>;
        branchFromTurn(sessionId: string, input: BranchFromTurnInput): Promise<SessionSummary>;
        respondToPermission(sessionId: string, response: PermissionResponse): Promise<void>;
        saveConversationToFile(input: {
          markdown: string;
          defaultName: string;
        }): Promise<
          { ok: true; path: string } | { ok: false; reason: 'canceled' | 'write_failed' | 'invalid_input' }
        >;
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
        bots: {
          listStatuses(): Promise<Record<BotProvider, BotStatus>>;
          restart(provider: BotProvider): Promise<BotStatus>;
          subscribeStatusChanges(handler: (status: BotStatus) => void): () => void;
        };
      };
      onboarding: {
        getSnapshot(): Promise<OnboardingSnapshot>;
        setMilestone(
          id: OnboardingMilestoneId,
          status: 'completed' | 'skipped',
        ): Promise<OnboardingSnapshot>;
        clearMilestone(id: OnboardingMilestoneId): Promise<OnboardingSnapshot>;
      };
      quickChat: {
        start(input?: { prompt?: string; mode?: QuickChatMode }): Promise<QuickChatResult>;
      };
      permissions: {
        getSnapshot(): Promise<PermissionSnapshot>;
      };
      capabilities: {
        getSnapshot(): Promise<CapabilitySnapshotCollection>;
      };
      health: {
        getSnapshot(): Promise<HealthSnapshot>;
      };
      memory: {
        getState(): Promise<LocalMemoryState>;
        save(content: string): Promise<LocalMemoryState>;
        reset(): Promise<LocalMemoryState>;
        setEnabled(enabled: boolean): Promise<LocalMemoryState>;
        setAgentReadEnabled(enabled: boolean): Promise<LocalMemoryState>;
        openFile(): Promise<{ ok: true } | { ok: false; message: string }>;
      };
      workspaceInstructions: {
        getState(): Promise<WorkspaceInstructionsState>;
        openFile(file: string): Promise<{ ok: true } | { ok: false; message: string }>;
        createFile(file: string): Promise<{ ok: true } | { ok: false; message: string }>;
      };
      context: {
        importTextFile(): Promise<TextFileImportResult>;
        importDroppedTextFiles(files: Array<{ name: string; size: number; text: string }>): Promise<TextFileImportResult>;
        importFolderOutline(): Promise<FolderOutlineImportResult>;
      };
      search: {
        thread(
          request: SearchRequest,
        ): Promise<
          | SearchResult[]
          | { ok: false; reason: SearchErrorReason; message: string }
        >;
      };
      gateway: {
        status(): Promise<OpenGatewayRuntimeStatus>;
        subscribeStatusChanges(handler: (status: OpenGatewayRuntimeStatus) => void): () => void;
      };
      claudeSubscription: {
        isExperimentalEnabled(): Promise<boolean>;
        getAuthUrl(): Promise<AuthorizationUrlPayload | SubscriptionActionResult>;
        openAuthUrl(authRequestId: string): Promise<SubscriptionActionResult>;
        completeAuthorization(
          authRequestId: string,
          pasted: string,
        ): Promise<SubscriptionActionResult>;
        cancelAuthorization(authRequestId?: string): Promise<{ ok: true }>;
        getAccountState(): Promise<SubscriptionAccountState>;
        refreshQuota(): Promise<SubscriptionActionResult>;
        refreshTokens(): Promise<SubscriptionActionResult>;
        logout(): Promise<SubscriptionActionResult>;
      };
      plans: {
        list(): Promise<PlanReminder[]>;
        create(input: { title: string; note?: string; runAt: number | string; recurrence?: PlanReminderRecurrence; cronExpression?: string; delivery?: PlanReminderDeliveryTarget }): Promise<PlanReminder>;
        update(
          id: string,
          patch: { title?: string; note?: string; runAt?: number | string; recurrence?: PlanReminderRecurrence; cronExpression?: string; delivery?: PlanReminderDeliveryTarget; enabled?: boolean },
        ): Promise<PlanReminder>;
        setEnabled(id: string, enabled: boolean): Promise<PlanReminder>;
        triggerNow(id: string): Promise<PlanReminder>;
        snooze(id: string): Promise<PlanReminder>;
        clearRunHistory(id: string): Promise<PlanReminder>;
        delete(id: string): Promise<void>;
        subscribeChanges(
          handler: (event: { type: 'plans_changed'; reason: string; reminderId?: string; ts: number }) => void,
        ): () => void;
        subscribeDue(handler: (reminder: PlanReminder) => void): () => void;
      };
      usage: {
        summary(query: UsageQuery): Promise<Result<UsageSummaryV2>>;
        buckets(query: UsageQuery & { groupBy: UsageGroupBy }): Promise<Result<UsageBucket[]>>;
        logs(query: UsageQuery & { offset?: number; limit?: number }): Promise<Result<{ rows: UsageLogRow[]; total: number }>>;
        listPricing(): Promise<Result<PricingConfig[]>>;
        putPricing(pricing: PricingConfig): Promise<Result<PricingConfig>>;
        resetPricing(modelKey: string): Promise<Result<void>>;
      };
      webSearch: {
        query(input: {
          query: string;
          limit?: number;
          provider?: WebSearchProvider;
          apiKey?: string;
        }): Promise<WebSearchResponse>;
        test(input: { provider?: WebSearchProvider; apiKey?: string }): Promise<WebSearchResponse>;
      };
      dailyReview: {
        day(offsetDays: number, daySpan?: number): Promise<Result<DailyReviewSummary>>;
        saveMarkdownToFile(input: {
          markdown: string;
          defaultName: string;
        }): Promise<
          { ok: true; path: string } | { ok: false; reason: 'canceled' | 'write_failed' | 'invalid_input' }
        >;
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
          projectPath: string;
          buildMode: 'dev' | 'packaged';
          buildCommit: string | null;
        }>;
        openPath(
          key: 'workspace' | 'skills' | 'memory' | 'project',
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
        capture(input: { scenario: string; variant: string }): Promise<
          | { ok: true; path: string }
          | {
              ok: false;
              reason:
                | 'not_in_fixture_mode'
                | 'invalid_input'
                | 'capture_failed'
                | 'write_failed';
            }
        >;
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
