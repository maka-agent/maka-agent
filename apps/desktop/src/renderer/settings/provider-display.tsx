import { type ProviderType } from '@maka/core';
import { ProviderBrandMark } from './provider-brand-marks';

// Kept as a thin wrapper so the many `ProviderLogo` call sites stay put.
function ProviderLogoMark({ type }: { type: ProviderType }) {
  return <ProviderBrandMark type={type} />;
}

export function ProviderLogo(props: { type: ProviderType; compact?: boolean }) {
  return (
    <span className="providerLogo" data-provider={props.type} data-compact={props.compact ? 'true' : undefined} aria-hidden="true">
      <ProviderLogoMark type={props.type} />
    </span>
  );
}

export function providerDisplay(type: ProviderType): { name: string; description: string; badge?: string } {
  switch (type) {
    // Descriptions stay version-agnostic on purpose: they name the
    // PROVIDER and how you connect (official key / protocol-compatible /
    // local), never a specific model generation — model names go stale
    // (GPT-4o, DeepSeek-V3, …) but the provider and access path do not.
    case 'anthropic':
      return { name: 'Anthropic', description: 'Anthropic 官方接入', badge: 'API' };
    case 'kimi-coding-plan':
      return { name: 'Kimi Coding Plan', description: '月之暗面 · Anthropic 兼容', badge: 'Coding' };
    case 'openai':
      return { name: 'OpenAI', description: 'OpenAI 官方接入', badge: 'API' };
    case 'google':
      return { name: 'Google Gemini', description: 'Google AI Studio 接入', badge: 'API' };
    case 'deepseek':
      return { name: 'DeepSeek', description: 'DeepSeek 官方接入', badge: 'API' };
    case 'moonshot':
      return { name: 'Moonshot', description: 'Moonshot 官方接入', badge: 'API' };
    case 'zai-coding-plan':
      return { name: 'Z.AI Coding Plan', description: '智谱 · OpenAI 兼容', badge: 'Coding' };
    case 'ollama':
      return { name: 'Ollama', description: '本机运行 · 离线可用', badge: 'Local' };
    case 'openai-compatible':
      return { name: 'OpenAI Compatible', description: '中转站、代理服务或自部署网关。', badge: 'Custom' };
    case 'claude-subscription':
      return { name: 'Claude Subscription', description: 'Claude Pro / Max 订阅账号登录；登录后自动成为可用模型连接。' };
    case 'codex-subscription':
      return { name: 'OpenAI OAuth', description: 'ChatGPT / Codex 账号登录；登录后自动成为可用模型连接。' };
    case 'gemini-cli':
      return { name: 'Gemini CLI', description: 'Google 账号登录暂未接入聊天发送。' };
  }
}
