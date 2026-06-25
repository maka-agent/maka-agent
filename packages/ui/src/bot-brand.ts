import type { BotProvider } from '@maka/core';

export interface BotBrand {
  /** Hex color used as the brand tint behind the logo tile. */
  color: string;
  /** Single-character offline fallback while the remote icon loads. */
  glyph: string;
  /**
   * Iconify icon id. When the prefix is `maka-bot:*` the icon is
   * pre-registered locally (`bot-brand-icons.ts`) and renders
   * synchronously with no CDN roundtrip; when the prefix is
   * `simple-icons:*` the icon is lazy-fetched from the Iconify CDN at
   * runtime — the `glyph` field is the offline fallback for that case.
   */
  iconifyId: string;
  /** Optional product-side help link for credential provisioning docs. */
  configDocUrl?: string;
}

// Shared bot brand metadata. Both Settings → 机器人对话 and the chat-side
// Plan Reminder delivery picker need real brand logos here so the same
// channel reads as the same channel everywhere in the product (kenji
// audit 2026-06-25 msg `e4cfbfb0` finding #2).
//
// `maka-bot:*` ids are pre-bundled SVG bodies that render offline.
// `simple-icons:*` ids still rely on Iconify's CDN — Simple Icons
// dropped (or never carried) Feishu/Lark and DingTalk standalone
// icons, so until we source them from each brand's official kit they
// fall back to the colored-tile-with-glyph state when offline. Track
// the gap on @kenji audit follow-up.
export const BOT_BRAND: Record<BotProvider, BotBrand> = {
  telegram: { color: '#229ED9', glyph: 'T', iconifyId: 'maka-bot:telegram', configDocUrl: 'https://core.telegram.org/bots/tutorial' },
  feishu:   { color: '#00C6B7', glyph: '飞', iconifyId: 'simple-icons:lark', configDocUrl: 'https://open.feishu.cn/document/server-docs/bot-v3' },
  wecom:    { color: '#0089FF', glyph: '企', iconifyId: 'maka-bot:wechat', configDocUrl: 'https://developer.work.weixin.qq.com/document/' },
  wechat:   { color: '#07C160', glyph: '微', iconifyId: 'maka-bot:wechat', configDocUrl: 'https://developers.weixin.qq.com/doc/offiaccount/Getting_Started/Overview.html' },
  discord:  { color: '#5865F2', glyph: 'D', iconifyId: 'maka-bot:discord', configDocUrl: 'https://discord.com/developers/docs/intro' },
  dingtalk: { color: '#1372FB', glyph: '钉', iconifyId: 'simple-icons:dingtalk', configDocUrl: 'https://open.dingtalk.com/document/' },
  qq:       { color: '#EB1923', glyph: 'Q', iconifyId: 'maka-bot:qq', configDocUrl: 'https://bot.q.qq.com/wiki/' },
};
