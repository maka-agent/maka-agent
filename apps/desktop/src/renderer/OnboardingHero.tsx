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

import { ArrowRight, Sparkles, KeyRound, Settings as SettingsIcon, Cpu, AlertCircle, FolderOpen, Paperclip } from 'lucide-react';
import { useCallback, useRef, useState, type KeyboardEvent } from 'react';
import type { LlmConnection, OnboardingState, ProviderType, QuickChatMode, SettingsSection } from '@maka/core';
import { appendPromptContextDraft, detectUiLocale, type UiLocale } from '@maka/ui';
import { ProviderLogo, providerDisplay } from './settings/ProvidersPanel';
import { FIRST_RUN_TASK_SUGGESTIONS } from './first-run-task-suggestions';

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
    headline: '你已经配置好了 —— 直接说说你想做什么。',
    intro: '下面这个输入框会用默认模型开新会话；空提交也会打开一个空会话，方便你之后再输入。',
    quickChatPlaceholder: '给 Maka 发消息…',
    quickChatAria: 'Quick Chat 输入框',
    quickChatExample: '例如：帮我读一下这个项目的目录结构，告诉我入口在哪里。',
    submitIdleLabel: '开始对话',
    submitPendingLabel: '正在创建…',
  },
  en: {
    ariaLabel: 'Start a conversation',
    eyebrow: 'READY · Start a conversation',
    headline: 'You\'re all set — just say what you want to do.',
    intro: 'The box below opens a new session with your default model; empty submit also opens a session so you can type later.',
    quickChatPlaceholder: 'Message Maka…',
    quickChatAria: 'Quick Chat input',
    quickChatExample: 'Example: walk me through this project\'s directory layout and where the entry point lives.',
    submitIdleLabel: 'Start chat',
    submitPendingLabel: 'Creating…',
  },
};

const FEATURED: Array<{ type: ProviderType; tag: string }> = [
  { type: 'anthropic', tag: 'Claude · Anthropic' },
  { type: 'openai', tag: 'GPT-4o · OpenAI' },
  { type: 'zai-coding-plan', tag: 'GLM Coding Plan · Z.ai' },
  { type: 'kimi-coding-plan', tag: 'Kimi · Moonshot' },
  { type: 'deepseek', tag: 'DeepSeek-V3' },
  { type: 'ollama', tag: 'Ollama · 本地' },
];

export interface OnboardingHeroProps {
  state: OnboardingState;
  /** Open Settings with a specific section preselected. */
  onOpenSettings: (section?: SettingsSection) => void;
  /**
   * Quick Chat submit handler (PR110b `quickChat:start`). Only
   * called from the `ready_empty` branch. The caller is responsible
   * for handling the discriminated-union result (setActiveId on
   * success, toast on `send_failed`, etc.).
   */
  onQuickChatSubmit: (prompt: string, mode?: QuickChatMode) => void;
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
  onImportTextFile?: () => Promise<string | undefined>;
  onImportFolderOutline?: () => Promise<string | undefined>;
}

export function OnboardingHero(props: OnboardingHeroProps) {
  const { state } = props;
  switch (state.kind) {
    case 'needs_connection':
      return (
        <NeedsConnectionHero
          onOpenSettings={props.onOpenSettings}
          onRefreshConnections={props.onRefreshConnections}
        />
      );
    case 'needs_default_connection':
      return <NeedsDefaultConnectionHero onOpenSettings={props.onOpenSettings} />;
    case 'needs_connection_credentials':
      return (
        <NeedsConnectionCredentialsHero
          connectionSlug={state.connectionSlug}
          connections={props.connections}
          onOpenSettings={props.onOpenSettings}
          onRefreshConnections={props.onRefreshConnections}
        />
      );
    case 'needs_default_model':
      return (
        <NeedsDefaultModelHero
          connectionSlug={state.connectionSlug}
          connections={props.connections}
          onOpenSettings={props.onOpenSettings}
          onRefreshConnections={props.onRefreshConnections}
        />
      );
    case 'ready_empty':
      return (
        <ReadyEmptyHero
          onQuickChatSubmit={props.onQuickChatSubmit}
          quickChatPending={props.quickChatPending === true}
          onImportTextFile={props.onImportTextFile}
          onImportFolderOutline={props.onImportFolderOutline}
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
          onRefreshConnections={props.onRefreshConnections}
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
  onRefreshConnections?: () => Promise<void> | void;
}) {
  return (
    <section className="maka-onboarding" aria-label="欢迎使用 Maka">
      <header>
        <span className="maka-onboarding-eyebrow">
          <Sparkles size={12} strokeWidth={2} aria-hidden="true" />
          {/*
            PR-SIDEBAR-IA-0 Phase 3 P0 fixup v2 (kenji `08be08d8`):
            replaced the previous all-caps English eyebrow with
            the Chinese-first `欢迎使用 Maka` that matches every
            other eyebrow in this surface (see
            `onboarding-hero-copy.ts` line 61). The old version
            was the lone outlier and looked like leftover
            scaffolding.
          */}
          <span>欢迎使用 Maka</span>
        </span>
        <h1>把一个真实的 LLM 接进来，再开始第一条对话。</h1>
        <p>
          Maka 只跑在你电脑上 —— 模型走你自己的 API key。下面是常见接入；
          点任意一张卡进入 <strong>设置 · 模型</strong> 添加它的 key。
        </p>
      </header>

      <ul className="maka-onboarding-grid" role="list">
        {FEATURED.map((entry) => {
          const display = providerDisplay(entry.type);
          return (
            <li key={entry.type}>
              <button
                type="button"
                className="maka-onboarding-card"
                onClick={() => props.onOpenSettings('models')}
              >
                <ProviderLogo type={entry.type} compact />
                <div className="maka-onboarding-card-copy">
                  <strong>{entry.tag}</strong>
                  <small>{display.description}</small>
                </div>
                <ArrowRight size={14} strokeWidth={1.75} aria-hidden="true" />
              </button>
            </li>
          );
        })}
      </ul>

      <footer className="maka-onboarding-footer">
        <button
          type="button"
          className="maka-button"
          data-variant="primary"
          onClick={() => props.onOpenSettings('models')}
        >
          打开设置 · 模型
        </button>
        {props.onRefreshConnections && (
          <button
            type="button"
            className="maka-button maka-button-ghost"
            onClick={() => void props.onRefreshConnections?.()}
          >
            已经配好了？刷新检测
          </button>
        )}
      </footer>
    </section>
  );
}

function NeedsDefaultConnectionHero(props: { onOpenSettings: (section?: SettingsSection) => void }) {
  return (
    <SetupHero
      icon={<SettingsIcon size={14} strokeWidth={2} aria-hidden="true" />}
      eyebrow="选择默认模型连接"
      title="选一个连接作为默认。"
      body={
        <>
          你已经配置了至少一个模型连接，但还没设为默认。请到
          <strong> 设置 · 模型 </strong>
          挑一个作为默认连接，再开始对话。
        </>
      }
      primaryCta={{ label: '打开设置 · 模型', onClick: () => props.onOpenSettings('models') }}
    />
  );
}

function NeedsConnectionCredentialsHero(props: {
  connectionSlug: string;
  connections?: ReadonlyArray<LlmConnection>;
  onOpenSettings: (section?: SettingsSection) => void;
  onRefreshConnections?: () => Promise<void> | void;
}) {
  const { name, isFallback } = connectionLabel(props.connectionSlug, props.connections);
  return (
    <SetupHero
      icon={<KeyRound size={14} strokeWidth={2} aria-hidden="true" />}
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
      primaryCta={{ label: '打开设置 · 模型', onClick: () => props.onOpenSettings('models') }}
      secondaryCta={
        props.onRefreshConnections
          ? { label: '已经填好了？刷新检测', onClick: () => void props.onRefreshConnections?.() }
          : undefined
      }
    />
  );
}

function NeedsDefaultModelHero(props: {
  connectionSlug: string;
  connections?: ReadonlyArray<LlmConnection>;
  onOpenSettings: (section?: SettingsSection) => void;
  onRefreshConnections?: () => Promise<void> | void;
}) {
  const { name, isFallback } = connectionLabel(props.connectionSlug, props.connections);
  return (
    <SetupHero
      icon={<Cpu size={14} strokeWidth={2} aria-hidden="true" />}
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
      primaryCta={{ label: '打开设置 · 模型', onClick: () => props.onOpenSettings('models') }}
      secondaryCta={
        props.onRefreshConnections
          ? { label: '已经选好了？刷新检测', onClick: () => void props.onRefreshConnections?.() }
          : undefined
      }
    />
  );
}

function BlockedHero(props: {
  reason: 'all_connections_unhealthy';
  onOpenSettings: (section?: SettingsSection) => void;
  onRefreshConnections?: () => Promise<void> | void;
}) {
  // The reason is destructured to satisfy exhaustive type-checking;
  // when PR-future extends the enum, this branch must update too.
  void props.reason;
  return (
    <SetupHero
      icon={<AlertCircle size={14} strokeWidth={2} aria-hidden="true" />}
      eyebrow="连接暂不可用"
      title="所有模型连接最近一次测试都没通过。"
      body={
        <>
          打开 <strong>设置 · 模型</strong>，对每个连接重新测试或更新 key；
          排查后回来刷新即可继续对话。
        </>
      }
      primaryCta={{ label: '打开设置 · 模型', onClick: () => props.onOpenSettings('models') }}
      secondaryCta={
        props.onRefreshConnections
          ? { label: '已经修好了？刷新检测', onClick: () => void props.onRefreshConnections?.() }
          : undefined
      }
      // PR-UI-LAYOUT-25: 'destructive' (vs the previous 'warning') so
      // the user sees "all connections unhealthy" at full gravity —
      // distinct from "missing default model" or "needs reauth" which
      // are recoverable yellow states.
      tone="destructive"
    />
  );
}

function ReadyEmptyHero(props: {
  onQuickChatSubmit: (prompt: string, mode?: QuickChatMode) => void;
  quickChatPending: boolean;
  onImportTextFile?: () => Promise<string | undefined>;
  onImportFolderOutline?: () => Promise<string | undefined>;
}) {
  const [draft, setDraft] = useState('');
  const [draftMode, setDraftMode] = useState<QuickChatMode | undefined>();
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const copy = READY_HERO_COPY_BY_LOCALE[detectUiLocale()];

  const submit = useCallback(() => {
    if (props.quickChatPending) return;
    // PR110b contract: empty prompt is OK — main creates the session
    // without sending. Caller (main.tsx) decides whether to focus the
    // composer afterward.
    props.onQuickChatSubmit(draft, draftMode);
    setDraft('');
    setDraftMode(undefined);
  }, [draft, draftMode, props]);

  const handleKey = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      // Enter (without modifier) → submit. Shift+Enter inserts newline.
      if (event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        submit();
      }
    },
    [submit],
  );

  const prefillSuggestion = useCallback((prompt: string, mode?: QuickChatMode) => {
    setDraft(prompt);
    setDraftMode(mode);
    window.requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      input.setSelectionRange(prompt.length, prompt.length);
    });
  }, []);

  const importTextFile = useCallback(async () => {
    if (!props.onImportTextFile || props.quickChatPending) return;
    const prompt = await props.onImportTextFile();
    if (!prompt) return;
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
  }, [props]);

  const importFolderOutline = useCallback(async () => {
    if (!props.onImportFolderOutline || props.quickChatPending) return;
    const prompt = await props.onImportFolderOutline();
    if (!prompt) return;
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
  }, [props]);

  return (
    <section className="maka-onboarding maka-onboarding-ready" aria-label={copy.ariaLabel}>
      <header>
        <span className="maka-onboarding-eyebrow">
          <Sparkles size={12} strokeWidth={2} aria-hidden="true" />
          <span>{copy.eyebrow}</span>
        </span>
        <h1>{copy.headline}</h1>
        <p>{copy.intro}</p>
      </header>

      <div className="maka-onboarding-quickchat">
        <textarea
          ref={inputRef}
          className="maka-onboarding-quickchat-input"
          placeholder={copy.quickChatPlaceholder}
          rows={3}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleKey}
          disabled={props.quickChatPending}
          aria-label={copy.quickChatAria}
        />
        <small className="maka-onboarding-quickchat-example" aria-hidden="true">
          {copy.quickChatExample}
        </small>
        {draftMode === 'deep_research' && (
          <span className="maka-onboarding-quickchat-mode">深度研究 · 只读分析</span>
        )}
        <div className="maka-onboarding-quickchat-actions">
          {props.onImportTextFile && (
            <button
              type="button"
              className="maka-button maka-button-ghost"
              onClick={() => void importTextFile()}
              disabled={props.quickChatPending}
            >
              <Paperclip size={14} strokeWidth={1.75} aria-hidden="true" />
              <span>导入文本文件</span>
            </button>
          )}
          {props.onImportFolderOutline && (
            <button
              type="button"
              className="maka-button maka-button-ghost"
              onClick={() => void importFolderOutline()}
              disabled={props.quickChatPending}
            >
              <FolderOpen size={14} strokeWidth={1.75} aria-hidden="true" />
              <span>导入文件夹目录</span>
            </button>
          )}
          <button
            type="button"
            className="maka-button"
            data-variant="primary"
            onClick={submit}
            disabled={props.quickChatPending}
          >
            {props.quickChatPending ? copy.submitPendingLabel : copy.submitIdleLabel}
          </button>
        </div>
      </div>

      <div className="maka-first-run-task-suggestions" aria-label="试试这些任务">
        <strong>试试这些任务</strong>
        <div className="maka-first-run-task-suggestion-list">
          {FIRST_RUN_TASK_SUGGESTIONS.map((suggestion) => (
            <button
              key={suggestion.id}
              type="button"
              className="maka-first-run-task-suggestion"
              onClick={() => prefillSuggestion(suggestion.prompt, suggestion.mode)}
              disabled={props.quickChatPending}
            >
              {suggestion.label}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

interface SetupHeroProps {
  icon: React.ReactNode;
  eyebrow: string;
  title: string;
  body: React.ReactNode;
  primaryCta: { label: string; onClick: () => void };
  /**
   * PR-ONBOARDING-EARLY-COPY-0: optional ghost-style secondary action
   * sitting next to the primary CTA. Used by the early-onboarding
   * branches to expose a "已经配好了？刷新检测" affordance so a user
   * with env-bootstrap connections is not stuck behind a stale
   * snapshot. Hidden when not provided so existing call sites are
   * unchanged.
   */
  secondaryCta?: { label: string; onClick: () => void };
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
      <footer className="maka-onboarding-footer">
        <button
          type="button"
          className="maka-button"
          data-variant="primary"
          onClick={props.primaryCta.onClick}
        >
          {props.primaryCta.label}
        </button>
        {props.secondaryCta && (
          <button
            type="button"
            className="maka-button maka-button-ghost"
            onClick={props.secondaryCta.onClick}
          >
            {props.secondaryCta.label}
          </button>
        )}
      </footer>
    </section>
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
