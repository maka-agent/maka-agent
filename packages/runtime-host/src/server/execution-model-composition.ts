import { randomUUID } from 'node:crypto';
import {
  AiSdkBackend,
  buildAskUserQuestionTool,
  buildAutomationToolFromService,
  buildDefaultContextBudgetPolicy,
  buildHostCapabilitiesFromBinding,
  buildLlmHistorySummarizer,
  buildPersonalizationPromptFragment,
  buildPricingLookup,
  buildProviderOptions,
  buildSessionEnvironmentPromptFragment,
  buildSkillAgentToolFromScan,
  buildSkillsPromptFragmentFromScan,
  buildSubscriptionModelFetch,
  buildTaskLedgerTools,
  buildWorkspaceInstructionsPromptFragment,
  createProviderRequestCaptureRecorder,
  createProxiedFetchTransport,
  getAIModel,
  isModelExplicitlyUnsupportedForChat,
  isOAuthSubscriptionProvider,
  loadHistoryCompactBlocksFromArtifacts,
  recordLlmCall,
  recordToolInvocation,
  resolveProjectGitInfo,
  resolveSelectedModelContextWindow,
  SKILL_TOOL_NAME,
  type AutomationToolService,
  type BackendFactoryContext,
  type GoalEvaluatorDeps,
  type MakaTool,
  type PermissionEngine,
  type ProxiedFetchProxy,
  type RuntimeCommitSink,
  type SandboxDiagnosticsProvider,
  type SkillCatalogBudgetOptions,
} from '@maka/runtime';
import type { RuntimeExecutionConnection } from '@maka/core/llm-connections';
import { resolveModelVisionSupport } from '@maka/core/model-metadata';
import type { RuntimePolicy } from '@maka/core/runtime-policy';
import type { SessionHeader } from '@maka/core/session';
import {
  filterModelVisibleTaskLedgerTasks,
  renderTaskLedgerPromptText,
} from '@maka/core/task-ledger';
import { createAttachmentByteReader, persistProviderRequestCaptureArtifact } from '@maka/storage';
import type { InteractiveArtifactStoreWriter } from '@maka/storage/artifact-stores';
import type { ExecutionSessionWriter } from '@maka/storage/execution-stores';
import {
  authenticateInteractiveTaskLedgerWriter,
  type InteractiveTaskLedgerWriterFacade,
} from '@maka/storage/task-ledger-store';
import type {
  RuntimePolicyReader,
  RuntimePolicyStoresWriter,
} from '@maka/storage/runtime-policy-stores';
import type { InteractiveUsageStoresWriter } from '@maka/storage/usage-stores';
import type { HostMemoryCoordinator } from './memory-coordinator.js';
import type { HostOAuthCoordinator } from './oauth-coordinator.js';
import type { HostSkillCatalogCoordinator } from './skill-catalog-coordinator.js';

export interface HostModelPromptContext {
  readonly sessionId: string;
  readonly cwd: string;
}

export interface HostExecutionModelComposition {
  readonly tools: MakaTool[];
  readonly systemPrompt: (context: HostModelPromptContext) => Promise<string | undefined>;
  readonly turnTailPrompt: (context: HostModelPromptContext) => Promise<string>;
}

export interface HostExecutionModelCompositionInput {
  readonly policy: Readonly<RuntimePolicyReader>;
  readonly skills: HostSkillCatalogCoordinator;
  readonly memory: HostMemoryCoordinator;
  readonly taskLedger: InteractiveTaskLedgerWriterFacade;
  readonly runtimeTools: readonly MakaTool[];
  readonly skillBudget?: SkillCatalogBudgetOptions;
  readonly platform?: NodeJS.Platform;
  readonly shell?: string;
  readonly now?: () => Date;
}

/** Fixed Host-owned model context and pure Host tools for one execution composition. */
export function createHostExecutionModelComposition(
  input: HostExecutionModelCompositionInput,
): HostExecutionModelComposition {
  const taskLedger = authenticateInteractiveTaskLedgerWriter(input.taskLedger);
  const questionTool = buildAskUserQuestionTool();
  const taskTools = buildTaskLedgerTools({ store: taskLedger });
  const hostCapabilities = buildHostCapabilitiesFromBinding([
    questionTool.name,
    SKILL_TOOL_NAME,
    ...taskTools.map((tool) => tool.name),
    ...input.runtimeTools.map((tool) => tool.name),
  ]);
  const skillTool = buildSkillAgentToolFromScan(
    () => [...input.skills.readCanonicalModelSkills()],
    hostCapabilities,
  );

  return Object.freeze({
    tools: [questionTool, skillTool, ...taskTools, ...input.runtimeTools],
    systemPrompt: async (context: HostModelPromptContext) => {
      const policy = (await input.policy.getSnapshot()).policy;
      const personalization = buildPersonalizationPromptFragment(policy.personalization).text;
      const skills = buildSkillsPromptFragmentFromScan(
        [...input.skills.readCanonicalModelSkills()],
        hostCapabilities,
        input.skillBudget,
      );
      const workspaceInstructions = policy.workspaceInstructions.enabled
        ? await buildWorkspaceInstructionsPromptFragment(context.cwd)
        : undefined;
      const memory = await input.memory.readCanonicalModelPrompt(policy);
      return joinFragments([personalization, skills, workspaceInstructions, memory]);
    },
    turnTailPrompt: async (context: HostModelPromptContext) => {
      const environment = buildSessionEnvironmentPromptFragment({
        cwd: context.cwd,
        projectGit: await resolveProjectGitInfo(context.cwd),
        ...(input.platform ? { platform: input.platform } : {}),
        ...(input.shell ? { shell: input.shell } : {}),
        ...(input.now ? { now: input.now() } : {}),
      });
      const tasks = filterModelVisibleTaskLedgerTasks(
        await taskLedger.listCanonical(context.sessionId, {
          classifyResumeTrust: true,
          includeArchived: false,
        }),
      );
      return joinFragments([environment, renderTaskLedgerTail(tasks)]) ?? environment;
    },
  });
}

export interface HostAiSdkBackendInput {
  readonly context: BackendFactoryContext;
  readonly automationService: AutomationToolService;
  readonly runtimePolicy: RuntimePolicyStoresWriter;
  readonly skills: HostSkillCatalogCoordinator;
  readonly memory: HostMemoryCoordinator;
  readonly taskLedger: InteractiveTaskLedgerWriterFacade;
  readonly artifacts: InteractiveArtifactStoreWriter;
  readonly usage: InteractiveUsageStoresWriter;
  readonly permissionEngine: PermissionEngine;
  readonly sandboxDiagnosticsProvider: SandboxDiagnosticsProvider;
  readonly runtimeTools: readonly MakaTool[];
  readonly runtimeCommitSink: RuntimeCommitSink;
  readonly oauth: HostOAuthCoordinator;
}

/** Builds the one Host-owned real model backend from canonical root state. */
export async function createHostAiSdkBackend(input: HostAiSdkBackendInput): Promise<AiSdkBackend> {
  const target = await resolveExecutionTarget({
    header: input.context.header,
    runtimePolicyOperations: input.runtimePolicy.operations,
    oauth: input.oauth,
  });
  const sandboxDiagnosticsSnapshot = await input.sandboxDiagnosticsProvider.resolve({
    mode: input.context.header.permissionMode,
    cwd: input.context.header.cwd,
  });
  const modelTransport = createProxiedFetchTransport(
    toProxySettings(target.networkProxy, target.proxySecret),
  );
  const modelFetch = buildHostModelFetch(target, input.context.sessionId, modelTransport.fetch);
  const providerOptions = buildProviderOptions(
    target.connection,
    target.model,
    input.context.header.thinkingLevel,
  );
  const modelComposition = createHostExecutionModelComposition({
    policy: input.runtimePolicy.runtimePolicy,
    skills: input.skills,
    memory: input.memory,
    taskLedger: input.taskLedger,
    runtimeTools: [
      ...input.runtimeTools,
      buildAutomationToolFromService({
        automationService: input.automationService,
        cronEnabled: true,
      }),
    ],
    skillBudget: {
      contextWindow: resolveSelectedModelContextWindow(target.connection, target.model),
    },
  });
  const modelFactory = () =>
    getAIModel({
      connection: target.connection,
      apiKey: target.apiKey,
      modelId: target.model,
      fetch: modelFetch,
    });
  const pricing = (modelKey: string) =>
    buildPricingLookup(input.usage.pricing.snapshot().overrides)(modelKey);
  const telemetry = {
    insertLlmCall: (record: Parameters<typeof input.usage.telemetry.recordLlmCall>[0]) =>
      input.usage.telemetry.recordLlmCall(record),
    insertToolInvocation: (
      record: Parameters<typeof input.usage.telemetry.recordToolInvocation>[0],
    ) => input.usage.telemetry.recordToolInvocation(record),
  };

  try {
    return new HostAiSdkBackend(
      {
        execution: input.context.execution,
        sessionId: input.context.sessionId,
        header: { ...input.context.header, model: target.model },
        appendMessage:
          input.context.appendMessage ??
          ((message) => input.context.store.appendMessage(input.context.sessionId, message)),
        connection: target.connection,
        apiKey: target.apiKey,
        modelId: target.model,
        permissionEngine: input.permissionEngine,
        modelFactory,
        tools: modelComposition.tools,
        sandboxDiagnosticsSnapshot,
        runtimeCommitSink: input.runtimeCommitSink,
        shellRunContextSummary: input.context.shellRunContextSummary,
        providerOptions,
        contextBudget: buildDefaultContextBudgetPolicy(target.connection, {
          name: 'runtime-host-default-history-budget',
          modelId: target.model,
        }),
        supportsVision: resolveModelVisionSupport(
          target.connection.providerType,
          target.connection.models,
          target.model,
        ),
        readAttachmentBytes: createAttachmentByteReader({
          artifactStore: input.artifacts,
          sessionId: input.context.sessionId,
        }),
        loadHistoryCompact: (event) =>
          loadHistoryCompactBlocksFromArtifacts(input.artifacts, event),
        loadHistoryCompactCheckpoint: input.context.loadHistoryCompactCheckpoint,
        summarizeHistoryCompact: buildLlmHistorySummarizer({
          resolveModel: modelFactory,
          providerOptions,
        }),
        recordHistoryCompactCheckpoint: input.context.recordHistoryCompactCheckpoint,
        loadTurnRuntimeEvents: input.context.loadTurnRuntimeEvents,
        recordRunTrace: input.context.recordRunTrace,
        systemPrompt: modelComposition.systemPrompt,
        turnTailPrompt: modelComposition.turnTailPrompt,
        lookupPricing: pricing,
        recordLlmCall: (event) => recordLlmCall({ repo: telemetry, lookupPricing: pricing }, event),
        recordToolInvocation: (event) => recordToolInvocation({ repo: telemetry }, event),
        ...(input.context.recordProviderRequestCapture
          ? {
              recordProviderRequestCapture: createProviderRequestCaptureRecorder({
                persistArtifact: async (capture) => {
                  const artifact = await persistProviderRequestCaptureArtifact(input.artifacts, {
                    sessionId: input.context.sessionId,
                    turnId: capture.turnId,
                    captureId: capture.captureId,
                    step: capture.step,
                    serializedRequest: capture.serializedRequest,
                    now: Date.now(),
                  });
                  return { artifactId: artifact.id };
                },
                recordLedger: input.context.recordProviderRequestCapture,
              }),
              recordProviderRequestAttempt: input.context.recordProviderRequestAttempt,
            }
          : {}),
        newId: randomUUID,
        now: Date.now,
      },
      modelTransport.close,
    );
  } catch (error) {
    await modelTransport.close();
    throw error;
  }
}

export interface HostGoalEvaluatorInput {
  readonly sessions: Pick<ExecutionSessionWriter, 'readHeader'>;
  readonly runtimePolicy: RuntimePolicyStoresWriter;
  readonly oauth: HostOAuthCoordinator;
}

export interface HostGoalEvaluator extends GoalEvaluatorDeps {
  whenCurrentPostCutEffectsSettled(): Promise<void>;
  beginDrain(): void;
  close(): Promise<void>;
}

/** Builds the Host-owned Goal judge against each Session's canonical model selection. */
export function createHostGoalEvaluator(input: HostGoalEvaluatorInput): HostGoalEvaluator {
  let admissionClosed = false;
  const targetResolutions = new Set<Promise<ResolvedExecutionTarget>>();
  return {
    async evaluate(prompt: string, sessionId: string, signal?: AbortSignal): Promise<string> {
      if (admissionClosed) throw new Error('Runtime Host Goal evaluator admission is closed');
      throwIfGoalEvaluationAborted(signal);
      const header = await input.sessions.readHeader(sessionId);
      throwIfGoalEvaluationAborted(signal);
      if (header.isArchived || header.status === 'archived') {
        throw new Error('Runtime Host cannot evaluate a Goal for an archived Session');
      }
      throwIfGoalEvaluationAborted(signal);
      const targetResolution = resolveExecutionTarget({
        header,
        runtimePolicyOperations: input.runtimePolicy.operations,
        oauth: input.oauth,
        signal,
      });
      targetResolutions.add(targetResolution);
      void targetResolution
        .finally(() => targetResolutions.delete(targetResolution))
        .catch(() => undefined);
      const target = await targetResolution;
      throwIfGoalEvaluationAborted(signal);
      const modelTransport = createProxiedFetchTransport(
        toProxySettings(target.networkProxy, target.proxySecret),
      );
      try {
        throwIfGoalEvaluationAborted(signal);
        const modelFetch = buildHostModelFetch(target, sessionId, modelTransport.fetch);
        throwIfGoalEvaluationAborted(signal);
        const ai = (await import('ai')) as unknown as {
          generateText(options: Record<string, unknown>): Promise<{ text: string }>;
        };
        throwIfGoalEvaluationAborted(signal);
        const result = await ai.generateText({
          model: getAIModel({
            connection: target.connection,
            apiKey: target.apiKey,
            modelId: target.model,
            fetch: modelFetch,
          }),
          prompt,
          providerOptions: buildProviderOptions(
            target.connection,
            target.model,
            header.thinkingLevel,
          ),
          maxOutputTokens: 1024,
          abortSignal: signal,
        });
        throwIfGoalEvaluationAborted(signal);
        return result.text;
      } finally {
        await modelTransport.close();
      }
    },
    whenCurrentPostCutEffectsSettled: async () => {
      await Promise.allSettled([...targetResolutions]);
    },
    beginDrain: () => {
      admissionClosed = true;
    },
    close: async () => {
      admissionClosed = true;
    },
  };
}

class HostAiSdkBackend extends AiSdkBackend {
  constructor(
    input: ConstructorParameters<typeof AiSdkBackend>[0],
    private readonly closeModelTransport: () => Promise<void>,
  ) {
    super(input);
  }

  override async dispose(): Promise<void> {
    try {
      await super.dispose();
    } finally {
      await this.closeModelTransport();
    }
  }
}

interface ResolvedExecutionTarget {
  readonly connection: RuntimeExecutionConnection;
  readonly model: string;
  readonly apiKey: string;
  readonly networkProxy: RuntimePolicy['networkProxy'];
  readonly proxySecret?: string;
  readonly claude?: {
    readonly deviceId: string;
    readonly accountUuid: string;
  };
}

interface ResolveExecutionTargetInput {
  readonly header: Pick<SessionHeader, 'llmConnectionSlug' | 'model'>;
  readonly runtimePolicyOperations: RuntimePolicyStoresWriter['operations'];
  readonly oauth: HostOAuthCoordinator;
  readonly signal?: AbortSignal;
}

async function resolveExecutionTarget(
  input: ResolveExecutionTargetInput,
): Promise<ResolvedExecutionTarget> {
  throwIfGoalEvaluationAborted(input.signal);
  const resolved = await input.runtimePolicyOperations.resolveExecutionConnection(
    input.header.llmConnectionSlug,
  );
  throwIfGoalEvaluationAborted(input.signal);
  if (resolved.kind !== 'ready') {
    throw new Error(`Runtime Host model connection is not ready: ${resolved.kind}`);
  }
  const model = input.header.model.trim();
  const modelInfo = resolved.connection.models.find((candidate) => candidate.id === model);
  if (!model || !resolved.connection.enabledModelIds.includes(model) || !modelInfo) {
    throw new Error('Runtime Host Session model is not enabled by its canonical connection');
  }
  if (isModelExplicitlyUnsupportedForChat(modelInfo)) {
    throw new Error('Runtime Host Session model is not chat-capable');
  }

  const connection: RuntimeExecutionConnection = {
    slug: resolved.connection.slug,
    providerType: resolved.connection.providerType,
    ...(resolved.connection.baseUrl ? { baseUrl: resolved.connection.baseUrl } : {}),
    defaultModel: model,
    models: [...resolved.connection.models],
  };
  const rawSecret = resolved.secretMaterial.connection?.secret ?? '';
  if (!isOAuthSubscriptionProvider(connection.providerType)) {
    return {
      connection,
      model,
      apiKey: rawSecret,
      networkProxy: resolved.networkProxy,
      ...(resolved.secretMaterial.networkProxy
        ? { proxySecret: resolved.secretMaterial.networkProxy.secret }
        : {}),
    };
  }

  let networkProxy = resolved.networkProxy;
  let proxySecret = resolved.secretMaterial.networkProxy?.secret;
  const credential = await input.oauth.resolveExecutionCredential({
    connectionId: resolved.connection.connectionId,
    provider: connection.providerType,
    secret: rawSecret,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const tokens = credential.tokens;
  if (credential.networkProxy) networkProxy = credential.networkProxy;
  if (credential.proxySecret !== undefined) proxySecret = credential.proxySecret;
  throwIfGoalEvaluationAborted(input.signal);

  const claude =
    connection.providerType === 'claude-subscription'
      ? requireClaudeExecutionMetadata(tokens)
      : undefined;

  return {
    connection: tokens.base_url ? { ...connection, baseUrl: tokens.base_url } : connection,
    model,
    apiKey: tokens.access_token,
    networkProxy,
    ...(proxySecret === undefined ? {} : { proxySecret }),
    ...(claude ? { claude } : {}),
  };
}

function requireClaudeExecutionMetadata(tokens: {
  readonly device_id?: string;
  readonly account_uuid?: string;
}): NonNullable<ResolvedExecutionTarget['claude']> {
  if (!tokens.device_id || !tokens.account_uuid) {
    throw new Error('Runtime Host Claude OAuth credential is missing cloak metadata');
  }
  return { deviceId: tokens.device_id, accountUuid: tokens.account_uuid };
}

function throwIfGoalEvaluationAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}

export function buildHostModelFetch(
  target: ResolvedExecutionTarget,
  sessionId: string,
  fetchFn: typeof globalThis.fetch,
): typeof globalThis.fetch {
  const claude =
    target.connection.providerType === 'claude-subscription'
      ? requireResolvedClaudeMetadata(target.claude)
      : undefined;
  return (
    buildSubscriptionModelFetch({
      connection: target.connection,
      sessionId,
      modelId: target.model,
      fetchFn,
      ...(claude
        ? {
            claude: {
              cloakEnabled: process.env.MAKA_CLAUDE_SUBSCRIPTION_CLOAK !== '0',
              ...claude,
            },
          }
        : {}),
    }) ?? fetchFn
  );
}

function requireResolvedClaudeMetadata(
  claude: ResolvedExecutionTarget['claude'],
): NonNullable<ResolvedExecutionTarget['claude']> {
  if (!claude) throw new Error('Runtime Host Claude execution target is missing cloak metadata');
  return claude;
}

function toProxySettings(
  proxy: ResolvedExecutionTarget['networkProxy'],
  password: string | undefined,
): ProxiedFetchProxy | null {
  if (!proxy.enabled) return null;
  return {
    enabled: true,
    type: proxy.protocol,
    host: proxy.host,
    port: proxy.port,
    ...(proxy.authEnabled ? { username: proxy.username, password: password ?? '' } : {}),
    bypassList: [...new Set([...proxy.bypassList, ...proxy.autoBypassDomains])],
  };
}

function renderTaskLedgerTail(
  tasks: Parameters<typeof renderTaskLedgerPromptText>[0],
): string | undefined {
  if (tasks.length === 0) return undefined;
  const rendered = renderTaskLedgerPromptText(tasks);
  if (!rendered.text) return undefined;
  return [
    'Current task ledger (current-turn context only; maintain it with task_create, task_update, task_list, and task_get):',
    '<task-ledger>',
    rendered.text,
    ...(rendered.omittedCount > 0
      ? [`omitted=${rendered.omittedCount} (use task_list/task_get for the complete ledger)`]
      : []),
    '</task-ledger>',
  ].join('\n');
}

function joinFragments(fragments: readonly (string | undefined)[]): string | undefined {
  const present = fragments.map((fragment) => fragment?.trim()).filter(Boolean) as string[];
  return present.length > 0 ? present.join('\n\n') : undefined;
}
