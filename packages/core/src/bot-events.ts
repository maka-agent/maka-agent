import type { BotProvider } from './settings.js';

export type BotPlatform = BotProvider;

export interface BotAttachmentRef {
  kind: 'image' | 'file' | 'voice';
  url?: string;
  fileId?: string;
  mimeType?: string;
}

export interface BotMessageEvent {
  platform: BotPlatform;
  userId: string;
  userName: string;
  chatId: string;
  isGroup: boolean;
  text: string;
  sourceMessageId: string;
  receivedAt: number;
  attachments?: BotAttachmentRef[];
}

export function botDisplayLabel(platform: BotPlatform): string {
  switch (platform) {
    case 'telegram': return 'Telegram';
    case 'feishu': return '飞书';
    case 'wecom': return '企业微信';
    case 'wechat': return '微信';
    case 'discord': return 'Discord';
    case 'dingtalk': return '钉钉';
    case 'qq': return 'QQ';
  }
}

export function botConversationKey(message: Pick<BotMessageEvent, 'platform' | 'chatId'>): string {
  return `${message.platform}:${message.chatId}`;
}

export function formatBotMessageForSession(
  message: Pick<BotMessageEvent, 'platform' | 'userName' | 'text'>,
): string {
  return `[${botDisplayLabel(message.platform)}:${sanitizeBotUserName(message.userName)}] ${message.text.trim()}`;
}

function sanitizeBotUserName(value: string): string {
  return value
    .replace(/[\u0000-\u001F\u007F-\u009F]+/g, ' ')
    .replace(/[\p{Cf}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim() || 'unknown';
}
