import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  botConversationKey,
  botDisplayLabel,
  formatBotMessageForSession,
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
