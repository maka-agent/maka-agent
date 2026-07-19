import type { BotProvider, BotReadinessState } from '@maka/core';
import type { BotStatus } from '@maka/runtime';
import { BotBrandLogo as BotBrandMark } from '@maka/ui';

/**
 * Per-platform brand presentation.
 *
 * History:
 * - PR-BOT-SETTINGS-UI-0 (WAWQAQ msg `51c7b4ff`) shipped single-char
 *   monograms (T / 飞 / 企 / 微 / D / 钉 / Q) tinted with the brand color
 *   as a license/asset-hygiene compromise.
 * - WAWQAQ msg `c8a9fc6f` 2026-06-25 reversed this: "IM 的渠道，这一些
 *   显然应该用真实的图标，而不是用字。就像现在模型的这一些图标都是
 *   用的真实对应公司的图标。" → swap the monogram for the real brand
 *   icon, the same way model providers already use their actual logos.
 *
 * Implementation: `BotBrandMark` renders a local provider SVG. The icons
 * render synchronously offline; `glyph` stays only as metadata for text
 * fallback contexts.
 *
 * `configDocUrl` is the official developer doc surfaced inline as a
 * "查看配置文档" link.
 */
// BOT_BRAND moved to `packages/ui/src/bot-brand.ts` so the Plan Reminder
// delivery picker can use the same brand metadata as Settings here (@kenji
// audit 2026-06-25 msg `e4cfbfb0` finding #2). Imported via `@maka/ui`.

// PR-BOT-WECHAT-SCAN-LOGIN-0 (WAWQAQ msg `2fa6ada6`): help copy
// rewritten per reference screenshots — short product sentence pointing
// at where to provision credentials; not a runtime technical breakdown.
export const BOT_LABELS: Record<BotProvider, { label: string; help: string; support: 'runtime' | 'credentials' | 'planned' }> = {
  telegram: {
    label: 'Telegram',
    help: '通过 @BotFather 创建 Bot 并获取 Token',
    support: 'runtime',
  },
  feishu: {
    label: '飞书',
    help: '在飞书开放平台创建应用并获取凭证',
    support: 'credentials',
  },
  wecom: {
    label: '企业微信',
    help: '通过企业微信 AI 应用接入，使用 WebSocket 长连接',
    support: 'credentials',
  },
  wechat: {
    label: '微信',
    help: '通过本机 wechat-bridge 接入个人微信，需 iOS / Android 微信 8.0.70+。',
    support: 'credentials',
  },
  discord: {
    label: 'Discord',
    help: '在 Discord Developer Portal 创建 Bot',
    support: 'runtime',
  },
  dingtalk: {
    label: '钉钉',
    help: '在钉钉开发者后台创建机器人应用',
    support: 'runtime',
  },
  qq: {
    label: 'QQ',
    help: '在 QQ 开放平台创建机器人并获取 AppID 和 AppSecret',
    support: 'runtime',
  },
};

const BOT_READINESS_COPY: Record<BotReadinessState, { label: string; detail: string; tone: 'neutral' | 'info' | 'success' | 'warning' | 'destructive' }> = {
  unscaffolded: { label: '未开放', detail: '该平台当前不可作为远程接入渠道。', tone: 'neutral' },
  scaffolded: { label: '待配置', detail: '等待补齐这个平台需要的凭据配置。', tone: 'neutral' },
  configured: { label: '已配置', detail: '已填写配置；等待完成凭据或运行态验证。', tone: 'info' },
  credentials_valid: { label: '凭据有效', detail: '凭据探测通过；这不代表已能收发消息。', tone: 'warning' },
  operational: { label: '运行可用', detail: '最近一次真实运行探测成功。', tone: 'success' },
  degraded: { label: '运行降级', detail: '之前可用，但最近运行态探测失败。', tone: 'destructive' },
};

const BOT_PLANNED_COPY = {
  label: '未开放',
  detail: '该平台当前不会保存为远程接入渠道或计划提醒投递目标。',
  tone: 'neutral' as const,
};

export function botReadinessCopyForSupport(support: 'runtime' | 'credentials' | 'planned', readiness: BotReadinessState) {
  if (support === 'planned') return BOT_PLANNED_COPY;
  return BOT_READINESS_COPY[readiness] ?? BOT_READINESS_COPY.scaffolded;
}

/** Shared provider logo, compact in the overview and larger in channel detail. */
export function BotBrandLogo(props: { provider: BotProvider; size?: 'compact' | 'large' }) {
  const isLarge = props.size === 'large';
  return (
    <span
      className="settingsBotLogo"
      data-large={isLarge ? 'true' : undefined}
      data-provider={props.provider}
      aria-hidden="true"
    >
      {/* PR-BOT-LOGO-NEUTRAL-PLATE-0 (WAWQAQ msg `f3d263b4`
          2026-06-26): real iOS-app-icon style. The brand SVG carries
          the brand-color disc + white official mark (Telegram blue
          gradient + paper plane, WeChat green + double-bubble,
          Discord blurple + Clyde, Feishu 3-color staircase, …) —
          see `packages/ui/src/bot-brand-logo.tsx`. width/height
          100% so the brand tile fills `.settingsBotLogo` edge-to-
          edge; the parent plate is transparent so the brand-color
          disc IS the visible tile. */}
      <BotBrandMark
        provider={props.provider}
        width="100%"
        height="100%"
        aria-hidden="true"
      />
    </span>
  );
}

export type BotPendingActionName = 'test' | 'connect' | 'restart' | 'disconnect';
export type BotPendingAction = { provider: BotProvider; action: BotPendingActionName };

export function botStatusDetail(status: BotStatus): string {
  switch (status.reason) {
    case 'disabled': return '开关关闭';
    case 'no-token': return '等待填写 Bot Token';
    case 'missing-feishu-credentials': return '等待填写飞书 App ID 或 App Secret';
    case 'feishu-domain-required': return '飞书凭据有效，等待填写事件订阅域名';
    case 'feishu-events-not-connected': return '飞书凭据有效，等待事件回调接入';
    case 'scaffold-only': return '该平台当前不可作为远程接入渠道';
    case 'unimplemented': return '该平台当前不可作为远程接入渠道';
    case 'stopped': return '监听已停止';
    // PR-BOT-CHAT-POLISH-0: the previous fallback `status.reason ??
    // '暂无运行细节'` would surface a raw reason code (e.g.
    // `polling-timeout`) for any unmapped state. That's noise the
    // user can't act on; collapse to a generalized copy.
    default: return '运行态详情请见日志';
  }
}
