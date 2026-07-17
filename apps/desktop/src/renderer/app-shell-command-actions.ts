import { useMemo, useRef } from 'react';
import type {
  DailyReviewSummary,
  LlmConnection,
  PermissionMode,
  QuickChatMode,
  SessionSummary,
  SettingsSection,
  StoredMessage,
  ThemePreference,
} from '@maka/core';
import { formatDailyReviewMarkdown } from '@maka/ui';
import type { NavSelection } from '@maka/ui';
import { buildCommandList, buildSessionCommands } from './command-palette-commands.js';
import type { Command } from './command-palette-types.js';
import { renderConversationMarkdown } from './conversation-markdown.js';
import { dailyReviewActionErrorMessage } from './daily-review-actions.js';
import { commandPaletteActionErrorMessage, commandPaletteConnectionTestFailureMessage } from './app-shell-copy.js';

type ToastApi = {
  success(title: string, description?: string): void;
  info(title: string, description?: string): void;
  error(title: string, description?: string): void;
};

type ComposerImportOwner = {
  sessionId: string | undefined;
  navSection: NavSelection['section'];
};

type RefBox<T> = { current: T };

type ComposerAppendHandle = {
  appendText(text: string): void;
};

type DailyReviewBridge = {
  fetchDay(offsetDays: number, daySpan?: number): Promise<DailyReviewSummary>;
};

export interface AppShellCommandListOptions {
  activeId: string | undefined;
  activePermissionMode: PermissionMode | undefined;
  connections: LlmConnection[];
  defaultConnection: string | null;
  dailyReviewBridge: DailyReviewBridge;
  messages: StoredMessage[];
  sessions: SessionSummary[];
  themePref: ThemePreference;
  visibleSessions: SessionSummary[];
  captureComposerImportOwner: () => ComposerImportOwner;
  closePalette: () => void;
  composerRef: RefBox<ComposerAppendHandle | null>;
  createSession: () => void;
  handleQuickChatSubmit: (prompt: string, mode?: QuickChatMode) => Promise<boolean>;
  isComposerImportOwnerActive: (owner: ComposerImportOwner) => boolean;
  openHelp: () => void;
  openPlanReminderForm: () => void;
  openProjectFolder: () => Promise<void>;
  openSessionInChat: (sessionId: string) => void;
  openSettings: () => void;
  openSettingsSection: (section: SettingsSection) => void;
  openSkillsFolder: () => Promise<void>;
  openWorkspaceFolder: () => Promise<void>;
  refreshConnections: () => Promise<void>;
  saveDailyReviewMarkdown: (input: {
    markdown: string;
    label: string;
    summary: DailyReviewSummary;
  }) => Promise<void>;
  setNavSelection: (selection: NavSelection) => void;
  setPermissionMode: (mode: PermissionMode) => Promise<void>;
  setThemePref: (themePref: ThemePreference) => void;
  toastApi: ToastApi;
}

export function buildAppShellCommandList(
  optionsRef: RefBox<AppShellCommandListOptions>,
): ReturnType<typeof buildCommandList> {
  // #1045: useAppShellCommands freezes this list per palette open/close
  // transition. List-SHAPING fields (which rows exist, labels, hints) come
  // from the build-time snapshot below; every value a command touches at RUN
  // time is dereferenced from the ref inside the callback, so the frozen list
  // still acts on current data (same stable-ref pattern as
  // openSessionInChatRef in app-shell.tsx).
  const options = optionsRef.current;

  return buildCommandList({
    activeSessionId: options.activeId,
    themePref: options.themePref,
    connections: options.connections,
    defaultSlug: options.defaultConnection,
    onNewChat: () => optionsRef.current.createSession(),
    onStartDeepResearch: async () => {
      const { handleQuickChatSubmit } = optionsRef.current;
      await handleQuickChatSubmit('', 'deep_research');
    },
    onStartPlanReminder: () => optionsRef.current.openPlanReminderForm(),
    onOpenSettings: () => optionsRef.current.openSettings(),
    onOpenSettingsSection: (section) => optionsRef.current.openSettingsSection(section),
    // PR-UX-POLISH-1 commit 4 (WAWQAQ `e0dbad11` + kenji `2844f64f`):
    // use the openHelp callback returned by useKeyboardHelp directly,
    // instead of dispatching a synthetic KeyboardEvent. Same effect,
    // clearer intent, and avoids the foot-gun where a typed `?` in a
    // text input would be swallowed by the global keydown listener.
    onOpenShortcuts: () => optionsRef.current.openHelp(),
    onSetTheme: (next) => optionsRef.current.setThemePref(next),
    onTestConnection: async (slug) => {
      const { connections, refreshConnections, toastApi } = optionsRef.current;
      try {
        const result = await window.maka.connections.test(slug);
        const conn = connections.find((c) => c.slug === slug);
        const name = conn?.name ?? slug;
        if (result.ok) {
          toastApi.success(
            `连接已验证 · ${name}`,
            `延迟 ${result.latencyMs ?? '?'} ms${result.modelTested ? ' · ' + result.modelTested : ''}`,
          );
        } else {
          toastApi.error(`连接测试失败 · ${name}`, commandPaletteConnectionTestFailureMessage(result));
        }
        await refreshConnections();
      } catch (err) {
        toastApi.error(
          '测试出错',
          commandPaletteActionErrorMessage(err, '连接测试暂时不可用，请稍后重试。'),
        );
      }
    },
    onSetDefaultConnection: async (slug) => {
      const { connections, refreshConnections, toastApi } = optionsRef.current;
      try {
        await window.maka.connections.setDefault(slug);
        await refreshConnections();
        const conn = connections.find((c) => c.slug === slug);
        toastApi.success(`已设为默认 · ${conn?.name ?? slug}`);
      } catch (err) {
        toastApi.error(
          '切换默认失败',
          commandPaletteActionErrorMessage(err, '默认模型暂时无法切换，请稍后重试。'),
        );
      }
    },
    onOpenWorkspace: async () => {
      await optionsRef.current.openWorkspaceFolder();
    },
    onOpenProjectFolder: () => optionsRef.current.openProjectFolder(),
    onOpenSkillsFolder: () => optionsRef.current.openSkillsFolder(),
    onSelectModule: (selection) => {
      const { closePalette, setNavSelection } = optionsRef.current;
      setNavSelection(selection);
      closePalette();
    },
    onExportActiveConversation: async () => {
      const { activeId, messages, sessions, toastApi } = optionsRef.current;
      if (!activeId) return;
      const session = sessions.find((s) => s.id === activeId);
      const markdown = renderConversationMarkdown(session?.name ?? '新建对话', messages);
      try {
        await navigator.clipboard.writeText(markdown);
        toastApi.success(
          '已复制对话为 Markdown',
          `${markdown.split('\n').length} 行 · 可粘贴到 Notion / Obsidian / GitHub`,
        );
      } catch {
        toastApi.error('复制失败', '剪贴板不可用');
      }
    },
    onSaveActiveConversationToFile: async () => {
      const { activeId, messages, sessions, toastApi } = optionsRef.current;
      if (!activeId) return;
      const session = sessions.find((s) => s.id === activeId);
      const sessionName = session?.name ?? '新建对话';
      const markdown = renderConversationMarkdown(sessionName, messages);
      const now = new Date();
      const yyyy = now.getFullYear();
      const mm = String(now.getMonth() + 1).padStart(2, '0');
      const dd = String(now.getDate()).padStart(2, '0');
      // Make the filename mostly portable: collapse whitespace
      // and quote chars that some file pickers don't like.
      const sanitizedSession = sessionName
        .replace(/[\s ]+/g, '-')
        .replace(/["<>:|?*]/g, '')
        .slice(0, 80);
      const defaultName = `maka-${sanitizedSession}-${yyyy}-${mm}-${dd}.md`;
      try {
        const result = await window.maka.sessions.saveConversationToFile({ markdown, defaultName });
        if (result.ok) {
          toastApi.success(
            '已保存当前对话',
            `${markdown.split('\n').length} 行 · 保存为 ${defaultName}`,
          );
        } else if (result.reason === 'canceled') {
          // User dismissed the dialog — no toast.
        } else if (result.reason === 'invalid_input') {
          toastApi.error('保存失败', '导出内容无效');
        } else {
          toastApi.error('保存失败', '无法写入选择的位置');
        }
      } catch (err) {
        toastApi.error(
          '保存失败',
          commandPaletteActionErrorMessage(err, '导出当前对话失败，请稍后重试。'),
        );
      }
    },
    onOpenLocalMemoryFile: async () => {
      const { toastApi } = optionsRef.current;
      try {
        const result = await window.maka.memory.openFile();
        if (!result.ok) {
          toastApi.error('无法打开 MEMORY.md', result.message);
        }
      } catch (err) {
        toastApi.error(
          '打开失败',
          commandPaletteActionErrorMessage(err, '无法打开 MEMORY.md，请稍后重试。'),
        );
      }
    },
    onOpenWorkspaceInstructionsFile: async () => {
      const { toastApi } = optionsRef.current;
      try {
        // PR-CMD-PALETTE-OPEN-WORKSPACE-INSTRUCTIONS-0: open the
        // first available workspace instruction file. If none are
        // available, surface a hint so the user knows where to
        // create one rather than getting a silent no-op.
        const state = await window.maka.workspaceInstructions.getState();
        const available = state.files.find((f) => f.status === 'available');
        if (!available) {
          toastApi.info(
            '等待创建项目指引',
            '在 Settings · 记忆 创建 AGENTS.md 或 CLAUDE.md',
          );
          return;
        }
        const result = await window.maka.workspaceInstructions.openFile(available.file);
        if (!result.ok) {
          toastApi.error(`无法打开 ${available.file}`, result.message);
        }
      } catch (err) {
        toastApi.error(
          '打开失败',
          commandPaletteActionErrorMessage(err, '无法打开项目指引，请稍后重试。'),
        );
      }
    },
    onSetPermissionMode: (mode) => optionsRef.current.setPermissionMode(mode),
    activePermissionMode: options.activePermissionMode,
    onCopyTodayDailyReview: async () => {
      const { dailyReviewBridge, toastApi } = optionsRef.current;
      try {
        const summary = await dailyReviewBridge.fetchDay(0, 1);
        const markdown = formatDailyReviewMarkdown(summary, '今天');
        await navigator.clipboard.writeText(markdown);
        toastApi.success(
          '已复制今日回顾为 Markdown',
          `${summary.totals.sessionCount} 个对话 · ${summary.totals.requestCount} 个请求`,
        );
      } catch (err) {
        toastApi.error(
          '复制失败',
          dailyReviewActionErrorMessage(err, '今日回顾暂时不可用，或剪贴板被系统拒绝。'),
        );
      }
    },
    onPasteTodayDailyReviewIntoComposer: async () => {
      const {
        captureComposerImportOwner,
        composerRef,
        dailyReviewBridge,
        isComposerImportOwnerActive,
        toastApi,
      } = optionsRef.current;
      const owner = captureComposerImportOwner();
      if (!owner.sessionId) return;
      try {
        const summary = await dailyReviewBridge.fetchDay(0, 1);
        const markdown = formatDailyReviewMarkdown(summary, '今天');
        if (!isComposerImportOwnerActive(owner)) return;
        composerRef.current?.appendText(markdown);
        toastApi.success(
          '已追加今日回顾到输入框',
          `${summary.totals.sessionCount} 个对话 · ${summary.totals.requestCount} 个请求`,
        );
      } catch (err) {
        if (isComposerImportOwnerActive(owner)) {
          toastApi.error(
            '粘贴失败',
            dailyReviewActionErrorMessage(err, '今日回顾暂时不可用，请稍后重试。'),
          );
        }
      }
    },
    onSaveTodayDailyReviewToFile: async () => {
      const { dailyReviewBridge, saveDailyReviewMarkdown, toastApi } = optionsRef.current;
      try {
        const summary = await dailyReviewBridge.fetchDay(0, 1);
        const markdown = formatDailyReviewMarkdown(summary, '今天');
        await saveDailyReviewMarkdown({ markdown, label: '今天', summary });
      } catch (err) {
        toastApi.error(
          '保存失败',
          dailyReviewActionErrorMessage(err, '今日回顾暂时不可用，请稍后重试。'),
        );
      }
    },
    onCopyEnvSummary: async () => {
      const { toastApi } = optionsRef.current;
      try {
        const info = await window.maka.app.info();
        const platformPretty =
          info.platform === 'darwin'
            ? 'macOS'
            : info.platform === 'win32'
              ? 'Windows'
              : info.platform === 'linux'
                ? 'Linux'
                : info.platform;
        const buildLine =
          info.buildMode === 'dev'
            ? `- Build: dev${info.buildCommit ? ` @ ${info.buildCommit}` : ''}`
            : '- Build: packaged';
        const summary = [
          `**Maka** v${info.appVersion}`,
          ``,
          `- Electron: ${info.electronVersion}`,
          `- Node: ${info.nodeVersion}`,
          `- Chrome: ${info.chromeVersion}`,
          `- Platform: ${platformPretty} ${info.osRelease}`,
          `- Arch: ${info.arch}`,
          buildLine,
        ].join('\n');
        await navigator.clipboard.writeText(summary);
        toastApi.success(
          '已复制环境信息',
          `Maka v${info.appVersion} · ${platformPretty} · ${info.arch}`,
        );
      } catch (err) {
        toastApi.error(
          '复制失败',
          commandPaletteActionErrorMessage(err, '剪贴板不可用或被系统拒绝'),
        );
      }
    },
    onTestNetworkProxy: async () => {
      const { toastApi } = optionsRef.current;
      try {
        // PR-CMD-PALETTE-NETWORK-PROXY-TEST-0: surface the
        // proxy test result via toast so a user debugging a
        // connection issue does not need to open Settings →
        // 网络. `testNetworkProxy(undefined)` uses the
        // current persisted proxy config.
        const result = await window.maka.settings.testNetworkProxy(undefined);
        if (result.ok) {
          const latency = result.latencyMs ? ` · ${result.latencyMs}ms` : '';
          toastApi.success('网络代理测试通过', `${result.message}${latency}`);
        } else {
          toastApi.error('网络代理测试失败', result.message);
        }
      } catch (err) {
        toastApi.error(
          '测试失败',
          commandPaletteActionErrorMessage(err, '网络代理测试暂时不可用，请稍后重试。'),
        );
      }
    },
  });
}

export function buildAppShellSessionCommands(
  optionsRef: RefBox<AppShellCommandListOptions>,
): ReturnType<typeof buildSessionCommands> {
  const options = optionsRef.current;
  return buildSessionCommands({
    sessions: options.visibleSessions,
    activeSessionId: options.activeId,
    onSelectSession: (sessionId) => {
      optionsRef.current.openSessionInChat(sessionId);
    },
  });
}

/**
 * #1045: the palette's command list keeps a stable identity while it is open.
 * app-shell rebuilds commandOptions on every render (streaming ticks
 * included), so the base commands are built once per open/close transition —
 * their run() closures dereference the latest options through the ref, so the
 * frozen list still acts on current data. Session rows are derived separately,
 * memoized on the visible session catalog + active session only: background
 * session creates/renames stay live while the palette is open, without
 * reintroducing per-tick rebuilds (visibleSessions is itself memoized in
 * app-shell, so rows rebuild only on real catalog changes).
 */
export function useAppShellCommands(
  paletteOpen: boolean,
  commandOptions: AppShellCommandListOptions,
): Command[] {
  const optionsRef = useRef(commandOptions);
  optionsRef.current = commandOptions;
  const baseCommands = useMemo(
    () => buildAppShellCommandList(optionsRef),
    [paletteOpen],
  );
  const { activeId, visibleSessions } = commandOptions;
  const sessionCommands = useMemo(
    () => buildAppShellSessionCommands(optionsRef),
    [paletteOpen, visibleSessions, activeId],
  );
  return useMemo(
    () => [...baseCommands, ...sessionCommands],
    [baseCommands, sessionCommands],
  );
}
