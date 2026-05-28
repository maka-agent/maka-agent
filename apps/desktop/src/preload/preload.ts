import { contextBridge, ipcRenderer } from 'electron';
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
import type { BotStatus } from '@maka/runtime';
import type { TestProxyInput } from '@maka/core/settings/network-settings';
import type { Result } from '@maka/core/settings/result';
import type { CreateSessionInput } from '@maka/core';
import type {
  OnboardingMilestone,
  OnboardingMilestoneId,
  OnboardingState,
  QuickChatMode,
} from '@maka/core';

// PR110b: Quick Chat result discriminated union — mirrors the
// definition in main.ts. The renderer side type-checks against this
// shape so a future contract change requires updates on both sides.
//
// @xuan PR110b review: the success branch carries ONLY `sessionId`.
// No `firstMessageId` — that was a misnamed turnId in an earlier
// draft. PR110c can add `firstTurnId` if the UI ever needs a scroll
// anchor.
export type QuickChatResult =
  | { ok: true; sessionId: string }
  | { ok: false; reason: 'setup_required'; state: OnboardingState }
  | { ok: false; reason: 'send_failed'; message: string };

export interface OnboardingSnapshot {
  state: OnboardingState;
  milestones: OnboardingMilestone[];
}

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
    listTurns(sessionId: string): Promise<TurnRecord[]> {
      return ipcRenderer.invoke('sessions:listTurns', sessionId);
    },
    retryTurn(sessionId: string, input: RetryTurnInput): Promise<void> {
      return ipcRenderer.invoke('sessions:retryTurn', sessionId, input);
    },
    regenerateTurn(sessionId: string, input: RegenerateTurnInput): Promise<void> {
      return ipcRenderer.invoke('sessions:regenerateTurn', sessionId, input);
    },
    branchFromTurn(sessionId: string, input: BranchFromTurnInput): Promise<SessionSummary> {
      return ipcRenderer.invoke('sessions:branchFromTurn', sessionId, input);
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
  // PR110b: onboarding snapshot + milestone IPCs. Renderer polls
  // `getSnapshot()` on app load and re-polls when
  // `sessions:changed` / `connections:changed` / settings change
  // events fire. There is no push event for OnboardingState — it is
  // a derived projection and refresh latency is acceptable.
  onboarding: {
    getSnapshot(): Promise<OnboardingSnapshot> {
      return ipcRenderer.invoke('onboarding:getSnapshot');
    },
    setMilestone(
      id: OnboardingMilestoneId,
      status: 'completed' | 'skipped',
    ): Promise<OnboardingSnapshot> {
      return ipcRenderer.invoke('onboarding:setMilestone', id, status);
    },
  },
  quickChat: {
    /**
     * PR110b: Quick Chat entry. Input is intentionally minimal —
     * `{ prompt?: string }`. The main process always uses the
     * derived ready default and never accepts user-supplied
     * connection/model overrides at this stage (PR110c/d will add
     * model picker UI).
     */
    start(input?: { prompt?: string; mode?: QuickChatMode }): Promise<QuickChatResult> {
      return ipcRenderer.invoke('quickChat:start', input);
    },
  },
  permissions: {
    getSnapshot(): Promise<PermissionSnapshot> {
      return ipcRenderer.invoke('permissions:getSnapshot');
    },
  },
  capabilities: {
    getSnapshot(): Promise<CapabilitySnapshotCollection> {
      return ipcRenderer.invoke('capabilities:getSnapshot');
    },
  },
  health: {
    getSnapshot(): Promise<HealthSnapshot> {
      return ipcRenderer.invoke('health:getSnapshot');
    },
  },
  memory: {
    getState(): Promise<LocalMemoryState> {
      return ipcRenderer.invoke('memory:getState');
    },
    save(content: string): Promise<LocalMemoryState> {
      return ipcRenderer.invoke('memory:save', content);
    },
    reset(): Promise<LocalMemoryState> {
      return ipcRenderer.invoke('memory:reset');
    },
    setEnabled(enabled: boolean): Promise<LocalMemoryState> {
      return ipcRenderer.invoke('memory:setEnabled', enabled);
    },
    setAgentReadEnabled(enabled: boolean): Promise<LocalMemoryState> {
      return ipcRenderer.invoke('memory:setAgentReadEnabled', enabled);
    },
    openFile(): Promise<{ ok: true } | { ok: false; message: string }> {
      return ipcRenderer.invoke('memory:openFile');
    },
  },
  search: {
    // PR-SEARCH-2: local thread search. Renderer sends a `SearchRequest`
    // (source must be 'thread'); main responds with `SearchResult[]` or
    // an error envelope. The query body never leaves the device — the
    // helper is local-only and the IPC handler never emits the query
    // into telemetry.
    thread(request: SearchRequest): Promise<SearchResult[] | { ok: false; reason: SearchErrorReason; message: string }> {
      return ipcRenderer.invoke('search:thread', request);
    },
  },
  gateway: {
    status(): Promise<OpenGatewayRuntimeStatus> {
      return ipcRenderer.invoke('gateway:status');
    },
    subscribeStatusChanges(handler: (status: OpenGatewayRuntimeStatus) => void): () => void {
      const listener = (_event: Electron.IpcRendererEvent, payload: OpenGatewayRuntimeStatus) => handler(payload);
      ipcRenderer.on('gateway:statusChanged', listener);
      return () => ipcRenderer.off('gateway:statusChanged', listener);
    },
  },
  // PR-OAUTH-SUBSCRIPTION-0: Claude subscription OAuth bridge.
  // NEVER returns raw OAuth credentials; renderer only sees account
  // state + quota + action results (xuan G-X3 + the
  // claude-subscription-ipc-boundary contract test enforces this).
  //
  // kenji `1da909d5`/`45b31e16` hardening: `openAuthUrl` takes
  // ONLY an `authRequestId`; the URL is held by main from the
  // earlier `getAuthUrl` call. Renderer can never hand
  // `shell.openExternal` an arbitrary URL.
  //
  // Whole feature is gated behind `MAKA_CLAUDE_SUBSCRIPTION_EXPERIMENTAL=1`
  // until product/legal sign-off. `isExperimentalEnabled()` lets the
  // Settings UI hide the card; even without that hide, all auth-flow
  // handlers re-check the flag main-side (fail-closed via the
  // `experimental_disabled` reason).
  claudeSubscription: {
    isExperimentalEnabled(): Promise<boolean> {
      return ipcRenderer.invoke('claude-subscription:is-experimental-enabled');
    },
    getAuthUrl(): Promise<AuthorizationUrlPayload | SubscriptionActionResult> {
      return ipcRenderer.invoke('claude-subscription:get-auth-url');
    },
    openAuthUrl(authRequestId: string): Promise<SubscriptionActionResult> {
      return ipcRenderer.invoke('claude-subscription:open-auth-url', authRequestId);
    },
    completeAuthorization(authRequestId: string, pasted: string): Promise<SubscriptionActionResult> {
      return ipcRenderer.invoke('claude-subscription:complete-authorization', authRequestId, pasted);
    },
    cancelAuthorization(authRequestId?: string): Promise<{ ok: true }> {
      return ipcRenderer.invoke('claude-subscription:cancel-authorization', authRequestId);
    },
    getAccountState(): Promise<SubscriptionAccountState> {
      return ipcRenderer.invoke('claude-subscription:get-account-state');
    },
    refreshQuota(): Promise<SubscriptionActionResult> {
      return ipcRenderer.invoke('claude-subscription:refresh-quota');
    },
    refreshTokens(): Promise<SubscriptionActionResult> {
      return ipcRenderer.invoke('claude-subscription:refresh-tokens');
    },
    logout(): Promise<SubscriptionActionResult> {
      return ipcRenderer.invoke('claude-subscription:logout');
    },
  },
  plans: {
    list(): Promise<PlanReminder[]> {
      return ipcRenderer.invoke('plans:list');
    },
    create(input: { title: string; note?: string; runAt: number | string; recurrence?: PlanReminderRecurrence; delivery?: PlanReminderDeliveryTarget }): Promise<PlanReminder> {
      return ipcRenderer.invoke('plans:create', input);
    },
    update(id: string, patch: { title?: string; note?: string; runAt?: number | string; recurrence?: PlanReminderRecurrence; delivery?: PlanReminderDeliveryTarget; enabled?: boolean }): Promise<PlanReminder> {
      return ipcRenderer.invoke('plans:update', id, patch);
    },
    setEnabled(id: string, enabled: boolean): Promise<PlanReminder> {
      return ipcRenderer.invoke('plans:setEnabled', id, enabled);
    },
    delete(id: string): Promise<void> {
      return ipcRenderer.invoke('plans:delete', id);
    },
    subscribeChanges(handler: (event: { type: 'plans_changed'; reason: string; reminderId?: string; ts: number }) => void): () => void {
      const listener = (_event: Electron.IpcRendererEvent, payload: { type: 'plans_changed'; reason: string; reminderId?: string; ts: number }) => handler(payload);
      ipcRenderer.on('plans:changed', listener);
      return () => ipcRenderer.off('plans:changed', listener);
    },
    subscribeDue(handler: (reminder: PlanReminder) => void): () => void {
      const listener = (_event: Electron.IpcRendererEvent, payload: PlanReminder) => handler(payload);
      ipcRenderer.on('plans:due', listener);
      return () => ipcRenderer.off('plans:due', listener);
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
    bots: {
      listStatuses(): Promise<Record<BotProvider, BotStatus>> {
        return ipcRenderer.invoke('settings:bots:listStatuses');
      },
      restart(provider: BotProvider): Promise<BotStatus> {
        return ipcRenderer.invoke('settings:bots:restart', provider);
      },
      subscribeStatusChanges(handler: (status: BotStatus) => void): () => void {
        const listener = (_event: Electron.IpcRendererEvent, payload: BotStatus) => handler(payload);
        ipcRenderer.on('settings:bots:statusChanged', listener);
        return () => ipcRenderer.off('settings:bots:statusChanged', listener);
      },
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
  dailyReview: {
    day(offsetDays: number, daySpan?: number): Promise<Result<DailyReviewSummary>> {
      return ipcRenderer.invoke('daily-review:day', { offsetDays, daySpan });
    },
  },
  webSearch: {
    query(input: {
      query: string;
      limit?: number;
      provider?: WebSearchProvider;
      apiKey?: string;
    }): Promise<WebSearchResponse> {
      return ipcRenderer.invoke('web-search:query', input);
    },
    test(input: { provider?: WebSearchProvider; apiKey?: string }): Promise<WebSearchResponse> {
      return ipcRenderer.invoke('web-search:test', input);
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
      buildMode: 'dev' | 'packaged';
      buildCommit: string | null;
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
    openArtifactPath(
      artifactId: string,
    ): Promise<
      | { ok: true; opened: string }
      | {
          ok: false;
          reason: 'unknown-key' | 'not-allowed' | 'missing' | 'not-a-directory' | 'open-failed';
        }
    > {
      return ipcRenderer.invoke('app:openArtifactPath', artifactId);
    },
    saveArtifactAs(artifactId: string): Promise<ArtifactSaveResult> {
      return ipcRenderer.invoke('app:saveArtifactAs', artifactId);
    },
  },
  visualSmoke: {
    getState(): Promise<VisualSmokeState | null> {
      return ipcRenderer.invoke('visualSmoke:getState');
    },
    /**
     * PR-IR-01: capture a screenshot of the renderer to disk. Only
     * works in fixture mode (refuses otherwise). The capture script
     * drives this from outside Electron via the test runner — renderer
     * code doesn't normally call it.
     */
    capture(input: { scenario: string; variant: string }): Promise<
      | { ok: true; path: string }
      | { ok: false; reason: 'not_in_fixture_mode' | 'invalid_input' | 'capture_failed' | 'write_failed' }
    > {
      return ipcRenderer.invoke('visualSmoke:capture', input);
    },
  },
  artifacts: {
    list(sessionId: string, opts?: { includeDeleted?: boolean }): Promise<ArtifactRecord[]> {
      return ipcRenderer.invoke('artifacts:list', sessionId, opts);
    },
    get(artifactId: string): Promise<ArtifactRecord | null> {
      return ipcRenderer.invoke('artifacts:get', artifactId);
    },
    readText(artifactId: string): Promise<ArtifactTextReadResult> {
      return ipcRenderer.invoke('artifacts:readText', artifactId);
    },
    readBinary(artifactId: string): Promise<ArtifactBinaryReadResult> {
      return ipcRenderer.invoke('artifacts:readBinary', artifactId);
    },
    delete(artifactId: string): Promise<void> {
      return ipcRenderer.invoke('artifacts:delete', artifactId);
    },
    subscribeChanges(handler: (event: ArtifactChangedEvent) => void): () => void {
      const listener = (_event: Electron.IpcRendererEvent, payload: ArtifactChangedEvent) => handler(payload);
      ipcRenderer.on('artifacts:changed', listener);
      return () => ipcRenderer.off('artifacts:changed', listener);
    },
  },
  skills: {
    list(): Promise<Array<{ id: string; name: string; description: string; path: string; declaredTools: string[] }>> {
      return ipcRenderer.invoke('skills:list');
    },
  },
});
