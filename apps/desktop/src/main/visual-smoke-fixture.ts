import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  ArtifactRecord,
  LlmConnection,
  PermissionRequestEvent,
  SessionHeader,
  StoredMessage,
  VisualSmokeScenario,
  VisualSmokeState,
} from '@maka/core';
import { createDefaultSettings } from '@maka/core/settings';
import type { CredentialStore } from './credential-store.js';

const VISUAL_SMOKE_SCENARIOS = new Set<VisualSmokeScenario>([
  'all',
  'first-run',
  'provider-workspace',
  'fallback-source',
  'fetched-empty',
  'connection-error',
  'turn-narrative',
  'artifact-pane',
  'artifact-errors',
  'streaming-sidebar',
  'permission-destructive',
  'stale-sessions',
]);

export interface VisualSmokeFixture {
  scenario: VisualSmokeScenario;
  workspaceName: string;
  /**
   * PR-IR-04: when `MAKA_VISUAL_SMOKE_REDUCED_MOTION=1` is set alongside
   * the scenario var, the renderer collapses all animations to ~0.01ms
   * via the `[data-maka-reduced-motion="true"]` CSS path. Lets the
   * screenshot pipeline capture a "reduced motion" variant for every
   * surface without depending on the host OS accessibility setting.
   */
  reducedMotion: boolean;
  /**
   * PR-IR-01: when set, the renderer auto-captures a screenshot after
   * the fixture settles. The variant name becomes the filename under
   * `<scenario>/<variant>.png`. Validated against `[a-zA-Z0-9._-]+`
   * — anything else fails closed.
   */
  autoCaptureVariant: string | null;
  /**
   * PR-IR-01b: theme override (light | dark | auto). null means "use
   * the user's persisted theme preference". Unknown values fail closed
   * to null.
   */
  theme: 'light' | 'dark' | 'auto' | null;
}

export function resolveVisualSmokeFixture(
  rawScenario: string | undefined,
  isPackaged: boolean,
  rawReducedMotion: string | undefined = undefined,
  rawAutoCaptureVariant: string | undefined = undefined,
  rawTheme: string | undefined = undefined,
): VisualSmokeFixture | null {
  if (!rawScenario) return null;
  if (isPackaged) {
    throw new Error('MAKA_VISUAL_SMOKE_FIXTURE is only available in dev/test builds.');
  }
  if (!VISUAL_SMOKE_SCENARIOS.has(rawScenario as VisualSmokeScenario)) {
    throw new Error(`Unknown MAKA_VISUAL_SMOKE_FIXTURE scenario: ${rawScenario}`);
  }
  const scenario = rawScenario as VisualSmokeScenario;
  const reducedMotion = parseReducedMotionFlag(rawReducedMotion);
  const autoCaptureVariant = parseAutoCaptureVariant(rawAutoCaptureVariant);
  const theme = parseThemeFlag(rawTheme);
  return {
    scenario,
    workspaceName: `visual-smoke-${scenario}`,
    reducedMotion,
    autoCaptureVariant,
    theme,
  };
}

/**
 * Validate the theme override. Accepts only the closed enum
 * `light | dark | auto`; everything else fails closed to null
 * (renderer falls back to the user's persisted preference).
 */
function parseThemeFlag(raw: string | undefined): 'light' | 'dark' | 'auto' | null {
  if (raw === undefined) return null;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'light' || normalized === 'dark' || normalized === 'auto') return normalized;
  return null;
}

function parseReducedMotionFlag(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

/**
 * Validate the auto-capture variant name. Must be `[a-zA-Z0-9._-]+` (no
 * slashes, no `..`, no whitespace). Fail-closed for invalid input.
 */
function parseAutoCaptureVariant(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 64) return null;
  if (!/^[a-zA-Z0-9._-]+$/.test(trimmed)) return null;
  if (trimmed === '.' || trimmed === '..') return null;
  return trimmed;
}

export function getVisualSmokeState(fixture: VisualSmokeFixture | null): VisualSmokeState | null {
  if (!fixture) return null;
  const state: VisualSmokeState = {
    enabled: true,
    scenario: fixture.scenario,
    ...(fixture.reducedMotion ? { reducedMotion: true } : {}),
    ...(fixture.autoCaptureVariant ? { autoCaptureVariant: fixture.autoCaptureVariant } : {}),
    ...(fixture.theme ? { theme: fixture.theme } : {}),
  };
  switch (fixture.scenario) {
    case 'first-run':
      return state;
    case 'provider-workspace':
      return { ...state, activeSessionId: TURN_SESSION_ID, openSettingsSection: 'models' };
    case 'fallback-source':
    case 'fetched-empty':
      return { ...state, activeSessionId: TURN_SESSION_ID, openSettingsSection: 'models' };
    case 'connection-error':
      return { ...state, activeSessionId: ERROR_SESSION_ID, openSettingsSection: 'account' };
    case 'artifact-pane':
    case 'artifact-errors':
      return { ...state, activeSessionId: ARTIFACT_SESSION_ID };
    case 'turn-narrative':
      return { ...state, activeSessionId: TURN_SESSION_ID };
    case 'streaming-sidebar':
      return {
        ...state,
        activeSessionId: TURN_SESSION_ID,
        streamingBySession: streamingState(),
        liveToolsBySession: streamingTools(),
      };
    case 'permission-destructive':
      return {
        ...state,
        activeSessionId: PERMISSION_SESSION_ID,
        permissionBySession: permissionState(),
        liveToolsBySession: permissionTools(),
      };
    case 'stale-sessions':
      // Active session intentionally a stale one — verifies the @kenji
      // gate that an active+stale row still shows the "已过期" pill
      // (active highlight must not erase the warning signal).
      return { ...state, activeSessionId: STALE_FAKE_SESSION_ID };
    case 'all':
      return {
        ...state,
        activeSessionId: TURN_SESSION_ID,
        streamingBySession: streamingState(),
        permissionBySession: permissionState(),
        liveToolsBySession: {
          ...streamingTools(),
          ...permissionTools(),
        },
      };
  }
}

export async function seedVisualSmokeFixture(input: {
  workspaceRoot: string;
  fixture: VisualSmokeFixture;
  credentialStore: Pick<CredentialStore, 'setSecret'>;
  now?: number;
}): Promise<void> {
  const now = input.now ?? Date.now();
  await rm(input.workspaceRoot, { recursive: true, force: true });
  await mkdir(input.workspaceRoot, { recursive: true });
  await writeSettings(input.workspaceRoot);
  if (input.fixture.scenario === 'first-run') return;
  await writeConnections(input.workspaceRoot, now, input.fixture.scenario);
  for (const slug of ['zai-live', 'relay-fallback', 'empty-fetched', 'needs-reauth', 'broken-provider']) {
    await input.credentialStore.setSecret(slug, 'api_key', `fixture-key-${slug}`);
  }
  await writeSession(input.workspaceRoot, turnSession(now), turnMessages(now));
  await writeSession(input.workspaceRoot, streamingSession(now), streamingMessages(now));
  await writeSession(input.workspaceRoot, permissionSession(now), permissionMessages(now));
  await writeSession(input.workspaceRoot, errorSession(now), errorMessages(now));
  await writeSession(input.workspaceRoot, artifactSession(now), artifactMessages(now));
  await writeArtifacts(input.workspaceRoot, now, input.fixture.scenario);
  // Stale-session fixture seeds three sessions reproducing the @WAWQAQ
  // workspace state that triggered the P0:
  //   - one healthy ai-sdk session (zai-live, correct slug)
  //   - one fake backend session (FakeBackend)
  //   - one legacy backend kind ('claude' with slug 'fake-claude')
  // Together with the connection list (no `fake-claude` slug present),
  // the renderer must mark the bottom two as stale + leave the first
  // alone.
  if (input.fixture.scenario === 'stale-sessions') {
    await writeSession(input.workspaceRoot, staleFakeSession(now), staleFakeMessages(now));
    await writeSession(input.workspaceRoot, staleLegacySession(now), staleLegacyMessages(now));
    await writeSession(input.workspaceRoot, healthySession(now), healthyMessages(now));
  }
}

const TURN_SESSION_ID = 'visual-smoke-turn';
const STREAMING_SESSION_ID = 'visual-smoke-streaming';
const PERMISSION_SESSION_ID = 'visual-smoke-permission';
const ERROR_SESSION_ID = 'visual-smoke-error';
const ARTIFACT_SESSION_ID = 'visual-smoke-artifact';
const STALE_FAKE_SESSION_ID = 'visual-smoke-stale-fake';
const STALE_LEGACY_SESSION_ID = 'visual-smoke-stale-legacy';
const HEALTHY_SESSION_ID = 'visual-smoke-healthy';

async function writeSettings(workspaceRoot: string): Promise<void> {
  const settings = createDefaultSettings();
  settings.personalization.displayName = '建文';
  settings.appearance.theme = 'auto';
  await writeJson(join(workspaceRoot, 'settings.json'), settings);
}

async function writeConnections(workspaceRoot: string, now: number, scenario: VisualSmokeScenario): Promise<void> {
  const connections: LlmConnection[] = [
    {
      slug: 'zai-live',
      name: 'Z.ai Live Fixture',
      providerType: 'zai-coding-plan',
      baseUrl: 'https://api.z.ai/api/coding/paas/v4',
      defaultModel: 'glm-5.1',
      enabled: true,
      models: [
        model('glm-4.5', { functionCalling: true }, 128_000),
        model('glm-4.5-air', { functionCalling: true }, 128_000),
        model('glm-4.6', { reasoning: true, functionCalling: true }, 200_000),
        model('glm-4.7', { reasoning: true, functionCalling: true }, 200_000),
        model('glm-5', { reasoning: true, functionCalling: true }, 200_000),
        model('glm-5-turbo', { reasoning: true, functionCalling: true }, 200_000),
        model('glm-5.1', { vision: true, reasoning: true, functionCalling: true }, 1_000_000),
      ],
      modelSource: 'fetched',
      modelsFetchedAt: now - 5 * 60_000,
      lastTestStatus: 'verified',
      lastTestAt: new Date(now - 4 * 60_000).toISOString(),
      lastTestMessage: 'Connection verified',
      createdAt: now - 3_600_000,
      updatedAt: now - 4 * 60_000,
    },
    {
      slug: 'relay-fallback',
      name: 'Fallback Relay Fixture',
      providerType: 'openai-compatible',
      baseUrl: 'https://relay.example.test/v1',
      defaultModel: 'relay-static-model',
      enabled: true,
      modelSource: 'fallback',
      createdAt: now - 3_500_000,
      updatedAt: now - 3_500_000,
    },
    {
      slug: 'empty-fetched',
      name: 'Fetched Empty Fixture',
      providerType: 'openai-compatible',
      baseUrl: 'https://empty.example.test/v1',
      defaultModel: 'empty-placeholder',
      enabled: true,
      models: [],
      modelSource: 'fetched',
      modelsFetchedAt: now - 15 * 60_000,
      lastTestStatus: 'verified',
      lastTestAt: new Date(now - 15 * 60_000).toISOString(),
      lastTestMessage: 'Connection verified',
      createdAt: now - 3_400_000,
      updatedAt: now - 15 * 60_000,
    },
    {
      slug: 'needs-reauth',
      name: 'Needs Reauth Fixture',
      providerType: 'anthropic',
      defaultModel: 'claude-sonnet-4-5-20250929',
      enabled: true,
      models: [model('claude-sonnet-4-5-20250929', { vision: true, reasoning: true, functionCalling: true }, 200_000)],
      modelSource: 'fetched',
      modelsFetchedAt: now - 3 * 3_600_000,
      lastTestStatus: 'needs_reauth',
      lastTestAt: new Date(now - 10 * 60_000).toISOString(),
      lastTestMessage: 'Authentication failed',
      createdAt: now - 3_300_000,
      updatedAt: now - 10 * 60_000,
    },
    {
      slug: 'broken-provider',
      name: 'Broken Provider Fixture',
      providerType: 'openai',
      defaultModel: 'gpt-4o-mini',
      enabled: true,
      models: [model('gpt-4o-mini', { vision: true, functionCalling: true }, 128_000)],
      modelSource: 'fetched',
      modelsFetchedAt: now - 4 * 3_600_000,
      lastTestStatus: 'error',
      lastTestAt: new Date(now - 8 * 60_000).toISOString(),
      lastTestMessage: 'Provider unavailable',
      createdAt: now - 3_200_000,
      updatedAt: now - 8 * 60_000,
    },
  ];
  const focusSlug = connectionFocusSlug(scenario);
  const ordered = focusSlug
    ? [
        ...connections.filter((connection) => connection.slug === focusSlug),
        ...connections.filter((connection) => connection.slug !== focusSlug),
      ]
    : connections;
  await writeJson(join(workspaceRoot, 'llm-connections.json'), {
    defaultSlug: focusSlug ?? 'zai-live',
    connections: ordered,
  });
}

function connectionFocusSlug(scenario: VisualSmokeScenario): string | null {
  switch (scenario) {
    case 'fallback-source':
      return 'relay-fallback';
    case 'fetched-empty':
      return 'empty-fetched';
    case 'connection-error':
      return 'broken-provider';
    default:
      return null;
  }
}

function model(
  id: string,
  capabilities: NonNullable<LlmConnection['models']>[number]['capabilities'],
  contextWindow: number,
): NonNullable<LlmConnection['models']>[number] {
  return { id, capabilities, contextWindow };
}

function turnSession(now: number): SessionHeader {
  return header({
    id: TURN_SESSION_ID,
    name: '模型管理与工具调用示例',
    connection: 'zai-live',
    model: 'glm-5.1',
    now,
    lastMessageAt: now - 9 * 60_000,
  });
}

function turnMessages(now: number): StoredMessage[] {
  const turnId = 'turn-fixture-1';
  return [
    { type: 'user', id: 'msg-user-1', turnId, ts: now - 10 * 60_000, text: '检查项目状态，列出需要我优先处理的风险。' },
    {
      type: 'tool_call',
      id: 'tool-status',
      turnId,
      ts: now - 9 * 60_000 - 50_000,
      toolName: 'Bash',
      displayName: '检查测试状态',
      intent: '运行测试摘要并读取失败输出',
      args: { cmd: 'npm test --workspaces --if-present', cwd: '/workspace/maka' },
    },
    {
      type: 'tool_result',
      id: 'tool-status-result',
      turnId,
      ts: now - 9 * 60_000 - 42_000,
      toolUseId: 'tool-status',
      isError: false,
      durationMs: 8_240,
      content: {
        kind: 'terminal',
        cwd: '/workspace/maka',
        cmd: 'npm test --workspaces --if-present',
        exitCode: 0,
        stdout: 'core 41 passing\nstorage 17 passing\nruntime 70 passing\ndesktop 74 passing\n',
        stderr: '',
      },
    },
    {
      type: 'tool_call',
      id: 'tool-diff',
      turnId,
      ts: now - 9 * 60_000 - 38_000,
      toolName: 'Read',
      displayName: '查看关键 diff',
      intent: '确认 ModelTable 键盘行为是否有 test gate',
      args: { path: 'apps/desktop/src/renderer/settings/model-table-keyboard.ts' },
    },
    {
      type: 'tool_result',
      id: 'tool-diff-result',
      turnId,
      ts: now - 9 * 60_000 - 34_000,
      toolUseId: 'tool-diff',
      isError: false,
      durationMs: 1_120,
      content: {
        kind: 'file_diff',
        paths: ['apps/desktop/src/renderer/settings/model-table-keyboard.ts'],
        diff: [
          'diff --git a/model-table-keyboard.ts b/model-table-keyboard.ts',
          '+export function nextRadioId(currentId, visibleIds, key) {',
          '+  if (visibleIds.length === 0) return null;',
          '+  if (key === "Home") return visibleIds[0] ?? null;',
          '-// focus-only behavior',
        ].join('\n'),
      },
    },
    {
      type: 'assistant',
      id: 'msg-assistant-1',
      turnId,
      ts: now - 9 * 60_000,
      text: '当前主线风险集中在视觉 smoke 尚未自动化、provider capability 数据还未从后端丰富。ModelTable 的 source/fetchedAt 与键盘行为已经有 test gate，可以作为下一轮截图基线。',
      thinking: {
        text: '这段是 fixture 用的模型推理草稿。它应默认折叠，并且不会进入默认复制答案路径。',
      },
      modelId: 'glm-5.1',
    },
    {
      type: 'token_usage',
      id: 'usage-1',
      turnId,
      ts: now - 9 * 60_000 + 100,
      input: 1250,
      output: 320,
      cacheRead: 180,
      costUsd: 0.0042,
    },
  ];
}

function streamingSession(now: number): SessionHeader {
  return header({
    id: STREAMING_SESSION_ID,
    name: '后台流式任务',
    connection: 'zai-live',
    model: 'glm-5',
    now,
    hasUnread: true,
    lastMessageAt: now - 2 * 60_000,
  });
}

function streamingMessages(now: number): StoredMessage[] {
  return [
    {
      type: 'user',
      id: 'stream-user',
      turnId: 'turn-streaming',
      ts: now - 2 * 60_000,
      text: '后台继续跑一轮诊断，完成后告诉我。',
    },
  ];
}

function permissionSession(now: number): SessionHeader {
  return header({
    id: PERMISSION_SESSION_ID,
    name: '危险权限确认',
    connection: 'zai-live',
    model: 'glm-5.1',
    now,
    lastMessageAt: now - 4 * 60_000,
  });
}

function permissionMessages(now: number): StoredMessage[] {
  return [
    {
      type: 'user',
      id: 'permission-user',
      turnId: 'turn-permission',
      ts: now - 4 * 60_000,
      text: '模拟一个需要 destructive 权限确认的操作，但不要真的执行。',
    },
    {
      type: 'tool_call',
      id: 'permission-tool',
      turnId: 'turn-permission',
      ts: now - 4 * 60_000 + 1_000,
      toolName: 'Bash',
      displayName: '模拟删除命令',
      intent: '触发 PermissionDialog destructive UI',
      args: { cmd: 'rm -rf ./dist', cwd: '/workspace/maka' },
    },
  ];
}

function errorSession(now: number): SessionHeader {
  return header({
    id: ERROR_SESSION_ID,
    name: '连接失败提示',
    connection: 'broken-provider',
    model: 'gpt-4o-mini',
    now,
    lastMessageAt: now - 20 * 60_000,
  });
}

function errorMessages(now: number): StoredMessage[] {
  return [
    {
      type: 'user',
      id: 'error-user',
      turnId: 'turn-error',
      ts: now - 20 * 60_000,
      text: '这条会话用于验证 chat header 的连接失败提示。',
    },
  ];
}

function artifactSession(now: number): SessionHeader {
  return header({
    id: ARTIFACT_SESSION_ID,
    name: 'Artifact Pane 验收',
    connection: 'zai-live',
    model: 'glm-5.1',
    now,
    lastMessageAt: now - 6 * 60_000,
  });
}

function artifactMessages(now: number): StoredMessage[] {
  const turnId = 'turn-artifact';
  return [
    {
      type: 'user',
      id: 'artifact-user',
      turnId,
      ts: now - 7 * 60_000,
      text: '生成一个 HTML 报告、一个 diff 和一份 Markdown 说明，放到 artifact pane 里检查。',
    },
    {
      type: 'tool_call',
      id: 'artifact-tool',
      turnId,
      ts: now - 7 * 60_000 + 1_000,
      toolName: 'Write',
      displayName: '写入 artifact fixture',
      intent: '生成 report.html / patch.diff / notes.md 三个 artifact',
      args: { path: 'artifacts/visual-smoke' },
    },
    {
      type: 'assistant',
      id: 'artifact-assistant',
      turnId,
      ts: now - 6 * 60_000,
      text: '已生成 3 个 artifact：HTML 报告、补丁 diff 和 Markdown 说明。请在右侧 Artifact pane 验证预览、大小限制与 HTML 沙箱边界。',
      modelId: 'glm-5.1',
    },
  ];
}

function header(input: {
  id: string;
  name: string;
  connection: string;
  model: string;
  now: number;
  lastMessageAt: number;
  hasUnread?: boolean;
  /**
   * Override default `backend: 'ai-sdk'`. Used by stale-sessions fixture
   * to seed FakeBackend + legacy backend kinds. SessionHeader's BackendKind
   * union allows widening via `as unknown` for legacy values like
   * 'claude' that no longer exist in the type.
   */
  backend?: SessionHeader['backend'] | 'claude';
  connectionLocked?: boolean;
}): SessionHeader {
  return {
    id: input.id,
    workspaceRoot: 'visual-smoke',
    cwd: '/workspace/maka',
    createdAt: input.now - 3_600_000,
    lastUsedAt: input.lastMessageAt,
    lastMessageAt: input.lastMessageAt,
    name: input.name,
    isFlagged: false,
    labels: [],
    isArchived: false,
    hasUnread: input.hasUnread ?? false,
    // Legacy backend kinds like 'claude' aren't in the current BackendKind
    // union but are needed for the stale-sessions reproduction. Forward
    // the value verbatim into the JSONL so the renderer sees exactly what
    // a real legacy workspace would have on disk.
    backend: (input.backend ?? 'ai-sdk') as SessionHeader['backend'],
    llmConnectionSlug: input.connection,
    connectionLocked: input.connectionLocked ?? true,
    model: input.model,
    permissionMode: 'ask',
    schemaVersion: 1,
  };
}

// Stale-sessions fixture seeds three sessions reproducing the on-disk
// state that triggered the P0 (WAWQAQ workspace had `fake-claude` +
// `backend=fake` sessions sitting next to a healthy `zai-coding-plan`
// one). Locks the @kenji active-stale pill gate (active session is
// intentionally one of the stale ones).
function staleFakeSession(now: number): SessionHeader {
  return header({
    id: STALE_FAKE_SESSION_ID,
    name: '旧的 FakeBackend 演示',
    connection: 'fake',
    model: 'fake-model',
    now,
    lastMessageAt: now - 4 * 24 * 3_600_000,
    backend: 'fake',
    connectionLocked: false,
  });
}

function staleLegacySession(now: number): SessionHeader {
  return header({
    id: STALE_LEGACY_SESSION_ID,
    name: '旧的 Claude backend 会话',
    connection: 'fake-claude',
    model: 'claude-3-sonnet',
    now,
    lastMessageAt: now - 7 * 24 * 3_600_000,
    backend: 'claude' as SessionHeader['backend'],
    connectionLocked: true,
  });
}

function healthySession(now: number): SessionHeader {
  return header({
    id: HEALTHY_SESSION_ID,
    name: '正常会话（Z.ai Live）',
    connection: 'zai-live',
    model: 'glm-5.1',
    now,
    lastMessageAt: now - 12 * 60_000,
    backend: 'ai-sdk',
  });
}

function staleFakeMessages(now: number): StoredMessage[] {
  const turnId = 'stale-fake-turn-1';
  return [
    {
      type: 'user',
      id: 'stale-fake-msg-1',
      turnId,
      ts: now - 4 * 24 * 3_600_000,
      text: '这是早期演示版会话，发送时应该会被 silent rebind。',
    },
    {
      type: 'assistant',
      id: 'stale-fake-msg-2',
      turnId,
      ts: now - 4 * 24 * 3_600_000 + 2_000,
      text: '这是 FakeBackend 的回复占位文本。',
      modelId: 'fake-model',
    },
  ];
}

function staleLegacyMessages(now: number): StoredMessage[] {
  const turnId = 'stale-legacy-turn-1';
  return [
    {
      type: 'user',
      id: 'stale-legacy-msg-1',
      turnId,
      ts: now - 7 * 24 * 3_600_000,
      text: '这是历史 Claude backend 留下的会话。slug fake-claude 已不在连接列表里。',
    },
    {
      type: 'assistant',
      id: 'stale-legacy-msg-2',
      turnId,
      ts: now - 7 * 24 * 3_600_000 + 3_000,
      text: '占位回复。',
      modelId: 'claude-3-sonnet',
    },
  ];
}

function healthyMessages(now: number): StoredMessage[] {
  const turnId = 'healthy-turn-1';
  return [
    {
      type: 'user',
      id: 'healthy-msg-1',
      turnId,
      ts: now - 12 * 60_000,
      text: '这是正常的 ai-sdk + zai-live 会话，sidebar 应该没有 "已过期" pill。',
    },
    {
      type: 'assistant',
      id: 'healthy-msg-2',
      turnId,
      ts: now - 12 * 60_000 + 1_500,
      text: 'Z.ai Live fixture 路径的占位回复。',
      modelId: 'glm-5.1',
    },
  ];
}

async function writeSession(workspaceRoot: string, session: SessionHeader, messages: StoredMessage[]): Promise<void> {
  const dir = join(workspaceRoot, 'sessions', session.id);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'session.jsonl'),
    [session, ...messages].map((entry) => JSON.stringify(entry)).join('\n') + '\n',
    'utf8',
  );
}

async function writeArtifacts(workspaceRoot: string, now: number, scenario: VisualSmokeScenario): Promise<void> {
  const root = join(workspaceRoot, 'artifacts');
  const specs: Array<{
    id: string;
    name: string;
    kind: ArtifactRecord['kind'];
    mimeType?: string;
    content: string | Uint8Array;
    status?: ArtifactRecord['status'];
    skipFile?: boolean;
  }> = [
    {
      id: 'artifact-report',
      name: 'report.html',
      kind: 'html' as const,
      mimeType: 'text/html',
      content: [
        '<!doctype html>',
        '<html lang="zh-CN">',
        '<meta charset="utf-8">',
        '<title>Maka Artifact Smoke Report</title>',
        '<style>body{font-family:system-ui;margin:24px;line-height:1.5}code{background:#eee;padding:2px 4px}</style>',
        '<h1>Artifact Pane Smoke Report</h1>',
        '<p>这个 HTML artifact 用于验证 sandboxed iframe view-only 预览。</p>',
        '<p><a href="https://example.com">外部链接应被禁用</a></p>',
        '<script>document.body.dataset.scriptRan = "true";</script>',
        '</html>',
      ].join('\n'),
    },
    {
      id: 'artifact-patch',
      name: 'patch.diff',
      kind: 'diff' as const,
      mimeType: 'text/x-diff',
      content: [
        'diff --git a/apps/desktop/src/renderer/ArtifactPane.tsx b/apps/desktop/src/renderer/ArtifactPane.tsx',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/apps/desktop/src/renderer/ArtifactPane.tsx',
        '@@ -0,0 +1,4 @@',
        '+export function ArtifactPane() {',
        '+  return <aside className="maka-artifact-pane" />;',
        '+}',
      ].join('\n'),
    },
    {
      id: 'artifact-notes',
      name: 'notes.md',
      kind: 'file' as const,
      mimeType: 'text/markdown',
      content: [
        '# Artifact Pane Notes',
        '',
        '- HTML preview is view-only.',
        '- Deleted tombstones must block reads.',
        '- Binary preview requires MIME sniff allow-list.',
      ].join('\n'),
    },
  ];
  if (scenario === 'artifact-errors') {
    specs.push(
      {
        id: 'artifact-deleted',
        name: 'deleted.md',
        kind: 'file',
        mimeType: 'text/markdown',
        content: '# Deleted artifact\n\nThis file remains on disk but reads must be blocked by tombstone.',
        status: 'deleted',
      },
      {
        id: 'artifact-unsupported',
        name: 'unsupported.bin',
        kind: 'image',
        mimeType: 'image/png',
        content: Uint8Array.from([0x00, 0x01, 0x02, 0x03]),
      },
      {
        id: 'artifact-missing',
        name: 'missing.md',
        kind: 'file',
        mimeType: 'text/markdown',
        content: '# Missing artifact',
        skipFile: true,
      },
    );
  }

  const records: ArtifactRecord[] = [];
  for (const spec of specs) {
    const relativePath = `${ARTIFACT_SESSION_ID}/${spec.id}-${spec.name}`;
    const path = join(root, relativePath);
    let sizeBytes = spec.content instanceof Uint8Array ? spec.content.byteLength : Buffer.byteLength(spec.content);
    if (!spec.skipFile) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, spec.content);
      sizeBytes = (await stat(path)).size;
    }
    records.push({
      id: spec.id,
      sessionId: ARTIFACT_SESSION_ID,
      turnId: 'turn-artifact',
      createdAt: now - 6 * 60_000 + records.length * 1_000,
      name: spec.name,
      kind: spec.kind,
      relativePath,
      sizeBytes,
      ...(spec.mimeType ? { mimeType: spec.mimeType } : {}),
      source: 'fixture',
      status: spec.status ?? 'live',
    });
  }

  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, 'metadata.jsonl'),
    records.map((record) => JSON.stringify(record)).join('\n') + '\n',
    'utf8',
  );
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function streamingState(): NonNullable<VisualSmokeState['streamingBySession']> {
  return {
    [STREAMING_SESSION_ID]: '正在检查日志、模型配置和最近的工具输出…',
  };
}

function streamingTools(): NonNullable<VisualSmokeState['liveToolsBySession']> {
  return {
    [STREAMING_SESSION_ID]: [
      {
        toolUseId: 'stream-live-tool',
        toolName: 'Bash',
        displayName: '运行中的诊断',
        intent: '模拟后台 stream 中的 tool activity',
        status: 'running',
        args: { cmd: 'npm run visual-smoke:fixture' },
      },
    ],
  };
}

function permissionState(): NonNullable<VisualSmokeState['permissionBySession']> {
  return {
    [PERMISSION_SESSION_ID]: permissionRequest(Date.now()),
  };
}

function permissionTools(): NonNullable<VisualSmokeState['liveToolsBySession']> {
  const request = permissionRequest(Date.now());
  return {
    [PERMISSION_SESSION_ID]: [
      {
        toolUseId: request.toolUseId,
        toolName: request.toolName,
        displayName: '模拟删除命令',
        intent: request.hint,
        status: 'waiting_permission',
        args: request.args,
      },
    ],
  };
}

function permissionRequest(now: number): PermissionRequestEvent {
  return {
    type: 'permission_request',
    id: 'visual-smoke-permission-event',
    turnId: 'turn-permission',
    ts: now,
    requestId: 'visual-smoke-permission-request',
    toolUseId: 'permission-tool',
    toolName: 'Bash',
    category: 'fs_destructive',
    reason: 'fs_destructive',
    args: { cmd: 'rm -rf ./dist', cwd: '/workspace/maka' },
    hint: '模拟/拦截 permission request：不要实际执行 rm。',
  };
}
