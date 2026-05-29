import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createDefaultBotChannel } from '@maka/core';
import { botReadinessFromSettings, botSettingsRequireRestart } from '../base-adapter.js';
import {
  mapWechatBridgeMessage,
  normalizeWechatBridgeUrl,
  readSseJsonObjects,
} from '../wechat-bridge.js';

describe('WechatBridge', () => {
  test('normalizes only local http bridge URLs', () => {
    assert.equal(normalizeWechatBridgeUrl(undefined), 'http://127.0.0.1:18400');
    assert.equal(normalizeWechatBridgeUrl(' http://localhost:18400/ '), 'http://localhost:18400');
    assert.equal(normalizeWechatBridgeUrl('http://127.0.0.1:18400/'), 'http://127.0.0.1:18400');
    assert.equal(normalizeWechatBridgeUrl('https://127.0.0.1:18400'), null);
    assert.equal(normalizeWechatBridgeUrl('http://192.168.0.2:18400'), null);
    assert.equal(normalizeWechatBridgeUrl('https://example.com/wechat-bridge'), null);
  });

  test('bridge URL is a credential fact and a restart boundary', () => {
    const channel = createDefaultBotChannel('wechat');
    assert.equal(channel.webhookUrl, 'http://127.0.0.1:18400');
    assert.equal(botReadinessFromSettings({ ...channel, enabled: true }), 'configured');
    assert.equal(
      botSettingsRequireRestart(channel, { ...channel, webhookUrl: 'http://localhost:18400' }),
      true,
    );
  });

  test('maps live direct bridge messages into bot events', () => {
    const event = mapWechatBridgeMessage({
      chatId: 'wxid_friend',
      senderId: 'wxid_friend',
      senderName: 'Alice',
      messageId: 'msg-1',
      body: 'hello',
      timestamp: 1_700_000_000,
    });

    assert.deepEqual(event, {
      platform: 'wechat',
      userId: 'wxid_friend',
      userName: 'Alice',
      chatId: 'wxid_friend',
      isGroup: false,
      text: 'hello',
      sourceMessageId: 'msg-1',
      receivedAt: 1_700_000_000_000,
    });
  });

  test('drops self messages and unmentioned group messages', () => {
    assert.equal(mapWechatBridgeMessage({
      chatId: 'wxid_friend',
      senderId: 'wxid_friend',
      messageId: 'self',
      body: 'loop',
      fromSelf: true,
    }), null);

    assert.equal(mapWechatBridgeMessage({
      chatId: 'room@chatroom',
      senderId: 'wxid_member',
      messageId: 'group-no-at',
      body: 'not for maka',
    }), null);
  });

  test('accepts mentioned group messages and common bridge aliases', () => {
    const event = mapWechatBridgeMessage({
      roomId: 'room@chatroom',
      fromWxid: 'wxid_member',
      nickname: 'Bob',
      msgId: 'group-1',
      content: '@Maka ping',
      isAt: true,
      createTime: 1_700_000_001_234,
    });

    assert.equal(event?.platform, 'wechat');
    assert.equal(event?.chatId, 'room@chatroom');
    assert.equal(event?.userId, 'wxid_member');
    assert.equal(event?.userName, 'Bob');
    assert.equal(event?.isGroup, true);
    assert.equal(event?.sourceMessageId, 'group-1');
    assert.equal(event?.text, '@Maka ping');
    assert.equal(event?.receivedAt, 1_700_000_001_234);
  });

  test('maps bridge media kinds and rejects empty non-media messages', () => {
    assert.equal(mapWechatBridgeMessage({
      chatId: 'wxid_friend',
      senderId: 'wxid_friend',
      messageId: 'empty',
      body: '',
    }), null);

    assert.equal(mapWechatBridgeMessage({
      chatId: 'wxid_friend',
      senderId: 'wxid_friend',
      messageId: 'image',
      messageKind: 'image',
    })?.attachmentKind, 'photo');

    assert.equal(mapWechatBridgeMessage({
      chatId: 'wxid_friend',
      senderId: 'wxid_friend',
      messageId: 'voice',
      mediaType: 'voice',
    })?.attachmentKind, 'voice');

    assert.equal(mapWechatBridgeMessage({
      chatId: 'wxid_friend',
      senderId: 'wxid_friend',
      messageId: 'file',
      type: 'file',
    })?.attachmentKind, 'document');
  });

  test('parses SSE data objects with LF and CRLF event boundaries', async () => {
    const encoder = new TextEncoder();
    async function* chunks(): AsyncGenerator<Uint8Array> {
      yield encoder.encode('event: message\r\ndata: {"id":1}\r\n\r\n');
      yield encoder.encode('data: [{"id":2}');
      yield encoder.encode(',{"id":3}]\n\n');
    }

    const parsed: unknown[] = [];
    for await (const value of readSseJsonObjects(chunks())) parsed.push(value);

    assert.deepEqual(parsed, [{ id: 1 }, [{ id: 2 }, { id: 3 }]]);
  });
});
