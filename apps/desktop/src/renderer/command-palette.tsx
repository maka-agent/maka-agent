// apps/desktop/src/renderer/command-palette.tsx
//
// ⌘K / Ctrl+K command palette. Combines static actions (new chat, theme
// switch, open settings, open keyboard help) with the live session list so
// the user can fuzzy-search across both. Renders as a Base UI Dialog modal;
// Arrow/Enter/Esc navigation is local to the input, focus trap + restore +
// Esc-dismiss come from DialogRoot/DialogContent (#520 PR7).

import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import {
  Blocks,
  CalendarDays,
  ChevronRight,
  Clock,
  CornerDownLeft,
  Database,
  Download,
  FolderOpen,
  Keyboard,
  MessageSquare,
  Moon,
  Palette,
  Plug,
  Plus,
  Search,
  Settings as SettingsIcon,
  ShieldCheck,
  Sparkles,
  Sun,
  SunMoon,
  Wifi,
  type LucideIcon,
} from '@maka/ui/icons';
import type { LlmConnection, PermissionMode, SessionSummary, SettingsSection, ThemePreference } from '@maka/core';
import type { NavSelection } from '@maka/ui';
import {
  DialogContent,
  DialogRoot,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  InputGroup,
  InputGroupInput,
  Kbd,
  KbdGroup,
} from '@maka/ui';
import { Autocomplete } from '@base-ui/react/autocomplete';
import { SETTINGS_NAV } from './settings/settings-nav';
import { useThreadSearch } from './use-thread-search';
import { buildContentSearchCommands } from './command-palette-content-search';
import type { Command, CommandKind } from './command-palette-types';
import type { UseThreadSearchDeps } from './use-thread-search';
export type { Command, CommandKind } from './command-palette-types';
export { buildContentSearchCommands } from './command-palette-content-search';

// `Command` / `CommandKind` types live in `./command-palette-types`
// (extracted so non-JSX consumers can import them under the main
// tsconfig). Re-exported via the explicit `export { ... }` above.

const PALETTE_DELIM = '·';

export function useCommandPalette(): [boolean, () => void, () => void] {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key !== 'k' && event.key !== 'K') return;
      event.preventDefault();
      setOpen((prev) => !prev);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return [open, () => setOpen(true), () => setOpen(false)];
}

/**
 * Helper used by App to compose the active command list each render. Pulling
 * this out makes the palette itself pure presentation.
 */
export function buildCommandList(args: {
  sessions: SessionSummary[];
  activeSessionId: string | undefined;
  themePref: ThemePreference;
  connections: LlmConnection[];
  defaultSlug: string | null;
  onSelectSession(id: string): void;
  onNewChat(): Promise<void> | void;
  onStartDeepResearch?(): Promise<void> | void;
  onOpenSettings(): void;
  onOpenSettingsSection(section: SettingsSection): void;
  onOpenShortcuts(): void;
  onSetTheme(next: ThemePreference): void;
  /**
   * Diagnostics — wired up via the existing IPC bridge in main.tsx so the
   * palette can trigger actions without taking a dependency on
   * `window.maka.*` directly from this file.
   */
  onTestConnection?(slug: string): Promise<void> | void;
  onSetDefaultConnection?(slug: string): Promise<void> | void;
  onOpenWorkspace?(): Promise<void> | void;
  onOpenProjectFolder?(): Promise<void> | void;
  onOpenSkillsFolder?(): Promise<void> | void;
  /** Copy the active conversation as Markdown to the clipboard. */
  onExportActiveConversation?(): Promise<void> | void;
  /**
   * PR-CMD-PALETTE-SAVE-CONVERSATION-FILE-0: save the active conversation
   * as a Markdown file via the native save dialog. Complements
   * `onExportActiveConversation` (clipboard) for users who want a
   * durable archive without the clipboard detour.
   */
  onSaveActiveConversationToFile?(): Promise<void> | void;
  /**
   * PR-CMD-PALETTE-COPY-DAILY-REVIEW-0: copy today's Daily Review
   * as Markdown from anywhere via ⌘K. Same Markdown formatter
   * `<DailyReviewPanel>` uses; renderer wires the bridge.
   */
  onCopyTodayDailyReview?(): Promise<void> | void;
  /**
   * PR-CMD-PALETTE-OPEN-MEMORY-0: open the local MEMORY.md file in
   * the OS default editor from anywhere via ⌘K. The renderer wires
   * this to `window.maka.memory.openFile()`.
   */
  onOpenLocalMemoryFile?(): Promise<void> | void;
  /**
   * PR-CMD-PALETTE-OPEN-WORKSPACE-INSTRUCTIONS-0: open the first
   * available workspace instruction file (AGENTS.md / CLAUDE.md / …)
   * in the OS default editor. The renderer is responsible for falling
   * back gracefully when no available file exists.
   */
  onOpenWorkspaceInstructionsFile?(): Promise<void> | void;
  /**
   * PR-CMD-PALETTE-PERMISSION-MODE-0: switch the active session's
   * permission mode from anywhere via ⌘K. Only registers when both
   * a callback and an active session id are wired. Mirrors the
   * composer's permission-mode dropdown (PR-MOVE-PERMISSION-MODE
   * relocated the picker out of the chat header).
   */
  onSetPermissionMode?(mode: PermissionMode): Promise<void> | void;
  activePermissionMode?: PermissionMode;
  /**
   * PR-CMD-PALETTE-PASTE-DAILY-REVIEW-0: fetch today's review and
   * paste the Markdown into the composer instead of the clipboard.
   * Useful when the user wants to ask the model "summarize my day"
   * without leaving the chat.
   */
  onPasteTodayDailyReviewIntoComposer?(): Promise<void> | void;
  /**
   * PR-DAILY-REVIEW-EXPORT-FILE-0: save today's review as a Markdown
   * file via the native save dialog. Persistent archive without
   * round-tripping the clipboard.
   */
  onSaveTodayDailyReviewToFile?(): Promise<void> | void;
  /**
   * PR-CMD-PALETTE-COPY-ENV-SUMMARY-0: copy the Settings → 关于
   * environment summary (Maka version + Electron / Node / Chrome
   * versions + platform + arch + build mode/sha) as Markdown,
   * without having to open Settings. Useful for bug reports.
   */
  onCopyEnvSummary?(): Promise<void> | void;
  /**
   * PR-CMD-PALETTE-NETWORK-PROXY-TEST-0: ⌘K → 测试当前网络代理. Fires
   * `window.maka.settings.testNetworkProxy()` and surfaces the result
   * via toast so a user debugging a connection issue does not have to
   * open Settings → 网络 first.
   */
  onTestNetworkProxy?(): Promise<void> | void;
  /**
   * PR-CMD-PALETTE-ENRICH-0: jump to an app module (会话 / 计划 /
   * 技能 / 每日回顾) directly from the palette. Search itself is
   * already covered by the existing thread-search hookup, so the
   * `search` module nav id is intentionally omitted here.
   */
  onSelectModule?(selection: NavSelection): void;
  onStartPlanReminder?(): void;
}): Command[] {
  const cmds: Command[] = [
    {
      id: 'action:new-chat',
      kind: 'action',
      label: '新建对话',
      hint: '开始新的会话',
      group: '操作',
      Icon: Plus,
      keywords: ['new', 'chat', 'start', '新', '建', '对话'],
      run: args.onNewChat,
    },
    ...(args.onStartDeepResearch
      ? [{
          id: 'action:new-deep-research',
          kind: 'action' as const,
          label: '新建深度研究',
          hint: '只读探索',
          group: '操作',
          Icon: Sparkles,
          keywords: ['deep', 'research', 'explore', 'readonly', '研究', '深度', '探索', '只读'],
          run: () => args.onStartDeepResearch!(),
        }]
      : []),
    ...(args.onStartPlanReminder
      ? [{
          id: 'action:new-plan-reminder',
          kind: 'action' as const,
          label: '新建计划提醒',
          hint: '打开计划表单',
          group: '操作',
          Icon: Clock,
          keywords: ['plan', 'reminder', 'schedule', 'new', 'create', '计划', '提醒', '新建', '创建'],
          run: args.onStartPlanReminder,
        }]
      : []),
    {
      id: 'action:open-settings',
      kind: 'action',
      label: '打开设置',
      hint: '⌘,',
      group: '操作',
      Icon: SettingsIcon,
      keywords: ['settings', 'preferences', '设置', 'options'],
      run: args.onOpenSettings,
    },
    {
      id: 'action:keyboard-help',
      kind: 'action',
      label: '查看键盘快捷键',
      hint: '?',
      group: '操作',
      Icon: Keyboard,
      keywords: ['shortcuts', 'keyboard', 'help', '快捷键', '帮助'],
      run: args.onOpenShortcuts,
    },
    {
      id: 'theme:light',
      kind: 'action',
      label: '主题 · 浅色',
      hint: args.themePref === 'light' ? '当前' : undefined,
      group: '主题',
      Icon: Sun,
      keywords: ['light', 'theme', '浅色', '主题'],
      run: () => args.onSetTheme('light'),
    },
    {
      id: 'theme:dark',
      kind: 'action',
      label: '主题 · 深色',
      hint: args.themePref === 'dark' ? '当前' : undefined,
      group: '主题',
      Icon: Moon,
      keywords: ['dark', 'theme', '深色', 'night', '主题'],
      run: () => args.onSetTheme('dark'),
    },
    {
      id: 'theme:auto',
      kind: 'action',
      label: '主题 · 跟随系统',
      hint: args.themePref === 'auto' ? '当前' : undefined,
      group: '主题',
      Icon: SunMoon,
      keywords: ['auto', 'system', 'theme', '跟随', '系统', '主题'],
      run: () => args.onSetTheme('auto'),
    },
  ];

  // PR-CMD-PALETTE-ENRICH-0: app module jumps. Lets ⌘K →
  // "每日回顾" / "技能" / "计划" switch app modules without an
  // extra mouse click. Cheap to ship — pure callback wiring.
  if (args.onSelectModule) {
    const select = args.onSelectModule;
    cmds.push({
      id: 'nav:sessions',
      kind: 'action',
      label: '侧栏 · 会话',
      group: '导航',
      Icon: MessageSquare,
      keywords: ['sessions', 'chats', '会话', '对话', 'left'],
      run: () => select({ section: 'sessions', filter: 'chats' }),
    });
    cmds.push({
      id: 'nav:automations',
      kind: 'action',
      label: '侧栏 · 定时任务',
      group: '导航',
      Icon: Clock,
      keywords: ['automations', 'plan', 'reminder', 'schedule', 'cron', '定时任务', '计划', '提醒'],
      run: () => select({ section: 'automations' }),
    });
    cmds.push({
      id: 'nav:skills',
      kind: 'action',
      label: '打开 · 技能',
      group: '导航',
      Icon: Blocks,
      keywords: ['skills', '技能'],
      run: () => select({ section: 'skills' }),
    });
    cmds.push({
      id: 'nav:daily-review',
      kind: 'action',
      label: '打开 · 每日回顾',
      group: '导航',
      Icon: CalendarDays,
      keywords: ['daily', 'review', 'today', '每日', '回顾', '今天'],
      run: () => select({ section: 'daily-review' }),
    });
  }

  // One palette command per Settings section so ⌘K → label lands the user
  // directly on that page.
  for (const navItem of SETTINGS_NAV) {
    cmds.push({
      id: `settings:${navItem.id}`,
      kind: 'action',
      label: `设置 · ${navItem.label}`,
      group: '设置',
      Icon: navItem.Icon as LucideIcon,
      keywords: [navItem.id, navItem.label, 'settings', '设置'],
      run: () => args.onOpenSettingsSection(navItem.id),
    });
  }

  // Diagnostics — quick actions @kenji called out in UI-05 (palette as
  // command surface, not just navigation). Each is gated on the matching
  // host callback being provided so the palette stays useful even when
  // some IPC entry isn't wired up.
  if (args.onOpenWorkspace) {
    cmds.push({
      id: 'diag:open-workspace',
      kind: 'action',
      label: '打开工作区文件夹',
      hint: 'Finder',
      group: '诊断',
      Icon: FolderOpen,
      keywords: ['workspace', 'folder', 'open', 'finder', '工作区', '文件夹', '目录'],
      run: () => args.onOpenWorkspace!(),
    });
  }
  if (args.onOpenProjectFolder) {
    cmds.push({
      id: 'diag:open-project-folder',
      kind: 'action',
      label: '打开项目目录',
      hint: 'Finder',
      group: '诊断',
      Icon: FolderOpen,
      keywords: ['project', 'folder', 'open', 'finder', '项目', '目录', '文件夹'],
      run: () => args.onOpenProjectFolder!(),
    });
  }
  if (args.onOpenSkillsFolder) {
    cmds.push({
      id: 'diag:open-skills',
      kind: 'action',
      label: '打开 Skills 文件夹',
      hint: 'Finder',
      group: '诊断',
      Icon: FolderOpen,
      keywords: ['skills', 'folder', 'open', 'finder', '技能', '文件夹'],
      run: () => args.onOpenSkillsFolder!(),
    });
  }
  if (args.onExportActiveConversation && args.activeSessionId) {
    cmds.push({
      id: 'diag:export-conversation',
      kind: 'action',
      label: '导出当前对话为 Markdown',
      hint: '复制到剪贴板',
      group: '诊断',
      Icon: Download,
      keywords: ['export', 'markdown', 'copy', 'conversation', '导出', '对话', '剪贴板', 'md'],
      run: () => args.onExportActiveConversation!(),
    });
  }
  if (args.onSaveActiveConversationToFile && args.activeSessionId) {
    cmds.push({
      id: 'diag:save-conversation-file',
      kind: 'action',
      label: '保存当前对话为 .md 文件',
      hint: '用系统保存对话框',
      group: '诊断',
      Icon: Download,
      keywords: ['save', 'file', 'markdown', 'conversation', 'export', '保存', '文件', '对话', '导出', 'md'],
      run: () => args.onSaveActiveConversationToFile!(),
    });
  }
  if (args.onCopyTodayDailyReview) {
    cmds.push({
      id: 'diag:copy-today-daily-review',
      kind: 'action',
      label: '复制今日回顾为 Markdown',
      hint: '复制到剪贴板',
      group: '诊断',
      Icon: CalendarDays,
      keywords: ['daily', 'review', 'today', 'copy', 'markdown', '今日', '回顾', '复制', '剪贴板'],
      run: () => args.onCopyTodayDailyReview!(),
    });
  }
  if (args.onPasteTodayDailyReviewIntoComposer && args.activeSessionId) {
    cmds.push({
      id: 'diag:paste-today-daily-review',
      kind: 'action',
      label: '把今日回顾粘到 composer',
      hint: '不进剪贴板',
      group: '诊断',
      Icon: CalendarDays,
      keywords: ['daily', 'review', 'paste', 'composer', '今日', '回顾', '粘贴', '输入框'],
      run: () => args.onPasteTodayDailyReviewIntoComposer!(),
    });
  }
  if (args.onSaveTodayDailyReviewToFile) {
    cmds.push({
      id: 'diag:save-today-daily-review',
      kind: 'action',
      label: '保存今日回顾为 .md 文件',
      hint: '用系统保存对话框',
      group: '诊断',
      Icon: CalendarDays,
      keywords: ['daily', 'review', 'save', 'file', 'export', 'markdown', '今日', '回顾', '保存', '文件', '导出'],
      run: () => args.onSaveTodayDailyReviewToFile!(),
    });
  }
  if (args.onCopyEnvSummary) {
    cmds.push({
      id: 'diag:copy-env-summary',
      kind: 'action',
      label: '复制环境信息',
      hint: 'Markdown · bug report 友好',
      group: '诊断',
      Icon: Database,
      keywords: ['env', 'environment', 'version', 'about', 'bug', 'report', '环境', '版本', '关于', '诊断', '汇报'],
      run: () => args.onCopyEnvSummary!(),
    });
  }
  if (args.onTestNetworkProxy) {
    cmds.push({
      id: 'diag:test-network-proxy',
      kind: 'action',
      label: '测试当前网络代理',
      hint: '诊断 · 不打开设置',
      group: '诊断',
      Icon: Wifi,
      keywords: ['network', 'proxy', 'test', 'ping', '网络', '代理', '测试', '连接', '诊断'],
      run: () => args.onTestNetworkProxy!(),
    });
  }
  if (args.onOpenLocalMemoryFile) {
    cmds.push({
      id: 'diag:open-local-memory',
      kind: 'action',
      label: '打开本地 MEMORY.md',
      hint: '系统编辑器',
      group: '诊断',
      Icon: FolderOpen,
      keywords: ['memory', 'md', 'open', '记忆', '本地', '编辑', 'edit'],
      run: () => args.onOpenLocalMemoryFile!(),
    });
  }
  if (args.onOpenWorkspaceInstructionsFile) {
    cmds.push({
      id: 'diag:open-workspace-instructions',
      kind: 'action',
      label: '打开项目指引文件',
      hint: 'AGENTS.md / CLAUDE.md',
      group: '诊断',
      Icon: FolderOpen,
      keywords: ['workspace', 'instructions', 'agents', 'claude', 'md', 'open', '项目', '指引', '本地'],
      run: () => args.onOpenWorkspaceInstructionsFile!(),
    });
  }
  if (args.onSetPermissionMode && args.activeSessionId) {
    const setMode = args.onSetPermissionMode;
    const current = args.activePermissionMode;
    const modes: Array<{ id: PermissionMode; label: string; hintCopy: string }> = [
      { id: 'explore', label: '权限 · 只读', hintCopy: '读取和搜索直通，写入仍确认' },
      { id: 'ask', label: '权限 · 询问权限', hintCopy: '每条敏感工具都先确认（默认）' },
      { id: 'execute', label: '权限 · 自动执行', hintCopy: '常见工具直通，破坏性操作仍确认' },
      { id: 'bypass', label: '权限 · 跳过确认', hintCopy: '全部工具直通，不再弹权限确认' },
    ];
    for (const entry of modes) {
      cmds.push({
        id: `perm:set-${entry.id}`,
        kind: 'action',
        label: entry.label,
        hint: current === entry.id ? '当前' : entry.hintCopy,
        group: '权限',
        Icon: ShieldCheck,
        keywords: [entry.id, 'permission', 'mode', '权限', '模式'],
        run: () => setMode(entry.id),
      });
    }
  }
  if (args.onTestConnection && args.defaultSlug) {
    const defaultConnection = args.connections.find((c) => c.slug === args.defaultSlug);
    if (defaultConnection) {
      cmds.push({
        id: 'diag:test-default',
        kind: 'action',
        label: `测试默认连接 · ${defaultConnection.name}`,
        hint: defaultConnection.providerType,
        group: '诊断',
        Icon: Plug,
        keywords: ['test', 'connection', 'verify', '测试', '连接', '验证', 'default', '默认'],
        run: () => args.onTestConnection!(defaultConnection.slug),
      });
    }
  }

  // Per-connection: switch the default model + run a test. Useful when the
  // user has 3+ connections and doesn't want to walk through Settings ·
  // 账号 just to swap.
  if (args.onSetDefaultConnection || args.onTestConnection) {
    for (const connection of args.connections) {
      if (!connection.enabled) continue;
      const isDefault = connection.slug === args.defaultSlug;
      if (args.onSetDefaultConnection && !isDefault) {
        cmds.push({
          id: `connection:set-default:${connection.slug}`,
          kind: 'action',
          label: `设为默认 · ${connection.name}`,
          hint: connection.providerType,
          group: '连接',
          Icon: Wifi,
          keywords: ['default', 'connection', '默认', '连接', connection.name, connection.providerType],
          run: () => args.onSetDefaultConnection!(connection.slug),
        });
      }
      if (args.onTestConnection && !isDefault) {
        cmds.push({
          id: `connection:test:${connection.slug}`,
          kind: 'action',
          label: `测试连接 · ${connection.name}`,
          hint: connection.providerType,
          group: '连接',
          Icon: Plug,
          keywords: ['test', 'connection', '测试', '连接', connection.name, connection.providerType],
          run: () => args.onTestConnection!(connection.slug),
        });
      }
    }
  }

  for (const session of args.sessions) {
    if (session.isArchived) continue;
    cmds.push({
      id: `session:${session.id}`,
      kind: 'session',
      label: session.name,
      hint: session.id === args.activeSessionId ? '当前' : undefined,
      group: '会话',
      Icon: session.isFlagged ? Palette : MessageSquare,
      keywords: ['session', 'chat', session.name],
      run: () => args.onSelectSession(session.id),
    });
  }

  return cmds;
}

function fuzzy(query: string, text: string): boolean {
  // Cheap subsequence match: every char of query (lowercase) must appear in
  // order somewhere inside text (lowercase). Good enough for a palette with
  // <100 commands; we can swap in a real fuzzy matcher later.
  if (!query) return true;
  let i = 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  for (let j = 0; j < t.length && i < q.length; j += 1) {
    if (t[j] === q[i]) i += 1;
  }
  return i === q.length;
}

export function CommandPalette(props: {
  commands: Command[];
  onClose(): void;
  /**
   * Navigate to a session. Called when the user activates a content-
   * search hit so the palette can jump to the matched session and,
   * when the backend supplied one, scroll to the matched turn.
   */
  onSelectSession?: (sessionId: string, turnId?: string) => void;
  threadSearchDeps?: UseThreadSearchDeps;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const commitPendingRef = useRef(false);
  const [query, setQuery] = useState('');
  const [committedCommandId, setCommittedCommandId] = useState<string | null>(null);

  // Focus + select the search input as soon as the dialog mounts.
  // DialogContent.initialFocus points Base UI at the input for the focus
  // trap; this useEffect adds the select-all so the first keystroke
  // replaces the previous query.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // PR-SEARCH-2.6: content-search hits from local thread store. The
  // hook handles debounce, ticket-based race control, and unmount
  // safety. Query body never enters telemetry or local history.
  const threadSearch = useThreadSearch(query, props.threadSearchDeps);

  // Keystrokes stay urgent; list filtering renders at deferred priority
  // (vercel rerender-use-deferred-value) so fast typing in the palette
  // never waits on the filter + content-command list re-render.
  const deferredQuery = useDeferredValue(query);
  const filtered = useMemo(() => {
    const q = deferredQuery.trim();
    if (!q) return props.commands;
    return props.commands.filter((cmd) => {
      if (fuzzy(q, cmd.label)) return true;
      if (cmd.hint && fuzzy(q, cmd.hint)) return true;
      if (cmd.keywords && cmd.keywords.some((kw) => fuzzy(q, kw))) return true;
      return false;
    });
  }, [props.commands, deferredQuery]);

  // Build content-search commands from the hook state. These are
  // merged into the palette's command list after the existing
  // fuzzy-matched commands so the user sees actions / settings /
  // sessions first, then matched content. Single empty / blocked /
  // error tile per state.
  const contentCommands = useMemo(() => {
    return buildContentSearchCommands(threadSearch.state, props.onSelectSession);
  }, [threadSearch.state, props.onSelectSession]);

  // Combine. Filtered commands keep their existing order; content
  // commands always sit at the end so they don't disrupt muscle
  // memory for cmd-K + first-letter navigation.
  const combined = useMemo(() => [...filtered, ...contentCommands], [filtered, contentCommands]);

  const grouped = useMemo(() => groupCommands(combined), [combined]);

  function commit(cmd: Command | undefined) {
    if (!cmd) return;
    if (commitPendingRef.current) return;
    // xuan `fd675604`: disabled commands are inert. We MUST NOT fire
    // their `run()` and MUST NOT close the palette — that would make
    // a status tile (blocked / loading / error / empty) look like a
    // user action.
    if (cmd.disabled) return;
    commitPendingRef.current = true;
    setCommittedCommandId(cmd.id);
    void (async () => {
      try {
        await cmd.run();
      } finally {
        props.onClose();
      }
    })().catch(() => undefined);
  }

  return (
    <DialogRoot
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent
        className="maka-modal maka-palette-modal top-[12vh] -translate-y-0"
        aria-label="命令面板"
        initialFocus={inputRef}
      >
        {/*
          #520 PR8: Autocomplete owns the listbox/option ARIA + ArrowUp/Down/
          Enter/Escape keyboard nav (activedescendant mode). `inline` keeps the
          list in the modal body. `mode="none"` + `filter={null}` preserve the
          palette's own fuzzy + content-search filtering — Autocomplete does not
          re-filter the combined list locally. `autoHighlight="always"` so Enter
          on the first command works without an extra ArrowDown.
        */}
        <Autocomplete.Root
          inline
          open
          mode="none"
          autoHighlight="always"
          keepHighlight
          filter={null}
          value={query}
          onValueChange={(next, details) => {
            // item-press (click / Enter on highlighted) is a selection, not
            // input — never write the command object back into the query.
            if (details.reason === 'item-press') return;
            setQuery(next);
          }}
          itemToStringValue={(cmd) => cmd.label}
          items={combined}
        >
          <InputGroup
            className="maka-palette-input-wrap"
            aria-label="命令面板搜索"
            onMouseDown={(event) => {
              const target = event.target as HTMLElement;
              if (target.closest('input')) return;
              event.preventDefault();
              inputRef.current?.focus();
            }}
          >
            <Autocomplete.Input
              render={
                <InputGroupInput
                  ref={inputRef}
                  className="maka-palette-input"
                  type="text"
                  placeholder="搜索命令、设置项或会话…"
                  aria-label="搜索命令、设置项或会话"
                  autoComplete="off"
                  spellCheck={false}
                />
              }
            />
          </InputGroup>
          <Autocomplete.List className="maka-palette-list" id="maka-palette-list" aria-label="命令面板结果">
            {grouped.length === 0 ? (
              <Empty className="maka-palette-empty py-8 md:py-10 gap-3">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Search aria-hidden="true" />
                  </EmptyMedia>
                  <EmptyTitle>没有匹配的命令</EmptyTitle>
                  <EmptyDescription>换个关键词，或按 Esc 关闭。</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              grouped.map((group) => (
                <Autocomplete.Group key={group.label} className="maka-palette-group">
                  <Autocomplete.GroupLabel className="maka-palette-group-label">
                    {group.label}
                  </Autocomplete.GroupLabel>
                  {group.items.map((entry) => {
                    const cmd = entry.command;
                    const commandCommitPending = committedCommandId === cmd.id;
                    return (
                      <Autocomplete.Item
                        key={cmd.id}
                        value={cmd}
                        index={entry.index}
                        onClick={() => commit(cmd)}
                        disabled={cmd.disabled}
                        aria-busy={commandCommitPending ? 'true' : undefined}
                        data-disabled={cmd.disabled ? 'true' : undefined}
                        data-pending={commandCommitPending ? 'true' : undefined}
                        className="maka-palette-item"
                      >
                        <span className="maka-palette-icon" aria-hidden="true">
                          <cmd.Icon size={15} />
                        </span>
                        <span className="maka-palette-label">{cmd.label}</span>
                        {cmd.hint && (
                          <span className="maka-palette-hint">
                            {cmd.hint}
                            <ChevronRight size={12} aria-hidden="true" />
                          </span>
                        )}
                        {!cmd.hint && (
                          <span className="maka-palette-hint maka-palette-cursor" aria-hidden="true">
                            <CornerDownLeft size={12} />
                          </span>
                        )}
                      </Autocomplete.Item>
                    );
                  })}
                </Autocomplete.Group>
              ))
            )}
          </Autocomplete.List>
        </Autocomplete.Root>
        <div className="maka-palette-footer">
          <span>
            <KbdGroup className="maka-shortcut-group">
              <Kbd className="maka-shortcut-kbd">↑</Kbd>
              <Kbd className="maka-shortcut-kbd">↓</Kbd>
            </KbdGroup>
            选择
          </span>
          <span>{PALETTE_DELIM}</span>
          <span><Kbd className="maka-shortcut-kbd">↵</Kbd> 执行</span>
          <span>{PALETTE_DELIM}</span>
          <span><Kbd className="maka-shortcut-kbd">Esc</Kbd> 关闭</span>
        </div>
      </DialogContent>
    </DialogRoot>
  );
}

function groupCommands(commands: Command[]): Array<{ label: string; items: Array<{ command: Command; index: number }> }> {
  const order: string[] = [];
  const map = new Map<string, Array<{ command: Command; index: number }>>();
  commands.forEach((command, index) => {
    if (!map.has(command.group)) {
      map.set(command.group, []);
      order.push(command.group);
    }
    map.get(command.group)!.push({ command, index });
  });
  return order.map((label) => ({ label, items: map.get(label)! }));
}

// `buildContentSearchCommands` moved to
// `./command-palette-content-search` so it can be unit-tested without
// JSX compilation. Re-exported via the explicit `export { ... }` at
// the top of this file.
