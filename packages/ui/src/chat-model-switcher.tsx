/**
 * Chat model pickers, extracted from `components.tsx`.
 *
 * `ChatModelSwitcher` (in-session) and `NewChatModelPicker` (home / empty
 * state) were ~200 lines of Select JSX living next to the Composer in the
 * 8k-line `components.tsx`. They are consumed only by the Composer and share
 * the `ModelChoiceOptions` list body plus the pure codecs in
 * `chat-model-helpers.ts`, so they form a clean seam. Behavior is unchanged
 * by the move; `index.ts` does not re-export them (they are internal to the
 * `@maka/ui` Composer surface).
 */

import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import {
  Button as UiButton,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectList,
  SelectPopup,
  SelectPortal,
  SelectPositioner,
  SelectRoot,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from './ui.js';
import { Settings } from './icons.js';
import {
  type ChatModelChoice,
  type ModelMenuGroup,
  modelMenuGroups,
  modelChoiceValue,
  parseModelChoiceValue,
} from './chat-model-helpers.js';
import { type ProviderType, type SessionSummary } from '@maka/core';

/**
 * Shared grouped option rows for both model pickers: one `<SelectItem>` per
 * model, grouped under a leak-safe heading from `modelMenuGroups` — the short
 * provider label, disambiguated by connection slug when the same provider has
 * multiple connections. The heading never derives from the connection name
 * (which embeds the OAuth account email). Its brand mark is injected by the
 * desktop app via `renderProviderMark` so `@maka/ui` stays free of the provider
 * SVG library. Headings + rows wear the shared `.settingsSelectMenu*` recipe so
 * the menu reads as the governed grouped form; the selected-row check is the
 * `SelectItem` primitive's built-in `ItemIndicator`.
 */
function ModelChoiceOptions({
  groups,
  renderProviderMark,
}: {
  groups: ModelMenuGroup[];
  renderProviderMark?: (type: ProviderType) => ReactNode;
}) {
  return (
    <>
      {groups.map((group) => {
        const logo = renderProviderMark?.(group.providerType);
        return (
          <SelectGroup key={group.connectionSlug}>
            <SelectGroupLabel className="settingsSelectMenuGroupLabel">
              {logo ? (
                <span className="settingsSelectMenuGroupLogo" aria-hidden="true">{logo}</span>
              ) : (
                <span aria-hidden="true" />
              )}
              <span>{group.heading}</span>
            </SelectGroupLabel>
            {group.choices.map((choice) => {
              const value = modelChoiceValue(choice.connectionSlug, choice.model);
              return (
                <SelectItem key={value} value={value}>
                  <span className="settingsSelectMenuOption">{choice.label}</span>
                </SelectItem>
              );
            })}
          </SelectGroup>
        );
      })}
    </>
  );
}

export function ChatModelSwitcher(props: {
  activeSession: SessionSummary;
  activeModel?: string;
  activeConnectionLabel?: string;
  activeModelLabel?: string;
  choices: ChatModelChoice[];
  pending?: boolean;
  disabledReason?: string;
  renderProviderMark?(type: ProviderType): ReactNode;
  onChange?(input: { llmConnectionSlug: string; model: string }): void | Promise<void>;
}) {
  const [localPending, setLocalPending] = useState(false);
  const pendingRef = useRef(false);
  const modelSwitcherMountedRef = useRef(true);
  const pendingModelChangeRef = useRef<{ sessionId: string; token: number } | null>(null);
  const pendingModelChangeTokenRef = useRef(0);
  const currentModel = props.activeModel ?? props.activeSession.model;
  const currentValue = modelChoiceValue(props.activeSession.llmConnectionSlug, currentModel);
  const pending = props.pending || localPending;
  const disabled = pending || Boolean(props.disabledReason) || !props.onChange || props.choices.length === 0;
  const grouped = modelMenuGroups(props.choices);
  const currentKnownChoice = props.choices.some((choice) => modelChoiceValue(choice.connectionSlug, choice.model) === currentValue);
  const modelSelectItems = useMemo(
    () => [
      // Keep the Select value as the stable model id, but render the
      // catalog display label when present. Account / connection names
      // still stay out of the option row to avoid OAuth email leaks.
      ...(!currentKnownChoice ? [{ value: currentValue, label: currentModel }] : []),
      ...props.choices.map((choice) => ({
        value: modelChoiceValue(choice.connectionSlug, choice.model),
        label: choice.label,
      })),
    ],
    [currentKnownChoice, currentModel, currentValue, props.choices],
  );
  const currentSessionModelTitle = props.activeConnectionLabel && props.activeModelLabel
    ? `本会话固定模型：${props.activeConnectionLabel} · ${props.activeModelLabel}`
    : '切换当前会话使用的模型';
  const title = pending
    ? '正在切换当前会话模型…'
    : props.disabledReason ?? `${currentSessionModelTitle}。设置里的默认模型只影响新建会话；这里会更新当前会话。`;

  useEffect(() => {
    modelSwitcherMountedRef.current = true;
    return () => {
      modelSwitcherMountedRef.current = false;
      pendingModelChangeRef.current = null;
      pendingModelChangeTokenRef.current += 1;
      pendingRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (pendingModelChangeRef.current?.sessionId === props.activeSession.id) return;
    pendingModelChangeRef.current = null;
    pendingModelChangeTokenRef.current += 1;
    pendingRef.current = false;
    setLocalPending(false);
  }, [props.activeSession.id]);

  return (
    <div
      className="maka-model-switcher"
      title={title}
      data-disabled={disabled ? 'true' : undefined}
      data-pending={pending ? 'true' : undefined}
      aria-busy={pending ? 'true' : undefined}
    >
      <SelectRoot<string>
        items={modelSelectItems}
        value={currentValue}
        disabled={disabled}
        onValueChange={(value) => {
          if (pendingRef.current || props.pending) return;
          const next = typeof value === 'string' ? parseModelChoiceValue(value) : undefined;
          if (!next) return;
          if (
            next.llmConnectionSlug === props.activeSession.llmConnectionSlug &&
            next.model === currentModel
          ) {
            return;
          }
          const sessionId = props.activeSession.id;
          const token = pendingModelChangeTokenRef.current + 1;
          pendingModelChangeTokenRef.current = token;
          pendingModelChangeRef.current = { sessionId, token };
          pendingRef.current = true;
          setLocalPending(true);
          void (async () => {
            try {
              await props.onChange?.(next);
            } catch {
              // The AppShell action owner reports the visible model-switch failure.
            } finally {
              const owner = pendingModelChangeRef.current;
              if (modelSwitcherMountedRef.current && owner?.sessionId === sessionId && owner.token === token) {
                pendingModelChangeRef.current = null;
                pendingRef.current = false;
                setLocalPending(false);
              }
            }
          })();
        }}
      >
        <SelectTrigger
          className="maka-model-switcher-trigger"
          aria-label="切换当前会话模型"
          title={title}
        >
          <span className="maka-model-switcher-label">{pending ? '切换中' : '模型'}</span>
          <SelectValue className="maka-model-switcher-value" />
        </SelectTrigger>
        <SelectPortal>
          <SelectPositioner alignItemWithTrigger={false} sideOffset={8} className="settingsSelectPositioner">
            <SelectPopup className="settingsSelectMenuPopup">
              {/* PR-CHAT-CHROME-FIX-0 (WAWQAQ msg `ccce4a31`):
                   menu rows show only the raw model name. The
                   group label (connection + email) and the meta
                   line (duplicate model id) used to render below
                   each row but produced "Codex OAuth ·
                   kabikabigoog@gmail.com / gpt-5.5 / gpt-5.5" —
                   user wanted just "gpt-5.5". Groups still
                   separate connections visually via
                   `<SelectSeparator>` between them. */}
              <SelectList>
                {!currentKnownChoice && (
                  <>
                    <SelectItem value={currentValue}>
                      <span className="settingsSelectMenuOption">{currentModel}</span>
                    </SelectItem>
                    {grouped.length > 0 && <SelectSeparator />}
                  </>
                )}
                <ModelChoiceOptions groups={grouped} renderProviderMark={props.renderProviderMark} />
              </SelectList>
            </SelectPopup>
          </SelectPositioner>
        </SelectPortal>
      </SelectRoot>
    </div>
  );
}

/**
 * Home / empty-state model picker (no active session yet). Unlike
 * `ChatModelSwitcher` — which is bound to a live session and switches THAT
 * session's model — this one just records which model the next new chat should
 * start with. Reuses the model chip's look so the only visible change is that
 * the chevron now actually opens a menu.
 */
export function NewChatModelPicker(props: {
  label: string;
  choices: ChatModelChoice[];
  currentValue?: string;
  renderProviderMark?(type: ProviderType): ReactNode;
  onPick(input: { llmConnectionSlug: string; model: string }): void | Promise<void>;
}) {
  const grouped = modelMenuGroups(props.choices);
  return (
    <SelectRoot<string>
      items={props.choices.map((choice) => ({
        value: modelChoiceValue(choice.connectionSlug, choice.model),
        label: choice.label,
      }))}
      value={props.currentValue}
      onValueChange={(value) => {
        if (typeof value !== 'string') return;
        const next = parseModelChoiceValue(value);
        if (next) void props.onPick(next);
      }}
    >
      <SelectTrigger
        className="maka-composer-model-chip"
        aria-label={`选择新对话模型，当前 ${props.label}`}
        title={`新对话使用的模型：${props.label}`}
      >
        <span className="maka-composer-model-chip-text">{props.label}</span>
        <span className="maka-composer-model-status" aria-hidden="true" />
        {/* SelectTrigger already renders a BaseSelect.Icon chevron — no manual one. */}
      </SelectTrigger>
      <SelectPortal>
        <SelectPositioner alignItemWithTrigger={false} sideOffset={8} className="settingsSelectPositioner">
          <SelectPopup className="settingsSelectMenuPopup">
            <SelectList>
              <ModelChoiceOptions groups={grouped} renderProviderMark={props.renderProviderMark} />
            </SelectList>
          </SelectPopup>
        </SelectPositioner>
      </SelectPortal>
    </SelectRoot>
  );
}

/**
 * Non-interactive model chip for the composer's empty state: no active
 * session and no models to pick from yet. Replaces a former inline `<span>`
 * that wore a dropdown chevron it could not honor. When `onOpenSettings` is
 * given it becomes an honest button into Settings · 模型 (with a gear, no fake
 * chevron); otherwise it is plain inert text. Shares the `.maka-composer-model-chip`
 * look with `NewChatModelPicker` so the chip reads identically across states.
 */
export function ModelChipStatic(props: { label: string; onOpenSettings?: () => void }) {
  if (props.onOpenSettings) {
    return (
      <UiButton
        type="button"
        variant="quiet"
        size="nav"
        className="maka-composer-model-chip maka-composer-model-chip-action"
        onClick={props.onOpenSettings}
        aria-label={`配置模型连接，当前 ${props.label}`}
        title="配置模型连接"
      >
        <Settings size={12} strokeWidth={1.8} aria-hidden="true" />
        <span className="maka-composer-model-chip-text">{props.label}</span>
      </UiButton>
    );
  }
  return (
    <span className="maka-composer-model-chip" aria-label={`当前模型：${props.label}`} title={props.label}>
      <span className="maka-composer-model-chip-text">{props.label}</span>
      <span className="maka-composer-model-status" aria-hidden="true" />
    </span>
  );
}
