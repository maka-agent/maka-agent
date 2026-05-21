// apps/desktop/src/renderer/OnboardingHero.tsx
//
// First-run hero shown in the chat surface when the user hasn't configured
// any real LLM connection yet. Replaces the generic prompt-suggestions
// empty state so brand-new users see a clear path to a real conversation
// instead of typing into FakeBackend echo.
//
// Tapping a featured provider opens Settings → 模型 (Models). The "skip"
// link drops down to the original prompt-suggestion hero in case the user
// wants to read first.

import { ArrowRight, Sparkles } from 'lucide-react';
import type { ProviderType } from '@maka/core';
import { ProviderLogo, providerDisplay } from './settings/ProvidersPanel';

const FEATURED: Array<{ type: ProviderType; tag: string }> = [
  { type: 'anthropic', tag: 'Claude · Anthropic' },
  { type: 'openai', tag: 'GPT-4o · OpenAI' },
  { type: 'zai-coding-plan', tag: 'GLM Coding Plan · Z.ai' },
  { type: 'kimi-coding-plan', tag: 'Kimi · Moonshot' },
  { type: 'deepseek', tag: 'DeepSeek-V3' },
  { type: 'ollama', tag: 'Ollama · 本地' },
];

export function OnboardingHero(props: {
  onOpenSettings(): void;
  onUseAnyway(): void;
}) {
  return (
    <section className="maka-onboarding" aria-label="Welcome to Maka">
      <header>
        <span className="maka-onboarding-eyebrow">
          <Sparkles size={12} strokeWidth={2} aria-hidden="true" />
          <span>WELCOME TO MAKA</span>
        </span>
        <h1>把一个真实的 LLM 接进来，再开始第一条对话。</h1>
        <p>
          Maka 本身只跑在你电脑上 —— 模型走你自己的 API key。下面是常见接入；
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
                onClick={props.onOpenSettings}
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
          onClick={props.onOpenSettings}
        >
          打开设置 · 模型
        </button>
        <button
          type="button"
          className="maka-onboarding-skip"
          onClick={props.onUseAnyway}
        >
          先用 FakeBackend 走一遍流程 →
        </button>
      </footer>
    </section>
  );
}
