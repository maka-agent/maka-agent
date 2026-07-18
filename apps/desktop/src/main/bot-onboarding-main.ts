import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type {
  AppSettings,
  BotChannelSettings,
  BotOnboardingBrand,
  BotOnboardingProvider,
  BotOnboardingSnapshot,
  BotOnboardingStartInput,
  BotOnboardingState,
  UpdateAppSettingsInput,
} from '@maka/core';
import { isBotOnboardingBrand, isBotOnboardingProvider } from '@maka/core';
import type { BotRegistry } from '@maka/runtime';
import type { SettingsStore } from '@maka/storage';
import { fetchWeChatQrcode, pollWeChatQrcodeStatus } from './wechat-scan-login.js';

const REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const MAX_POLL_INTERVAL_MS = 30_000;
const DEFAULT_EXPIRES_IN_SECONDS = 10 * 60;
const DINGTALK_EXPIRES_IN_SECONDS = 2 * 60 * 60;

type OnboardingCredential =
  | { provider: 'dingtalk'; clientId: string; clientSecret: string }
  | { provider: 'feishu'; appId: string; appSecret: string; brand: BotOnboardingBrand; botName?: string }
  | { provider: 'wecom'; botId: string; secret: string }
  | { provider: 'wechat'; botToken: string; baseUrl: string; botId: string; userId: string };

type ProviderStartResult = {
  opaqueToken: string;
  qrValue?: string;
  qrCodeDataUrl?: string;
  verificationUrl?: string;
  pollIntervalMs: number;
  expiresInSeconds: number;
};

type ProviderPollResult =
  | { status: 'pending' | 'scanned' | 'slow_down' }
  | { status: 'expired' | 'denied'; error?: string }
  | { status: 'confirmed'; credential: OnboardingCredential; identity?: { id?: string; displayName?: string } };

export interface BotOnboardingProviderAdapter {
  start(input: BotOnboardingStartInput, signal: AbortSignal): Promise<ProviderStartResult>;
  poll(session: Readonly<BotOnboardingSession>, signal: AbortSignal): Promise<ProviderPollResult>;
}

interface BotOnboardingSession {
  id: string;
  provider: BotOnboardingProvider;
  brand?: BotOnboardingBrand;
  state: BotOnboardingState | 'starting';
  opaqueToken?: string;
  qrCodeDataUrl?: string;
  verificationUrl?: string;
  expiresAt?: number;
  pollIntervalMs: number;
  nextPollAt: number;
  controller: AbortController;
  pollPromise?: Promise<BotOnboardingSnapshot>;
  identity?: { id?: string; displayName?: string };
  error?: string;
}

export interface BotOnboardingServiceDeps {
  settingsStore: SettingsStore;
  botRegistry: BotRegistry;
  applySettingsRuntimeEffects(settings: AppSettings, patch: UpdateAppSettingsInput): Promise<void>;
  adapters?: Partial<Record<BotOnboardingProvider, BotOnboardingProviderAdapter>>;
  now?: () => number;
  createId?: () => string;
  openExternal?: (url: string) => Promise<unknown>;
  productVersion?: string;
}

/**
 * Main-process authority for QR onboarding. Device codes, provider secrets,
 * polling and credential persistence remain outside the renderer process.
 */
export class BotOnboardingService {
  private readonly sessions = new Map<string, BotOnboardingSession>();
  private readonly currentByProvider = new Map<BotOnboardingProvider, string>();
  private readonly adapters: Record<BotOnboardingProvider, BotOnboardingProviderAdapter>;
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly openExternal: (url: string) => Promise<unknown>;

  constructor(private readonly deps: BotOnboardingServiceDeps) {
    this.adapters = createProductionBotOnboardingAdapters(deps.productVersion ?? '0.1.0');
    for (const provider of ['dingtalk', 'feishu', 'wecom', 'wechat'] as const) {
      const override = deps.adapters?.[provider];
      if (override) this.adapters[provider] = override;
    }
    this.now = deps.now ?? Date.now;
    this.createId = deps.createId ?? randomUUID;
    this.openExternal = deps.openExternal ?? (async () => {
      throw new Error('External browser opening is unavailable');
    });
  }

  async start(rawInput: unknown): Promise<BotOnboardingSnapshot> {
    const input = parseStartInput(rawInput);
    this.cancelCurrent(input.provider);

    const session: BotOnboardingSession = {
      id: this.createId(),
      provider: input.provider,
      brand: input.provider === 'feishu' ? (input.brand ?? 'feishu') : undefined,
      state: 'starting',
      pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
      nextPollAt: 0,
      controller: new AbortController(),
    };
    this.sessions.set(session.id, session);
    this.currentByProvider.set(session.provider, session.id);

    try {
      const result = await this.adapters[session.provider].start(
        { provider: session.provider, brand: session.brand },
        session.controller.signal,
      );
      this.assertCurrent(session);
      session.opaqueToken = result.opaqueToken;
      session.qrCodeDataUrl = result.qrCodeDataUrl ?? await renderQrCode(result.qrValue ?? '');
      session.verificationUrl = result.verificationUrl;
      session.pollIntervalMs = clampPollInterval(result.pollIntervalMs);
      session.expiresAt = this.now() + Math.max(1, result.expiresInSeconds) * 1_000;
      session.nextPollAt = this.now() + session.pollIntervalMs;
      session.state = 'waiting';
      return this.snapshot(session);
    } catch (error) {
      if (session.controller.signal.aborted || !this.isCurrent(session)) {
        session.state = 'cancelled';
        throw new Error('Bot onboarding cancelled');
      }
      session.state = 'error';
      session.error = safeProviderError(error);
      throw new Error(session.error);
    }
  }

  async poll(rawSessionId: unknown): Promise<BotOnboardingSnapshot> {
    const session = this.getSession(rawSessionId);
    if (session.state !== 'waiting' && session.state !== 'scanned') {
      return this.snapshot(session);
    }
    if (session.expiresAt !== undefined && session.expiresAt <= this.now()) {
      session.state = 'expired';
      return this.snapshot(session);
    }
    if (session.nextPollAt > this.now()) return this.snapshot(session);
    if (session.pollPromise) return session.pollPromise;

    const operation = this.pollOnce(session).finally(() => {
      if (session.pollPromise === operation) session.pollPromise = undefined;
    });
    session.pollPromise = operation;
    return operation;
  }

  cancel(rawSessionId: unknown): BotOnboardingSnapshot {
    const session = this.getSession(rawSessionId);
    this.cancelSession(session);
    return this.snapshot(session);
  }

  async openInBrowser(rawSessionId: unknown): Promise<void> {
    const session = this.getSession(rawSessionId);
    this.assertCurrent(session);
    if (!session.verificationUrl) throw new Error('This onboarding session has no browser URL');
    const url = new URL(session.verificationUrl);
    if (url.protocol !== 'https:') throw new Error('Only HTTPS onboarding URLs are allowed');
    await this.openExternal(url.toString());
  }

  dispose(): void {
    for (const session of this.sessions.values()) this.cancelSession(session);
    this.sessions.clear();
    this.currentByProvider.clear();
  }

  private async pollOnce(session: BotOnboardingSession): Promise<BotOnboardingSnapshot> {
    try {
      const result = await this.adapters[session.provider].poll(session, session.controller.signal);
      this.assertCurrent(session);
      switch (result.status) {
        case 'pending':
          session.state = 'waiting';
          session.nextPollAt = this.now() + session.pollIntervalMs;
          break;
        case 'scanned':
          session.state = 'scanned';
          session.nextPollAt = this.now() + session.pollIntervalMs;
          break;
        case 'slow_down':
          session.state = 'waiting';
          session.pollIntervalMs = Math.min(session.pollIntervalMs + 5_000, MAX_POLL_INTERVAL_MS);
          session.nextPollAt = this.now() + session.pollIntervalMs;
          break;
        case 'expired':
          session.state = 'expired';
          session.error = result.error;
          break;
        case 'denied':
          session.state = 'denied';
          session.error = result.error;
          break;
        case 'confirmed':
          session.state = 'connecting';
          await this.persistCredential(session, result.credential);
          this.assertCurrent(session);
          session.identity = result.identity ?? identityFromCredential(result.credential);
          session.state = 'connected';
          break;
      }
      return this.snapshot(session);
    } catch (error) {
      if (session.controller.signal.aborted || !this.isCurrent(session)) {
        session.state = 'cancelled';
        return this.snapshot(session);
      }
      session.state = 'error';
      session.error = safeProviderError(error);
      return this.snapshot(session);
    }
  }

  private async persistCredential(session: BotOnboardingSession, credential: OnboardingCredential): Promise<void> {
    this.assertCurrent(session);
    const previousSettings = await this.deps.settingsStore.get();
    this.assertCurrent(session);
    const previousChannel = previousSettings.botChat.channels[session.provider];
    const channelPatch = channelPatchFromCredential(credential);
    const patch: UpdateAppSettingsInput = {
      botChat: { channels: { [session.provider]: channelPatch } },
    };
    const next = await this.deps.settingsStore.update(patch);
    const installedChannel = next.botChat.channels[session.provider];
    const ownedFields = Object.keys(channelPatch) as Array<keyof BotChannelSettings>;
    if (!this.isCurrent(session)) {
      await this.rollbackCredential(session.provider, previousChannel, installedChannel, ownedFields);
      this.assertCurrent(session);
    }
    await this.deps.applySettingsRuntimeEffects(next, patch);
    if (!this.isCurrent(session)) {
      await this.rollbackCredential(session.provider, previousChannel, installedChannel, ownedFields);
      this.assertCurrent(session);
    }
    const runtimeStatus = this.deps.botRegistry.getStatus(session.provider);
    if (runtimeStatus.identity) {
      session.identity = {
        id: runtimeStatus.identity.id,
        displayName: runtimeStatus.identity.displayName ?? runtimeStatus.identity.username,
      };
    }
  }

  private async rollbackCredential(
    provider: BotOnboardingProvider,
    previousChannel: AppSettings['botChat']['channels'][BotOnboardingProvider],
    installedChannel: BotChannelSettings,
    ownedFields: ReadonlyArray<keyof BotChannelSettings>,
  ): Promise<void> {
    const previousValues = pickChannelFields(previousChannel, ownedFields);
    const rollbackPatch: UpdateAppSettingsInput = {
      botChat: { channels: { [provider]: previousValues } },
    };
    const rollback = await this.deps.settingsStore.updateIf(
      (current) => channelFieldsEqual(
        current.botChat.channels[provider],
        installedChannel,
        ownedFields,
      ),
      rollbackPatch,
    );
    if (rollback.applied) {
      await this.deps.applySettingsRuntimeEffects(rollback.settings, rollbackPatch);
    }
  }

  private getSession(rawSessionId: unknown): BotOnboardingSession {
    if (typeof rawSessionId !== 'string' || !rawSessionId) throw new Error('sessionId must be a non-empty string');
    const session = this.sessions.get(rawSessionId);
    if (!session) throw new Error('Unknown bot onboarding session');
    return session;
  }

  private cancelCurrent(provider: BotOnboardingProvider): void {
    const currentId = this.currentByProvider.get(provider);
    if (!currentId) return;
    const current = this.sessions.get(currentId);
    if (current) this.cancelSession(current);
  }

  private cancelSession(session: BotOnboardingSession): void {
    if (!session.controller.signal.aborted) session.controller.abort();
    if (session.state !== 'connected' && session.state !== 'expired' && session.state !== 'denied') {
      session.state = 'cancelled';
    }
    if (this.currentByProvider.get(session.provider) === session.id) {
      this.currentByProvider.delete(session.provider);
    }
  }

  private isCurrent(session: BotOnboardingSession): boolean {
    return !session.controller.signal.aborted
      && this.currentByProvider.get(session.provider) === session.id;
  }

  private assertCurrent(session: BotOnboardingSession): void {
    if (!this.isCurrent(session)) throw new Error('Bot onboarding session is no longer active');
  }

  private snapshot(session: BotOnboardingSession): BotOnboardingSnapshot {
    const state = session.state === 'starting' ? 'waiting' : session.state;
    return {
      sessionId: session.id,
      provider: session.provider,
      ...(session.brand ? { brand: session.brand } : {}),
      state,
      ...(session.qrCodeDataUrl ? { qrCodeDataUrl: session.qrCodeDataUrl } : {}),
      ...(session.expiresAt !== undefined ? { expiresAt: session.expiresAt } : {}),
      nextPollAfterMs: Math.max(0, session.nextPollAt - this.now()),
      canOpenInBrowser: Boolean(session.verificationUrl),
      ...(session.identity ? { identity: { ...session.identity } } : {}),
      ...(session.error ? { error: session.error } : {}),
    };
  }
}

function parseStartInput(value: unknown): BotOnboardingStartInput {
  if (!value || typeof value !== 'object') throw new Error('Bot onboarding input is required');
  const raw = value as { provider?: unknown; brand?: unknown };
  if (!isBotOnboardingProvider(raw.provider)) throw new Error('Unsupported bot onboarding provider');
  if (raw.brand !== undefined && !isBotOnboardingBrand(raw.brand)) throw new Error('Unsupported bot onboarding brand');
  if (raw.provider !== 'feishu' && raw.brand !== undefined) throw new Error('brand is only valid for Feishu onboarding');
  return { provider: raw.provider, ...(raw.brand ? { brand: raw.brand } : {}) };
}

function clampPollInterval(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_POLL_INTERVAL_MS;
  return Math.min(Math.max(Math.round(value), 1_000), MAX_POLL_INTERVAL_MS);
}

function safeProviderError(error: unknown): string {
  if (error instanceof Error && error.name === 'AbortError') return '扫码接入已取消。';
  return '扫码接入暂时不可用，请稍后重试。';
}

function channelPatchFromCredential(credential: OnboardingCredential): Partial<BotChannelSettings> {
  const common = {
    enabled: true,
    connected: false,
    readiness: 'configured' as const,
    readinessReason: undefined,
    readinessUpdatedAt: Date.now(),
    lastError: undefined,
  };
  switch (credential.provider) {
    case 'dingtalk':
      return { ...common, appId: credential.clientId, appSecret: credential.clientSecret };
    case 'feishu':
      return {
        ...common,
        appId: credential.appId,
        appSecret: credential.appSecret,
        domain: credential.brand === 'lark' ? 'larksuite.com' : 'feishu.cn',
      };
    case 'wecom':
      return { ...common, appId: credential.botId, appSecret: credential.secret };
    case 'wechat':
      return {
        ...common,
        token: credential.botToken,
        webhookUrl: credential.baseUrl,
        botUserId: credential.botId,
      };
  }
}

function pickChannelFields(
  channel: BotChannelSettings,
  fields: ReadonlyArray<keyof BotChannelSettings>,
): Partial<BotChannelSettings> {
  return Object.fromEntries(fields.map((field) => [field, channel[field]])) as Partial<BotChannelSettings>;
}

function channelFieldsEqual(
  current: BotChannelSettings,
  expected: BotChannelSettings,
  fields: ReadonlyArray<keyof BotChannelSettings>,
): boolean {
  return fields.every((field) => Object.is(current[field], expected[field]));
}

function identityFromCredential(credential: OnboardingCredential): { id?: string; displayName?: string } {
  switch (credential.provider) {
    case 'dingtalk': return { id: credential.clientId };
    case 'feishu': return { id: credential.appId, displayName: credential.botName };
    case 'wecom': return { id: credential.botId };
    case 'wechat': return { id: credential.botId };
  }
}

const require = createRequire(import.meta.url);

async function renderQrCode(value: string): Promise<string> {
  if (!value) throw new Error('Provider returned an empty QR payload');
  if (value.startsWith('data:image/')) return value;
  const qrcode = require('qrcode') as {
    toDataURL(input: string, options: Record<string, unknown>): Promise<string>;
  };
  return qrcode.toDataURL(value, { width: 320, margin: 2, errorCorrectionLevel: 'M' });
}

function requestSignal(signal: AbortSignal): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
}

async function postJson(url: string, body: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, any>> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: requestSignal(signal),
  });
  if (!response.ok) throw new Error(`Provider request failed with HTTP ${response.status}`);
  return response.json() as Promise<Record<string, any>>;
}

async function postForm(url: string, body: Record<string, string>, signal: AbortSignal): Promise<Record<string, any>> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
    signal: requestSignal(signal),
  });
  const json = await response.json().catch(() => ({})) as Record<string, any>;
  if (!response.ok && typeof json.error !== 'string') {
    throw new Error(`Provider request failed with HTTP ${response.status}`);
  }
  return json;
}

function platformCode(): number {
  switch (process.platform) {
    case 'darwin': return 1;
    case 'win32': return 2;
    case 'linux': return 3;
    default: return 0;
  }
}

function createProductionBotOnboardingAdapters(productVersion: string): Record<BotOnboardingProvider, BotOnboardingProviderAdapter> {
  return {
    dingtalk: {
      async start(_input, signal) {
        const init = await postJson('https://oapi.dingtalk.com/app/registration/init', { source: 'MAKA' }, signal);
        if (init.errcode !== 0 || typeof init.nonce !== 'string') throw new Error('DingTalk registration init failed');
        const begin = await postJson('https://oapi.dingtalk.com/app/registration/begin', { nonce: init.nonce }, signal);
        const verificationUrl = begin.pc_verification_uri_complete ?? begin.verification_uri_complete;
        if (typeof begin.device_code !== 'string' || typeof verificationUrl !== 'string') {
          throw new Error('DingTalk registration begin returned an invalid response');
        }
        return {
          opaqueToken: begin.device_code,
          qrValue: verificationUrl,
          verificationUrl,
          pollIntervalMs: Number(begin.interval ?? 5) * 1_000,
          expiresInSeconds: Number(begin.expires_in ?? DINGTALK_EXPIRES_IN_SECONDS),
        };
      },
      async poll(session, signal) {
        const result = await postJson(
          'https://oapi.dingtalk.com/app/registration/poll',
          { device_code: session.opaqueToken },
          signal,
        );
        switch (result.status) {
          case 'SUCCESS':
            if (typeof result.client_id !== 'string' || typeof result.client_secret !== 'string') {
              throw new Error('DingTalk registration returned incomplete credentials');
            }
            return {
              status: 'confirmed',
              credential: { provider: 'dingtalk', clientId: result.client_id, clientSecret: result.client_secret },
              identity: { id: result.client_id },
            };
          case 'WAITING': return { status: 'pending' };
          case 'EXPIRED': return { status: 'expired' };
          case 'FAIL': return { status: 'denied' };
          default: throw new Error('DingTalk registration returned an unknown status');
        }
      },
    },
    feishu: {
      async start(input, signal) {
        const brand = input.brand ?? 'feishu';
        const accounts = brand === 'lark' ? 'accounts.larksuite.com' : 'accounts.feishu.cn';
        const endpoint = `https://${accounts}/oauth/v1/app/registration`;
        const init = await postForm(endpoint, { action: 'init' }, signal);
        if (!Array.isArray(init.supported_auth_methods) || !init.supported_auth_methods.includes('client_secret')) {
          throw new Error('Feishu registration does not support client_secret');
        }
        const begin = await postForm(endpoint, {
          action: 'begin',
          archetype: 'PersonalAgent',
          auth_method: 'client_secret',
          request_user_info: 'open_id',
        }, signal);
        if (typeof begin.device_code !== 'string' || typeof begin.verification_uri_complete !== 'string') {
          throw new Error('Feishu registration begin returned an invalid response');
        }
        const verificationUrl = new URL(begin.verification_uri_complete);
        verificationUrl.searchParams.set('from', 'maka');
        verificationUrl.searchParams.set('lpv', productVersion);
        return {
          opaqueToken: begin.device_code,
          qrValue: verificationUrl.toString(),
          verificationUrl: verificationUrl.toString(),
          pollIntervalMs: Number(begin.interval ?? 5) * 1_000,
          expiresInSeconds: Number(begin.expire_in ?? begin.expires_in ?? DEFAULT_EXPIRES_IN_SECONDS),
        };
      },
      async poll(session, signal) {
        const brand = session.brand ?? 'feishu';
        const accounts = brand === 'lark' ? 'accounts.larksuite.com' : 'accounts.feishu.cn';
        const result = await postForm(`https://${accounts}/oauth/v1/app/registration`, {
          action: 'poll',
          device_code: session.opaqueToken ?? '',
        }, signal);
        if (typeof result.client_id === 'string' && typeof result.client_secret === 'string') {
          const botName = await fetchFeishuBotName(result.client_id, result.client_secret, brand, signal);
          return {
            status: 'confirmed',
            credential: {
              provider: 'feishu',
              appId: result.client_id,
              appSecret: result.client_secret,
              brand,
              ...(botName ? { botName } : {}),
            },
            identity: { id: result.client_id, ...(botName ? { displayName: botName } : {}) },
          };
        }
        switch (result.error) {
          case 'authorization_pending': return { status: 'pending' };
          case 'slow_down': return { status: 'slow_down' };
          case 'expired_token': return { status: 'expired' };
          case 'access_denied': return { status: 'denied' };
          default: throw new Error('Feishu registration returned an unknown status');
        }
      },
    },
    wecom: {
      async start(_input, signal) {
        const response = await fetch(
          `https://work.weixin.qq.com/ai/qc/generate?source=maka&plat=${platformCode()}`,
          { signal: requestSignal(signal) },
        );
        if (!response.ok) throw new Error(`WeCom QR generation failed with HTTP ${response.status}`);
        const json = await response.json() as { data?: { scode?: unknown; auth_url?: unknown } };
        if (typeof json.data?.scode !== 'string' || typeof json.data.auth_url !== 'string') {
          throw new Error('WeCom QR generation returned an invalid response');
        }
        return {
          opaqueToken: json.data.scode,
          qrValue: json.data.auth_url,
          verificationUrl: json.data.auth_url,
          pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
          expiresInSeconds: DEFAULT_EXPIRES_IN_SECONDS,
        };
      },
      async poll(session, signal) {
        const response = await fetch(
          `https://work.weixin.qq.com/ai/qc/query_result?scode=${encodeURIComponent(session.opaqueToken ?? '')}`,
          { signal: requestSignal(signal) },
        );
        if (!response.ok) throw new Error(`WeCom QR poll failed with HTTP ${response.status}`);
        const json = await response.json() as {
          data?: { status?: unknown; bot_info?: { botid?: unknown; secret?: unknown } };
        };
        if (json.data?.status !== 'success') return { status: 'pending' };
        const info = json.data.bot_info;
        if (typeof info?.botid !== 'string' || typeof info.secret !== 'string') {
          throw new Error('WeCom registration returned incomplete credentials');
        }
        return {
          status: 'confirmed',
          credential: { provider: 'wecom', botId: info.botid, secret: info.secret },
          identity: { id: info.botid },
        };
      },
    },
    wechat: {
      async start(_input, _signal) {
        const result = await fetchWeChatQrcode();
        return {
          opaqueToken: result.qrToken,
          qrCodeDataUrl: result.qrcodeUrl,
          pollIntervalMs: 2_500,
          expiresInSeconds: DEFAULT_EXPIRES_IN_SECONDS,
        };
      },
      async poll(session, _signal) {
        const result = await pollWeChatQrcodeStatus(session.opaqueToken ?? '');
        if (result.status === 'waiting') return { status: 'pending' };
        if (result.status === 'expired') return { status: 'expired' };
        return {
          status: 'confirmed',
          credential: { provider: 'wechat', ...result.credentials },
          identity: { id: result.credentials.botId },
        };
      },
    },
  };
}

async function fetchFeishuBotName(
  appId: string,
  appSecret: string,
  brand: BotOnboardingBrand,
  signal: AbortSignal,
): Promise<string | undefined> {
  const domain = brand === 'lark' ? 'open.larksuite.com' : 'open.feishu.cn';
  try {
    const token = await postJson(
      `https://${domain}/open-apis/auth/v3/tenant_access_token/internal/`,
      { app_id: appId, app_secret: appSecret },
      signal,
    );
    if (typeof token.tenant_access_token !== 'string') return undefined;
    const response = await fetch(`https://${domain}/open-apis/bot/v3/info/`, {
      headers: { Authorization: `Bearer ${token.tenant_access_token}` },
      signal: requestSignal(signal),
    });
    if (!response.ok) return undefined;
    const json = await response.json() as { bot?: { app_name?: unknown } };
    return typeof json.bot?.app_name === 'string' ? json.bot.app_name : undefined;
  } catch {
    return undefined;
  }
}
