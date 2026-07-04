import { Check } from './icons.js';
import type { ChatDefaultPermissionMode, PermissionMode } from '@maka/core';
import { CHAT_DEFAULT_PERMISSION_MODES } from '@maka/core';
import { MenuItem, MenuPopup } from './primitives/menu.js';

export interface PermissionModeMeta {
  label: string;
  hint: string;
  tone: 'info' | 'accent' | 'destructive';
}

/**
 * PR-MOVE-PERMISSION-MODE (WAWQAQ msgs 47fe0d0e / 21993dcc / a667cf6c
 * 2026-06-23): the user-facing permission-mode picker is a three-option
 * dropdown. The `explore` (read-only) mode is not user-selectable — it
 * exists in the `PermissionMode` enum because Deep Research sessions and
 * Bot-incoming guards use it as their default; pickers collapse those
 * sessions to display 询问权限 so the user sees a coherent option.
 *
 * Labels follow WAWQAQ's a667cf6c renaming — direct, action-led copy
 * instead of engineering shorthand.
 *
 * This module is the ONE home for the mode table and the shared popup —
 * both the composer picker and Settings → 通用 → 默认权限模式 render
 * from it, so labels/hints/markup can't drift between the two surfaces.
 */
export const PERMISSION_MODE_META: Record<PermissionMode, PermissionModeMeta> = {
  explore: {
    label: '只读模式',
    hint: '只读模式：读取、列表、搜索直通，写入或网络仍需明确确认。Deep Research 默认走这档；不再出现在用户切换里。',
    tone: 'info',
  },
  ask: {
    label: '询问权限',
    hint: '每次工具调用前都弹出对话框让你确认。最稳健，适合需要盯着 agent 干活的场景。',
    tone: 'accent',
  },
  execute: {
    label: '自动执行',
    hint: '常见工具直通，破坏性操作、特权操作和浏览器操作仍会停下来确认。',
    tone: 'info',
  },
  bypass: {
    label: '跳过确认',
    hint: '跳过全部工具确认，包括破坏性操作、特权操作和浏览器操作。只在完全信任本轮任务时使用。',
    tone: 'destructive',
  },
};

/** User-selectable modes, in display order — the canonical non-`explore`
 *  list from @maka/core, aliased under the name the composer historically
 *  exported. */
export const PERMISSION_MODE_ORDER: readonly ChatDefaultPermissionMode[] = CHAT_DEFAULT_PERMISSION_MODES;

/**
 * The shared popup body: every option renders its label AND full hint up
 * front, so the user never has to select a mode to learn what it does.
 * Callers own the trigger (composer: tinted chip; Settings: outline
 * select-style button) and pass their active mode + select handler.
 */
export function PermissionModeMenuPopup(props: {
  activeMode: PermissionMode;
  onSelect(mode: ChatDefaultPermissionMode): void | Promise<void>;
  align?: 'start' | 'end';
}) {
  return (
    <MenuPopup className="maka-composer-mode-menu" align={props.align ?? 'start'}>
      {PERMISSION_MODE_ORDER.map((mode) => {
        const optionMeta = PERMISSION_MODE_META[mode];
        const active = mode === props.activeMode;
        return (
          <MenuItem
            key={mode}
            onClick={() => {
              if (active) return;
              void props.onSelect(mode);
            }}
            data-active={active}
            data-tone={optionMeta.tone}
          >
            <div className="maka-composer-mode-menu-item">
              <span className="maka-composer-mode-menu-label">{optionMeta.label}</span>
              <span className="maka-composer-mode-menu-hint">{optionMeta.hint}</span>
            </div>
            {active ? <Check size={12} strokeWidth={2} aria-hidden="true" /> : null}
          </MenuItem>
        );
      })}
    </MenuPopup>
  );
}
