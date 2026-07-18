import type { BotOnboardingProvider } from '@maka/core';
import type { BotOnboardingProviderAdapter } from './bot-onboarding-main.js';

type AdapterMap = Partial<Record<BotOnboardingProvider, BotOnboardingProviderAdapter>>;

const POLL_INTERVAL_MS = 1_000;
const NORMAL_TTL_SECONDS = 30;

/**
 * Deterministic provider adapters for the dev-only Settings visual fixture.
 * They exercise the real main-owned session, IPC, persistence, runtime-effect,
 * and renderer polling paths without contacting an external IM platform.
 */
export function createVisualSmokeBotOnboardingAdapters(): AdapterMap {
  const pollCounts = new Map<string, number>();
  let startSequence = 0;

  function nextPoll(token: string | undefined): number {
    const key = token ?? 'missing';
    const count = (pollCounts.get(key) ?? 0) + 1;
    pollCounts.set(key, count);
    return count;
  }

  function start(provider: BotOnboardingProvider, expiresInSeconds = NORMAL_TTL_SECONDS) {
    startSequence += 1;
    return {
      opaqueToken: `visual-smoke-${provider}-${startSequence}`,
      qrValue: `https://example.com/maka/bot-onboarding/${provider}`,
      verificationUrl: `https://example.com/maka/bot-onboarding/${provider}`,
      pollIntervalMs: POLL_INTERVAL_MS,
      expiresInSeconds,
    };
  }

  async function settlePoll(): Promise<void> {
    // Keeps a real in-flight window so E2E can prove that closing a modal
    // invalidates a late provider result before credentials are persisted.
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
  }

  return {
    dingtalk: {
      async start() { return start('dingtalk'); },
      async poll(session) {
        await settlePoll();
        if (nextPoll(session.opaqueToken) === 1) return { status: 'scanned' };
        return {
          status: 'confirmed',
          credential: {
            provider: 'dingtalk',
            clientId: 'visual-smoke-dingtalk-client',
            clientSecret: 'visual-smoke-dingtalk-secret',
          },
          identity: { id: 'visual-smoke-dingtalk-client', displayName: 'Maka 测试机器人' },
        };
      },
    },
    feishu: {
      async start() { return start('feishu'); },
      async poll(session) {
        await settlePoll();
        if (nextPoll(session.opaqueToken) === 1) return { status: 'scanned' };
        const brand = session.brand ?? 'feishu';
        return {
          status: 'confirmed',
          credential: {
            provider: 'feishu',
            appId: `visual-smoke-${brand}-app`,
            appSecret: `visual-smoke-${brand}-secret`,
            brand,
            botName: 'Maka 测试机器人',
          },
          identity: { id: `visual-smoke-${brand}-app`, displayName: 'Maka 测试机器人' },
        };
      },
    },
    wecom: {
      async start() { return start('wecom', 1); },
      async poll() {
        await settlePoll();
        return { status: 'pending' };
      },
    },
    wechat: {
      async start() { return start('wechat'); },
      async poll() {
        await new Promise<void>((resolve) => setTimeout(resolve, 1_200));
        return {
          status: 'confirmed',
          credential: {
            provider: 'wechat',
            botToken: 'visual-smoke-wechat-token',
            baseUrl: 'https://ilinkai.weixin.qq.com/',
            botId: 'visual-smoke-wechat-bot',
            userId: 'visual-smoke-wechat-user',
          },
          identity: { id: 'visual-smoke-wechat-bot', displayName: 'Maka 测试机器人' },
        };
      },
    },
  };
}
