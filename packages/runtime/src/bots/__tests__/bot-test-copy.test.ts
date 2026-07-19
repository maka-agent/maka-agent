import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createDefaultBotChannel, type BotProvider } from '@maka/core';
import { testBotChannel } from '../bot-test.js';

describe('testBotChannel copy', () => {
  test('all bot platforms now route to a real credential probe, not the planned fallback', async () => {
    // PR-BOT-QQ-CREDENTIALS-TEST-0 + PR-BOT-WECHAT-BRIDGE-0: every
    // BotProvider now has a credential or local-bridge probe. None of
    // them should return the "当前不支持凭据测试" placeholder copy when
    // given empty credentials — they all surface product-specific errors.
    const providers: BotProvider[] = [
      'telegram',
      'discord',
      'feishu',
      'wecom',
      'wechat',
      'dingtalk',
      'qq',
    ];

    for (const provider of providers) {
      const result = await testBotChannel(provider, createDefaultBotChannel(provider));
      assert.equal(result.ok, false, `${provider} should reject empty credentials`);
      assert.doesNotMatch(
        result.error ?? '',
        /当前不支持凭据测试/,
        `${provider} must not surface the planned-fallback placeholder anymore`,
      );
    }
  });

  test('wecom rejects empty credentials with product copy (not a generic "Bot token required")', async () => {
    const result = await testBotChannel('wecom', createDefaultBotChannel('wecom'));
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /corp_id/);
    assert.match(result.error ?? '', /corp_secret/);
  });

  test('dingtalk rejects empty credentials with product copy (not a generic "Bot token required")', async () => {
    const result = await testBotChannel('dingtalk', createDefaultBotChannel('dingtalk'));
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /appkey/);
    assert.match(result.error ?? '', /appsecret/);
  });

  test('wechat rejects non-local bridge URLs instead of treating it as planned', async () => {
    const result = await testBotChannel('wechat', {
      ...createDefaultBotChannel('wechat'),
      webhookUrl: 'https://example.com/wechat-bridge',
    });
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /127\.0\.0\.1|localhost/);
    assert.doesNotMatch(
      `${result.error ?? ''} ${result.hint ?? ''}`,
      /当前不支持凭据测试|planned|not implemented|scaffold/i,
    );
  });

  test('qq rejects empty credentials with product copy (not a generic "Bot token required")', async () => {
    const result = await testBotChannel('qq', createDefaultBotChannel('qq'));
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /App ID/);
    assert.match(result.error ?? '', /Client Secret/);
  });
});
