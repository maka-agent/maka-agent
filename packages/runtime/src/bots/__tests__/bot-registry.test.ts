import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createDefaultBotChannel } from '@maka/core/settings';
import type { BotChatSettings, BotProvider } from '@maka/core';
import { BotRegistry } from '../bot-registry.js';
import type { BotStatus } from '../types.js';

describe('BotRegistry', () => {
  test('reports disabled and unimplemented statuses without starting bridges', async () => {
    const statuses: BotStatus[] = [];
    const registry = new BotRegistry({
      onIncomingMessage: () => {},
      onStatusChange: (status) => statuses.push(status),
    });

    // PR-BOT-QQ-OPERATIONAL-0: QQ used to be the unimplemented stand-in
    // here (and dingtalk before that), but now QQ has a live bridge too.
    // The remaining credentials-only platforms are WeCom + Feishu;
    // WeCom is the stand-in here. When WeCom-operational lands, this
    // assertion will need to move to Feishu (or to whichever credentials-
    // only platform is still unimplemented).
    await registry.applySettings(
      settingsWith({
        wecom: { enabled: true, token: 'unused', appId: 'corp', appSecret: 'secret' },
      }),
    );

    assert.equal(registry.getStatus('telegram').reason, 'disabled');
    assert.equal(registry.getStatus('telegram').readiness, 'scaffolded');
    assert.equal(registry.getStatus('wecom').reason, 'scaffold-only');
    assert.equal(registry.getStatus('wecom').running, false);
    assert.equal(registry.getStatus('wecom').readiness, 'configured');
    assert.equal(
      statuses.some((status) => status.platform === 'wecom' && status.readiness === 'configured'),
      true,
    );
  });

  // PR-BOT-DISCORD-OPERATIONAL-0: Discord is now an implemented platform
  // (DiscordBotBridge), so the "scaffold-only" assertions moved off Discord
  // onto WeCom which still has credentials-only (no live bridge).
  test('does not mark scaffold-only WeCom as operational', async () => {
    const statuses: BotStatus[] = [];
    const registry = new BotRegistry({
      onIncomingMessage: () => {},
      onStatusChange: (status) => statuses.push(status),
    });

    await registry.applySettings(
      settingsWith({
        wecom: { enabled: true, token: 'wecom-token', appId: 'corp-id', appSecret: 'corp-secret' },
      }),
    );

    assert.equal(registry.getStatus('wecom').running, false);
    assert.equal(registry.getStatus('wecom').reason, 'scaffold-only');
    assert.equal(registry.getStatus('wecom').readiness, 'configured');
    assert.equal(
      statuses.some((status) => status.platform === 'wecom' && status.readiness === 'operational'),
      false,
    );

    await registry.applySettings(
      settingsWith({
        wecom: { enabled: false, token: 'wecom-token' },
      }),
    );

    assert.equal(registry.getStatus('wecom').running, false);
    assert.equal(registry.getStatus('wecom').reason, 'disabled');
    assert.equal(
      statuses.some((status) => status.platform === 'wecom' && status.reason === 'disabled'),
      true,
    );
  });

  test('queues overlapping applySettings calls so the newest settings win deterministically', async () => {
    const registry = new BotRegistry({
      onIncomingMessage: () => {},
      onStatusChange: () => {},
    });

    await Promise.all([
      registry.applySettings(settingsWith({ wecom: { enabled: true, token: 'old-token' } })),
      registry.applySettings(settingsWith({ wecom: { enabled: false, token: 'old-token' } })),
      registry.applySettings(settingsWith({ wecom: { enabled: true, token: 'new-token' } })),
    ]);

    assert.equal(registry.getStatus('wecom').running, false);
    assert.equal(registry.getStatus('wecom').reason, 'scaffold-only');
    assert.equal(registry.getStatus('wecom').readiness, 'configured');
  });

  test('stopAll waits behind any pending applySettings call and clears bridges', async () => {
    const registry = new BotRegistry({
      onIncomingMessage: () => {},
      onStatusChange: () => {},
    });

    await Promise.all([
      registry.applySettings(settingsWith({ wecom: { enabled: true, token: 'wecom-token' } })),
      registry.stopAll(),
    ]);

    assert.equal(registry.getStatus('wecom').running, false);
    assert.equal(registry.getStatus('wecom').reason, 'disabled');
  });

  // PR-HEALTH-1 (xuan msg `e4887ffd`, I1 — read-path single-authority):
  // Previously `scaffoldStatus` inherited the persisted
  // `settings.readiness === 'credentials_valid'` directly into
  // `BotStatus.readiness`. That let stale credential claims survive across
  // settings reloads even after a live bridge had never probed. Post-fix,
  // unimplemented platforms ONLY use `readinessFromSettings` (computed
  // fresh from the channel's CURRENT facts). Credential-valid / operational
  // are reserved for the live bridge write path (SimpleBotBridge etc.).
  test('unimplemented platform with credentials downgrades persisted credentials_valid to configured', () => {
    // F1b in audit catalog. Settings claim credentials_valid was persisted;
    // since wecom has no live bridge yet, the read path must NOT honor the
    // claim — it returns `configured` (credentials present, never probed).
    // (Was Discord before PR-BOT-DISCORD-OPERATIONAL-0; now Discord IS a
    // live bridge so the assertion moved off it.)
    const registry = new BotRegistry({
      onIncomingMessage: () => {},
      onStatusChange: () => {},
    });

    return registry
      .applySettings(
        settingsWith({
          wecom: {
            enabled: true,
            token: 'tenant-token',
            appId: 'corp-id',
            appSecret: 'secret',
            connected: true,
            readiness: 'credentials_valid',
          },
        }),
      )
      .then(() => {
        const status = registry.getStatus('wecom');
        assert.equal(status.running, false);
        assert.equal(
          status.readiness,
          'configured',
          'persisted credentials_valid must NOT flow through to read path for unimplemented platforms',
        );
        assert.notEqual(status.readiness, 'operational');
      });
  });

  test('unimplemented platform with no credentials reports scaffolded (regardless of persisted state)', async () => {
    // F1 in audit catalog. Even with a stale persisted credentials_valid,
    // an empty credential trio means scaffoldStatus must return scaffolded.
    const registry = new BotRegistry({
      onIncomingMessage: () => {},
      onStatusChange: () => {},
    });

    await registry.applySettings(
      settingsWith({
        wecom: {
          enabled: true,
          token: '',
          appId: undefined,
          appSecret: undefined,
          readiness: 'credentials_valid',
        },
      }),
    );

    const status = registry.getStatus('wecom');
    assert.equal(status.readiness, 'scaffolded');
    assert.equal(status.reason, 'unimplemented');
  });

  // PR-BOT-TYPING-INDICATOR-0 — `sendTypingIndicator` is best-effort and
  // must never throw, even when the platform has no bridge or no send
  // capability. The actual Telegram API call is exercised separately at
  // the simple-bridge layer; here we pin the contract that no bridge =
  // returns false silently.
  test('sendTypingIndicator returns false (without throwing) when no bridge is registered', async () => {
    const registry = new BotRegistry({
      onIncomingMessage: () => {},
      onStatusChange: () => {},
    });

    const result = await registry.sendTypingIndicator('telegram', 'chat-1');
    assert.equal(result, false);
  });

  test('sendTypingIndicator returns false for an unimplemented platform with persisted credentials', async () => {
    const registry = new BotRegistry({
      onIncomingMessage: () => {},
      onStatusChange: () => {},
    });

    await registry.applySettings(
      settingsWith({
        wecom: { enabled: true, token: 'wecom-token', appId: 'corp', appSecret: 'secret' },
      }),
    );

    // scaffoldStatus path means no live bridge is registered for wecom;
    // typing indicator must silently degrade to false.
    // (Was discord before PR-BOT-DISCORD-OPERATIONAL-0; discord is now a
    // live bridge so the assertion moved off it.)
    const result = await registry.sendTypingIndicator('wecom', 'chat-x');
    assert.equal(result, false);
  });

  test('unimplemented platform with persisted operational + no credentials reports scaffolded', async () => {
    // Tighter coercion: even operational is downgraded for the read path
    // when credentials are absent. Live bridge would write its own
    // operational state on a per-reconcile basis; persisted operational
    // alone is not honored.
    const registry = new BotRegistry({
      onIncomingMessage: () => {},
      onStatusChange: () => {},
    });

    await registry.applySettings(
      settingsWith({
        wecom: {
          enabled: true,
          token: '',
          appId: undefined,
          appSecret: undefined,
          readiness: 'operational',
        },
      }),
    );

    const status = registry.getStatus('wecom');
    assert.equal(
      status.readiness,
      'scaffolded',
      'persisted operational with no credentials must NOT survive into read path',
    );
  });
});

function settingsWith(
  overrides: Partial<Record<BotProvider, Partial<ReturnType<typeof createDefaultBotChannel>>>>,
): BotChatSettings {
  const providers: BotProvider[] = [
    'telegram',
    'feishu',
    'wecom',
    'wechat',
    'discord',
    'dingtalk',
    'qq',
  ];
  return {
    channels: Object.fromEntries(
      providers.map((provider) => [
        provider,
        {
          ...createDefaultBotChannel(provider),
          ...(overrides[provider] ?? {}),
        },
      ]),
    ) as BotChatSettings['channels'],
  };
}
