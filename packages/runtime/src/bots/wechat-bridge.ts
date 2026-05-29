import type { BotChannelSettings } from '@maka/core';
import { generalizedErrorMessage } from '@maka/core/redaction';
import { BaseBotAdapter, botReadinessFromSettings } from './base-adapter.js';
import { proxiedFetch } from './proxied-fetch.js';
import type { BotIncomingMessage, BotSendOptions, BotStatus, BotTestResult, SendCapable } from './types.js';

const DEFAULT_WECHAT_BRIDGE_URL = 'http://127.0.0.1:18400';
const WECHAT_BRIDGE_TIMEOUT_MS = 5_000;

const LOCAL_WECHAT_BRIDGE_HOSTS = new Set([
  '127.0.0.1',
  'localhost',
  '[::1]',
  '::1',
]);

export function normalizeWechatBridgeUrl(input: string | undefined): string | null {
  const raw = input?.trim() || DEFAULT_WECHAT_BRIDGE_URL;
  if (raw.length > 256) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:') return null;
    if (!LOCAL_WECHAT_BRIDGE_HOSTS.has(url.hostname)) return null;
    url.pathname = url.pathname.replace(/\/+$/, '');
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

export class WechatBridge extends BaseBotAdapter implements SendCapable {
  private abortController: AbortController | null = null;

  constructor(settings: BotChannelSettings) {
    super('wechat', settings);
  }

  async start(): Promise<void> {
    if (this.running) return;
    if (!this.settings.enabled) {
      this.reason = 'disabled';
      this.readiness = 'scaffolded';
      return;
    }
    const probe = await testWechatBridge(this.settings);
    if (!probe.ok) {
      this.running = false;
      this.reason = probe.error;
      this.readiness = botReadinessFromSettings(this.settings);
      this.emitStatusChange();
      return;
    }
    this.identity = probe.identity;
    this.running = true;
    this.startedAt = Date.now();
    this.reason = undefined;
    this.readiness = 'credentials_valid';
    this.emitStatusChange();
    void this.streamLiveMessages(Math.floor(Date.now() / 1000));
  }

  async stop(): Promise<void> {
    this.running = false;
    this.abortController?.abort();
    this.abortController = null;
    this.reason = 'stopped';
    this.readiness = botReadinessFromSettings(this.settings);
    this.emitStatusChange();
  }

  async sendMessage(chatId: string, text: string, _options?: BotSendOptions): Promise<string | null> {
    if (!this.running) return null;
    try {
      const response = await wechatBridgeJson(this.settings, '/send', {
        method: 'POST',
        body: JSON.stringify({ wxid: chatId, text }),
      });
      const status = typeof response.status === 'string' ? response.status : '';
      if (status === 'failed') {
        this.readiness = 'degraded';
        this.reason = typeof response.diagnostic === 'string' ? response.diagnostic : 'wechat-send-failed';
        this.emitStatusChange();
        return null;
      }
      this.readiness = 'operational';
      this.reason = undefined;
      this.lastEventAt = Date.now();
      this.emitStatusChange();
      const id = response.messageId ?? response.id ?? response.svrId ?? status;
      return typeof id === 'string' || typeof id === 'number' ? String(id) : 'wechat-submitted';
    } catch (error) {
      this.readiness = 'degraded';
      this.reason = generalizedErrorMessage(error);
      this.emitStatusChange();
      return null;
    }
  }

  protected override connectionKind(): BotStatus['connection'] {
    return 'gateway';
  }

  private async streamLiveMessages(sinceEpochSeconds: number): Promise<void> {
    const baseUrl = normalizeWechatBridgeUrl(this.settings.webhookUrl);
    if (!baseUrl) return;
    while (this.running) {
      this.abortController = new AbortController();
      try {
        const response = await proxiedFetch(`${baseUrl}/messages/stream?since=${sinceEpochSeconds}`, {
          method: 'GET',
          headers: wechatBridgeHeaders(this.settings),
          signal: this.abortController.signal,
          timeoutMs: 0,
        });
        if (!response.ok || !response.body) throw new Error(`WeChat stream HTTP ${response.status}`);
        for await (const raw of readSseJsonObjects(response.body)) {
          const messages = Array.isArray(raw) ? raw : [raw];
          for (const message of messages) {
            const event = mapWechatBridgeMessage(message);
            if (!event) continue;
            sinceEpochSeconds = Math.max(sinceEpochSeconds, Math.floor(event.receivedAt / 1000));
            this.readiness = 'operational';
            this.reason = undefined;
            this.emitIncomingMessage(event);
            this.emitStatusChange();
          }
        }
        if (this.running) await sleep(1_000);
      } catch (error) {
        if (!this.running) return;
        if (error instanceof Error && error.name === 'AbortError') return;
        this.readiness = this.readiness === 'operational' ? 'degraded' : botReadinessFromSettings(this.settings);
        this.reason = generalizedErrorMessage(error);
        this.emitStatusChange();
        await sleep(3_000);
      }
    }
  }
}

export function mapWechatBridgeMessage(raw: unknown): BotIncomingMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const message = raw as Record<string, unknown>;
  if (message.fromSelf === true || message.isSelf === true) return null;
  const chatId = firstStringField(message, ['chatId', 'roomId', 'toWxid', 'talker']);
  const isGroup = message.isGroup === true ||
    message.is_group === true ||
    chatId?.endsWith('@chatroom') === true;
  const isMentioned = message.isMentioned === true || message.isAt === true || message.atMe === true;
  if (isGroup && !isMentioned) return null;
  const senderId = firstStringField(message, ['senderId', 'fromWxid', 'sender', 'wxid']) ?? chatId;
  const messageId = firstStringField(message, ['messageId', 'msgId', 'id', 'svrId']);
  if (!chatId || !senderId || !messageId) return null;
  const body = firstStringField(message, ['body', 'text', 'content', 'message']) ?? '';
  const attachmentKind = wechatAttachmentKind(message);
  if (!body && !attachmentKind) return null;
  const timestamp = firstNumberField(message, ['timestamp', 'createTime', 'createdAt']);
  return {
    platform: 'wechat',
    userId: senderId,
    userName: firstStringField(message, ['senderName', 'nickname', 'displayName']) ?? senderId,
    chatId,
    isGroup,
    text: body,
    sourceMessageId: messageId,
    receivedAt: timestamp ? normalizeBridgeTimestamp(timestamp) : Date.now(),
    ...(attachmentKind ? { attachmentKind } : {}),
  };
}

export async function* readSseJsonObjects(body: AsyncIterable<Uint8Array>): AsyncGenerator<unknown> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary = findSseBoundary(buffer);
    while (boundary) {
      const event = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary.length);
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n')
        .trim();
      if (data) yield JSON.parse(data);
      boundary = findSseBoundary(buffer);
    }
  }
}

export async function testWechatBridge(
  channel: BotChannelSettings,
): Promise<BotTestResult> {
  const baseUrl = normalizeWechatBridgeUrl(channel.webhookUrl);
  if (!baseUrl) {
    return {
      ok: false,
      error: 'WeChat bridge URL must be http://127.0.0.1 or http://localhost',
      hint: '微信本地桥接只允许访问本机 wechat-bridge，不能指向远端 URL。',
    };
  }
  try {
    const health = await wechatBridgeJson(channel, '/health', { method: 'GET' });
    const self = typeof health.self === 'object' && health.self !== null
      ? health.self as Record<string, unknown>
      : {};
    const sendStatus = typeof health.send_status === 'string'
      ? health.send_status
      : typeof health.sendStatus === 'string'
        ? health.sendStatus
        : undefined;
    return {
      ok: true,
      identity: {
        id: stringField(health.wxid) ?? stringField(self.wxid) ?? baseUrl,
        username: stringField(health.alias) ?? stringField(self.alias),
        displayName: stringField(health.nickname) ?? stringField(self.nickname) ?? 'wechat-bridge',
      },
      capabilities: {
        health: true,
        send: sendStatus !== 'unavailable' && sendStatus !== 'blocked',
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: generalizedErrorMessage(error),
      hint: '先在本机启动 wechat-bridge，并确认 WeChat 已登录；发送能力需要 wxp_act_ 激活码。',
    };
  }
}

async function wechatBridgeJson(
  channel: BotChannelSettings,
  path: string,
  init: { method: 'GET' | 'POST'; body?: string },
): Promise<Record<string, unknown>> {
  const baseUrl = normalizeWechatBridgeUrl(channel.webhookUrl);
  if (!baseUrl) throw new Error('Invalid WeChat bridge URL');
  const headers = wechatBridgeHeaders(channel);
  if (init.body) headers['Content-Type'] = 'application/json';
  const response = await proxiedFetch(`${baseUrl}${path}`, {
    method: init.method,
    headers,
    body: init.body,
    timeoutMs: WECHAT_BRIDGE_TIMEOUT_MS,
  });
  const json = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const message = stringField(json.error) ?? stringField(json.message) ?? `HTTP ${response.status}`;
    throw new Error(message);
  }
  return json;
}

function wechatBridgeHeaders(channel: BotChannelSettings): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  const bearer = channel.token.trim();
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  return headers;
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function firstStringField(message: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = stringField(message[key]);
    if (value) return value;
  }
  return undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function firstNumberField(message: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = numberField(message[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function normalizeBridgeTimestamp(timestamp: number): number {
  return timestamp > 10_000_000_000 ? timestamp : timestamp * 1_000;
}

function wechatAttachmentKind(message: Record<string, unknown>): BotIncomingMessage['attachmentKind'] | undefined {
  const kind = firstStringField(message, ['messageKind', 'mediaType', 'type']);
  switch (kind) {
    case 'image':
      return 'photo';
    case 'audio':
      return 'audio';
    case 'voice':
      return 'voice';
    case 'video':
      return 'video';
    case 'file':
    case 'attachment':
      return 'document';
    case 'emoticon':
      return 'sticker';
    default:
      return message.hasMedia === true ? 'unknown' : undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findSseBoundary(input: string): { index: number; length: number } | null {
  const match = /\r?\n\r?\n/.exec(input);
  return match ? { index: match.index, length: match[0].length } : null;
}
