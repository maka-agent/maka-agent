import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  createDefaultSettings,
  mergeSettings,
  type AppSettings,
  type UpdateAppSettingsInput,
} from '@maka/core';
import type { BotRegistry } from '@maka/runtime';
import type { SettingsStore } from '@maka/storage';
import {
  BotOnboardingService,
  type BotOnboardingProviderAdapter,
} from '../bot-onboarding-main.js';

const QR_DATA = 'data:image/png;base64,ZmFrZQ==';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function harness(
  adapter: BotOnboardingProviderAdapter,
  applyEffect?: (settings: AppSettings, patch: UpdateAppSettingsInput) => Promise<void>,
) {
  let now = 1_000;
  const updates: UpdateAppSettingsInput[] = [];
  const effects: UpdateAppSettingsInput[] = [];
  let currentSettings = createDefaultSettings();
  const settingsStore = {
    async get() {
      return currentSettings;
    },
    async update(patch: UpdateAppSettingsInput) {
      updates.push(patch);
      currentSettings = mergeSettings(currentSettings, patch);
      return currentSettings;
    },
    async updateIf(
      predicate: (current: AppSettings) => boolean,
      patch: UpdateAppSettingsInput,
    ) {
      if (!predicate(currentSettings)) return { applied: false, settings: currentSettings };
      updates.push(patch);
      currentSettings = mergeSettings(currentSettings, patch);
      return { applied: true, settings: currentSettings };
    },
  } as SettingsStore;
  const botRegistry = {
    getStatus() {
      return {
        platform: 'dingtalk',
        running: true,
        readiness: 'credentials_valid',
        connection: 'gateway',
      };
    },
  } as unknown as BotRegistry;
  let sequence = 0;
  const service = new BotOnboardingService({
    settingsStore,
    botRegistry,
    applySettingsRuntimeEffects: async (settings, patch) => {
      effects.push(patch);
      await applyEffect?.(settings, patch);
    },
    adapters: { dingtalk: adapter },
    now: () => now,
    createId: () => `session-${++sequence}`,
    openExternal: async () => undefined,
  });
  return {
    service,
    updates,
    effects,
    settingsStore,
    getSettings() { return currentSettings; },
    advance(ms: number) { now += ms; },
  };
}

function startResult() {
  return {
    opaqueToken: 'opaque-device-code',
    qrCodeDataUrl: QR_DATA,
    verificationUrl: 'https://example.com/device',
    pollIntervalMs: 5_000,
    expiresInSeconds: 600,
  };
}

describe('BotOnboardingService', () => {
  it('persists confirmed credentials in main while returning a secret-free snapshot', async () => {
    const adapter: BotOnboardingProviderAdapter = {
      async start() { return startResult(); },
      async poll() {
        return {
          status: 'confirmed',
          credential: {
            provider: 'dingtalk',
            clientId: 'public-client-id',
            clientSecret: 'private-client-secret',
          },
          identity: { id: 'public-client-id' },
        };
      },
    };
    const test = harness(adapter);
    const started = await test.service.start({ provider: 'dingtalk' });
    assert.equal(started.state, 'waiting');
    assert.equal(started.qrCodeDataUrl, QR_DATA);
    assert.equal(JSON.stringify(started).includes('opaque-device-code'), false);

    test.advance(5_000);
    const connected = await test.service.poll(started.sessionId);
    assert.equal(connected.state, 'connected');
    assert.equal(connected.identity?.id, 'public-client-id');
    assert.equal(test.updates.length, 1);
    assert.equal(test.effects.length, 1);
    assert.equal(JSON.stringify(connected).includes('private-client-secret'), false);
    assert.equal(JSON.stringify(connected).includes('opaque-device-code'), false);
    assert.equal(
      (test.updates[0].botChat?.channels?.dingtalk as { appSecret?: string } | undefined)?.appSecret,
      'private-client-secret',
    );
  });

  it('cancels an in-flight poll and rejects its late credential result', async () => {
    const pending = deferred<any>();
    const adapter: BotOnboardingProviderAdapter = {
      async start() { return startResult(); },
      async poll() { return pending.promise; },
    };
    const test = harness(adapter);
    const started = await test.service.start({ provider: 'dingtalk' });
    test.advance(5_000);
    const polling = test.service.poll(started.sessionId);
    const cancelled = test.service.cancel(started.sessionId);
    assert.equal(cancelled.state, 'cancelled');
    pending.resolve({
      status: 'confirmed',
      credential: {
        provider: 'dingtalk',
        clientId: 'late-client-id',
        clientSecret: 'late-secret',
      },
    });
    assert.equal((await polling).state, 'cancelled');
    assert.equal(test.updates.length, 0);
    assert.equal(test.effects.length, 0);
  });

  it('rolls back credentials when cancellation crosses the runtime-effect commit window', async () => {
    const effectStarted = deferred<void>();
    const releaseEffect = deferred<void>();
    let effectCalls = 0;
    const adapter: BotOnboardingProviderAdapter = {
      async start() { return startResult(); },
      async poll() {
        return {
          status: 'confirmed',
          credential: {
            provider: 'dingtalk',
            clientId: 'cancelled-client-id',
            clientSecret: 'cancelled-secret',
          },
        };
      },
    };
    const test = harness(adapter, async () => {
      effectCalls += 1;
      if (effectCalls === 1) {
        effectStarted.resolve();
        await releaseEffect.promise;
      }
    });
    const started = await test.service.start({ provider: 'dingtalk' });
    test.advance(5_000);
    const polling = test.service.poll(started.sessionId);
    await effectStarted.promise;
    test.service.cancel(started.sessionId);
    releaseEffect.resolve();

    assert.equal((await polling).state, 'cancelled');
    const channel = test.getSettings().botChat.channels.dingtalk;
    assert.equal(channel.enabled, false);
    assert.equal(channel.appId, undefined);
    assert.equal(channel.appSecret, undefined);
    assert.equal(test.updates.length, 2);
    assert.equal(test.effects.length, 2);
  });

  it('does not overwrite a concurrent manual credential edit during cancellation rollback', async () => {
    const effectStarted = deferred<void>();
    const releaseEffect = deferred<void>();
    let effectCalls = 0;
    const adapter: BotOnboardingProviderAdapter = {
      async start() { return startResult(); },
      async poll() {
        return {
          status: 'confirmed',
          credential: {
            provider: 'dingtalk',
            clientId: 'onboarding-client-id',
            clientSecret: 'onboarding-secret',
          },
        };
      },
    };
    const test = harness(adapter, async () => {
      effectCalls += 1;
      if (effectCalls === 1) {
        effectStarted.resolve();
        await releaseEffect.promise;
      }
    });
    const started = await test.service.start({ provider: 'dingtalk' });
    test.advance(5_000);
    const polling = test.service.poll(started.sessionId);
    await effectStarted.promise;
    test.service.cancel(started.sessionId);
    await test.settingsStore.update({
      botChat: {
        channels: {
          dingtalk: {
            appId: 'manual-client-id',
            appSecret: 'manual-secret',
          },
        },
      },
    });
    releaseEffect.resolve();

    assert.equal((await polling).state, 'cancelled');
    const channel = test.getSettings().botChat.channels.dingtalk;
    assert.equal(channel.appId, 'manual-client-id');
    assert.equal(channel.appSecret, 'manual-secret');
    assert.equal(test.effects.length, 1);
  });

  it('invalidates an older session when the same provider starts again', async () => {
    const pending = deferred<any>();
    let polls = 0;
    const adapter: BotOnboardingProviderAdapter = {
      async start() { return startResult(); },
      async poll() {
        polls += 1;
        return pending.promise;
      },
    };
    const test = harness(adapter);
    const first = await test.service.start({ provider: 'dingtalk' });
    test.advance(5_000);
    const firstPoll = test.service.poll(first.sessionId);
    const second = await test.service.start({ provider: 'dingtalk' });
    assert.notEqual(second.sessionId, first.sessionId);
    pending.resolve({
      status: 'confirmed',
      credential: {
        provider: 'dingtalk',
        clientId: 'stale-client-id',
        clientSecret: 'stale-secret',
      },
    });
    assert.equal((await firstPoll).state, 'cancelled');
    assert.equal(polls, 1);
    assert.equal(test.updates.length, 0);
  });

  it('coalesces duplicate polls and applies provider slow-down backoff', async () => {
    const pending = deferred<any>();
    let polls = 0;
    const adapter: BotOnboardingProviderAdapter = {
      async start() { return startResult(); },
      async poll() {
        polls += 1;
        return pending.promise;
      },
    };
    const test = harness(adapter);
    const started = await test.service.start({ provider: 'dingtalk' });
    test.advance(5_000);
    const first = test.service.poll(started.sessionId);
    const duplicate = test.service.poll(started.sessionId);
    pending.resolve({ status: 'slow_down' });
    const [a, b] = await Promise.all([first, duplicate]);
    assert.equal(polls, 1);
    assert.equal(a.nextPollAfterMs, 10_000);
    assert.deepEqual(a, b);
  });

  it('expires locally without polling after the provider TTL', async () => {
    let polls = 0;
    const adapter: BotOnboardingProviderAdapter = {
      async start() { return { ...startResult(), expiresInSeconds: 1 }; },
      async poll() { polls += 1; return { status: 'pending' }; },
    };
    const test = harness(adapter);
    const started = await test.service.start({ provider: 'dingtalk' });
    test.advance(1_001);
    const expired = await test.service.poll(started.sessionId);
    assert.equal(expired.state, 'expired');
    assert.equal(polls, 0);
  });
});
