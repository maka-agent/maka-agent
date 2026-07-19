import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ModelMessage } from 'ai';
import {
  AiSdkBackend,
  AutomationManager,
  AutomationScheduler,
  BackendRegistry,
  GoalManager,
  PermissionEngine,
  RuntimeReadModel,
  SessionManager,
  ShellRunProcessManager,
  applyRuntimeEventContextBudget,
  buildAutomationTool,
  buildAskUserQuestionTool,
  buildBuiltinTools,
  buildRuntimeEventModelReplayPlan,
  buildChildAgentTools,
  createBuiltinSandboxManager,
  createFilesystemWorkerLaunchSpecProvider,
  FilesystemWorkerClient,
  buildDefaultContextBudgetPolicy,
  buildSkillAgentTool,
  buildGoalTools,
  buildParentAgentTools,
  buildSubagentToolGroup,
  buildLlmHistorySummarizer,
  cleanupLegacyHistoryCompactArtifacts,
  buildProviderOptions,
  buildSubscriptionModelFetch,
  evaluateAutomationCanFire,
  getAIModel,
  generateSessionTitle as generateRuntimeSessionTitle,
  loadHistoryCompactBlocksFromArtifacts,
  replayPlanItemsToModelMessages,
  resolveSkillDiscoveryPaths,
  resolveSelectedModelContextWindow,
  type AutomationDefinition,
  type HostCapabilities,
  type MakaTool,
  type InvocationResult,
  type ShellRunUpdate,
  type SkillSource,
  type ToolAvailabilityConfig,
} from '@maka/runtime';
import {
  createAgentRunStore,
  createAttachmentByteReader,
  createArtifactStore,
  createAutomationStore,
  createConnectionStore,
  createFileCredentialStore,
  createForeignSessionStore,
  createReadImageSnapshotter,
  createRuntimeEventStore,
  createSessionStore,
  createSettingsStore,
  createShellRunStore,
  type ForeignSessionStore,
} from '@maka/storage';
import type { ToolPermissionRule } from '@maka/core/permission';
import { fetchProviderModels } from '@maka/runtime';
import { createApiKeyOnboardingSurface, type MakaOnboardingSurface } from './onboarding.js';
import { resolveModelVisionSupport } from '@maka/core';
import type { ModelChoice, ReadySessionTarget } from './connection-target.js';
import {
  listReadyModelChoices,
  resolveDefaultSessionTarget,
  resolveSessionTargetForSlug,
} from './connection-target.js';
import { buildCliSystemPrompt, buildCliTurnTailPrompt } from './cli-system-prompt.js';
import { CliGoalContinuation } from './cli-goal-continuation.js';
import { RECAP_INSTRUCTION, cleanRecapText } from './session-recap.js';

export interface MakaCliRuntimeContext {
  workspaceRoot: string;
  cwd: string;
  runtime: SessionManager;
  target: ReadySessionTarget;
  /** Selectable models across every ready connection, for the `/model` picker. */
  modelChoices: ModelChoice[];
  /** Tools passed to the backend, including TUI-only interactive and subagent tools. */
  tools: MakaTool[];
  /**
   * Explicit skill invocation surface (issue #1148): the discovery source +
   * host gate shared with the Skill tool and the system-prompt catalog, so
   * `/skill:<name>` autocomplete, highlight, and submit-time injection all
   * resolve against exactly what the host can load.
   */
  skills: MakaCliSkillSurface;
  automationManager: AutomationManager;
  automationScheduler: AutomationScheduler;
  subscribeShellRunUpdates(listener: (update: ShellRunUpdate) => void): () => void;
  listShellRunUpdates(sessionId: string): Promise<ShellRunUpdate[]>;
  goalManager: GoalManager;
  goalContinuation: CliGoalContinuation;
  /** One-sentence session recap generator (issue #1055), shared by `/recap` and idle-return auto-recap. */
  recap: SessionRecapGenerator;
  /** Read-only scanner for other agents' sessions (Claude Code, Codex), for the resume picker (#1057). */
  foreignSessions: ForeignSessionStore;
  close(): Promise<void>;
  /** API-key onboarding surface for the /setup wizard (#1098). */
  onboarding: MakaOnboardingSurface;
}

/**
 * Generates a one-sentence recap of a session so far, using a tool-free model
 * call whose exchange is never written to the session's own history. Never
 * throws — failures resolve to `{ ok: false }` so callers can surface them
 * without a try/catch.
 */
export interface SessionRecapGenerator {
  generate(
    sessionId: string,
    reason: 'manual' | 'idle',
  ): Promise<{ ok: true; text: string; raw: string } | { ok: false; error: string }>;
}

export interface CreateMakaCliRuntimeContextInput {
  surface: 'tui' | 'run';
  workspaceRoot: string;
  cwd: string;
  requestedConnectionSlug?: string;
  requestedModel?: string;
  maxSteps?: number;
  permissionRules?: readonly ToolPermissionRule[];
  /** Canonical cwd used for one resumed session without rewriting its stored header. */
  sessionCwdOverride?: { sessionId: string; cwd: string };
  runtimeInvocationObserver?: (result: InvocationResult) => void | Promise<void>;
  onSessionTitleChanged?: (sessionId: string) => void;
  /**
   * Optional cron executor. When provided, the Automation tool advertises the
   * cron kind and cron fires spawn a fresh session + run via this callback
   * (reviewer G1: a host derives cron support from the executor it passes in).
   * Omitted by the default CLI (no multi-session surface) — heartbeat only.
   */
  automationCreateFreshRun?: (
    prompt: string,
    automationId: string,
  ) => Promise<import('@maka/runtime').AutomationFireResult>;
}

export interface GetOrCreateCliClaudeDeviceIdDeps {
  newId?: () => string;
}

export interface MakaCliSkillSurface {
  /** Five-path discovery source for a session cwd (project-level paths are cwd-relative). */
  source(cwd: string): SkillSource;
  /** This host's capability surface — the same gate the Skill tool loads through. */
  host: HostCapabilities;
}

export function isMakaClaudeSubscriptionCloakEnabled(
  env: { MAKA_CLAUDE_SUBSCRIPTION_CLOAK?: string } = process.env,
): boolean {
  return env.MAKA_CLAUDE_SUBSCRIPTION_CLOAK !== '0';
}

export async function createMakaCliRuntimeContext(
  input: CreateMakaCliRuntimeContextInput,
): Promise<MakaCliRuntimeContext> {
  const store = createSessionStore(input.workspaceRoot);
  const runStore = createAgentRunStore(input.workspaceRoot);
  const runtimeEventStore = createRuntimeEventStore(input.workspaceRoot);
  const shellRunStore = createShellRunStore(input.workspaceRoot);
  const artifactStore = createArtifactStore(input.workspaceRoot);
  const connectionStore = createConnectionStore(input.workspaceRoot);
  const credentialStore = createFileCredentialStore(input.workspaceRoot);
  const settingsStore = createSettingsStore(input.workspaceRoot);
  // Read-only scanner over other agents' local session stores (~/.claude,
  // ~/.codex). Independent of the Maka workspace — takes no workspaceRoot.
  const foreignSessions = createForeignSessionStore();
  // Authoritative RuntimeEvent read model (issue #1055's session-recap
  // generator projects through this instead of re-deriving its own lossy
  // StoredMessage-based projection). Built once and shared — mirrors
  // SessionManager's own construction in session-manager.ts's readModel().
  const runtimeReadModel = new RuntimeReadModel({
    runStore,
    runtimeEventStore,
    projectionCache: store,
  });
  const targetInput = {
    connectionStore,
    credentialStore,
    requestedModel: input.requestedModel,
  };
  const target = input.requestedConnectionSlug
    ? await resolveSessionTargetForSlug(input.requestedConnectionSlug, targetInput)
    : await resolveDefaultSessionTarget(targetInput);
  const modelChoices = await listReadyModelChoices({ connectionStore, credentialStore });
  const permissionEngine = new PermissionEngine({ newId: randomUUID, now: Date.now });
  const backends = new BackendRegistry();
  const shellRunListeners = new Set<(update: ShellRunUpdate) => void>();
  const shellRuns = new ShellRunProcessManager({
    store: shellRunStore,
    newId: randomUUID,
    now: Date.now,
    onShellRunUpdate: (update) => {
      for (const listener of shellRunListeners) {
        try {
          listener(update);
        } catch {
          // One UI observer must not suppress updates for the rest.
        }
      }
    },
  });
  const sandboxManager = createBuiltinSandboxManager();
  const filesystemWorker =
    process.platform === 'darwin' && sandboxManager
      ? new FilesystemWorkerClient({
          sandboxManager,
          getLaunchSpec: createFilesystemWorkerLaunchSpecProvider({
            runtime: 'node',
            resourceLocation: { kind: 'runtime' },
          }),
        })
      : undefined;
  const tools = buildBuiltinTools({
    shellRuns,
    runtimeResources: shellRuns,
    backgroundTasks: shellRuns,
    ptyControls: shellRuns,
    snapshotImage: createReadImageSnapshotter(artifactStore),
    ...(sandboxManager ? { sandboxManager } : {}),
    ...(filesystemWorker
      ? {
          filesystemWorker,
          enableBashAdditionalPermissions: true,
          enableFileToolAdditionalPermissions: true,
        }
      : {}),
  });
  // Child sessions get fresh file-only tools. In particular, their Read tool
  // cannot inspect parent runtime resources and no write/shell/agent tool is
  // present for the catalog allowlist to select.
  const childAgentTools =
    input.surface === 'tui'
      ? buildChildAgentTools(
          buildBuiltinTools({
            snapshotImage: createReadImageSnapshotter(artifactStore),
            ...(sandboxManager ? { sandboxManager } : {}),
            ...(filesystemWorker
              ? {
                  filesystemWorker,
                  enableBashAdditionalPermissions: true,
                  enableFileToolAdditionalPermissions: true,
                }
              : {}),
          }),
        )
      : [];
  const automationManager = new AutomationManager({
    generateId: () => randomUUID(),
    now: () => Date.now(),
  });
  // Durable persistence is tied to cron capability. A cron-disabled host is
  // heartbeat-only, and heartbeats are never durable — so it has NO durable
  // automations of its own. Critically, the CLI shares the desktop's workspace
  // (resolveMakaWorkspaceRoot reconstructs the Electron userData path), so its
  // automations.json IS the desktop's. store.sync() is a full-file overwrite,
  // so a heartbeat-only CLI writing its (empty) durable list would erase the
  // desktop's crons, and loading+reconciling crons it can't run would mutate
  // them. It therefore does neither — it leaves durable state entirely to the
  // host that owns it. (Two cron-enabled hosts sharing a store is the separate,
  // still-deferred leader-lock concern.)
  const cronEnabled = input.automationCreateFreshRun !== undefined;
  const automationStore = createAutomationStore<AutomationDefinition>(input.workspaceRoot);
  // If the durable store fails to READ, we must not WRITE over it (a full sync
  // would erase unread crons). Disable persistence loudly until restart.
  let durableStoreReadable = true;
  const syncAutomations = cronEnabled
    ? (): void => {
        if (!durableStoreReadable) return;
        const durable = automationManager
          .listAll()
          .filter((a) => a.durable && (a.status === 'active' || a.status === 'paused'));
        automationStore.sync(durable).catch((err) => {
          console.warn('[runtime-bootstrap] failed to persist durable automations:', err);
        });
      }
    : (): void => {
        /* heartbeat-only host owns no durable automations; never overwrite the shared store */
      };
  const automationTool = buildAutomationTool({
    automationManager,
    onAutomationChange: syncAutomations,
    cronEnabled,
  });

  // Load durable automations only on a host that can run them — a cron-disabled
  // host must not adopt/reconcile crons it doesn't own (see above).
  if (cronEnabled) {
    try {
      const saved = await automationStore.loadAll();
      automationManager.registerAll(saved);
    } catch (err) {
      durableStoreReadable = false;
      console.error(
        '[runtime-bootstrap] durable automation store unreadable; persistence disabled to avoid data loss:',
        err,
      );
    }
  }

  const goalManager = new GoalManager({ generateId: () => randomUUID(), now: () => Date.now() });
  const goalTokenCache = new Map<string, number>();
  let runtime!: SessionManager;
  // Construct the lifecycle authority before exposing Goal tools. The runtime
  // reference is only read after context creation, when a real turn settles.
  const goalContinuation = new CliGoalContinuation({
    goalManager,
    evaluator: {
      async evaluate(prompt: string, sessionId: string): Promise<string> {
        const ai = (await import('ai')) as unknown as {
          generateText(opts: Record<string, unknown>): Promise<{ text: string }>;
        };
        const header = await store.readHeader(sessionId);
        const ready = await resolveSessionTargetForSlug(header.llmConnectionSlug, {
          connectionStore,
          credentialStore,
          requestedModel: header.model,
        });
        const modelFetch = buildSubscriptionModelFetch({
          connection: ready.connection,
          sessionId: 'goal-evaluator',
          modelId: ready.model,
          ...(ready.connection.providerType === 'claude-subscription'
            ? {
                claude: {
                  cloakEnabled: isMakaClaudeSubscriptionCloakEnabled(),
                  deviceId: await getOrCreateCliClaudeDeviceId(input.workspaceRoot),
                  accountUuid: ready.oauthTokens?.account_uuid ?? '',
                },
              }
            : {}),
        });
        const result = await ai.generateText({
          model: getAIModel({
            connection: ready.connection,
            apiKey: ready.apiKey ?? '',
            modelId: ready.model,
            fetch: modelFetch,
          }),
          prompt,
          providerOptions: buildProviderOptions(
            ready.connection,
            ready.model,
            header.thinkingLevel,
          ),
          maxOutputTokens: 1024,
        });
        return result.text;
      },
    },
    async getRecentContext(sessionId: string): Promise<string> {
      const messages = await runtime.getMessages(sessionId);
      let total = 0;
      for (const message of messages) {
        if (message.type === 'token_usage')
          total += message.total ?? message.input + message.output;
      }
      goalTokenCache.set(sessionId, total);
      return messages
        .slice(-10)
        .filter((message) => message.type === 'user' || message.type === 'assistant')
        .slice(-6)
        .map(
          (message) =>
            `[${message.type}]: ${(message.type === 'user' || message.type === 'assistant' ? message.text : '').slice(0, 500)}`,
        )
        .join('\n');
    },
    getTokenCount: (sessionId: string) => goalTokenCache.get(sessionId) ?? 0,
  });

  // One-sentence session recap (issue #1055): a tool-free model call over the
  // session's own history, never written back to it. Mirrors the goal
  // evaluator's connection resolution + call shape above.
  const recap: SessionRecapGenerator = {
    async generate(sessionId, reason) {
      let modelId = '';
      // The actual bounded request sent to the model (projection + budget trim
      // + trailing instruction), persisted verbatim to the artifact below.
      let requestMessages: ModelMessage[] = [];
      let rawText = '';
      let cleaned = '';
      let errorMessage: string | undefined;
      try {
        // Authoritative RuntimeEvent projection (issue #1182 review): reuses
        // the same read model, budget policy, and replay-plan projection the
        // backend uses for its own history, instead of re-deriving a lossy
        // StoredMessage-based one.
        const view = await runtimeReadModel.getSessionView(sessionId);
        const header = await store.readHeader(sessionId);
        const ready = await resolveSessionTargetForSlug(header.llmConnectionSlug, {
          connectionStore,
          credentialStore,
          requestedModel: header.model,
        });
        modelId = ready.model;
        const modelFetch = buildSubscriptionModelFetch({
          connection: ready.connection,
          sessionId: 'session-recap',
          modelId: ready.model,
          ...(ready.connection.providerType === 'claude-subscription'
            ? {
                claude: {
                  cloakEnabled: isMakaClaudeSubscriptionCloakEnabled(),
                  deviceId: await getOrCreateCliClaudeDeviceId(input.workspaceRoot),
                  accountUuid: ready.oauthTokens?.account_uuid ?? '',
                },
              }
            : {}),
        });
        const contextWindow = resolveSelectedModelContextWindow(ready.connection, ready.model);
        // Same budget-policy construction the backend uses (buildDefaultContextBudgetPolicy
        // + applyRuntimeEventContextBudget), with the cap overridden to the
        // recap-specific 85%-of-window-minus-4096 semantics. An unknown context
        // window skips trimming entirely rather than guessing a cap.
        let trimmedEvents = view.events;
        if (contextWindow !== undefined) {
          const budgetPolicy = buildDefaultContextBudgetPolicy(ready.connection, {
            name: 'session-recap-history-budget',
            modelId: ready.model,
          });
          if (budgetPolicy?.maxHistoryEstimatedTokens !== undefined) {
            budgetPolicy.maxHistoryEstimatedTokens = Math.floor(contextWindow * 0.85) - 4096;
          }
          trimmedEvents =
            applyRuntimeEventContextBudget(view.events, budgetPolicy)?.events ?? view.events;
        }
        const plan = buildRuntimeEventModelReplayPlan(trimmedEvents);
        requestMessages = replayPlanItemsToModelMessages(plan.items);
        requestMessages.push({ role: 'user', content: RECAP_INSTRUCTION });
        const ai = (await import('ai')) as unknown as {
          generateText(opts: Record<string, unknown>): Promise<{ text: string }>;
        };
        const result = await ai.generateText({
          model: getAIModel({
            connection: ready.connection,
            apiKey: ready.apiKey ?? '',
            modelId: ready.model,
            fetch: modelFetch,
          }),
          messages: requestMessages,
          providerOptions: buildProviderOptions(
            ready.connection,
            ready.model,
            header.thinkingLevel,
          ),
          maxOutputTokens: 1024,
        });
        rawText = result.text;
        cleaned = cleanRecapText(rawText);
        return { ok: true as const, text: cleaned, raw: rawText };
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : String(error);
        return { ok: false as const, error: errorMessage };
      } finally {
        try {
          await artifactStore.create({
            sessionId,
            turnId: randomUUID(),
            name: 'recap-request.json',
            kind: 'file',
            content: JSON.stringify(
              {
                reason,
                model: modelId,
                messageCount: requestMessages.length,
                messages: requestMessages,
                raw: rawText,
                cleaned,
                ...(errorMessage ? { error: errorMessage } : {}),
              },
              null,
              2,
            ),
            ...(cleaned ? { summary: cleaned.slice(0, 100) } : {}),
          });
        } catch {
          // Best-effort persistence; recap must work even if the artifact store fails.
        }
      }
    },
  };

  const goalTools =
    input.surface === 'tui'
      ? buildGoalTools({
          goalManager,
          goalContinuation,
          getTokenCount: (sessionId: string) => goalTokenCache.get(sessionId) ?? 0,
        })
      : [];
  const subagentTools = input.surface === 'tui' ? buildParentAgentTools() : [];
  const toolAvailability: ToolAvailabilityConfig | undefined =
    input.surface === 'tui'
      ? {
          economy: !process.env.MAKA_DISABLE_DEFERRED_TOOLS,
          groups: [buildSubagentToolGroup()],
        }
      : undefined;
  // CLI host capability surface for the skill-compatibility gate: the tool
  // names registered on this host. The CLI has no Office tools, so bundled
  // Office skills (requiredTools includes OfficeDocument/OfficeDocumentEdit)
  // are hard-hidden here without seeding them — desktop owns Office seeding.
  const surfaceTools = input.surface === 'tui' ? [buildAskUserQuestionTool()] : [];
  const host: HostCapabilities = {
    toolNames: new Set(
      [...tools, automationTool, ...goalTools, ...subagentTools, ...surfaceTools].map(
        (tool) => tool.name,
      ),
    ),
  };
  const skillTool = buildSkillAgentTool(
    ({ cwd }) => resolveSkillDiscoveryPaths(cwd, input.workspaceRoot),
    host,
  );
  const allTools = [
    ...tools,
    automationTool,
    ...goalTools,
    skillTool,
    ...subagentTools,
    ...surfaceTools,
  ];

  backends.register('ai-sdk', async (ctx) => {
    const header =
      input.sessionCwdOverride?.sessionId === ctx.sessionId
        ? { ...ctx.header, cwd: input.sessionCwdOverride.cwd }
        : ctx.header;
    // Resolve the session's own connection — not the global default — so a
    // /model switch that rebinds the session to another provider actually runs
    // on that provider (the desktop app resolves the backend the same way).
    const ready = await resolveSessionTargetForSlug(header.llmConnectionSlug, {
      connectionStore,
      credentialStore,
      requestedModel: header.model,
    });
    const modelFetch = buildSubscriptionModelFetch({
      connection: ready.connection,
      sessionId: ctx.sessionId,
      modelId: ready.model,
      ...(ready.connection.providerType === 'claude-subscription'
        ? {
            claude: {
              cloakEnabled: isMakaClaudeSubscriptionCloakEnabled(),
              deviceId: await getOrCreateCliClaudeDeviceId(input.workspaceRoot),
              accountUuid: ready.oauthTokens?.account_uuid ?? '',
            },
          }
        : {}),
    });
    return new AiSdkBackend({
      sessionId: ctx.sessionId,
      header: { ...header, model: ready.model },
      appendMessage:
        ctx.appendMessage ?? ((message) => ctx.store.appendMessage(ctx.sessionId, message)),
      connection: ready.connection,
      apiKey: ready.apiKey,
      modelId: ready.model,
      permissionEngine,
      modelFactory: (modelInput) => getAIModel({ ...modelInput, fetch: modelFetch }),
      tools: allTools,
      toolAvailability,
      ...(input.surface === 'tui'
        ? {
            spawnChildAgent: (childInput) => runtime.spawnChildAgent(ctx.sessionId, childInput),
            listChildAgents: () => runtime.listChildAgents(ctx.sessionId),
            readChildAgentOutput: (childInput) =>
              runtime.readChildAgentOutput(ctx.sessionId, childInput),
          }
        : {}),
      providerOptions: buildProviderOptions(ready.connection, ready.model, header.thinkingLevel),
      contextBudget: buildDefaultContextBudgetPolicy(ready.connection, {
        name: 'cli-default-history-budget',
        modelId: ready.model,
      }),
      supportsVision: resolveModelVisionSupport(
        ready.connection.providerType,
        ready.connection.models,
        ready.model,
      ),
      readAttachmentBytes: createAttachmentByteReader({ artifactStore, sessionId: ctx.sessionId }),
      loadHistoryCompact: (event) => loadHistoryCompactBlocksFromArtifacts(artifactStore, event),
      loadHistoryCompactCheckpoint: ctx.loadHistoryCompactCheckpoint,
      summarizeHistoryCompact: buildLlmHistorySummarizer({
        // Reuse the same connection/model the session already drives, so the
        // summary stays consistent with the model that will consume it.
        resolveModel: () =>
          getAIModel({
            connection: ready.connection,
            apiKey: ready.apiKey,
            modelId: ready.model,
            fetch: modelFetch,
          }),
        providerOptions: buildProviderOptions(ready.connection, ready.model, header.thinkingLevel),
      }),
      recordHistoryCompactCheckpoint: ctx.recordHistoryCompactCheckpoint,
      loadTurnRuntimeEvents: ctx.loadTurnRuntimeEvents,
      systemPrompt: async ({ cwd }) => {
        const settings = await settingsStore.get();
        return buildCliSystemPrompt({
          settings,
          cwd,
          workspaceRoot: input.workspaceRoot,
          host,
          modelContextWindow: resolveSelectedModelContextWindow(ready.connection, ready.model),
        });
      },
      turnTailPrompt: ({ cwd }) =>
        buildCliTurnTailPrompt({ cwd, sessionId: ctx.sessionId, automationManager, goalManager }),
      shellRunContextSummary: ctx.shellRunContextSummary,
      newId: randomUUID,
      now: Date.now,
      ...(input.maxSteps !== undefined ? { maxSteps: input.maxSteps } : {}),
      ...(input.permissionRules !== undefined ? { permissionRules: input.permissionRules } : {}),
    });
  });

  runtime = new SessionManager({
    store,
    runStore,
    runtimeEventStore,
    shellRuns,
    backends,
    ...(input.surface === 'tui' ? { childTools: childAgentTools } : {}),
    runtimeInvocationObserver: input.runtimeInvocationObserver,
    onSessionTitleChanged: input.onSessionTitleChanged,
    ...(input.surface === 'tui'
      ? {
          generateSessionTitle: async ({ sessionId, header, sourceText }) => {
            const ready = await resolveSessionTargetForSlug(header.llmConnectionSlug, {
              connectionStore,
              credentialStore,
              requestedModel: header.model,
            });
            const modelFetch = buildSubscriptionModelFetch({
              connection: ready.connection,
              sessionId,
              modelId: ready.model,
              ...(ready.connection.providerType === 'claude-subscription'
                ? {
                    claude: {
                      cloakEnabled: isMakaClaudeSubscriptionCloakEnabled(),
                      deviceId: await getOrCreateCliClaudeDeviceId(input.workspaceRoot),
                      accountUuid: ready.oauthTokens?.account_uuid ?? '',
                    },
                  }
                : {}),
            });
            return generateRuntimeSessionTitle({
              model: getAIModel({
                connection: ready.connection,
                apiKey: ready.apiKey ?? '',
                modelId: ready.model,
                fetch: modelFetch,
              }),
              providerOptions: buildProviderOptions(ready.connection, ready.model),
              sourceText,
            });
          },
        }
      : {}),
    cleanupHistoryCompactArtifacts: async (cleanupInput) => {
      await cleanupLegacyHistoryCompactArtifacts({
        ...cleanupInput,
        artifactStore,
        onDiagnostic: (diagnostic) => console.warn('[history-compact-cleanup]', diagnostic),
      });
    },
    newId: randomUUID,
    now: Date.now,
  });
  await runtime.recoverInterruptedSessions();

  const automationScheduler = new AutomationScheduler({
    automationManager,
    canFire: async (automation) => {
      if (
        automation.kind === 'heartbeat' &&
        goalContinuation.activities.whenIdle(automation.sessionId)
      ) {
        return false;
      }
      return evaluateAutomationCanFire(automation, {
        // The CLI has no incognito UI, but the setting is shared — honour it if set.
        isIncognitoActive: async () =>
          (await settingsStore.get()).privacy?.incognitoActive === true,
        readSessionHeader: (sessionId) => store.readHeader(sessionId),
        // Default idle set {active, done, waiting_for_user} — a session parked
        // waiting for the user IS the wakeup's home scenario (#639): the
        // heartbeat starts a turn in place of the user. It still never fires
        // into a 'running' (mid-turn) session.
        // Cron is disabled here (createFreshRun omitted); the scheduler ignores it.
      });
    },
    // Heartbeat: inject into the automation's session; resolve after the drain.
    // The CLI has no multi-session UI, so cron (fresh-session) is disabled —
    // createFreshRun is omitted, so the tool advertises heartbeat only.
    injectTurn: async (sessionId, prompt, automationId) => {
      const turnId = randomUUID();
      const outcome = await goalContinuation.runAutomationTurn({
        sessionId,
        turnId,
        start: () =>
          runtime.sendMessage(sessionId, {
            turnId,
            text: prompt,
            origin: { kind: 'automation', automationId },
          }),
      });
      const error =
        outcome.kind === 'errored' || outcome.kind === 'suspended'
          ? outcome.reason
          : outcome.kind === 'aborted'
            ? 'Automation turn was aborted.'
            : undefined;
      return {
        runId: turnId,
        ok: outcome.kind === 'completed',
        ...(error ? { error } : {}),
      };
    },
    createFreshRun: input.automationCreateFreshRun,
    // unref() the tick timer: a background poll must never hold the CLI
    // process open. Without this, any bootstrap consumer that exits without
    // close() (a finished one-shot run, a test) hangs on the 5s tick forever.
    setTimeout: (fn, ms) => {
      const timer = setTimeout(fn, ms);
      timer.unref?.();
      return timer;
    },
    clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    onStateChange: syncAutomations,
  });

  automationScheduler.start();

  return {
    workspaceRoot: input.workspaceRoot,
    cwd: input.cwd,
    runtime,
    target,
    modelChoices,
    tools: allTools,
    skills: {
      source: (cwd) => resolveSkillDiscoveryPaths(cwd, input.workspaceRoot),
      host,
    },
    automationManager,
    automationScheduler,
    subscribeShellRunUpdates: (listener) => {
      shellRunListeners.add(listener);
      return () => shellRunListeners.delete(listener);
    },
    listShellRunUpdates: (sessionId) => runtime.listShellRunUpdates(sessionId),
    goalManager,
    goalContinuation,
    onboarding: createApiKeyOnboardingSurface({
      connectionStore,
      credentialStore,
      fetchModels: fetchProviderModels,
    }),
    recap,
    foreignSessions,
    close: async () => {
      // Stop the automation scheduler's timer (else it keeps the process alive
      // and ticks into a stopped session), then terminate background shell runs.
      automationScheduler.dispose();
      goalContinuation.dispose();
      goalManager.dispose();
      await shellRuns.terminateAll();
      shellRunListeners.clear();
    },
  };
}

export async function getOrCreateCliClaudeDeviceId(
  workspaceRoot: string,
  deps: GetOrCreateCliClaudeDeviceIdDeps = {},
): Promise<string> {
  const deviceIdFilePath = join(workspaceRoot, '.maka_cli_claude_device_id');
  try {
    const existing = (await readFile(deviceIdFilePath, 'utf8')).trim();
    if (/^[a-f0-9]{64}$/i.test(existing)) return existing.toLowerCase();
  } catch {
    // fall through to create; device id persistence is best-effort metadata.
  }

  const next = (deps.newId ?? (() => randomBytes(32).toString('hex')))().toLowerCase();
  try {
    await mkdir(dirname(deviceIdFilePath), { recursive: true });
    await writeFile(deviceIdFilePath, next, { mode: 0o600 });
    await chmod(deviceIdFilePath, 0o600);
  } catch {
    // best-effort persistence; use the generated id for this process if disk fails.
  }
  return next;
}
