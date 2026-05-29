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

/**
 * PR-BOT-PLAINTEXT-RESET-COMMAND-0 (Hermes deep-dive): DM-only plain-text
 * "restart this conversation" affordance. Maka has no slash command
 * runtime; users on mobile cannot easily type `/restart` either, so we
 * coerce a handful of natural phrases into a reset action.
 *
 * Why DM-only: the bot conversation key is `${platform}:${chatId}`, NOT
 * keyed by userId. In a group chat any member typing "restart" would
 * wipe the conversation everyone else is in. Until a userId-scoped key
 * lands, plain-text reset is silently ignored in groups so the cost of
 * a misfire stays bounded to the sender's own DM.
 *
 * Match policy: NFC-normalize + lowercase + trim, then exact membership.
 * No substring matching — the word "restart" inside a sentence is NOT
 * a reset request; matching only the bare command avoids surprising
 * users who intended to send a message ABOUT restart.
 */
export const BOT_PLAINTEXT_RESET_COMMANDS: ReadonlyArray<string> = Object.freeze([
  'restart',
  'reset',
  '/restart',
  '/reset',
  '/new',
  '/newchat',
  'new chat',
  '重启',
  '重置',
  '重新开始',
  '新对话',
  '新会话',
]);

export function isPlaintextResetCommand(
  message: Pick<BotMessageEvent, 'text' | 'isGroup'>,
): boolean {
  if (message.isGroup) return false;
  const trimmed = message.text.normalize('NFC').trim().toLowerCase();
  if (trimmed.length === 0) return false;
  return BOT_PLAINTEXT_RESET_COMMANDS.includes(trimmed);
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
