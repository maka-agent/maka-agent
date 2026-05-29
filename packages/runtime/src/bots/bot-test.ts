import { botDisplayLabel, type BotChannelSettings, type BotProvider } from '@maka/core';
import type { BotTestResult } from './types.js';
import { proxiedFetch } from './proxied-fetch.js';

const BOT_TEST_TIMEOUT_MS = 10_000;

export async function testBotChannel(provider: BotProvider, channel: BotChannelSettings): Promise<BotTestResult> {
  if (
    provider !== 'feishu' &&
    provider !== 'wecom' &&
    provider !== 'wechat' &&
    !channel.token.trim()
  ) {
    return { ok: false, error: 'Bot token is required' };
  }
  switch (provider) {
    case 'telegram': return testTelegram(channel);
    case 'discord': return testDiscord(channel);
    case 'feishu': return testFeishu(channel);
    case 'wecom': return testWeCom(channel);
    case 'wechat':
    case 'dingtalk':
    case 'qq':
      return {
        ok: false,
        error: `${botDisplayLabel(provider)} 当前不支持凭据测试。`,
        hint: '该平台不会进入可用机器人列表或计划提醒投递目标。',
      };
  }
}

async function testTelegram(channel: BotChannelSettings): Promise<BotTestResult> {
  const base = `https://api.telegram.org/bot${channel.token}`;
  try {
    const me = await (await proxiedFetch(`${base}/getMe`, { method: 'GET', timeoutMs: BOT_TEST_TIMEOUT_MS })).json();
    if (!me.ok) return { ok: false, error: me.description ?? 'Invalid bot token' };
    return {
      ok: true,
      identity: { id: String(me.result.id), username: me.result.username, displayName: me.result.first_name },
      messageSent: false,
      hint: '发送 /start 给机器人后可在运行态接收消息。',
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function testDiscord(channel: BotChannelSettings): Promise<BotTestResult> {
  try {
    const response = await proxiedFetch('https://discord.com/api/v10/users/@me', {
      method: 'GET',
      headers: { Authorization: `Bot ${channel.token}` },
      timeoutMs: BOT_TEST_TIMEOUT_MS,
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) return { ok: false, error: json.message ?? `HTTP ${response.status}` };
    return { ok: true, identity: { id: json.id, username: json.username, displayName: json.global_name } };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * PR-BOT-WECOM-CREDENTIALS-TEST-0 (Hermes deep-dive: wecom_crypto pattern):
 * verify WeCom (企业微信) self-built app credentials by issuing an
 * `access_token` via the corp gettoken endpoint. Success proves the
 * corp_id + corp_secret pair are real and the app exists; it does NOT
 * prove that message send/receive will work — that needs the callback
 * + agent_id wiring which lands separately.
 *
 * WeCom stores credentials as:
 *   - `appId` = corp_id (the company's corporation id)
 *   - `appSecret` = the self-built app's secret
 *
 * Token is reused only for the test request; we discard it immediately
 * because the calling layer is just verifying credentials shape.
 */
async function testWeCom(channel: BotChannelSettings): Promise<BotTestResult> {
  const corpId = channel.appId?.trim() ?? '';
  const corpSecret = channel.appSecret?.trim() ?? '';
  if (!corpId || !corpSecret) {
    return { ok: false, error: '企业微信需要 corp_id 与 corp_secret' };
  }
  const url =
    'https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=' +
    encodeURIComponent(corpId) +
    '&corpsecret=' +
    encodeURIComponent(corpSecret);
  try {
    const response = await proxiedFetch(url, {
      method: 'GET',
      timeoutMs: BOT_TEST_TIMEOUT_MS,
    });
    const json = await response.json().catch(() => ({}));
    if (json.errcode && json.errcode !== 0) {
      return {
        ok: false,
        error: json.errmsg ? `WeCom: ${json.errmsg}` : `WeCom errcode ${json.errcode}`,
      };
    }
    if (typeof json.access_token !== 'string' || json.access_token.length === 0) {
      return { ok: false, error: 'WeCom 凭据测试未返回 access_token' };
    }
    return {
      ok: true,
      identity: { id: corpId, username: corpId, displayName: corpId },
      capabilities: { auth: true },
      hint: '凭据有效；接收消息需要在企业后台配置 callback 域名。',
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function testFeishu(channel: BotChannelSettings): Promise<BotTestResult> {
  const appId = channel.appId ?? '';
  const appSecret = channel.appSecret || channel.token;
  if (!appId || !appSecret) return { ok: false, error: 'Feishu appId and appSecret are required' };
  try {
    const response = await proxiedFetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      timeoutMs: BOT_TEST_TIMEOUT_MS,
    });
    const json = await response.json();
    if (json.code !== 0 || !json.tenant_access_token) {
      return { ok: false, error: json.msg ?? 'Failed to issue tenant_access_token' };
    }
    return {
      ok: true,
      identity: { id: appId, username: appId, displayName: appId },
      capabilities: { auth: true },
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
