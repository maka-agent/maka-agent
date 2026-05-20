// apps/desktop/src/renderer/command-palette.tsx
//
// ⌘K / Ctrl+K command palette. Combines static actions (new chat, theme
// switch, open settings, open keyboard help) with the live session list so
// the user can fuzzy-search across both. Renders as a portal-style modal
// with focus trap (via useModalA11y) and Arrow/Enter/Esc navigation.

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  ChevronRight,
  CornerDownLeft,
  Keyboard,
  MessageSquare,
  Moon,
  Palette,
  Plus,
  Settings as SettingsIcon,
  Sun,
  SunMoon,
  type LucideIcon,
} from 'lucide-react';
import type { SessionSummary, ThemePreference } from '@maka/core';
import { useModalA11y } from '@maka/ui';

export type CommandKind = 'action' | 'session';

export interface Command {
  id: string;
  kind: CommandKind;
  label: string;
  hint?: string;
  group: string;
  Icon: LucideIcon;
  keywords?: string[];
  run(): void;
}

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
  onSelectSession(id: string): void;
  onNewChat(): void;
  onOpenSettings(): void;
  onOpenShortcuts(): void;
  onSetTheme(next: ThemePreference): void;
}): Command[] {
  const cmds: Command[] = [
    {
      id: 'action:new-chat',
      kind: 'action',
      label: '新建对话',
      hint: 'New chat',
      group: '操作',
      Icon: Plus,
      keywords: ['new', 'chat', 'start', '新', '建', '对话'],
      run: args.onNewChat,
    },
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
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);

  useModalA11y(dialogRef, props.onClose);

  // Focus the search input as soon as the dialog mounts. useModalA11y will
  // pull focus to the first focusable element, which is the input.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim();
    if (!q) return props.commands;
    return props.commands.filter((cmd) => {
      if (fuzzy(q, cmd.label)) return true;
      if (cmd.hint && fuzzy(q, cmd.hint)) return true;
      if (cmd.keywords && cmd.keywords.some((kw) => fuzzy(q, kw))) return true;
      return false;
    });
  }, [props.commands, query]);

  useEffect(() => {
    // Reset highlight whenever the result set changes.
    setHighlight((current) => Math.min(current, Math.max(0, filtered.length - 1)));
  }, [filtered]);

  const grouped = useMemo(() => groupCommands(filtered), [filtered]);

  function commit(cmd: Command | undefined) {
    if (!cmd) return;
    cmd.run();
    props.onClose();
  }

  function onInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing || event.key === 'Process') return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setHighlight((current) => (filtered.length === 0 ? 0 : Math.min(filtered.length - 1, current + 1)));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlight((current) => Math.max(0, current - 1));
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      setHighlight(0);
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      setHighlight(filtered.length === 0 ? 0 : filtered.length - 1);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      commit(filtered[highlight]);
    }
  }

  return (
    <div className="maka-modal-backdrop maka-palette-backdrop" role="presentation" onClick={props.onClose}>
      <div
        ref={dialogRef}
        className="maka-modal maka-palette-modal"
        role="dialog"
        aria-modal="true"
        aria-label="命令面板"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="maka-palette-input-wrap">
          <input
            ref={inputRef}
            className="maka-palette-input"
            type="text"
            value={query}
            placeholder="搜索命令、设置项或会话…"
            onChange={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={onInputKeyDown}
            autoComplete="off"
            spellCheck={false}
            aria-controls="maka-palette-list"
            aria-activedescendant={filtered[highlight] ? `cmd-${filtered[highlight]!.id}` : undefined}
          />
          <span className="maka-palette-input-hint" aria-hidden="true">
            <kbd>↵</kbd> 执行 · <kbd>Esc</kbd> 关闭
          </span>
        </div>
        <div className="maka-palette-list" id="maka-palette-list" role="listbox">
          {grouped.length === 0 ? (
            <div className="maka-palette-empty">没有匹配的命令</div>
          ) : (
            grouped.map((group) => (
              <div key={group.label} className="maka-palette-group">
                <div className="maka-palette-group-label">{group.label}</div>
                {group.items.map((entry) => {
                  const index = entry.index;
                  const cmd = entry.command;
                  const active = index === highlight;
                  return (
                    <button
                      key={cmd.id}
                      id={`cmd-${cmd.id}`}
                      type="button"
                      role="option"
                      aria-selected={active}
                      data-active={active}
                      className="maka-palette-item"
                      onMouseEnter={() => setHighlight(index)}
                      onClick={() => commit(cmd)}
                    >
                      <span className="maka-palette-icon" aria-hidden="true">
                        <cmd.Icon size={15} strokeWidth={1.5} />
                      </span>
                      <span className="maka-palette-label">{cmd.label}</span>
                      {cmd.hint && (
                        <span className="maka-palette-hint">
                          {cmd.hint}
                          <ChevronRight size={12} strokeWidth={1.75} aria-hidden="true" />
                        </span>
                      )}
                      {!cmd.hint && active && (
                        <span className="maka-palette-hint" aria-hidden="true">
                          <CornerDownLeft size={12} strokeWidth={1.75} />
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
        <div className="maka-palette-footer">
          <span><kbd>↑</kbd><kbd>↓</kbd> 选择</span>
          <span>{PALETTE_DELIM}</span>
          <span><kbd>↵</kbd> 执行</span>
          <span>{PALETTE_DELIM}</span>
          <span><kbd>Esc</kbd> 关闭</span>
        </div>
      </div>
    </div>
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
