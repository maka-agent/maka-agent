import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createDefaultSettings, type BotProvider } from '@maka/core';
import type { BotStatus } from '@maka/runtime';
import { deriveBotChannelViewState } from '../../renderer/settings/bot-settings-view-model.js';

describe('Bot Settings view model', () => {
  it('uses live degraded readiness for enabled implemented channels', () => {
    for (const provider of ['feishu', 'wechat'] satisfies BotProvider[]) {
      const channel = createDefaultSettings().botChat.channels[provider];
      channel.enabled = true;
      channel.connected = true;
      channel.readiness = 'credentials_valid';
      const status: BotStatus = {
        platform: provider,
        running: false,
        readiness: 'degraded',
        reason: 'stopped',
        connection: 'none',
      };

      const result = deriveBotChannelViewState({
        channel,
        status,
      });

      assert.equal(result.readiness, 'degraded', provider);
      assert.equal(result.needsAttention, true, provider);
    }
  });

  it('lets a live operational state supersede a persisted historical error', () => {
    const channel = createDefaultSettings().botChat.channels.telegram;
    channel.enabled = true;
    channel.readiness = 'degraded';
    channel.lastError = '上一次连接超时';
    const status: BotStatus = {
      platform: 'telegram',
      running: true,
      readiness: 'operational',
      connection: 'polling',
    };

    const result = deriveBotChannelViewState({
      channel,
      status,
    });

    assert.equal(result.readiness, 'operational');
    assert.equal(result.needsAttention, false);
    assert.equal(result.currentError, undefined);
  });
});
