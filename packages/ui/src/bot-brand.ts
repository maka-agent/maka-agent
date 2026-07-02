import type { BotProvider } from '@maka/core';

export interface BotBrand {
  /** Hex color used as the brand tint behind the logo tile. */
  color: string;
  /** Single-character fallback if a local brand SVG id is missing. */
  glyph: string;
  /**
   * Local SVG id. `maka-bot:*` entries resolve against the vendored
   * bodies in `bot-brand-icons.ts` and render synchronously offline.
   */
  iconId: string;
  /** Optional product-side help link for credential provisioning docs. */
  configDocUrl?: string;
}

// Shared bot brand metadata. Both Settings → 机器人对话 and the chat-side
// Plan Reminder delivery picker need real brand logos here so the same
// channel reads as the same channel everywhere in the product (kenji
// audit 2026-06-25 msg `e4cfbfb0` finding #2).
//
// `maka-bot:*` ids are pre-bundled SVG bodies that render offline.
// See `bot-brand-icons.ts` header for the per-channel sourcing
// (Logos CC-BY for telegram + discord; Feishu official staircase
// for feishu; iOS-app-icon style locally composed for wechat /
// wecom / dingtalk / qq).
//
// PR-BOT-LOGO-NEUTRAL-PLATE-0 (WAWQAQ msg `f3d263b4` 2026-06-26)
// replaces the previous monochrome silhouettes with iOS-app-icon
// style real brand tiles — each `maka-bot:*` SVG body is now a
// brand-color rounded square with the official white mark, matching the
// realism of `provider-brand-marks.tsx` for model providers.
// All 7 IM channels render fully offline; nothing falls through to a CDN.
export const BOT_BRAND: Record<BotProvider, BotBrand> = {
  telegram: { color: '#229ED9', glyph: 'T', iconId: 'maka-bot:telegram', configDocUrl: 'https://core.telegram.org/bots/tutorial' },
  feishu:   { color: '#00C6B7', glyph: '飞', iconId: 'maka-bot:feishu', configDocUrl: 'https://open.feishu.cn/document/server-docs/bot-v3' },
  wecom:    { color: '#0089FF', glyph: '企', iconId: 'maka-bot:wecom', configDocUrl: 'https://developer.work.weixin.qq.com/document/' },
  wechat:   { color: '#07C160', glyph: '微', iconId: 'maka-bot:wechat', configDocUrl: 'https://developers.weixin.qq.com/doc/offiaccount/Getting_Started/Overview.html' },
  discord:  { color: '#5865F2', glyph: 'D', iconId: 'maka-bot:discord', configDocUrl: 'https://discord.com/developers/docs/intro' },
  dingtalk: { color: '#1372FB', glyph: '钉', iconId: 'maka-bot:dingtalk', configDocUrl: 'https://open.dingtalk.com/document/' },
  qq:       { color: '#12B7F5', glyph: 'Q', iconId: 'maka-bot:qq', configDocUrl: 'https://bot.q.qq.com/wiki/' },
};
