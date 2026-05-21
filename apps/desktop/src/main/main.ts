import { app, BrowserWindow, ipcMain, Menu, screen, shell } from 'electron';
import { isExternalUrl } from './external-link-guard.js';
import { readSavedBounds, writeSavedBounds, type SavedBounds } from './window-state.js';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { release as osRelease, arch as osArch } from 'node:os';
import {
  generalizedErrorMessage,
  isPermissionMode,
} from '@maka/core';
import type {
  AppSettings,
  BotProvider,
  ConnectionEvent,
  CreateConnectionInput,
  CreateSessionInput,
  SessionCommand,
  SessionChangedEvent,
  SessionChangedReason,
  SessionEvent,
  SessionListFilter,
  SettingsTestResult,
  UpdateAppSettingsResult,
  UpdateConnectionInput,
  UpdateAppSettingsInput,
  UsageRange,
} from '@maka/core';
import type {
  PricingConfig,
  UsageGroupBy,
  UsageQuery,
} from '@maka/core/usage-stats/types';
import type {
  NetworkSettings as ContractNetworkSettings,
  ProxySettings,
  TestProxyInput,
} from '@maka/core/settings/network-settings';
import {
  NETWORK_DEFAULTS,
  SENSITIVE_PLACEHOLDER,
  applySensitivePatch,
  maskSensitive,
} from '@maka/core/settings/network-settings';
import { tryResult, type Result } from '@maka/core/settings/result';
import {
  AiSdkBackend,
  BackendRegistry,
  FakeBackend,
  PermissionEngine,
  SessionManager,
  buildBuiltinTools,
  fetchProviderModels,
  getAIModel,
  recordLlmCall,
  recordToolInvocation,
  buildPricingLookup,
  BotRegistry,
  testBotChannel as testRuntimeBotChannel,
  setActiveProxy,
  testConnection,
} from '@maka/runtime';
import { testProxyConnection } from '@maka/runtime/network/proxy-test';
import { PROVIDER_DEFAULTS } from '@maka/core/llm-connections';
import { createConnectionStore, createSessionStore, createSettingsStore, createTelemetryRepo } from '@maka/storage';
import {
  assertSessionCanSend as assertHeaderCanSend,
  errorCode,
  errorMessage,
  requireReadyConnection,
} from './chat-readiness.js';
import { createSafeStorageCredentialStore } from './credential-store.js';
import { connectionTestStatusPatch } from './connection-test-status.js';
import { resolveOpenPath, type OpenPathResult } from './open-path-guard.js';
import { buildPersonalizationPromptFragment } from './personalization-prompt.js';
import { buildSettingsUpdateResult, maskAppSettings, preserveSensitivePlaceholders, toSettingsTestResult } from './settings-ipc-helpers.js';
import {
  getVisualSmokeState,
  resolveVisualSmokeFixture,
  seedVisualSmokeFixture,
} from './visual-smoke-fixture.js';

const visualSmokeFixture = resolveVisualSmokeFixture(process.env.MAKA_VISUAL_SMOKE_FIXTURE, app.isPackaged);
const workspaceRoot = join(app.getPath('userData'), 'workspaces', visualSmokeFixture?.workspaceName ?? 'default');
const store = createSessionStore(workspaceRoot);
const connectionStore = createConnectionStore(workspaceRoot);
const settingsStore = createSettingsStore(workspaceRoot);
const telemetryRepo = createTelemetryRepo(workspaceRoot);
const credentialStore = createSafeStorageCredentialStore(workspaceRoot);
const backends = new BackendRegistry();
const permissionEngine = new PermissionEngine({ newId: randomUUID, now: Date.now });
const builtinTools = buildBuiltinTools().filter((tool) => tool.name !== 'Edit');
let lookupPricing = buildPricingLookup();
const botRegistry = new BotRegistry({
  onIncomingMessage: (message) => {
    // Only log incoming bot messages in dev — production stdout leaking
    // platform + chatId is operational noise at best and a small privacy
    // signal at worst (which bridges are connected, with what frequency).
    if (process.env.VITE_DEV_SERVER_URL || process.env.NODE_ENV === 'development') {
      console.log('[bot] incoming message', message.platform, message.chatId);
    }
  },
  onStatusChange: (status) => {
    mainWindow?.webContents.send('settings:bots:statusChanged', status);
  },
});

app.setName('Maka');

backends.register('ai-sdk', async (ctx) => {
  const { connection, apiKey } = await getReadyConnection(ctx.header.llmConnectionSlug, ctx.header.model);

  return new AiSdkBackend({
    sessionId: ctx.sessionId,
    header: ctx.header,
    appendMessage: (message) => ctx.store.appendMessage(ctx.sessionId, message),
    connection,
    apiKey: apiKey ?? '',
    modelId: ctx.header.model || connection.defaultModel,
    permissionEngine,
    modelFactory: getAIModel,
    tools: builtinTools,
    systemPrompt: buildSystemPrompt,
    recordLlmCall: (event) => recordLlmCall({ repo: telemetryRepo, lookupPricing }, event),
    recordToolInvocation: (event) => recordToolInvocation({ repo: telemetryRepo }, event),
    newId: randomUUID,
    now: Date.now,
  });
});

backends.register('fake', (ctx) =>
  new FakeBackend({ sessionId: ctx.sessionId, header: ctx.header, store: ctx.store }),
);

const runtime = new SessionManager({
  store,
  backends,
  newId: randomUUID,
  now: Date.now,
});

let mainWindow: BrowserWindow | null = null;

/**
 * Guard against saved x/y referencing a display that no longer exists
 * (laptop docked → undocked, external monitor unplugged). Walks the
 * current display workAreas; if no display contains a meaningful
 * overlap with the saved bounds, strip x/y so Electron centers the
 * window on the primary display.
 *
 * "Meaningful overlap" = at least a 100×100 corner of the saved
 * rectangle lies inside some display's workArea. Tighter than "any
 * pixel intersects" so a 1px sliver still flagged-as-off-screen
 * doesn't leave a tiny visible nub the user has to grab.
 */
function clampBoundsToVisibleDisplay(bounds: SavedBounds): SavedBounds {
  if (bounds.x === undefined || bounds.y === undefined) return bounds;
  const displays = screen.getAllDisplays();
  if (displays.length === 0) return { width: bounds.width, height: bounds.height };
  const visible = displays.some((display) => {
    const wa = display.workArea;
    const overlapX = Math.max(0, Math.min(bounds.x! + bounds.width, wa.x + wa.width) - Math.max(bounds.x!, wa.x));
    const overlapY = Math.max(0, Math.min(bounds.y! + bounds.height, wa.y + wa.height) - Math.max(bounds.y!, wa.y));
    return overlapX >= 100 && overlapY >= 100;
  });
  if (visible) return bounds;
  // Off-screen: keep the size but drop the position so Electron centers.
  return { width: bounds.width, height: bounds.height, isMaximized: bounds.isMaximized };
}

async function createWindow(): Promise<void> {
  await mkdir(workspaceRoot, { recursive: true });
  installApplicationMenu();
  // Restore previously-saved bounds when available; first launch and
  // legacy installs both fall back to the default 1240x820 frame. After
  // load, validate the saved x/y against the current display layout — if
  // the previous external monitor is gone, drop x/y so Electron centers
  // the window on the primary display instead of opening it off-screen.
  const savedBounds = await readSavedBounds(workspaceRoot, { width: 1240, height: 820 });
  const bounds = clampBoundsToVisibleDisplay(savedBounds);
  mainWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    ...(bounds.x !== undefined && bounds.y !== undefined ? { x: bounds.x, y: bounds.y } : {}),
    title: 'Maka',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 24, y: 24 },
    backgroundColor: '#f3f3f5',
    webPreferences: {
      preload: join(import.meta.dirname, '..', 'preload', 'preload.cjs'),
      // Defense-in-depth flags (@kenji PR96 review). The external-link guard
      // is the perimeter; these settings keep a hostile page from reaching
      // Node primitives even if it somehow loaded inside the BrowserWindow:
      contextIsolation: true,    // window.maka via contextBridge only
      nodeIntegration: false,    // no `require` in renderer
      sandbox: true,             // preload runs in the renderer sandbox
      webSecurity: true,         // enforce CSP / same-origin policy
      allowRunningInsecureContent: false,
    },
  });

  // Two-layer external-link hygiene: assistant markdown often emits `<a href>`
  // links to docs / GitHub / provider sign-up pages. Without these guards
  // clicking such a link would either replace the renderer view with the
  // remote page (breaking the app) or open a new BrowserWindow with full
  // Node integration.
  //
  // 1. `setWindowOpenHandler` intercepts `target="_blank"` and JS `window.open`,
  //    hands the URL to the OS, denies the in-app open.
  // 2. `will-navigate` blocks plain `<a>` clicks that would replace the
  //    renderer location with a non-file:// URL, opening externally instead.
  //
  // Both are gated on the URL using `http(s):` or `mailto:` — everything else
  // (file://, electron internal, etc.) is allowed/denied per Electron defaults.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalUrl(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    // The initial Vite dev-server / packaged file:// load is allowed through
    // (current URL equals navigation target while the renderer is settling).
    // Every subsequent navigation is blocked: external URLs (http/https/
    // mailto) get handed off to the OS, internal/file:// (including dropped
    // files attempting to navigate to `file:///…`) are dropped entirely so
    // the renderer never loses its React tree.
    const current = mainWindow?.webContents.getURL() ?? '';
    if (current === url) return;
    event.preventDefault();
    if (isExternalUrl(url)) {
      void shell.openExternal(url);
    }
  });

  // Block in-window file drops. Without this, dropping a file onto the
  // BrowserWindow tries to navigate to its `file://` URL; the `will-navigate`
  // handler above stops the navigation, but the visual flash + dropEffect
  // ambiguity is still confusing. Suppressing dragover/drop at the document
  // level keeps the chat surface immutable to accidental drops.
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow?.webContents.executeJavaScript(`
      (() => {
        const block = (e) => { e.preventDefault(); e.stopPropagation(); };
        window.addEventListener('dragover', block, true);
        window.addEventListener('drop', block, true);
      })();
    `).catch(() => { /* renderer may not be ready; ignore */ });
  });

  // Restore maximized state after construction (BrowserWindow constructor
  // doesn't accept it directly; calling here keeps the unmaximized bounds
  // accurate for the next save).
  if (bounds.isMaximized) {
    mainWindow.maximize();
  }

  // Persist bounds across launches. Debounce so a continuous resize drag
  // doesn't write the file on every frame; flush on close.
  let saveTimer: NodeJS.Timeout | undefined;
  const scheduleSave = () => {
    if (!mainWindow) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!mainWindow) return;
      const next: SavedBounds = mainWindow.isMaximized()
        ? { ...mainWindow.getNormalBounds(), isMaximized: true }
        : { ...mainWindow.getBounds(), isMaximized: false };
      void writeSavedBounds(workspaceRoot, next);
    }, 400);
  };
  mainWindow.on('resize', scheduleSave);
  mainWindow.on('move', scheduleSave);
  mainWindow.on('maximize', scheduleSave);
  mainWindow.on('unmaximize', scheduleSave);
  mainWindow.on('close', () => {
    if (saveTimer) clearTimeout(saveTimer);
    if (!mainWindow) return;
    const final: SavedBounds = mainWindow.isMaximized()
      ? { ...mainWindow.getNormalBounds(), isMaximized: true }
      : { ...mainWindow.getBounds(), isMaximized: false };
    void writeSavedBounds(workspaceRoot, final);
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    await mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    await mainWindow.loadFile(join(import.meta.dirname, '..', 'renderer', 'index.html'));
  }
}


function installApplicationMenu(): void {
  // App menu labels match the in-app Chinese-leaning UI per the PR69/70/71
  // localization sweep. Role-based items (cut/copy/paste/reload/etc.) keep
  // their OS-localized labels — those auto-translate when the user's system
  // language matches; we only override the explicit `label` strings.
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'Maka',
        submenu: [
          { role: 'about', label: '关于 Maka' },
          {
            label: '设置…',
            accelerator: 'CommandOrControl+,',
            click: () => mainWindow?.webContents.send('window:openSettings'),
          },
          { type: 'separator' },
          { role: 'hide', label: '隐藏 Maka' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit', label: '退出 Maka' },
        ],
      },
      { label: '文件', submenu: [{ role: 'close' }] },
      {
        label: '编辑',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' },
        ],
      },
      {
        label: '视图',
        submenu: [
          { role: 'reload' },
          { role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' },
        ],
      },
      { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'zoom' }] },
    ]),
  );
}

/**
 * Scan `{workspaceRoot}/skills/` for directories that contain a SKILL.md.
 * Parse the YAML front-matter for `name`, `description`, and `allowed-tools`.
 * Errors per skill fall through silently so one malformed folder can't blank
 * the listing.
 *
 * `allowed-tools` is intentionally surfaced as "declared/requested" — never
 * granted — per @kenji's skills-ingestion contract. PermissionEngine remains
 * the only authority over tool calls.
 */
async function listInstalledSkills(root: string): Promise<Array<{
  id: string;
  name: string;
  description: string;
  path: string;
  declaredTools: string[];
}>> {
  const dir = join(root, 'skills');
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: Array<{
    id: string;
    name: string;
    description: string;
    path: string;
    declaredTools: string[];
  }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillPath = join(dir, entry.name);
    const skillFile = join(skillPath, 'SKILL.md');
    try {
      const text = await readFile(skillFile, 'utf8');
      const { name, description, allowedTools } = parseSkillFrontMatter(text);
      out.push({
        id: entry.name,
        name: name ?? entry.name,
        description: description ?? '',
        path: skillPath,
        declaredTools: allowedTools,
      });
    } catch {
      // Skip directories without a readable SKILL.md.
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function parseSkillFrontMatter(text: string): { name?: string; description?: string; allowedTools: string[] } {
  if (!text.startsWith('---')) return { allowedTools: [] };
  const close = text.indexOf('\n---', 3);
  if (close < 0) return { allowedTools: [] };
  const block = text.slice(3, close);
  const lines = block.split(/\r?\n/);
  const result: { name?: string; description?: string; allowedTools: string[] } = { allowedTools: [] };
  let key: 'name' | 'description' | 'allowed-tools' | null = null;
  for (const raw of lines) {
    const match = raw.match(/^(name|description|allowed-tools):\s*(.*)$/);
    if (match) {
      key = match[1] as 'name' | 'description' | 'allowed-tools';
      const value = match[2].trim().replace(/^['"]|['"]$/g, '');
      if (key === 'allowed-tools') {
        // Accept either inline `[A, B, C]` or a bare-line list that follows.
        if (value.startsWith('[') && value.endsWith(']')) {
          result.allowedTools = value
            .slice(1, -1)
            .split(',')
            .map((token) => token.trim().replace(/^['"]|['"]$/g, ''))
            .filter(Boolean);
        }
      } else if (value) {
        result[key] = value;
      }
      continue;
    }
    if (key === 'allowed-tools') {
      const item = raw.trim().match(/^-\s+(.+)$/);
      if (item) {
        result.allowedTools.push(item[1].trim().replace(/^['"]|['"]$/g, ''));
        continue;
      }
    }
    if (key === 'name' || key === 'description') {
      if (/^\s+/.test(raw)) {
        const continuation = raw.trim();
        if (continuation && !continuation.startsWith('#')) {
          result[key] = `${result[key] ?? ''} ${continuation}`.trim();
        }
      }
    }
  }
  return result;
}

function registerIpc(): void {
  ipcMain.handle('app:info', () => ({
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron ?? '',
    nodeVersion: process.versions.node ?? '',
    chromeVersion: process.versions.chrome ?? '',
    platform: process.platform,
    arch: osArch(),
    osRelease: osRelease(),
    workspacePath: workspaceRoot,
  }));
  ipcMain.handle('app:openPath', async (_event, key: string): Promise<OpenPathResult> => {
    const resolved = await resolveOpenPath({ key, workspaceRoot });
    if (!resolved.ok) return resolved;
    const error = await shell.openPath(resolved.path);
    if (error) return { ok: false, reason: 'open-failed' };
    return { ok: true, opened: resolved.key };
  });
  ipcMain.handle('visualSmoke:getState', () => getVisualSmokeState(visualSmokeFixture));
  ipcMain.handle('skills:list', async () => listInstalledSkills(workspaceRoot));
  ipcMain.handle('sessions:list', (_event, filter?: SessionListFilter) => runtime.listSessions(filter));
  ipcMain.handle('sessions:create', async (_event, input?: Partial<CreateSessionInput>) => {
    const cwd = input?.cwd ?? process.cwd();
    if (input?.backend === 'fake') {
      const session = await runtime.createSession({
        cwd,
        backend: 'fake',
        llmConnectionSlug: input.llmConnectionSlug ?? 'fake',
        model: input.model ?? 'fake-model',
        permissionMode: input.permissionMode ?? 'ask',
        name: input.name ?? 'New Chat',
        labels: input.labels,
      });
      emitSessionsChanged('created', session.id);
      return session;
    }

    const requestedSlug = input?.llmConnectionSlug ?? (await connectionStore.getDefault());
    const { connection, model } = await getReadyConnection(requestedSlug, input?.model);

    const session = await runtime.createSession({
      cwd,
      backend: 'ai-sdk',
      llmConnectionSlug: connection.slug,
      model,
      permissionMode: input?.permissionMode ?? 'ask',
      name: input?.name ?? 'New Chat',
      labels: input?.labels,
    });
    emitSessionsChanged('created', session.id);
    return session;
  });
  ipcMain.handle('sessions:readMessages', (_event, sessionId: string) => runtime.getMessages(sessionId));
  ipcMain.handle('sessions:stop', (_event, sessionId: string) => runtime.stopSession(sessionId));
  ipcMain.handle('sessions:respondToPermission', (_event, sessionId: string, response) =>
    runtime.respondToPermission(sessionId, response),
  );
  ipcMain.handle('sessions:send', async (_event, sessionId: string, command: SessionCommand) => {
    if (command.type !== 'send') return;
    await assertSessionCanSend(sessionId);
    const iterator = runtime.sendMessage(sessionId, {
      turnId: command.turnId || randomUUID(),
      text: command.text,
      attachments: command.attachments,
    });
    void streamEvents(sessionId, iterator);
  });
  ipcMain.handle('sessions:archive', async (_event, sessionId: string) => {
    await runtime.archive(sessionId);
    emitSessionsChanged('archived', sessionId);
  });
  ipcMain.handle('sessions:unarchive', async (_event, sessionId: string) => {
    await runtime.unarchive(sessionId);
    emitSessionsChanged('updated', sessionId);
  });
  ipcMain.handle('sessions:setFlagged', async (_event, sessionId: string, isFlagged: boolean) => {
    await runtime.setFlagged(sessionId, isFlagged);
    emitSessionsChanged('pinned', sessionId);
  });
  ipcMain.handle('sessions:rename', async (_event, sessionId: string, name: string) => {
    await runtime.renameSession(sessionId, name);
    emitSessionsChanged('renamed', sessionId);
  });
  ipcMain.handle('sessions:setPermissionMode', (_event, sessionId: string, mode: unknown) => {
    if (!isPermissionMode(mode)) {
      throw new Error(`Invalid permission mode: ${String(mode)}`);
    }
    return runtime.setPermissionMode(sessionId, mode).then((session) => {
      emitSessionsChanged('mode-change', sessionId);
      return session;
    });
  });
  ipcMain.handle('sessions:remove', async (_event, sessionId: string) => {
    await runtime.remove(sessionId);
    emitSessionsChanged('deleted', sessionId);
  });

  ipcMain.handle('connections:list', () => connectionStore.list());
  ipcMain.handle('connections:getDefault', () => connectionStore.getDefault());
  ipcMain.handle('connections:setDefault', async (_event, slug: string | null) => {
    if (slug && !(await connectionStore.get(slug))) {
      throw new Error(`No such connection: ${slug}`);
    }
    await connectionStore.setDefault(slug);
    emitConnectionListChanged();
  });
  ipcMain.handle('connections:create', async (_event, input: CreateConnectionInput) => {
    const connection = await connectionStore.create(input);
    if (input.apiKey) {
      await credentialStore.setSecret(connection.slug, 'api_key', input.apiKey);
    }
    emitConnectionListChanged();
    return connection;
  });
  ipcMain.handle('connections:update', async (_event, slug: string, patch: UpdateConnectionInput) => {
    const connection = await connectionStore.update(slug, patch);
    if (patch.apiKey !== undefined) {
      if (patch.apiKey) await credentialStore.setSecret(slug, 'api_key', patch.apiKey);
      else await credentialStore.deleteSecret(slug, 'api_key');
    }
    emitConnectionListChanged();
    return connection;
  });
  ipcMain.handle('connections:delete', async (_event, slug: string) => {
    await connectionStore.delete(slug);
    await credentialStore.deleteSecret(slug);
    emitConnectionListChanged();
  });
  ipcMain.handle('connections:test', async (_event, slug: string, opts?: { model?: string }) => {
    const connection = await connectionStore.get(slug);
    if (!connection) return { ok: false, errorMessage: `No such connection: ${slug}` };
    const apiKey = await credentialStore.getSecret(slug, 'api_key');
    if (PROVIDER_DEFAULTS[connection.providerType].authKind !== 'none' && !apiKey) {
      return { ok: false, errorMessage: 'No API key set for this connection', errorClass: 'auth' };
    }
    const result = await testConnection(connection, apiKey ?? '', opts?.model);
    await connectionStore.update(slug, connectionTestStatusPatch(result));
    emitConnectionListChanged();
    return result;
  });
  ipcMain.handle('connections:fetchModels', async (_event, slug: string) => {
    const connection = await connectionStore.get(slug);
    if (!connection) throw new Error(`No such connection: ${slug}`);
    const apiKey = await credentialStore.getSecret(slug, 'api_key');
    if (PROVIDER_DEFAULTS[connection.providerType].authKind !== 'none' && !apiKey) {
      throw new Error('No API key set for this connection');
    }
    try {
      const fetchedAt = Date.now();
      const models = await fetchProviderModels(connection, apiKey ?? '');
      await connectionStore.update(slug, {
        models,
        modelSource: 'fetched',
        modelsFetchedAt: fetchedAt,
      });
      emitConnectionListChanged();
      return {
        models,
        source: 'fetched',
        fetchedAt,
      };
    } catch (error) {
      throw new Error(generalizedErrorMessage(error, 'Failed to fetch provider models'));
    }
  });
  ipcMain.handle('connections:hasSecret', async (_event, slug: string) =>
    Boolean(await credentialStore.getSecret(slug, 'api_key')),
  );

  ipcMain.handle('settings:get', async () => maskAppSettings(await settingsStore.get()));
  ipcMain.handle('settings:update', async (_event, patch: UpdateAppSettingsInput): Promise<UpdateAppSettingsResult> => {
    const normalizedPatch = await normalizeSettingsPatch(patch);
    const next = await settingsStore.update(normalizedPatch);
    await applySettingsRuntimeEffects(next, patch);
    return buildSettingsUpdateResult(next, patch);
  });
  ipcMain.handle('settings:testNetworkProxy', async (_event, input: TestProxyInput = {}) => {
    const started = Date.now();
    const stored = toContractNetworkSettings((await settingsStore.get()).network).proxy;
    const proxy = input.proxy?.password === SENSITIVE_PLACEHOLDER
      ? { ...input.proxy, password: stored.password }
      : input.proxy;
    const testedProxy = proxy ?? stored;
    const result = await testProxyConnection({ ...input, proxy }, stored);
    const latencyMs = result.latencyMs ?? (Date.now() - started);
    if (!result.ok) {
      return {
        ok: false,
        message: result.error ?? (result.status ? `HTTP ${result.status}` : '代理不可达'),
        latencyMs,
      } satisfies SettingsTestResult;
    }
    return {
      ok: true,
      message: result.ip
        ? `代理配置有效：${testedProxy.type}://${testedProxy.host}:${testedProxy.port} · ${result.countryFlag ?? ''} ${result.ip}`.trim()
        : `代理配置有效：${testedProxy.type}://${testedProxy.host}:${testedProxy.port}`,
      latencyMs,
      details: {
        status: result.status,
        ip: result.ip,
        countryCode: result.countryCode,
        countryFlag: result.countryFlag,
        bypassList: testedProxy.bypassList,
      },
    } satisfies SettingsTestResult;
  });
  ipcMain.handle('settings:testBotChannel', async (_event, provider: BotProvider) => {
    const settings = await settingsStore.get();
    const result = await testRuntimeBotChannel(provider, settings.botChat.channels[provider]);
    await settingsStore.update({
      botChat: {
        channels: {
          [provider]: {
            connected: result.ok,
            lastTestAt: Date.now(),
            lastError: result.ok ? undefined : generalizedErrorMessage(result.error ?? '', 'Bot connection test failed'),
          },
        },
      },
    });
    const next = await settingsStore.get();
    await applySettingsRuntimeEffects(next, { botChat: { channels: { [provider]: {} } } });
    return toSettingsTestResult(provider, result);
  });
  ipcMain.handle('settings:bots:listStatuses', () =>
    tryResult(async () => botRegistry.allStatuses(), 'BOTS_STATUS_FAILED'),
  );
  ipcMain.handle('settings:bots:restart', (_event, provider: BotProvider) =>
    tryResult(async () => {
      const settings = await settingsStore.get();
      await botRegistry.applySettings(settings.botChat);
      return botRegistry.getStatus(provider);
    }, 'BOTS_RESTART_FAILED'),
  );
  ipcMain.handle('settings:bots:test', (_event, provider: BotProvider) =>
    tryResult(async () => {
      const settings = await settingsStore.get();
      return testRuntimeBotChannel(provider, settings.botChat.channels[provider]);
    }, 'BOTS_TEST_FAILED'),
  );
  ipcMain.handle('settings:usageStats', (_event, range?: UsageRange) =>
    settingsStore.usageStats(range),
  );
  ipcMain.handle('usage:summary', (_event, query: UsageQuery) =>
    tryResult(async () => telemetryRepo.summary(query), 'USAGE_SUMMARY_FAILED'),
  );
  ipcMain.handle('usage:buckets', (_event, query: UsageQuery & { groupBy: UsageGroupBy }) =>
    tryResult(async () => telemetryRepo.buckets(query, query.groupBy), 'USAGE_BUCKETS_FAILED'),
  );
  ipcMain.handle('usage:logs', (_event, query: UsageQuery & { offset?: number; limit?: number }) =>
    tryResult(async () => telemetryRepo.logs(query, query.offset, query.limit), 'USAGE_LOGS_FAILED'),
  );
  ipcMain.handle('usage:pricing:list', () =>
    tryResult(async () => telemetryRepo.listPricingOverrides(), 'USAGE_PRICING_LIST_FAILED'),
  );
  ipcMain.handle('usage:pricing:put', (_event, pricing: PricingConfig) =>
    tryResult(async () => {
      await telemetryRepo.upsertPricing(pricing);
      lookupPricing = buildPricingLookup(telemetryRepo.listPricingOverrides());
      mainWindow?.webContents.send('usage:pricing:changed');
      return pricing;
    }, 'USAGE_PRICING_PUT_FAILED'),
  );
  ipcMain.handle('usage:pricing:reset', (_event, modelKey: string) =>
    tryResult(async () => {
      await telemetryRepo.deletePricing(modelKey);
      lookupPricing = buildPricingLookup(telemetryRepo.listPricingOverrides());
      mainWindow?.webContents.send('usage:pricing:changed');
    }, 'USAGE_PRICING_RESET_FAILED'),
  );

  ipcMain.handle('settings:network:get', async (): Promise<Result<ContractNetworkSettings>> =>
    tryResult(async () => maskNetworkSettings(toContractNetworkSettings((await settingsStore.get()).network)), 'NETWORK_GET_FAILED'),
  );
  ipcMain.handle('settings:network:put', async (_event, patch: Partial<ContractNetworkSettings>): Promise<Result<ContractNetworkSettings>> =>
    tryResult(async () => {
      const current = await settingsStore.get();
      const nextNetwork = applyNetworkPatch(toContractNetworkSettings(current.network), patch);
      const next = await settingsStore.update({ network: toAppNetworkPatch(nextNetwork) });
      const masked = maskNetworkSettings(toContractNetworkSettings(next.network));
      await applySettingsRuntimeEffects(next, { network: {} });
      return masked;
    }, 'NETWORK_PUT_FAILED'),
  );
  ipcMain.handle('settings:network:test', async (_event, input: TestProxyInput = {}): Promise<Result<Awaited<ReturnType<typeof testProxyConnection>>>> =>
    tryResult(async () => {
      const stored = toContractNetworkSettings((await settingsStore.get()).network).proxy;
      const proxy = input.proxy?.password === SENSITIVE_PLACEHOLDER
        ? { ...input.proxy, password: stored.password }
        : input.proxy;
      return testProxyConnection({ ...input, proxy }, stored);
    }, 'NETWORK_TEST_FAILED'),
  );
}

async function normalizeSettingsPatch(patch: UpdateAppSettingsInput): Promise<UpdateAppSettingsInput> {
  const current = await settingsStore.get();
  return preserveSensitivePlaceholders(patch, current);
}

async function applySettingsRuntimeEffects(settings: AppSettings, patch: UpdateAppSettingsInput): Promise<void> {
  if (patch.network) {
    const network = toContractNetworkSettings(settings.network);
    setActiveProxy(network.proxy);
    mainWindow?.webContents.send('settings:network:changed', maskNetworkSettings(network));
  }
  if (patch.botChat) {
    await botRegistry.applySettings(settings.botChat);
  }
}

async function streamEvents(sessionId: string, iterator: AsyncIterable<SessionEvent>): Promise<void> {
  let userAppendBroadcasted = false;
  let finalAppendBroadcasted = false;
  try {
    for await (const event of iterator) {
      if (!userAppendBroadcasted) {
        emitSessionsChanged('message-appended', sessionId);
        userAppendBroadcasted = true;
      }
      mainWindow?.webContents.send(`sessions:event:${sessionId}`, event);
      if (!finalAppendBroadcasted && isFinalSessionEvent(event)) {
        emitSessionsChanged('message-appended', sessionId);
        finalAppendBroadcasted = true;
      }
    }
  } catch (error) {
    mainWindow?.webContents.send(`sessions:event:${sessionId}`, {
      type: 'error',
      id: randomUUID(),
      turnId: randomUUID(),
      ts: Date.now(),
      recoverable: false,
      code: errorCode(error),
      message: errorMessage(error),
    } satisfies SessionEvent);
    if (!finalAppendBroadcasted) {
      emitSessionsChanged('message-appended', sessionId);
    }
  }
}

function isFinalSessionEvent(event: SessionEvent): boolean {
  return event.type === 'text_complete' || event.type === 'complete' || event.type === 'abort' || event.type === 'error';
}

async function assertSessionCanSend(sessionId: string): Promise<void> {
  const header = await store.readHeader(sessionId);
  await assertHeaderCanSend(header, readyConnectionDeps);
}

const readyConnectionDeps = {
  getConnection: (slug: string) => connectionStore.get(slug),
  getApiKey: (slug: string) => credentialStore.getSecret(slug, 'api_key'),
};

function getReadyConnection(slug: string | null | undefined, model?: string) {
  return requireReadyConnection(slug, readyConnectionDeps, model);
}

async function buildSystemPrompt(): Promise<string | undefined> {
  const settings = await settingsStore.get();
  const personalization = buildPersonalizationPromptFragment(settings.personalization);
  const fragments = [
    personalization.text,
  ].filter((fragment): fragment is string => Boolean(fragment));
  return fragments.length > 0 ? fragments.join('\n\n') : undefined;
}

function emitConnectionListChanged(): void {
  const event: ConnectionEvent = {
    type: 'connection_list_changed',
    id: randomUUID(),
    ts: Date.now(),
  };
  mainWindow?.webContents.send('connections:event', event);
}

function emitSessionsChanged(reason: SessionChangedReason, sessionId?: string): void {
  const event: SessionChangedEvent = {
    type: 'sessions_changed',
    reason,
    ts: Date.now(),
  };
  if (sessionId) event.sessionId = sessionId;
  mainWindow?.webContents.send('sessions:changed', event);
}

function toContractNetworkSettings(network: Awaited<ReturnType<typeof settingsStore.get>>['network']): ContractNetworkSettings {
  const proxy = network.proxy;
  return {
    ...NETWORK_DEFAULTS,
    proxy: {
      ...NETWORK_DEFAULTS.proxy,
      enabled: proxy.enabled,
      type: proxy.protocol,
      host: proxy.host,
      port: proxy.port,
      username: proxy.authEnabled && proxy.username ? proxy.username : undefined,
      password: proxy.authEnabled && proxy.password ? proxy.password : undefined,
      bypassList: proxy.bypassList.length > 0 ? proxy.bypassList : NETWORK_DEFAULTS.proxy.bypassList,
    },
  };
}

function toAppNetworkPatch(network: ContractNetworkSettings): NonNullable<UpdateAppSettingsInput['network']> {
  return {
    proxy: {
      enabled: network.proxy.enabled,
      protocol: network.proxy.type,
      host: network.proxy.host,
      port: network.proxy.port,
      authEnabled: Boolean(network.proxy.username || network.proxy.password),
      username: network.proxy.username ?? '',
      password: typeof network.proxy.password === 'string' ? network.proxy.password : '',
      bypassList: network.proxy.bypassList,
    },
  };
}

function applyNetworkPatch(
  prev: ContractNetworkSettings,
  patch: Partial<ContractNetworkSettings>,
): ContractNetworkSettings {
  const proxyPatch: Partial<ProxySettings> = patch.proxy ?? {};
  const nextProxy: ProxySettings = {
    ...prev.proxy,
    ...stripUndefined(proxyPatch),
    password: applySensitivePatch(
      typeof prev.proxy.password === 'string' ? prev.proxy.password : undefined,
      proxyPatch.password,
    ),
    bypassList: Array.isArray(proxyPatch.bypassList) ? proxyPatch.bypassList : prev.proxy.bypassList,
  };
  return {
    ...prev,
    ...stripUndefined(patch),
    proxy: nextProxy,
  };
}

function maskNetworkSettings(settings: ContractNetworkSettings): ContractNetworkSettings {
  return {
    ...settings,
    proxy: {
      ...settings.proxy,
      password: maskSensitive(typeof settings.proxy.password === 'string' ? settings.proxy.password : undefined),
    },
  };
}

function stripUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}

async function ensureBootstrapConnection(): Promise<void> {
  await mkdir(workspaceRoot, { recursive: true });
  if ((await connectionStore.list()).length > 0) return;

  if (process.env.ANTHROPIC_API_KEY) {
    const slug = 'env-anthropic';
    await connectionStore.create({
      slug,
      name: 'Anthropic (env)',
      providerType: 'anthropic',
      defaultModel: 'claude-sonnet-4-5-20250929',
    });
    await credentialStore.setSecret(slug, 'api_key', process.env.ANTHROPIC_API_KEY);
    await connectionStore.setDefault(slug);
    return;
  }

  if (process.env.OPENAI_API_KEY) {
    const slug = 'env-openai';
    await connectionStore.create({
      slug,
      name: 'OpenAI (env)',
      providerType: 'openai',
      defaultModel: 'gpt-4o-mini',
    });
    await credentialStore.setSecret(slug, 'api_key', process.env.OPENAI_API_KEY);
    await connectionStore.setDefault(slug);
  }
}

registerIpc();

app.whenReady().then(async () => {
  if (visualSmokeFixture) {
    console.log(`[visual-smoke] scenario=${visualSmokeFixture.scenario} workspace=${workspaceRoot}`);
    await seedVisualSmokeFixture({ workspaceRoot, fixture: visualSmokeFixture, credentialStore });
  } else {
    await ensureBootstrapConnection();
  }
  const settings = await settingsStore.get();
  setActiveProxy(toContractNetworkSettings(settings.network).proxy);
  await telemetryRepo.load();
  lookupPricing = buildPricingLookup(telemetryRepo.listPricingOverrides());
  await botRegistry.applySettings(settings.botChat);
  await createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  void botRegistry.stopAll();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});
