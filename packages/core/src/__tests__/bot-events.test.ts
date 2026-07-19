import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  BOT_PLAINTEXT_HELP_COMMANDS,
  BOT_PLAINTEXT_RESET_COMMANDS,
  botConversationKey,
  botDisplayLabel,
  botSourceEventKey,
  formatBotMessageForSession,
  humanizeBotStatusReason,
  isPlaintextHelpCommand,
  isPlaintextResetCommand,
  nonTextMessageAck,
  plaintextHelpReply,
  type BotAttachmentKind,
  type BotMessageEvent,
} from '../index.js';

describe('bot event contract', () => {
  const message: BotMessageEvent = {
    platform: 'telegram',
    userId: 'u1',
    userName: ' Alice\u0000 ',
    chatId: 'chat-1',
    isGroup: false,
    text: '  hello  ',
    sourceMessageId: 'm1',
    receivedAt: 1_700_000_000_000,
  };

  test('uses stable platform labels for session names and prompts', () => {
    assert.equal(botDisplayLabel('telegram'), 'Telegram');
    assert.equal(botDisplayLabel('feishu'), '飞书');
    assert.equal(botDisplayLabel('dingtalk'), '钉钉');
  });

  test('builds stable conversation keys from platform and chat id', () => {
    assert.equal(botConversationKey(message), 'telegram:chat-1');
  });

  test('builds stable source event keys from platform chat and source message id', () => {
    assert.equal(botSourceEventKey(message), 'telegram:chat-1:m1');
    assert.equal(
      botSourceEventKey({
        ...message,
        platform: 'discord',
        chatId: 'chan-1',
        sourceMessageId: 'msg-99',
      }),
      'discord:chan-1:msg-99',
    );
  });

  test('does not fabricate source event keys when platform id is missing', () => {
    assert.equal(botSourceEventKey({ ...message, sourceMessageId: '' }), undefined);
    assert.equal(botSourceEventKey({ ...message, sourceMessageId: '   ' }), undefined);
  });

  test('formats incoming bot text before appending to a Maka session', () => {
    assert.equal(formatBotMessageForSession(message), '[Telegram:Alice] hello');
  });
});

// PR-BOT-PLAINTEXT-RESET-COMMAND-0
describe('isPlaintextResetCommand', () => {
  const dm = { isGroup: false };
  const group = { isGroup: true };

  test('matches the bare English reset commands in DMs', () => {
    assert.equal(isPlaintextResetCommand({ ...dm, text: 'restart' }), true);
    assert.equal(isPlaintextResetCommand({ ...dm, text: 'reset' }), true);
    assert.equal(isPlaintextResetCommand({ ...dm, text: '/restart' }), true);
    assert.equal(isPlaintextResetCommand({ ...dm, text: '/reset' }), true);
    assert.equal(isPlaintextResetCommand({ ...dm, text: '/new' }), true);
    assert.equal(isPlaintextResetCommand({ ...dm, text: 'new chat' }), true);
  });

  test('matches the bare Chinese reset commands in DMs', () => {
    assert.equal(isPlaintextResetCommand({ ...dm, text: '重启' }), true);
    assert.equal(isPlaintextResetCommand({ ...dm, text: '重置' }), true);
    assert.equal(isPlaintextResetCommand({ ...dm, text: '重新开始' }), true);
    assert.equal(isPlaintextResetCommand({ ...dm, text: '新对话' }), true);
    assert.equal(isPlaintextResetCommand({ ...dm, text: '新会话' }), true);
  });

  test('is case-insensitive and tolerates surrounding whitespace', () => {
    assert.equal(isPlaintextResetCommand({ ...dm, text: 'RESET' }), true);
    assert.equal(isPlaintextResetCommand({ ...dm, text: '  Restart  ' }), true);
    assert.equal(isPlaintextResetCommand({ ...dm, text: '\n/reset\n' }), true);
  });

  test('does NOT substring-match a sentence containing the word "restart"', () => {
    // Critical: "please restart the conversation" must NOT trigger.
    assert.equal(isPlaintextResetCommand({ ...dm, text: 'please restart' }), false);
    assert.equal(isPlaintextResetCommand({ ...dm, text: 'restart the conversation' }), false);
    assert.equal(isPlaintextResetCommand({ ...dm, text: '我想重启电脑' }), false);
  });

  test('is silently ignored in group chats — conversation key is not user-scoped', () => {
    // Until userId-scoped conversation keys land, a group member typing
    // "restart" would otherwise drop the conversation for everyone in
    // the chat. Stay defensive and require the explicit DM context.
    assert.equal(isPlaintextResetCommand({ ...group, text: 'restart' }), false);
    assert.equal(isPlaintextResetCommand({ ...group, text: '重置' }), false);
  });

  test('treats empty / whitespace-only text as no command', () => {
    assert.equal(isPlaintextResetCommand({ ...dm, text: '' }), false);
    assert.equal(isPlaintextResetCommand({ ...dm, text: '   ' }), false);
    assert.equal(isPlaintextResetCommand({ ...dm, text: '\n\t' }), false);
  });

  test('exports the canonical command list for downstream UI hints', () => {
    // Downstream UI (e.g. bot help footer) should be able to enumerate
    // the supported phrases without duplicating the list.
    assert.equal(BOT_PLAINTEXT_RESET_COMMANDS.length > 0, true);
    assert.equal(BOT_PLAINTEXT_RESET_COMMANDS.includes('restart'), true);
    assert.equal(BOT_PLAINTEXT_RESET_COMMANDS.includes('重置'), true);
  });
});

// PR-BOT-PLAINTEXT-HELP-COMMAND-0
describe('isPlaintextHelpCommand', () => {
  const dm = { isGroup: false };
  const group = { isGroup: true };

  test('matches the canonical help phrases in DMs', () => {
    for (const phrase of BOT_PLAINTEXT_HELP_COMMANDS) {
      assert.equal(
        isPlaintextHelpCommand({ ...dm, text: phrase }),
        true,
        `should match: ${phrase}`,
      );
    }
  });

  test('is case-insensitive and tolerates surrounding whitespace', () => {
    assert.equal(isPlaintextHelpCommand({ ...dm, text: 'HELP' }), true);
    assert.equal(isPlaintextHelpCommand({ ...dm, text: '  Help  ' }), true);
  });

  test('does NOT substring-match', () => {
    assert.equal(isPlaintextHelpCommand({ ...dm, text: 'I need help with this' }), false);
    assert.equal(isPlaintextHelpCommand({ ...dm, text: '请帮助我' }), false);
  });

  test('is silently ignored in group chats', () => {
    assert.equal(isPlaintextHelpCommand({ ...group, text: 'help' }), false);
    assert.equal(isPlaintextHelpCommand({ ...group, text: '帮助' }), false);
  });

  test('plaintextHelpReply lists the supported actions without marketing copy', () => {
    const reply = plaintextHelpReply();
    // Must surface the user-visible commands so a help-asker can act.
    assert.match(reply, /Maka 机器人帮助/);
    assert.match(reply, /restart/);
    assert.match(reply, /重置/);
    // Must NOT contain demo-stage / roadmap language.
    assert.equal(/即将|尚未|TODO|coming soon/i.test(reply), false);
  });

  test('does not collide with the reset phrases — they remain distinct', () => {
    for (const phrase of BOT_PLAINTEXT_HELP_COMMANDS) {
      assert.equal(
        BOT_PLAINTEXT_RESET_COMMANDS.includes(phrase),
        false,
        `help phrase ${phrase} must not also be a reset trigger`,
      );
    }
  });
});

// PR-BOT-LASTERROR-FROM-SEND-0
describe('humanizeBotStatusReason', () => {
  test('returns undefined for non-error states so we do not overwrite a real lastError', () => {
    assert.equal(humanizeBotStatusReason('disabled'), undefined);
    assert.equal(humanizeBotStatusReason('stopped'), undefined);
    assert.equal(humanizeBotStatusReason('no-token'), undefined);
    assert.equal(humanizeBotStatusReason('scaffold-only'), undefined);
    assert.equal(humanizeBotStatusReason('unimplemented'), undefined);
    assert.equal(humanizeBotStatusReason('feishu-domain-required'), undefined);
  });

  test('translates known send-path failure reasons to user-readable copy', () => {
    assert.match(humanizeBotStatusReason('rate-limited')!, /节流/);
    assert.match(humanizeBotStatusReason('polling-timeout')!, /轮询超时/);
    assert.match(humanizeBotStatusReason('send-failed')!, /发送失败/);
    assert.match(humanizeBotStatusReason('get-me-failed')!, /凭据探测失败/);
  });

  test('passes through Telegram-supplied descriptions verbatim (trimmed)', () => {
    assert.equal(
      humanizeBotStatusReason('  Bad Request: chat not found  '),
      'Bad Request: chat not found',
    );
    assert.equal(humanizeBotStatusReason('Unauthorized'), 'Unauthorized');
  });

  test('length-caps unknown reasons to 200 chars defensively', () => {
    const long = 'A'.repeat(300);
    const out = humanizeBotStatusReason(long)!;
    assert.equal(out.length, 200);
    assert.equal(out, 'A'.repeat(200));
  });

  // PR-BOT-RUNTIME-REASON-HUMANIZE-0: pattern-based translation for the
  // parameterized reason strings emitted by Discord / DingTalk / QQ
  // bridges. Without these the user would see raw `gateway-closed-4004`
  // in `lastError`.
  test('translates gateway-bot-NNN to a readable description preserving the diagnostic code', () => {
    assert.match(humanizeBotStatusReason('gateway-bot-401')!, /Gateway/);
    assert.match(humanizeBotStatusReason('gateway-bot-401')!, /401/);
    assert.match(humanizeBotStatusReason('gateway-bot-500')!, /500/);
  });

  test('translates gateway-closed-NNN to "正在重连" so users see active recovery', () => {
    const out = humanizeBotStatusReason('gateway-closed-4004')!;
    assert.match(out, /Gateway 连接关闭/);
    assert.match(out, /4004/);
    assert.match(out, /重连/);
  });

  test('translates connections-open-NNN (DingTalk Stream open failed)', () => {
    const out = humanizeBotStatusReason('connections-open-503')!;
    assert.match(out, /Stream 订阅打开失败/);
    assert.match(out, /503/);
  });

  test('translates stream-closed-NNN (DingTalk Stream gateway closed)', () => {
    const out = humanizeBotStatusReason('stream-closed-1006')!;
    assert.match(out, /Stream 连接关闭/);
    assert.match(out, /1006/);
    assert.match(out, /重连/);
  });

  test('translates send-failed-NNN (Discord REST send returned non-2xx)', () => {
    const out = humanizeBotStatusReason('send-failed-403')!;
    assert.match(out, /发送失败/);
    assert.match(out, /403/);
  });

  test('translates getAppAccessToken-NNN (QQ token refresh failed)', () => {
    const out = humanizeBotStatusReason('getAppAccessToken-401')!;
    assert.match(out, /access_token/);
    assert.match(out, /401/);
  });

  test('falls through to verbatim pass-through for unrecognized parameterized reasons', () => {
    // A future bridge might emit a code we haven't taught the
    // humanizer about yet — the user still sees something rather
    // than `undefined` or an empty `lastError`.
    assert.equal(humanizeBotStatusReason('something-weird-42'), 'something-weird-42');
  });

  test('returns undefined for empty / whitespace / non-string', () => {
    assert.equal(humanizeBotStatusReason(undefined), undefined);
    assert.equal(humanizeBotStatusReason(''), undefined);
    assert.equal(humanizeBotStatusReason('   '), undefined);
    assert.equal(humanizeBotStatusReason('\t\n'), undefined);
  });
});

// PR-BOT-NON-TEXT-MESSAGE-ACK-0
describe('nonTextMessageAck', () => {
  test('returns kind-appropriate copy for each attachment kind', () => {
    assert.match(nonTextMessageAck('photo'), /caption/);
    assert.match(nonTextMessageAck('voice'), /语音/);
    assert.match(nonTextMessageAck('audio'), /语音/);
    assert.match(nonTextMessageAck('sticker'), /贴纸/);
    assert.match(nonTextMessageAck('video'), /视频/);
    assert.match(nonTextMessageAck('animation'), /视频/);
    assert.match(nonTextMessageAck('document'), /附件文件/);
    assert.match(nonTextMessageAck('unknown'), /文字/);
  });

  test('all messages explain that Maka only handles text (consistent contract)', () => {
    const kinds: BotAttachmentKind[] = [
      'photo',
      'voice',
      'audio',
      'sticker',
      'video',
      'animation',
      'document',
      'unknown',
    ];
    for (const kind of kinds) {
      assert.match(nonTextMessageAck(kind), /Maka/, `${kind} ack should mention Maka by name`);
      // Must not contain demo-stage or roadmap language — these are
      // user-facing acks that should describe current product behavior.
      assert.equal(
        /即将|尚未|TODO|coming soon|后续版本/i.test(nonTextMessageAck(kind)),
        false,
        `${kind} ack must not use roadmap language`,
      );
    }
  });
});
