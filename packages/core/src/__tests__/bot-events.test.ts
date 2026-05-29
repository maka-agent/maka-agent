import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  BOT_PLAINTEXT_HELP_COMMANDS,
  BOT_PLAINTEXT_RESET_COMMANDS,
  botConversationKey,
  botDisplayLabel,
  formatBotMessageForSession,
  isPlaintextHelpCommand,
  isPlaintextResetCommand,
  plaintextHelpReply,
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
      assert.equal(isPlaintextHelpCommand({ ...dm, text: phrase }), true, `should match: ${phrase}`);
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
