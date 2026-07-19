import { botDisplayLabel, type BotChannelSettings, type BotProvider } from '@maka/core';
import type { BotTestResult } from './types.js';
import { proxiedFetch } from './proxied-fetch.js';
import {
  normalizeWechatIlinkBaseUrl,
  testWechatBridge,
  testWechatIlinkCredentials,
} from './wechat-bridge.js';

const BOT_TEST_TIMEOUT_MS = 10_000;

export async function testBotChannel(
  provider: BotProvider,
  channel: BotChannelSettings,
): Promise<BotTestResult> {
  if (
    provider !== 'feishu' &&
    provider !== 'wecom' &&
    provider !== 'wechat' &&
    provider !== 'dingtalk' &&
    provider !== 'qq' &&
    !channel.token.trim()
  ) {
    return { ok: false, error: 'Bot token is required' };
  }
  switch (provider) {
    case 'telegram':
      return testTelegram(channel);
    case 'discord':
      return testDiscord(channel);
    case 'feishu':
      return testFeishu(channel);
    case 'wecom':
      return testWeCom(channel);
    case 'dingtalk':
      return testDingTalk(channel);
    case 'wechat':
      return testWechat(channel);
    case 'qq':
      return testQQ(channel);
  }
}

async function testWechat(channel: BotChannelSettings): Promise<BotTestResult> {
  if (channel.token.trim() && normalizeWechatIlinkBaseUrl(channel.webhookUrl)) {
    return testWechatIlinkCredentials(channel);
  }
  const appId = channel.appId?.trim() ?? '';
  const appSecret = channel.appSecret?.trim() || channel.token.trim();
  if (!appId || !appSecret) {
    return testWechatBridge(channel);
  }
  try {
    const url = new URL('https://api.weixin.qq.com/cgi-bin/token');
    url.searchParams.set('grant_type', 'client_credential');
    url.searchParams.set('appid', appId);
    url.searchParams.set('secret', appSecret);
    const response = await proxiedFetch(url.toString(), {
      method: 'GET',
      timeoutMs: BOT_TEST_TIMEOUT_MS,
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok || typeof json.access_token !== 'string') {
      return { ok: false, error: json.errmsg ?? `HTTP ${response.status}` };
    }
    return {
      ok: true,
      identity: { id: appId, username: appId, displayName: appId },
      capabilities: { auth: true },
      hint: '凭据有效；消息收发还需要公众号服务器配置和回调验证。',
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function testTelegram(channel: BotChannelSettings): Promise<BotTestResult> {
  const base = `https://api.telegram.org/bot${channel.token}`;
  try {
    const me = await (
      await proxiedFetch(`${base}/getMe`, { method: 'GET', timeoutMs: BOT_TEST_TIMEOUT_MS })
    ).json();
    if (!me.ok) return { ok: false, error: me.description ?? 'Invalid bot token' };
    return {
      ok: true,
      identity: {
        id: String(me.result.id),
        username: me.result.username,
        displayName: me.result.first_name,
      },
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
    return {
      ok: true,
      identity: { id: json.id, username: json.username, displayName: json.global_name },
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * PR-BOT-WECOM-CREDENTIALS-TEST-0 (external bot research: wecom_crypto pattern):
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

/**
 * PR-BOT-DINGTALK-CREDENTIALS-TEST-0 (external bot research: enterprise IM
 * adapters): verify DingTalk (钉钉) self-built app credentials by
 * issuing an `access_token` via the open-platform `gettoken` endpoint.
 * Mirrors the WeCom pattern almost exactly — the open platform exposes
 * the same handshake shape with `appkey` / `appsecret`.
 *
 * Storage semantics (matches WeCom + Feishu):
 *   - `appId` = appkey (the self-built app's identifier)
 *   - `appSecret` = appsecret (the self-built app's secret)
 *
 * Success only proves the credentials exist; it does NOT prove that
 * message send / receive will work — that needs DingTalk's outgoing
 * group webhook or the Stream interface, which lands separately.
 */
async function testDingTalk(channel: BotChannelSettings): Promise<BotTestResult> {
  const appkey = channel.appId?.trim() ?? '';
  const appsecret = channel.appSecret?.trim() ?? '';
  if (!appkey || !appsecret) {
    return { ok: false, error: '钉钉需要 appkey 与 appsecret' };
  }
  const url =
    'https://oapi.dingtalk.com/gettoken?appkey=' +
    encodeURIComponent(appkey) +
    '&appsecret=' +
    encodeURIComponent(appsecret);
  try {
    const response = await proxiedFetch(url, {
      method: 'GET',
      timeoutMs: BOT_TEST_TIMEOUT_MS,
    });
    const json = await response.json().catch(() => ({}));
    if (json.errcode && json.errcode !== 0) {
      return {
        ok: false,
        error: json.errmsg ? `钉钉: ${json.errmsg}` : `钉钉 errcode ${json.errcode}`,
      };
    }
    if (typeof json.access_token !== 'string' || json.access_token.length === 0) {
      return { ok: false, error: '钉钉凭据测试未返回 access_token' };
    }
    return {
      ok: true,
      identity: { id: appkey, username: appkey, displayName: appkey },
      capabilities: { auth: true },
      hint: '凭据有效；接收消息需要 outgoing 机器人或 Stream 模式配置。',
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * PR-BOT-QQ-CREDENTIALS-TEST-0 (external bot research: official QQ Channel
 * bot): verify QQ 官方机器人 self-built app credentials by issuing an
 * `access_token` via the bots open-platform endpoint. Same handshake
 * shape as WeCom / DingTalk — `appId` + `clientSecret`, returns a
 * short-lived bot access token.
 *
 * Storage semantics (matches the existing self-built app pattern):
 *   - `appId` = QQ Bot App ID
 *   - `appSecret` = QQ Bot Client Secret
 *
 * Success only proves the credentials exist; it does NOT prove that
 * the bot can receive events (that needs WebSocket Gateway connection)
 * or send messages (that needs channel context + per-channel API).
 */
async function testQQ(channel: BotChannelSettings): Promise<BotTestResult> {
  const appId = channel.appId?.trim() ?? '';
  const clientSecret = channel.appSecret?.trim() ?? '';
  if (!appId || !clientSecret) {
    return { ok: false, error: 'QQ 官方机器人需要 App ID 与 Client Secret' };
  }
  try {
    const response = await proxiedFetch('https://bots.qq.com/app/getAppAccessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId, clientSecret }),
      timeoutMs: BOT_TEST_TIMEOUT_MS,
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message =
        typeof json.message === 'string' && json.message.length > 0
          ? `QQ: ${json.message}`
          : `HTTP ${response.status}`;
      return { ok: false, error: message };
    }
    if (typeof json.access_token !== 'string' || json.access_token.length === 0) {
      return { ok: false, error: 'QQ 官方机器人凭据测试未返回 access_token' };
    }
    return {
      ok: true,
      identity: { id: appId, username: appId, displayName: appId },
      capabilities: { auth: true },
      hint: '凭据有效；接收消息需要 QQ Gateway WebSocket 接入。',
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
    const response = await proxiedFetch(
      'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
        timeoutMs: BOT_TEST_TIMEOUT_MS,
      },
    );
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
