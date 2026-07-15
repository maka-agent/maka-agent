import { useMemo, useState } from 'react';
import type { LlmConnection, SessionSummary, SettingsSection, ThinkingLevel } from '@maka/core';
import { thinkingVariantsForModel } from '@maka/core';
import type { ChatModelChoice } from '@maka/ui';
import { deriveSessionHealthNotice } from './session-health-notice';
import { pickCatalogDefaultChatModel } from './model-catalog-choices';
import { buildChatModelChoices, chatModelChoiceLabel, normalizeActiveChatModel } from './chat-model-selection';
import type { ComposerDefaults } from './composer-defaults';

type NewChatModel = { llmConnectionSlug: string; model: string };

export type SessionHealthNoticeView = {
  tone: 'info' | 'warning' | 'destructive';
  label: string;
  tooltip?: string;
  onClick(): void;
  onClickTarget: 'models' | 'account';
};

/**
 * Owns every value the chat header + composer derive from the LLM-connection
 * list and the active session: the resolved active connection/model labels,
 * the shared model-choice list, the home / empty-state new-chat model + its
 * sticky pick, the thinking-variant lists, and the hard-only session health
 * notice (#1032).
 *
 * Pure move out of AppShell — every memo keeps its exact dependency array (so
 * `chatModelChoices` / `activeThinkingLevels` / `newChatThinkingLevels` retain
 * their referential-stability behavior) and the sticky-pick validation still
 * drops a `pendingNewChatModel` that is no longer an offered choice. The
 * `openSettingsSection` jump is injected so `sessionHealthNotice` can wrap the
 * derived click target; its memo deliberately omits the injected handler from
 * the dep array (see the inline note).
 */
export function useShellChatModel(options: {
  connections: LlmConnection[];
  defaultConnection: string | null;
  activeSession: SessionSummary | undefined;
  persistedComposerDefaults: ComposerDefaults | null;
  openSettingsSection: (section: SettingsSection) => void;
}): {
  chatModelChoices: ChatModelChoice[];
  activeConnection: LlmConnection | undefined;
  activeConnectionLabel: string | undefined;
  activeModel: string | undefined;
  activeModelLabel: string | undefined;
  activeThinkingLevels: readonly ThinkingLevel[];
  activeThinkingLevel: ThinkingLevel | undefined;
  newChatModel: NewChatModel | undefined;
  newChatModelLabel: string | undefined;
  newChatThinkingLevels: readonly ThinkingLevel[];
  newChatThinkingLevel: ThinkingLevel | undefined;
  validPendingNewChatModel: NewChatModel | null;
  pendingNewChatModel: NewChatModel | null;
  setPendingNewChatModel: (next: NewChatModel | null) => void;
  pendingNewChatThinkingLevel: ThinkingLevel | null;
  setPendingNewChatThinkingLevel: (next: ThinkingLevel | null) => void;
  sessionHealthNotice: SessionHealthNoticeView | undefined;
} {
  const { connections, defaultConnection, activeSession, persistedComposerDefaults, openSettingsSection } = options;
  // Persisted composer defaults seed the empty-state model so the home view is
  // populated before the async `app:info` round-trip completes on mount.
  const [pendingNewChatModel, setPendingNewChatModel] = useState<NewChatModel | null>(
    persistedComposerDefaults?.model ?? null,
  );
  const activeConnection = activeSession
    ? connections.find((connection) => connection.slug === activeSession.llmConnectionSlug)
    : undefined;
  const defaultConnectionEntry = defaultConnection
    ? connections.find((connection) => connection.slug === defaultConnection)
    : undefined;
  const chatModelChoices = useMemo<ChatModelChoice[]>(
    () => buildChatModelChoices(connections),
    [connections],
  );
  // Home / empty-state composer: which model the next NEW chat starts with.
  // Null = follow the default connection; a pick overrides it (sticky until
  // changed) and is forwarded to sessions.create in `send()`. Renderer-only —
  // it never mutates the persisted Settings · 模型 default.
  const [pendingNewChatThinkingLevel, setPendingNewChatThinkingLevel] = useState<ThinkingLevel | null>(null);
  // A pick only stays in effect while it is still an offered choice. If the user
  // later disables/removes that connection or model, fall back to the default so
  // the home chip never shows — nor sends — a model that no longer exists.
  const validPendingNewChatModel =
    pendingNewChatModel &&
    chatModelChoices.some(
      (c) => c.connectionSlug === pendingNewChatModel.llmConnectionSlug && c.model === pendingNewChatModel.model,
    )
      ? pendingNewChatModel
      : null;
  const catalogDefaultNewChatModel = defaultConnectionEntry
    ? pickCatalogDefaultChatModel(defaultConnectionEntry)
    : undefined;
  const newChatModel = validPendingNewChatModel ?? catalogDefaultNewChatModel;
  const activeConnectionLabel = activeSession?.backend === 'fake'
    ? '本地模拟连接'
    : activeConnection?.name ?? activeSession?.llmConnectionSlug;
  const activeModel = activeSession?.backend === 'fake'
    ? undefined
    : normalizeActiveChatModel(activeSession, activeConnection, chatModelChoices);
  const activeModelLabel = activeSession?.backend === 'fake'
    ? undefined
    : chatModelChoiceLabel(chatModelChoices, activeSession?.llmConnectionSlug, activeModel);
  const activeThinkingLevels = useMemo(
    () => (activeConnection && activeModel) ? thinkingVariantsForModel(activeConnection.providerType, activeModel) : [],
    [activeConnection, activeModel],
  );
  // Only surface a stored level when the current model still supports it;
  // if the model changed (setModel clears it) or the catalog reconfigured so
  // the level is no longer offered, the chip falls back to 默认 instead of
  // advertising a level the runtime would silently drop. The runtime's
  // `buildProviderOptions` is the wire-level guard; this keeps the UI honest.
  const activeThinkingLevel =
    activeSession?.thinkingLevel && activeThinkingLevels.includes(activeSession.thinkingLevel)
      ? activeSession.thinkingLevel
      : undefined;
  const newChatThinkingLevels = useMemo(
    () => {
      if (!newChatModel) return [];
      const c = connections.find((entry) => entry.slug === newChatModel.llmConnectionSlug);
      return c ? thinkingVariantsForModel(c.providerType, newChatModel.model) : [];
    },
    [newChatModel, connections],
  );
  const newChatThinkingLevel = pendingNewChatThinkingLevel && newChatThinkingLevels.includes(pendingNewChatThinkingLevel)
    ? pendingNewChatThinkingLevel
    : undefined;
  const newChatModelLabel = chatModelChoiceLabel(chatModelChoices, newChatModel?.llmConnectionSlug, newChatModel?.model);

  // Cheap renderer-side "is the default connection plausibly ready" check —
  // used only as a display filter for hard-only health notices (#1032). Soft
  // rebind cases stay silent when this is true; backend remains authoritative
  // at send time for missing_api_key / missing_model / etc.
  const defaultConnectionReady = useMemo(() => {
    if (!defaultConnection) return false;
    const entry = connections.find((connection) => connection.slug === defaultConnection);
    return entry?.enabled === true;
  }, [defaultConnection, connections]);

  // Notice derivation is a pure function (see `session-health-notice.ts`); we
  // wrap the returned `onClickTarget` here with the Settings-jump action.
  const sessionHealthNotice = useMemo<SessionHealthNoticeView | undefined>(() => {
    const derived = deriveSessionHealthNotice({
      backend: activeSession?.backend,
      hasActiveConnection: Boolean(activeConnection),
      defaultConnectionReady,
      lastTestStatus: activeConnection?.lastTestStatus,
    });
    if (!derived) return undefined;
    const target = derived.onClickTarget;
    return {
      tone: derived.tone,
      label: derived.label,
      ...(derived.tooltip ? { tooltip: derived.tooltip } : {}),
      onClickTarget: target,
      onClick: () => openSettingsSection(target),
    };
    // openSettingsSection is stable enough for our purposes — main.tsx
    // doesn't depend on it changing, and including it would force the
    // effect to re-create on every render due to its function identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeSession?.id,
    activeSession?.backend,
    activeConnection?.slug,
    activeConnection?.lastTestStatus,
    defaultConnectionReady,
  ]);

  return {
    chatModelChoices,
    activeConnection,
    activeConnectionLabel,
    activeModel,
    activeModelLabel,
    activeThinkingLevels,
    activeThinkingLevel,
    newChatModel,
    newChatModelLabel,
    newChatThinkingLevels,
    newChatThinkingLevel,
    validPendingNewChatModel,
    pendingNewChatModel,
    setPendingNewChatModel,
    pendingNewChatThinkingLevel,
    setPendingNewChatThinkingLevel,
    sessionHealthNotice,
  };
}
