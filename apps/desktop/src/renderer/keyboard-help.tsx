// apps/desktop/src/renderer/keyboard-help.tsx
//
// Discoverable keyboard cheat sheet. Modal triggered by `?` (when no input is
// focused) or `⌘/` / `Ctrl+/`. Lists every shortcut the renderer reacts to so
// users don't need to scrape the README. Routed through Base UI Dialog
// (DialogRoot + DialogContent) so focus trapping, Esc, and focus restoration
// are handled by the same shell as SearchModal / Permission (#520 PR7).

import { useEffect, useState } from 'react';
import { Keyboard, X } from '@maka/ui/icons';
import { Button, DialogContent, DialogRoot, Kbd } from '@maka/ui';

type Section = {
  heading: string;
  rows: Array<{ keys: string[]; description: string }>;
};

const SHORTCUTS: Section[] = [
  {
    heading: '通用',
    rows: [
      { keys: ['⌘', 'K'], description: '打开命令面板（跳会话 / 设置 / 主题等）' },
      { keys: ['?'], description: '打开 / 关闭此快捷键面板' },
      { keys: ['⌘', ','], description: '打开设置' },
      { keys: ['Esc'], description: '关闭当前模态框' },
    ],
  },
  {
    heading: 'Composer 输入',
    rows: [
      { keys: ['Enter'], description: '发送消息' },
      { keys: ['Shift', 'Enter'], description: '插入换行' },
      { keys: ['Alt', 'Enter'], description: '插入换行（备用）' },
    ],
  },
  {
    heading: '会话列表',
    rows: [
      { keys: ['Tab'], description: '在会话与导航之间移动焦点' },
      { keys: ['↑', '↓'], description: '上下移动聚焦的会话' },
      { keys: ['Home', 'End'], description: '跳到列表顶部 / 底部' },
      { keys: ['←', '→'], description: 'Chats / 已标记 / 已归档 之间循环切换' },
      { keys: ['Enter'], description: '打开聚焦的会话' },
      { keys: ['Delete'], description: '弹出删除确认（永远不静默删除）' },
      { keys: ['F'], description: '聚焦会话列表搜索框（按 Esc 清空）' },
    ],
  },
  {
    heading: '聊天区',
    rows: [
      { keys: ['Tab'], description: '聚焦工具活动 / Copy 按钮' },
      { keys: ['Space', 'Enter'], description: '展开 / 折叠工具调用' },
    ],
  },
  {
    heading: '面板调整',
    rows: [
      { keys: ['Tab'], description: '聚焦左右分割条' },
      { keys: ['←', '→'], description: '微调会话列表宽度（±10 px）' },
      { keys: ['Shift', '←', '→'], description: '快速调整（±50 px）' },
      { keys: ['Home', 'End'], description: '直接拉到最小 / 最大宽度' },
    ],
  },
];

/**
 * Manages the global key listener that opens and closes the help modal.
 * Returned tuple gives callers the current open state and an imperative
 * close function for the rendered modal.
 */
/**
 * Manages the global key listener that opens and closes the help modal.
 *
 * PR-UX-POLISH-1 commit 4 (WAWQAQ msg `e0dbad11` + kenji msg
 * `2844f64f`): the `openHelp` third tuple element added in commit
 * 2 is RETAINED — the Command Palette `查看快捷键` entry uses it
 * to open the modal without dispatching synthetic KeyboardEvent's.
 * The sidebar chip that originally needed it is removed; the
 * Command Palette is the new caller.
 */
export function useKeyboardHelp(): [boolean, () => void, () => void] {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey) {
        if (event.key === '/' || event.key === '?') {
          event.preventDefault();
          setOpen((prev) => !prev);
        }
        return;
      }
      if (event.key !== '?') return;
      // Skip if the user is typing in a text field so `?` still types.
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return;
      }
      event.preventDefault();
      setOpen(true);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return [open, () => setOpen(false), () => setOpen(true)];
}

export function KeyboardHelpModal(props: { onClose(): void }) {
  return (
    <DialogRoot
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent
        className="maka-modal maka-help-modal"
        aria-labelledby="maka-help-title"
        showClose={false}
      >
        <div className="maka-modal-header maka-help-header">
          <div>
            <span className="maka-help-eyebrow" aria-hidden="true">
              <Keyboard size={14} />
              <span>键盘快捷键</span>
            </span>
            <h2 className="maka-modal-title" id="maka-help-title">所有可用快捷键</h2>
          </div>
          <Button
            type="button"
            className="settingsCloseButton"
            variant="quiet"
            size="icon-sm"
            aria-label="关闭快捷键面板"
            onClick={props.onClose}
          >
            <X aria-hidden="true" />
          </Button>
        </div>
        <div className="maka-modal-body maka-help-body">
          {SHORTCUTS.map((section) => (
            <section key={section.heading} className="maka-help-section">
              <h3>{section.heading}</h3>
              <dl>
                {section.rows.map((row) => (
                  <div key={row.description}>
                    <dt>{row.description}</dt>
                    <dd>
                      {row.keys.map((key, index) => (
                        <span key={`${row.description}:${key}:${index}`}>
                          {index > 0 && <span className="maka-help-plus" aria-hidden="true">+</span>}
                          <Kbd className="maka-shortcut-kbd">{key}</Kbd>
                        </span>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </DialogContent>
    </DialogRoot>
  );
}
