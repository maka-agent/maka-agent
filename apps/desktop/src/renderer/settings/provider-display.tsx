import { PROVIDER_DEFAULTS, type ProviderType } from '@maka/core';
import { detectUiLocale, type UiLocale } from '@maka/ui';
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

interface ProviderCopy {
  name: string;
  description: string;
  badge?: string;
}

// UI-layer provider introduction copy, localized zh / en. These stay in the
// display layer (not the registry) because they are marketing/introduction
// prose tuned for the catalog, not the runtime provider facts. Descriptions
// stay version-agnostic on purpose: they name the PROVIDER and how you connect
// (official key / protocol-compatible / local), never a specific model
// generation — model names go stale (GPT-4o, DeepSeek-V3, …) but the provider
// and access path do not. Brand names (Anthropic, OpenAI, …) are never
// translated.
const PROVIDER_DISPLAY_COPY: Partial<Record<ProviderType, Record<UiLocale, ProviderCopy>>> = {
  siliconflow: {
    zh: { name: 'SiliconFlow', description: '硅基流动多模型 API，支持精确模型 ID。', badge: '聚合' },
    en: { name: 'SiliconFlow', description: 'Hosted multi-model API with exact upstream model ids.', badge: 'Aggregator' },
  },
  anthropic: {
    zh: { name: 'Anthropic', description: 'Anthropic 官方接入', badge: 'API' },
    en: { name: 'Anthropic', description: 'Official Anthropic API access.', badge: 'API' },
  },
  'kimi-coding-plan': {
    zh: { name: 'Kimi Coding Plan', description: '月之暗面 · Anthropic 兼容', badge: 'Coding' },
    en: { name: 'Kimi Coding Plan', description: 'Moonshot · Anthropic-compatible', badge: 'Coding' },
  },
  openai: {
    zh: { name: 'OpenAI', description: 'OpenAI 官方接入', badge: 'API' },
    en: { name: 'OpenAI', description: 'Official OpenAI API access.', badge: 'API' },
  },
  google: {
    zh: { name: 'Google Gemini', description: 'Google AI Studio 接入', badge: 'API' },
    en: { name: 'Google Gemini', description: 'Google AI Studio API access.', badge: 'API' },
  },
  deepseek: {
    zh: { name: 'DeepSeek', description: 'DeepSeek 官方接入', badge: 'API' },
    en: { name: 'DeepSeek', description: 'Official DeepSeek API access.', badge: 'API' },
  },
  moonshot: {
    zh: { name: 'Moonshot', description: 'Moonshot 官方接入', badge: 'API' },
    en: { name: 'Moonshot', description: 'Official Moonshot API access.', badge: 'API' },
  },
  'zai-coding-plan': {
    zh: { name: 'Z.AI Coding Plan', description: '智谱 · OpenAI 兼容', badge: 'Coding' },
    en: { name: 'Z.AI Coding Plan', description: 'Zhipu · OpenAI-compatible', badge: 'Coding' },
  },
  MiniMax: {
    zh: { name: 'MiniMax', description: 'MiniMax · Anthropic 兼容', badge: 'API' },
    en: { name: 'MiniMax', description: 'MiniMax · Anthropic-compatible', badge: 'API' },
  },
  'MiniMax-cn': {
    zh: { name: 'MiniMax 中国站', description: 'MiniMax 中国站 · Anthropic 兼容', badge: 'API' },
    en: { name: 'MiniMax China', description: 'MiniMax China · Anthropic-compatible', badge: 'API' },
  },
  ollama: {
    zh: { name: 'Ollama', description: '本机运行 · 离线可用', badge: 'Local' },
    en: { name: 'Ollama', description: 'Runs locally · works offline', badge: 'Local' },
  },
  'openai-compatible': {
    zh: { name: '自定义 OpenAI 兼容接口', description: '中转站、代理服务或自部署网关。', badge: 'Custom' },
    en: { name: 'Custom OpenAI-compatible', description: 'Relay, proxy, or self-hosted gateway.', badge: 'Custom' },
  },
  'claude-subscription': {
    zh: { name: 'Claude Subscription', description: 'Claude Pro / Max 订阅账号登录；登录后自动成为可用模型连接。' },
    en: { name: 'Claude Subscription', description: 'Sign in with a Claude Pro / Max subscription; it becomes an available model connection once signed in.' },
  },
  'openai-codex': {
    zh: { name: 'OpenAI OAuth', description: 'ChatGPT / Codex 账号登录；登录后自动成为可用模型连接。' },
    en: { name: 'OpenAI OAuth', description: 'Sign in with a ChatGPT / Codex account; it becomes an available model connection once signed in.' },
  },
  'gemini-cli': {
    zh: { name: 'Gemini CLI', description: 'Google 账号登录暂未接入聊天发送。' },
    en: { name: 'Gemini CLI', description: 'Google account sign-in is not yet wired to chat.' },
  },
};

export function providerDisplay(
  type: ProviderType,
  locale: UiLocale = detectUiLocale(),
): ProviderCopy {
  const copy = PROVIDER_DISPLAY_COPY[type]?.[locale];
  if (copy) return copy;
  // Unknown providerType (a connection persisted on a branch that registers a
  // provider this build doesn't know) → fall back to the registry facts
  // instead of crashing. Mirrors `isFakeBackend`.
  const definition = PROVIDER_DEFAULTS[type];
  return {
    name: definition?.label ?? type,
    description: definition?.description ?? (locale === 'en' ? 'This provider is not registered in the current build.' : '该 provider 在当前版本未注册。'),
    ...(definition?.catalogBadge ? { badge: definition.catalogBadge } : {}),
  };
}
