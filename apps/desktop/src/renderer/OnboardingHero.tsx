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

import { ArrowRight, Sparkles, KeyRound, Settings as SettingsIcon, Cpu, AlertCircle } from 'lucide-react';
import { useCallback, useState, type KeyboardEvent } from 'react';
import type { OnboardingState, ProviderType, SettingsSection } from '@maka/core';
import { ProviderLogo, providerDisplay } from './settings/ProvidersPanel';

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
  onQuickChatSubmit: (prompt: string) => void;
  /**
   * Flag set when a `quickChat:start` call is in flight, so the
   * composer can disable its submit button without owning the
   * pending state itself.
   */
  quickChatPending?: boolean;
}

export function OnboardingHero(props: OnboardingHeroProps) {
  const { state } = props;
  switch (state.kind) {
    case 'needs_connection':
      return <NeedsConnectionHero onOpenSettings={props.onOpenSettings} />;
    case 'needs_default_connection':
      return <NeedsDefaultConnectionHero onOpenSettings={props.onOpenSettings} />;
    case 'needs_connection_credentials':
      return (
        <NeedsConnectionCredentialsHero
          connectionSlug={state.connectionSlug}
          onOpenSettings={props.onOpenSettings}
        />
      );
    case 'needs_default_model':
      return (
        <NeedsDefaultModelHero
          connectionSlug={state.connectionSlug}
          onOpenSettings={props.onOpenSettings}
        />
      );
    case 'ready_empty':
      return (
        <ReadyEmptyHero
          onQuickChatSubmit={props.onQuickChatSubmit}
          quickChatPending={props.quickChatPending === true}
        />
      );
    case 'blocked':
      // `blocked.reason` is `'all_connections_unhealthy'` in PR110a's
      // closed enum; if a future PR extends it, this assignment will
      // fail to compile (assertNever), forcing a labeled branch
      // rather than a silent fallthrough.
      return <BlockedHero reason={state.reason} onOpenSettings={props.onOpenSettings} />;
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

function NeedsConnectionHero(props: { onOpenSettings: (section?: SettingsSection) => void }) {
  return (
    <section className="maka-onboarding" aria-label="欢迎使用 Maka">
      <header>
        <span className="maka-onboarding-eyebrow">
          <Sparkles size={12} strokeWidth={2} aria-hidden="true" />
          <span>WELCOME TO MAKA</span>
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
  onOpenSettings: (section?: SettingsSection) => void;
}) {
  return (
    <SetupHero
      icon={<KeyRound size={14} strokeWidth={2} aria-hidden="true" />}
      eyebrow="补齐凭据"
      title="为这个连接配置 API key。"
      body={
        <>
          默认连接 <code className="maka-onboarding-slug">{props.connectionSlug}</code> 缺少可用的 API key。
          请到 <strong>设置 · 模型</strong> 打开该连接，补齐密钥后再开始对话。
        </>
      }
      primaryCta={{ label: '打开设置 · 模型', onClick: () => props.onOpenSettings('models') }}
    />
  );
}

function NeedsDefaultModelHero(props: {
  connectionSlug: string;
  onOpenSettings: (section?: SettingsSection) => void;
}) {
  return (
    <SetupHero
      icon={<Cpu size={14} strokeWidth={2} aria-hidden="true" />}
      eyebrow="选择默认模型"
      title="为这个连接选一个可用模型。"
      body={
        <>
          默认连接 <code className="maka-onboarding-slug">{props.connectionSlug}</code>
          {' '}还没绑定可用模型。请到 <strong>设置 · 模型</strong> 给它选一个，再开始对话。
        </>
      }
      primaryCta={{ label: '打开设置 · 模型', onClick: () => props.onOpenSettings('models') }}
    />
  );
}

function BlockedHero(props: {
  reason: 'all_connections_unhealthy';
  onOpenSettings: (section?: SettingsSection) => void;
}) {
  // The reason is destructured to satisfy exhaustive type-checking;
  // when PR-future extends the enum, this branch must update too.
  void props.reason;
  return (
    <SetupHero
      icon={<AlertCircle size={14} strokeWidth={2} aria-hidden="true" />}
      eyebrow="连接暂不可用"
      title="当前所有模型连接都不可用。"
      body={
        <>
          请到 <strong>设置 · 账号</strong> 查看每个连接的状态，重新测试或重新登录后再开始对话。
        </>
      }
      primaryCta={{ label: '打开设置 · 账号', onClick: () => props.onOpenSettings('account') }}
      tone="warning"
    />
  );
}

function ReadyEmptyHero(props: {
  onQuickChatSubmit: (prompt: string) => void;
  quickChatPending: boolean;
}) {
  const [draft, setDraft] = useState('');

  const submit = useCallback(() => {
    if (props.quickChatPending) return;
    // PR110b contract: empty prompt is OK — main creates the session
    // without sending. Caller (main.tsx) decides whether to focus the
    // composer afterward.
    props.onQuickChatSubmit(draft);
    setDraft('');
  }, [draft, props]);

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

  return (
    <section className="maka-onboarding maka-onboarding-ready" aria-label="开始对话">
      <header>
        <span className="maka-onboarding-eyebrow">
          <Sparkles size={12} strokeWidth={2} aria-hidden="true" />
          <span>READY · 开始对话</span>
        </span>
        <h1>你已经配置好了 —— 直接说说你想做什么。</h1>
        <p>下面这个输入框会用默认模型开新会话；空提交也会打开一个空会话，方便你之后再输入。</p>
      </header>

      <div className="maka-onboarding-quickchat">
        <textarea
          className="maka-onboarding-quickchat-input"
          placeholder="例如：帮我读一下这个项目的目录结构，告诉我入口在哪里。"
          rows={3}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleKey}
          disabled={props.quickChatPending}
          aria-label="Quick Chat 输入框"
        />
        <button
          type="button"
          className="maka-button"
          data-variant="primary"
          onClick={submit}
          disabled={props.quickChatPending}
        >
          {props.quickChatPending ? '正在创建…' : '开始对话'}
        </button>
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
  tone?: 'warning';
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
