// apps/desktop/src/renderer/OnboardingHero.tsx
//
// First-run hero rendered above the chat surface when the workspace
// has no sessions yet (PR110c rewrite). Routes purely off the
// `OnboardingState` projection from `@maka/core/onboarding` — never
// re-derives provider readiness, never lists connections directly.
//
// @kenji + @xuan PR110c review gates:
//   - Each `OnboardingState.kind` has an explicit branch with a
//     diagnostic Chinese copy + Settings deep-link CTA. NO inline
//     editors (credential entry / model picker live in Settings).
//   - `blocked: all_connections_unhealthy` MUST have a labeled
//     fallback branch — no generic `default` swallowing it.
//   - `ready_with_history` MUST NOT render this hero (caller decides).
//   - Raw `state.kind` strings MUST NOT appear in rendered text;
//     copy is in Chinese with no enum identifier leakage.
//   - For `needs_connection_credentials` / `needs_default_model`,
//     `connectionSlug` is shown as a slug literal (no
//     `connectionName` promise) until sanitized display data is
//     wired in a later PR.

import { ArrowRight, ArrowUp, ChevronRight, RotateCcw, Sparkles, KeyRound, Settings as SettingsIcon, Cpu, AlertCircle, FolderOpen, Paperclip, X } from '@maka/ui/icons';
import { Fragment, useCallback, useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import type { LlmConnection, OnboardingState, ProviderType, QuickChatMode, SettingsSection } from '@maka/core';
import {
  Button,
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
  Textarea,
  appendPromptContextDraft,
  detectUiLocale,
  type UiLocale,
} from '@maka/ui';
import { ProviderLogo, providerDisplay } from './settings/provider-display';
import { FIRST_RUN_TASK_SUGGESTIONS } from './first-run-task-suggestions';
import { getOnboardingSetupSteps, type OnboardingSetupStep } from './onboarding-hero-copy';

/**
 * PR-UI-15 (@yuejing 2026-05-22): unify OnboardingHero quickChat
 * placeholder style with the main Composer. v1 used a long example
 * sentence as placeholder which stylistically conflicted with the
 * Composer's short action-oriented placeholder. New design: same
 * short placeholder, example sentence moved to a `<small>` hint
 * below the textarea so first-run users still know what to type.
 */
const READY_HERO_COPY_BY_LOCALE: Record<UiLocale, {
  ariaLabel: string;
  eyebrow: string;
  headline: string;
  intro: string;
  quickChatPlaceholder: string;
  quickChatAria: string;
  quickChatExample: string;
  submitIdleLabel: string;
  submitPendingLabel: string;
}> = {
  zh: {
    ariaLabel: '开始对话',
    // PR-SIDEBAR-IA-0 Phase 3 P0 fixup v2 (kenji `08be08d8`):
    // dropped the all-caps English prefix to match the Chinese-
    // first surface; en-locale entry below stays all-English.
    eyebrow: '准备就绪 · 开始对话',
    headline: '今天想让 Maka 帮你做什么？',
    intro: '下面这个输入框会用默认模型开新会话；空提交也会打开一个空会话，方便你之后再输入。',
    quickChatPlaceholder: '给 Maka 发消息…',
    quickChatAria: '快速对话输入框',
    quickChatExample: '例如：帮我读一下这个项目的目录结构，告诉我入口在哪里。',
    submitIdleLabel: '开始对话',
    submitPendingLabel: '正在创建…',
  },
  en: {
    ariaLabel: 'Start a conversation',
    eyebrow: 'READY · Start a conversation',
    headline: 'What should Maka help with today?',
    intro: 'The box below opens a new session with your default model; empty submit also opens a session so you can type later.',
    quickChatPlaceholder: 'Message Maka…',
    quickChatAria: 'Quick Chat input',
    quickChatExample: 'Example: walk me through this project\'s directory layout and where the entry point lives.',
    submitIdleLabel: 'Start chat',
    submitPendingLabel: 'Creating…',
  },
};

// Titles are PROVIDER-forward and version-free (no `GPT-4o` / `DeepSeek-V3`
// — those go stale). The row description comes from `providerDisplay` so
// copy has a single source of truth shared with Settings · 模型.
const FEATURED: Array<{ type: ProviderType; tag: string; recommended?: boolean }> = [
  { type: 'anthropic', tag: 'Claude · Anthropic', recommended: true },
  { type: 'openai', tag: 'OpenAI' },
  { type: 'zai-coding-plan', tag: 'GLM Coding Plan · Z.ai' },
  { type: 'MiniMax', tag: 'MiniMax M-series' },
  { type: 'kimi-coding-plan', tag: 'Kimi · Moonshot' },
  { type: 'deepseek', tag: 'DeepSeek' },
  { type: 'ollama', tag: 'Ollama' },
];

export interface OnboardingHeroProps {
  state: OnboardingState;
  /** Open Settings with a specific section preselected. */
  onOpenSettings: (section?: SettingsSection) => void;
  /**
   * Quick Chat submit handler (PR110b `quickChat:start`). Only
   * called from the `ready_empty` branch. The caller is responsible
   * for handling the discriminated-union result (setActiveId on
   * success, toast on `send_failed`, etc.). Returns true only after
   * the target session is created; the hero keeps the draft on false
   * so a setup/send failure does not erate the user's first prompt.
   */
  onQuickChatSubmit: (prompt: string, mode?: QuickChatMode) => boolean | Promise<boolean>;
  /**
   * Flag set when a `quickChat:start` call is in flight, so the
   * composer can disable its submit button without owning the
   * pending state itself.
   */
  quickChatPending?: boolean;
  /**
   * PR-ONBOARDING-EARLY-COPY-0: current connection list so the
   * credentials / model heroes can resolve a `connectionSlug` to a
   * human-friendly name. Optional; falls back to slug if missing.
   */
  connections?: ReadonlyArray<LlmConnection>;
  /**
   * PR-ONBOARDING-EARLY-COPY-0: refresh handler so env-bootstrap
   * users who finished their setup outside the UI can re-query
   * the snapshot without restarting. Optional.
   */
  onRefreshConnections?: () => Promise<void> | void;
  /**
   * Skip the initial onboarding and enter the app. Writes
   * `initial_onboarding` milestone as `skipped`. Only invoked from
   * the `needs_*` / `blocked` branches; `ready_empty` does not show
   * a skip button because the user is already configured.
   */
  onSkip?: () => Promise<void> | void;
  onImportDroppedTextFiles?: (files: File[]) => Promise<string | undefined>;
}

export function OnboardingHero(props: OnboardingHeroProps) {
  const { state } = props;
  const [refreshConnectionsPending, setRefreshConnectionsPending] = useState(false);
  const onboardingMountedRef = useRef(true);
  const refreshConnectionsPendingRef = useRef(false);

  useEffect(() => {
    onboardingMountedRef.current = true;
    return () => {
      onboardingMountedRef.current = false;
      refreshConnectionsPendingRef.current = false;
    };
  }, []);

  const runRefreshConnections = useCallback(async () => {
    if (!props.onRefreshConnections || refreshConnectionsPendingRef.current) return;
    refreshConnectionsPendingRef.current = true;
    setRefreshConnectionsPending(true);
    try {
      await props.onRefreshConnections();
    } finally {
      refreshConnectionsPendingRef.current = false;
      if (onboardingMountedRef.current) setRefreshConnectionsPending(false);
    }
  }, [props.onRefreshConnections]);

  switch (state.kind) {
    case 'needs_connection':
      return (
        <NeedsConnectionHero
          onOpenSettings={props.onOpenSettings}
          onRefreshConnections={props.onRefreshConnections ? runRefreshConnections : undefined}
          refreshConnectionsPending={refreshConnectionsPending}
          onSkip={props.onSkip}
        />
      );
    case 'needs_default_connection':
      return (
        <NeedsDefaultConnectionHero
          onOpenSettings={props.onOpenSettings}
          onRefreshConnections={props.onRefreshConnections ? runRefreshConnections : undefined}
          refreshConnectionsPending={refreshConnectionsPending}
          onSkip={props.onSkip}
        />
      );
    case 'needs_connection_credentials':
      return (
        <NeedsConnectionCredentialsHero
          connectionSlug={state.connectionSlug}
          connections={props.connections}
          onOpenSettings={props.onOpenSettings}
          onRefreshConnections={props.onRefreshConnections ? runRefreshConnections : undefined}
          refreshConnectionsPending={refreshConnectionsPending}
          onSkip={props.onSkip}
        />
      );
    case 'needs_default_model':
      return (
        <NeedsDefaultModelHero
          connectionSlug={state.connectionSlug}
          connections={props.connections}
          onOpenSettings={props.onOpenSettings}
          onRefreshConnections={props.onRefreshConnections ? runRefreshConnections : undefined}
          refreshConnectionsPending={refreshConnectionsPending}
          onSkip={props.onSkip}
        />
      );
    case 'ready_empty':
      return (
        <ReadyEmptyHero
          onQuickChatSubmit={props.onQuickChatSubmit}
          quickChatPending={props.quickChatPending === true}
          onImportDroppedTextFiles={props.onImportDroppedTextFiles}
        />
      );
    case 'blocked':
      // `blocked.reason` is `'all_connections_unhealthy'` in PR110a's
      // closed enum; if a future PR extends it, this assignment will
      // fail to compile (assertNever), forcing a labeled branch
      // rather than a silent fallthrough.
      return (
        <BlockedHero
          reason={state.reason}
          onOpenSettings={props.onOpenSettings}
          onRefreshConnections={props.onRefreshConnections ? runRefreshConnections : undefined}
          refreshConnectionsPending={refreshConnectionsPending}
          onSkip={props.onSkip}
        />
      );
    case 'ready_with_history':
      // The renderer caller decides which hero to render; this
      // component is only mounted when sessions.length === 0. Showing
      // ready_with_history at all means the caller bypassed the gate
      // — render nothing so the existing chat surface takes over.
      return null;
    default:
      return assertNever(state);
  }
}

/**
 * PR-ONBOARDING-EARLY-COPY-0: resolve a slug to its persisted
 * connection name. Falls back to the raw slug when the lookup misses
 * (e.g. snapshot raced ahead of the connection list refresh).
 */
function connectionLabel(
  slug: string,
  connections?: ReadonlyArray<LlmConnection>,
): { name: string; isFallback: boolean } {
  if (!connections) return { name: slug, isFallback: true };
  const match = connections.find((c) => c.slug === slug);
  if (!match || !match.name) return { name: slug, isFallback: true };
  return { name: match.name, isFallback: false };
}

function NeedsConnectionHero(props: {
  onOpenSettings: (section?: SettingsSection) => void;
  onRefreshConnections?: () => void;
  refreshConnectionsPending?: boolean;
  onSkip?: () => Promise<void> | void;
}) {
  const setupSteps = getOnboardingSetupSteps({ kind: 'needs_connection' });
  return (
    <section className="maka-onboarding maka-firstrun" aria-label="欢迎使用 Maka">
      {/* Selection-led layout: a big title sets the hierarchy, the three
          setup steps compress to one quiet stepper line (context, not the
          subject), and the provider list is the clear primary action. */}
      <h1 className="maka-firstrun-title">不只是聊天，搞定真事。</h1>
      <p className="maka-firstrun-sub">本地运行 · 自带 key · 每一步可见可控</p>

      {setupSteps && <FirstRunStepper steps={setupSteps} />}

      <div className="maka-firstrun-pick">
        <span className="maka-firstrun-pick-label">选择你的 AI</span>
        <span className="maka-firstrun-pick-hint">点一个进入设置，填它的 key</span>
      </div>

      {/* The list scrolls vertically (CSS max-height) so it scales as more
          providers are added without pushing the footer off-screen. */}
      <div className="maka-firstrun-list">
        <ul role="list">
          {FEATURED.map((entry) => {
            const display = providerDisplay(entry.type);
            return (
              <li key={entry.type}>
                <Item
                  className="maka-firstrun-row px-3.5 py-2 rounded-none"
                  render={
                    <button
                      type="button"
                      onClick={() => props.onOpenSettings('models')}
                    />
                  }
                >
                  <ItemMedia>
                    <ProviderLogo type={entry.type} compact />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>
                      {entry.tag}
                      {entry.recommended && (
                        <span className="maka-firstrun-tag">常用</span>
                      )}
                    </ItemTitle>
                    <ItemDescription>{display.description}</ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <ChevronRight size={16} aria-hidden="true" />
                  </ItemActions>
                </Item>
              </li>
            );
          })}
        </ul>
      </div>

      {/* Designer audit P2-15: the footer's primary 打开设置·模型 button
          duplicated what clicking any provider row above already does (the
          list header even says 点一个进入设置). One affordance per action —
          the footer keeps only the two genuinely distinct paths. */}
      <footer className="maka-onboarding-footer">
        {props.onRefreshConnections && (
          <Button
            type="button"
            variant="ghost"
            onClick={props.onRefreshConnections}
            disabled={props.refreshConnectionsPending === true}
            aria-busy={props.refreshConnectionsPending === true ? 'true' : undefined}
          >
            {props.refreshConnectionsPending === true ? '刷新中…' : '已经配好了？刷新检测'}
          </Button>
        )}
        {props.onSkip && <SkipButton onSkip={props.onSkip} />}
      </footer>
    </section>
  );
}

/**
 * Compact "where you are" stepper for the first-run hero: numbered nodes
 * joined by connectors, the active step lit with the brand accent and the
 * rest outlined. Stays one quiet line so the provider list keeps the lead.
 */
function FirstRunStepper({ steps }: { steps: readonly OnboardingSetupStep[] }) {
  return (
    <ol className="maka-firstrun-stepper" aria-label="配置 AI 进度">
      {steps.map((step, index) => (
        <Fragment key={`${step.label}-${index}`}>
          {index > 0 && <li className="maka-firstrun-step-line" aria-hidden="true" />}
          <li className="maka-firstrun-step" data-state={step.state}>
            <span className="maka-firstrun-step-dot" aria-hidden="true">{index + 1}</span>
            <span className="maka-firstrun-step-label">{step.label}</span>
          </li>
        </Fragment>
      ))}
    </ol>
  );
}

function NeedsDefaultConnectionHero(props: {
  onOpenSettings: (section?: SettingsSection) => void;
  onRefreshConnections?: () => void;
  refreshConnectionsPending?: boolean;
  onSkip?: () => Promise<void> | void;
}) {
  return (
    <SetupHero
      icon={<SettingsIcon size={14} aria-hidden="true" />}
      eyebrow="选择默认模型连接"
      title="选一个连接作为默认。"
      body={
        <>
          你已经配置了至少一个模型连接，但还没设为默认。请到
          <strong> 设置 · 模型 </strong>
          挑一个作为默认连接，再开始对话。
        </>
      }
      setupSteps={getOnboardingSetupSteps({ kind: 'needs_default_connection' })}
      primaryCta={{ label: '打开设置 · 模型', onClick: () => props.onOpenSettings('models') }}
      secondaryCta={
        props.onRefreshConnections
          ? {
            label: props.refreshConnectionsPending === true ? '刷新中…' : '已经设好了？刷新检测',
            onClick: props.onRefreshConnections,
            disabled: props.refreshConnectionsPending === true,
            busy: props.refreshConnectionsPending === true,
          }
          : undefined
      }
      onSkip={props.onSkip}
    />
  );
}

function NeedsConnectionCredentialsHero(props: {
  connectionSlug: string;
  connections?: ReadonlyArray<LlmConnection>;
  onOpenSettings: (section?: SettingsSection) => void;
  onRefreshConnections?: () => void;
  refreshConnectionsPending?: boolean;
  onSkip?: () => Promise<void> | void;
}) {
  const { name, isFallback } = connectionLabel(props.connectionSlug, props.connections);
  return (
    <SetupHero
      icon={<KeyRound size={14} aria-hidden="true" />}
      eyebrow="补齐凭据"
      title="这个连接还缺 API key。"
      body={
        <>
          默认连接{' '}
          {isFallback ? (
            <code className="maka-onboarding-slug">{name}</code>
          ) : (
            <strong>{name}</strong>
          )}
          {' '}没有可用的凭据 —— 不是模型坏了，是 key 还没填。请到
          <strong> 设置 · 模型</strong> 打开该连接，把 API key 补上再开始对话。
        </>
      }
      setupSteps={getOnboardingSetupSteps({
        kind: 'needs_connection_credentials',
        connectionSlug: props.connectionSlug,
      })}
      primaryCta={{ label: '打开设置 · 模型', onClick: () => props.onOpenSettings('models') }}
      secondaryCta={
        props.onRefreshConnections
          ? {
            label: props.refreshConnectionsPending === true ? '刷新中…' : '已经填好了？刷新检测',
            onClick: props.onRefreshConnections,
            disabled: props.refreshConnectionsPending === true,
            busy: props.refreshConnectionsPending === true,
          }
          : undefined
      }
      onSkip={props.onSkip}
    />
  );
}

function NeedsDefaultModelHero(props: {
  connectionSlug: string;
  connections?: ReadonlyArray<LlmConnection>;
  onOpenSettings: (section?: SettingsSection) => void;
  onRefreshConnections?: () => void;
  refreshConnectionsPending?: boolean;
  onSkip?: () => Promise<void> | void;
}) {
  const { name, isFallback } = connectionLabel(props.connectionSlug, props.connections);
  return (
    <SetupHero
      icon={<Cpu size={14} aria-hidden="true" />}
      eyebrow="选择默认模型"
      title="这个连接还没选默认模型。"
      body={
        <>
          连接{' '}
          {isFallback ? (
            <code className="maka-onboarding-slug">{name}</code>
          ) : (
            <strong>{name}</strong>
          )}
          {' '}已经接好了，但还没绑定可发起对话的默认模型。请到 <strong>设置 · 模型</strong>
          {' '}给它选一个模型，再回来开始对话。
        </>
      }
      setupSteps={getOnboardingSetupSteps({
        kind: 'needs_default_model',
        connectionSlug: props.connectionSlug,
      })}
      primaryCta={{ label: '打开设置 · 模型', onClick: () => props.onOpenSettings('models') }}
      secondaryCta={
        props.onRefreshConnections
          ? {
            label: props.refreshConnectionsPending === true ? '刷新中…' : '已经选好了？刷新检测',
            onClick: props.onRefreshConnections,
            disabled: props.refreshConnectionsPending === true,
            busy: props.refreshConnectionsPending === true,
          }
          : undefined
      }
      onSkip={props.onSkip}
    />
  );
}

function BlockedHero(props: {
  reason: 'all_connections_unhealthy';
  onOpenSettings: (section?: SettingsSection) => void;
  onRefreshConnections?: () => void;
  refreshConnectionsPending?: boolean;
  onSkip?: () => Promise<void> | void;
}) {
  // The reason is destructured to satisfy exhaustive type-checking;
  // when PR-future extends the enum, this branch must update too.
  void props.reason;
  return (
    <SetupHero
      icon={<AlertCircle size={14} aria-hidden="true" />}
      eyebrow="等待恢复模型连接"
      title="当前没有通过验证的模型连接。"
      body={
        <>
          打开 <strong>设置 · 账号</strong> 查看每个连接的状态，
          重新测试或重新登录后再开始对话。
        </>
      }
      setupSteps={getOnboardingSetupSteps({
        kind: 'blocked',
        reason: props.reason,
      })}
      primaryCta={{ label: '打开设置 · 账号', onClick: () => props.onOpenSettings('account') }}
      secondaryCta={
        props.onRefreshConnections
          ? {
            label: props.refreshConnectionsPending === true ? '刷新中…' : '已经修好了？刷新检测',
            onClick: props.onRefreshConnections,
            disabled: props.refreshConnectionsPending === true,
            busy: props.refreshConnectionsPending === true,
          }
          : undefined
      }
      onSkip={props.onSkip}
      // PR-UI-LAYOUT-25: 'destructive' (vs the previous 'warning') so
      // the user sees "all connections unhealthy" at full gravity —
      // distinct from "missing default model" or "needs reauth" which
      // are recoverable yellow states.
      tone="destructive"
    />
  );
}

function ReadyEmptyHero(props: {
  onQuickChatSubmit: (prompt: string, mode?: QuickChatMode) => boolean | Promise<boolean>;
  quickChatPending: boolean;
  onImportDroppedTextFiles?: (files: File[]) => Promise<string | undefined>;
}) {
  const [draft, setDraft] = useState('');
  const [draftMode, setDraftMode] = useState<QuickChatMode | undefined>();
  const [dragActive, setDragActive] = useState(false);
  const [submitPending, setSubmitPending] = useState(false);
  const [pendingImportAction, setPendingImportAction] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const readyHeroMountedRef = useRef(true);
  const submitPendingRef = useRef(false);
  const pendingImportActionRef = useRef<string | null>(null);

  useEffect(() => {
    readyHeroMountedRef.current = true;
    return () => {
      readyHeroMountedRef.current = false;
      submitPendingRef.current = false;
      pendingImportActionRef.current = null;
    };
  }, []);

  const copy = READY_HERO_COPY_BY_LOCALE[detectUiLocale()];
  const quickChatBusy = props.quickChatPending || submitPending;
  const importStatusText = pendingImportAction === null
    ? null
    : pendingImportAction === 'folder'
      ? '正在导入文件夹目录…'
      : '正在导入文件内容…';

  const submit = useCallback(async () => {
    if (props.quickChatPending || submitPendingRef.current) return;
    submitPendingRef.current = true;
    setSubmitPending(true);
    // PR110b contract: empty prompt is OK — main creates the session
    // without sending. Caller (main.tsx) decides whether to focus the
    // composer afterward.
    try {
      const submitted = await props.onQuickChatSubmit(draft, draftMode);
      if (!readyHeroMountedRef.current) return;
      if (!submitted) return;
      setDraft('');
      setDraftMode(undefined);
    } finally {
      submitPendingRef.current = false;
      if (readyHeroMountedRef.current) setSubmitPending(false);
    }
  }, [draft, draftMode, props]);

  const handleKey = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      // PR-FE-BUG-HUNT-0 (kenji bug-hunt 2026-06-24): mirror the main
      // Composer's IME composition guard. Without this, a Chinese /
      // Japanese / Korean user committing an IME composition with
      // Enter immediately fires `submit()` and sends the unfinished
      // draft. The same guard at packages/ui/src/components.tsx:5640
      // already covers the main chat input; the onboarding-hero clone
      // had drifted.
      if (event.nativeEvent.isComposing || event.key === 'Process') return;
      // Enter (without modifier) → submit. Shift+Enter inserts newline.
      if (event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        submit();
      }
      // Esc while drag-active clears the stuck highlight. The useEffect
      // listens for blur/dragend/drop but not keydown, so a user who
      // hits Esc mid-drag would otherwise see the highlight linger.
      if (event.key === 'Escape' && dragActive) {
        setDragActive(false);
      }
    },
    [submit, dragActive],
  );

  const prefillSuggestion = useCallback((prompt: string, mode?: QuickChatMode) => {
    if (quickChatBusy) return;
    const nextDraft = prompt;
    setDraft(nextDraft);
    setDraftMode(mode);
    window.requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      input.setSelectionRange(nextDraft.length, nextDraft.length);
    });
  }, [quickChatBusy]);

  const appendImportedPrompt = useCallback((prompt: string) => {
    if (!readyHeroMountedRef.current) return;
    let nextDraft = prompt;
    setDraft((current) => {
      nextDraft = appendPromptContextDraft(current, prompt);
      return nextDraft;
    });
    setDraftMode(undefined);
    window.requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      input.setSelectionRange(nextDraft.length, nextDraft.length);
    });
  }, []);

  const runImportAction = useCallback(async (
    actionKey: string,
    action: () => Promise<string | undefined>,
  ) => {
    if (pendingImportActionRef.current !== null || quickChatBusy) return;
    pendingImportActionRef.current = actionKey;
    setPendingImportAction(actionKey);
    try {
      const prompt = await action();
      if (prompt && readyHeroMountedRef.current) appendImportedPrompt(prompt);
    } finally {
      if (pendingImportActionRef.current === actionKey) {
        pendingImportActionRef.current = null;
        if (readyHeroMountedRef.current) setPendingImportAction(null);
      }
    }
  }, [appendImportedPrompt, quickChatBusy]);

  const importActionBusy = pendingImportAction !== null;

  const canAcceptDroppedTextFiles = useCallback(() => (
    Boolean(props.onImportDroppedTextFiles && !quickChatBusy && !importActionBusy)
  ), [importActionBusy, props.onImportDroppedTextFiles, quickChatBusy]);

  const hasDraggedFiles = useCallback((event: DragEvent<HTMLElement>) => (
    Array.from(event.dataTransfer.types).includes('Files')
  ), []);

  const hasPastedFiles = useCallback((event: ClipboardEvent<HTMLTextAreaElement>) => (
    Array.from(event.clipboardData.types).includes('Files') || event.clipboardData.files.length > 0
  ), []);

  const handleDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!canAcceptDroppedTextFiles() || !hasDraggedFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setDragActive(true);
  }, [canAcceptDroppedTextFiles, hasDraggedFiles]);

  const handleDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDragActive(false);
  }, []);

  const handleDrop = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    setDragActive(false);
    if (!canAcceptDroppedTextFiles()) return;
    const files = Array.from(event.dataTransfer.files);
    if (files.length === 0) return;
    void runImportAction('drop', async () => props.onImportDroppedTextFiles?.(files));
  }, [canAcceptDroppedTextFiles, hasDraggedFiles, props.onImportDroppedTextFiles, runImportAction]);

  useEffect(() => {
    if (!dragActive) return;
    const clearDragActive = () => setDragActive(false);
    window.addEventListener('blur', clearDragActive);
    window.addEventListener('dragend', clearDragActive);
    window.addEventListener('drop', clearDragActive);
    return () => {
      window.removeEventListener('blur', clearDragActive);
      window.removeEventListener('dragend', clearDragActive);
      window.removeEventListener('drop', clearDragActive);
    };
  }, [dragActive]);

  const handlePaste = useCallback((event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!hasPastedFiles(event)) return;
    if (!canAcceptDroppedTextFiles()) return;
    const files = Array.from(event.clipboardData.files);
    if (files.length === 0) return;
    event.preventDefault();
    void runImportAction('paste', async () => props.onImportDroppedTextFiles?.(files));
  }, [canAcceptDroppedTextFiles, hasPastedFiles, props.onImportDroppedTextFiles, runImportAction]);

  return (
    <section className="maka-onboarding maka-onboarding-ready" aria-label={copy.ariaLabel}>
      <header>
        <span className="maka-onboarding-eyebrow">
          <Sparkles size={12} aria-hidden="true" />
          <span>{copy.eyebrow}</span>
        </span>
        <h1>{copy.headline}</h1>
        <p>{copy.intro}</p>
      </header>

      <div
        className="maka-onboarding-quickchat"
        data-drag-active={dragActive ? 'true' : undefined}
        data-maka-file-drop-target={canAcceptDroppedTextFiles() ? 'true' : undefined}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <div className="maka-onboarding-quickchat-field">
          <Textarea
            ref={inputRef}
            unstyled
            className="maka-onboarding-quickchat-input"
            placeholder={copy.quickChatPlaceholder}
            rows={3}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={handleKey}
            onPaste={handlePaste}
            disabled={quickChatBusy}
            aria-label={copy.quickChatAria}
          />
          <small
            className="maka-onboarding-quickchat-example"
            data-pending={importStatusText ? 'true' : undefined}
            aria-hidden={importStatusText ? undefined : 'true'}
            aria-live={importStatusText ? 'polite' : undefined}
          >
            {importStatusText ?? copy.quickChatExample}
          </small>
        </div>
        {dragActive && (
          <span className="maka-visually-hidden" role="status" aria-live="polite">
            松开以导入文件内容
          </span>
        )}
        {draftMode === 'deep_research' && (
          <span className="maka-onboarding-quickchat-mode">深度研究 · 只读分析</span>
        )}
        <Button
          type="button"
          className="maka-onboarding-quickchat-submit"
          onClick={submit}
          disabled={quickChatBusy}
          aria-busy={quickChatBusy ? 'true' : undefined}
          aria-label={quickChatBusy ? copy.submitPendingLabel : copy.submitIdleLabel}
          title={quickChatBusy ? copy.submitPendingLabel : copy.submitIdleLabel}
        >
          <ArrowUp size={18} aria-hidden="true" />
        </Button>
      </div>

      {FIRST_RUN_TASK_SUGGESTIONS.length > 0 && (
        <div className="maka-first-run-task-suggestions" aria-label="试试这些任务">
          <div className="maka-first-run-task-suggestions-inner">
            <div className="maka-first-run-task-suggestions-header">
              <strong>试试这些任务</strong>
            </div>
            <div className="maka-first-run-task-suggestion-list">
              {FIRST_RUN_TASK_SUGGESTIONS.map((suggestion) => (
                <div key={suggestion.id} className="maka-first-run-task-suggestion-chip">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="maka-first-run-task-suggestion"
                    onClick={() => prefillSuggestion(suggestion.prompt, suggestion.mode)}
                    disabled={quickChatBusy}
                  >
                    {suggestion.label}
                  </Button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function SkipButton(props: { onSkip: () => Promise<void> | void; label?: string }) {
  const [pending, setPending] = useState(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  const onClick = useCallback(async () => {
    if (pending) return;
    setPending(true);
    try {
      await props.onSkip();
    } finally {
      if (mountedRef.current) setPending(false);
    }
  }, [pending, props]);
  return (
    <Button
      type="button"
      variant="ghost"
      onClick={onClick}
      disabled={pending}
      aria-busy={pending ? 'true' : undefined}
    >
      {pending ? '跳过中…' : (props.label ?? '跳过，先逛逛')}
    </Button>
  );
}

interface SetupHeroProps {
  icon: React.ReactNode;
  eyebrow: string;
  title: string;
  body: React.ReactNode;
  setupSteps?: readonly OnboardingSetupStep[] | null;
  primaryCta: { label: string; onClick: () => void };
  /**
   * PR-ONBOARDING-EARLY-COPY-0: optional ghost-style secondary action
   * sitting next to the primary CTA. Used by the early-onboarding
   * branches to expose a "已经配好了？刷新检测" affordance so a user
   * with env-bootstrap connections is not stuck behind a stale
   * snapshot. Hidden when not provided so existing call sites are
   * unchanged.
   */
  secondaryCta?: { label: string; onClick: () => void; disabled?: boolean; busy?: boolean };
  /**
   * Optional skip affordance for the `needs_*` / `blocked` branches.
   * Renders as a ghost button after the secondary CTA. Lets the user
   * enter the app without configuring a provider.
   */
  onSkip?: () => Promise<void> | void;
  /**
   * PR-UI-LAYOUT-25 (@yuejing 2026-05-22): extended from `'warning'`
   * only to also accept `'destructive'` so a blocked-state hero
   * ("all_connections_unhealthy") reads with genuine gravity
   * instead of "yellow warning". CSS rules for
   * `.maka-onboarding-setup[data-tone="destructive"]` paint the
   * eyebrow + headline in destructive tone.
   */
  tone?: 'warning' | 'destructive';
}

function SetupHero(props: SetupHeroProps) {
  return (
    <section
      className="maka-onboarding maka-onboarding-setup"
      data-tone={props.tone}
      aria-label={props.eyebrow}
    >
      <header>
        <span className="maka-onboarding-eyebrow">
          {props.icon}
          <span>{props.eyebrow}</span>
        </span>
        <h1>{props.title}</h1>
        <p>{props.body}</p>
      </header>
      {props.setupSteps && <SetupProgress steps={props.setupSteps} />}
      <footer className="maka-onboarding-footer">
        <Button
          type="button"
          onClick={props.primaryCta.onClick}
        >
          {props.primaryCta.label}
        </Button>
        {props.secondaryCta && (
          <Button
            type="button"
            variant="ghost"
            onClick={props.secondaryCta.onClick}
            disabled={props.secondaryCta.disabled === true}
            aria-busy={props.secondaryCta.busy === true ? 'true' : undefined}
          >
            {props.secondaryCta.label}
          </Button>
        )}
        {props.onSkip && <SkipButton onSkip={props.onSkip} />}
      </footer>
    </section>
  );
}

const SETUP_STEP_STATUS_LABELS: Record<OnboardingSetupStep['state'], string> = {
  done: '已完成',
  active: '当前步骤',
  pending: '待完成',
  warning: '需要处理',
};

function SetupProgress(props: { steps: readonly OnboardingSetupStep[] }) {
  return (
    <ol className="maka-onboarding-setup-steps" aria-label="配置 AI 进度">
      {props.steps.map((step, index) => (
        <li key={`${step.label}-${index}`} data-state={step.state}>
          <span className="maka-onboarding-setup-step-marker" aria-hidden="true">
            {index + 1}
          </span>
          <span className="maka-onboarding-setup-step-copy">
            <strong>{step.label}</strong>
            <small>{step.detail}</small>
          </span>
          <span className="maka-onboarding-setup-step-state">
            {SETUP_STEP_STATUS_LABELS[step.state]}
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * Exhaustive switch helper. If `OnboardingState` ever grows a new
 * variant without a matching `case`, this call site fails to compile
 * — preventing a silent fallthrough that would render no hero or a
 * generic placeholder for the missing state.
 */
function assertNever(state: never): never {
  // The runtime fallback should never execute. We still log a
  // generalized error class (no raw `state.kind` leak) to surface the
  // gap in dev builds without breaking the chat surface.
  void state;
  throw new Error('OnboardingHero: unexhausted OnboardingState variant');
}
