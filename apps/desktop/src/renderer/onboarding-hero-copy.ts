/**
 * Pure copy + CTA mapping for `OnboardingHero` (PR110c).
 *
 * Extracted so the per-`OnboardingState.kind` branches can be unit-
 * tested without JSX / React. The hero component consumes this
 * helper and renders the matching structure.
 *
 * @kenji + @xuan PR110c review gates:
 *   - Every `OnboardingState.kind` has an explicit branch — no
 *     generic default. `blocked: all_connections_unhealthy` MUST
 *     produce a labeled fallback.
 *   - Copy is Chinese; raw `state.kind` strings MUST NOT appear in
 *     `title`, `body`, `cta.label`, or `eyebrow`.
 *   - For `needs_connection_credentials` / `needs_default_model`,
 *     `connectionSlug` may appear in the body as a slug literal but
 *     `connectionName` / model list must NOT be promised until
 *     sanitized display data is wired in a later PR.
 *   - `ready_with_history` returns `null` — the caller MUST NOT
 *     mount the hero for that state (the existing chat surface
 *     takes over).
 */

import type { OnboardingState, SettingsSection } from '@maka/core';

export interface OnboardingHeroCopy {
  /** `OnboardingState.kind` echoed verbatim — useful for tests +
   * tooling. Never rendered to the user. */
  kind: OnboardingState['kind'];
  eyebrow: string;
  title: string;
  /**
   * Plain-text body. The actual hero component may render this with
   * inline emphasis / `<code>` for the slug; the test surface uses
   * the plain string.
   */
  body: string;
  /**
   * Slug to highlight in the body, if any (rendered as `<code>` by
   * the component). Currently only set for the two per-connection
   * variants. PR110c does NOT promise a `connectionName` — only the
   * raw slug literal.
   */
  connectionSlug?: string;
  cta: {
    label: string;
    settingsSection: SettingsSection;
  };
  tone?: 'warning';
  /**
   * Whether the hero should render the Quick Chat composer rather
   * than a setup CTA. Only true for `ready_empty`.
   */
  showQuickChat?: boolean;
}

export function getOnboardingHeroCopy(state: OnboardingState): OnboardingHeroCopy | null {
  switch (state.kind) {
    case 'needs_connection':
      return {
        kind: state.kind,
        eyebrow: '欢迎使用 Maka',
        title: '把一个真实的 LLM 接进来，再开始第一条对话。',
        body: 'Maka 只跑在你电脑上 —— 模型走你自己的 API key。点常见接入卡片进入「设置 · 模型」添加它的 key。',
        cta: { label: '打开设置 · 模型', settingsSection: 'models' },
      };
    case 'needs_default_connection':
      return {
        kind: state.kind,
        eyebrow: '选择默认模型连接',
        title: '选一个连接作为默认。',
        body: '你已经配置了至少一个模型连接，但还没设为默认。请到「设置 · 模型」挑一个作为默认连接，再开始对话。',
        cta: { label: '打开设置 · 模型', settingsSection: 'models' },
      };
    case 'needs_connection_credentials':
      return {
        kind: state.kind,
        eyebrow: '补齐凭据',
        title: '为这个连接配置 API key。',
        body: '默认连接等待填写 API key。请到「设置 · 模型」打开该连接，补齐密钥后再开始对话。',
        connectionSlug: state.connectionSlug,
        cta: { label: '打开设置 · 模型', settingsSection: 'models' },
      };
    case 'needs_default_model':
      return {
        kind: state.kind,
        eyebrow: '选择默认模型',
        title: '为这个连接选一个可用模型。',
        body: '默认连接还没绑定可用模型。请到「设置 · 模型」给它选一个，再开始对话。',
        connectionSlug: state.connectionSlug,
        cta: { label: '打开设置 · 模型', settingsSection: 'models' },
      };
    case 'ready_empty':
      return {
        kind: state.kind,
        // PR-SIDEBAR-IA-0 Phase 3 P0 fixup v2 (kenji `08be08d8`):
        // dropped the all-caps English `READY` prefix — the rest
        // of this enum is Chinese-only. The eyebrow now reads
        // `准备就绪 · 开始对话` to match the surrounding rhythm.
        eyebrow: '准备就绪 · 开始对话',
        title: '你已经配置好了 —— 直接说说你想做什么。',
        body: '下面的输入框会用默认模型开新会话；空提交也会打开一个空会话，方便你之后再输入。',
        cta: { label: '开始对话', settingsSection: 'models' },
        showQuickChat: true,
      };
    case 'blocked':
      // `blocked.reason` is `'all_connections_unhealthy'` in PR110a's
      // closed enum. The labeled branch keeps the assertion explicit
      // — a future enum extension fails to compile rather than
      // silently fallthrough.
      void state.reason;
      return {
        kind: state.kind,
        eyebrow: '等待恢复模型连接',
        title: '当前没有通过验证的模型连接。',
        body: '请到「设置 · 账号」查看每个连接的状态，重新测试或重新登录后再开始对话。',
        cta: { label: '打开设置 · 账号', settingsSection: 'account' },
        tone: 'warning',
      };
    case 'ready_with_history':
      // The renderer caller decides which surface to mount; this
      // helper returning `null` is the explicit "do not render"
      // signal. The existing chat / session list takes over.
      return null;
    default:
      return assertNever(state);
  }
}

function assertNever(state: never): never {
  void state;
  throw new Error('getOnboardingHeroCopy: unexhausted OnboardingState variant');
}
