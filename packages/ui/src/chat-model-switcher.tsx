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
import { Button as UiButton } from './ui.js';
import { ModelPicker } from './model-picker.js';
import { Settings } from './icons.js';
import {
  type ChatModelChoice,
  modelMenuGroups,
  modelChoiceValue,
  parseModelChoiceValue,
} from './chat-model-helpers.js';
import { type ProviderType, type SessionSummary } from '@maka/core';

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
  // Render the catalog display label when the current model is a known
  // choice; account / connection names still stay out of the trigger to
  // avoid OAuth email leaks.
  const currentLabel = useMemo(
    () => props.choices.find((choice) => modelChoiceValue(choice.connectionSlug, choice.model) === currentValue)?.label ?? currentModel,
    [currentModel, currentValue, props.choices],
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
      <ModelPicker
        groups={grouped}
        value={currentValue}
        disabled={disabled}
        renderProviderMark={props.renderProviderMark}
        ariaLabel="切换当前会话模型"
        title={title}
        triggerClassName="maka-model-switcher-trigger"
        // PR-CHAT-CHROME-FIX-0 (WAWQAQ msg `ccce4a31`): menu rows show only
        // the raw model name, never the connection/account name (which
        // embeds the OAuth email).
        pinnedItem={!currentKnownChoice ? { value: currentValue, label: currentModel } : undefined}
        onValueChange={(value) => {
          if (pendingRef.current || props.pending) return;
          const next = parseModelChoiceValue(value);
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
        <span className="maka-model-switcher-label">{pending ? '切换中' : '模型'}</span>
        <span className="maka-model-switcher-value">{currentLabel}</span>
      </ModelPicker>
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
    <ModelPicker
      groups={grouped}
      value={props.currentValue ?? ''}
      renderProviderMark={props.renderProviderMark}
      ariaLabel={`选择新对话模型，当前 ${props.label}`}
      title={`新对话使用的模型：${props.label}`}
      triggerClassName="maka-composer-model-chip"
      onValueChange={(value) => {
        const next = parseModelChoiceValue(value);
        if (next) void props.onPick(next);
      }}
    >
      <span className="maka-composer-model-chip-text">{props.label}</span>
      <span className="maka-composer-model-status" aria-hidden="true" />
      {/* ModelPicker's trigger already renders a chevron — no manual one. */}
    </ModelPicker>
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
