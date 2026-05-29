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

/**
 * PR-BOT-PLAINTEXT-HELP-COMMAND-0 (Hermes deep-dive): DM-only help
 * affordance so a new user can discover what the bot supports
 * without leaving Telegram. Same match policy as
 * {@link isPlaintextResetCommand} — DM-only, NFC + lowercase + trim,
 * exact membership, no substring match.
 *
 * The fixed reply text is deliberately short and product-scoped:
 * how to chat, how to reset, and the threading behavior. No
 * marketing copy or roadmap language.
 */
export const BOT_PLAINTEXT_HELP_COMMANDS: ReadonlyArray<string> = Object.freeze([
  'help',
  '/help',
  '?',
  '/?',
  '帮助',
  '/帮助',
]);

export function isPlaintextHelpCommand(
  message: Pick<BotMessageEvent, 'text' | 'isGroup'>,
): boolean {
  if (message.isGroup) return false;
  const trimmed = message.text.normalize('NFC').trim().toLowerCase();
  if (trimmed.length === 0) return false;
  return BOT_PLAINTEXT_HELP_COMMANDS.includes(trimmed);
}

export function plaintextHelpReply(): string {
  return [
    'Maka 机器人帮助',
    '',
    '· 直接发文字消息就能和 Maka 对话；回复会挂在你的提问下面。',
    '· 想清空当前对话开新会话，发：restart / reset / 重置 / 重启 / 新对话。',
    '· 群里不响应 plaintext 重置指令（避免一个成员把整群对话清掉）。',
    '· 长回复会自动拆成多条，第一条挂在你的提问下面。',
  ].join('\n');
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

/**
 * PR-BOT-LASTERROR-FROM-SEND-0 (Hermes deep-dive): translate the bridge's
 * machine-readable `BotStatus.reason` into a short user-readable string
 * suitable for persistence in `BotChannelSettings.lastError`. The Settings
 * page reads `lastError` from persisted settings (not live status), so
 * without this persistence step the user sees stale connection-test
 * errors instead of the actual send-path failure that happened minutes
 * ago.
 *
 * Returns `undefined` for non-error reasons (disabled/stopped/missing
 * credentials — those have their own UI surface) and for unrecognized
 * inputs whose pass-through risks leaking unredacted payloads.
 *
 * Length-capped at 200 chars defensively; a real Telegram error
 * description is typically well under 80 chars.
 */
const BOT_REASON_HUMANIZE: Record<string, string | undefined> = {
  'rate-limited': '发送被节流（429）；上一条回复可能截断，可以请用户再发一次',
  'polling-timeout': '事件轮询超时；可能是网络抖动或代理失效',
  'send-failed': '上一次发送失败，详细原因 Telegram 没有返回',
  'get-me-failed': '凭据探测失败；请检查 Bot Token',
  // Non-error states surface elsewhere in the UI — return undefined so
  // we do not overwrite a real lastError with a benign status change.
  'disabled': undefined,
  'stopped': undefined,
  'no-token': undefined,
  'missing-feishu-credentials': undefined,
  'feishu-domain-required': undefined,
  'feishu-events-not-connected': undefined,
  'scaffold-only': undefined,
  'unimplemented': undefined,
};

export function humanizeBotStatusReason(reason: string | undefined): string | undefined {
  if (typeof reason !== 'string' || reason.length === 0) return undefined;
  if (reason in BOT_REASON_HUMANIZE) {
    return BOT_REASON_HUMANIZE[reason];
  }
  // Pass-through for Telegram-supplied descriptions ("Bad Request: chat
  // not found", etc.). Trim + length-cap to keep `lastError` bounded.
  const trimmed = reason.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > 200 ? trimmed.slice(0, 200) : trimmed;
}
