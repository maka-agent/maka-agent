import { useEffect, useRef, useState } from 'react';
import { X } from '@maka/ui/icons';
import type { BotChannelSettings } from '@maka/core';
import type { WechatBridgeQrCodeResult } from '@maka/runtime';
import { Button, DialogContent, DialogRoot, Input } from '@maka/ui';
import { PasswordInput } from './password-input';
import { settingsActionErrorMessage } from './settings-error-copy';

/**
 * PR-BOT-WECHAT-SCAN-LOGIN-0 (WAWQAQ msg `1d9c412e` / `e0ae9de2`):
 * WeChat detail follows the reference design — primary surface is a
 * single Bot Token field for the local bridge, with 公众号 (App ID /
 * App Secret) and the bridge URL tucked into a collapsed "高级设置"
 * section so backend wiring stays intact for users that depend on
 * 公众号 messaging.
 *
 * The Bot Token field maps to `channel.token` (used by wechat-bridge
 * for Bearer auth). Advanced fields keep `appId / appSecret /
 * webhookUrl` so the existing runtime contract continues to work.
 */
export function BotWeChatFields(props: {
  channel: BotChannelSettings;
  updateChannel(patch: Partial<BotChannelSettings>): Promise<boolean>;
}) {
  const { channel, updateChannel } = props;
  const hasAdvanced = Boolean(channel.appId || channel.appSecret || channel.webhookUrl);
  const [advancedOpen, setAdvancedOpen] = useState<boolean>(hasAdvanced);
  return (
    <>
      <label className="settingsField">
        <span>Bot Token</span>
        <PasswordInput
          value={channel.token}
          onChange={(next) => updateChannel({ token: next })}
          placeholder="本机 wechat-bridge Bearer Token"
          ariaLabel="微信 Bot Token"
        />
      </label>
      <div className="settingsBotAdvanced">
        <Button
          type="button"
          variant="quiet"
          size="sm"
          className="settingsBotAdvancedToggle"
          aria-expanded={advancedOpen}
          onClick={() => setAdvancedOpen((current) => !current)}
        >
          {advancedOpen ? '收起高级设置' : '高级设置（公众号 / 本机 bridge 地址）'}
        </Button>
        {advancedOpen && (
          <div className="settingsBotAdvancedBody">
            <label className="settingsField">
              <span>本机 bridge 地址</span>
              <Input
                value={channel.webhookUrl ?? ''}
                onChange={(event) => updateChannel({ webhookUrl: event.currentTarget.value })}
                placeholder="http://127.0.0.1:18400"
                aria-label="微信本机 bridge 地址"
              />
            </label>
            <label className="settingsField">
              <span>公众号 App ID</span>
              <Input
                value={channel.appId ?? ''}
                onChange={(event) => updateChannel({ appId: event.currentTarget.value })}
                placeholder="微信公众号 App ID"
                aria-label="微信公众号 App ID"
              />
            </label>
            <label className="settingsField">
              <span>公众号 App Secret</span>
              <PasswordInput
                value={channel.appSecret ?? ''}
                onChange={(next) => updateChannel({ appSecret: next })}
                placeholder="微信公众号 App Secret"
                ariaLabel="微信公众号 App Secret"
              />
            </label>
            <div className="settingsNotice">
              本机 bridge 默认为 <code>http://127.0.0.1:18400</code>。公众号 App ID / App Secret 仅用于公众号消息发送，个人微信扫码登录走本机 bridge。
            </div>
          </div>
        )}
      </div>
    </>
  );
}

export function WeChatScanLoginModal(props: {
  onClose(): void;
  onConfirmed(credentials: { botToken: string; baseUrl: string; botId: string; userId: string }): Promise<void>;
}) {
  const [qr, setQr] = useState<{ qrcodeUrl: string; qrToken: string } | null>(null);
  const [status, setStatus] = useState<'fetching' | 'waiting' | 'expired' | 'confirmed' | 'error'>('fetching');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const fetchingQrRef = useRef(false);
  const scanLoginPollingRef = useRef(false);
  const scanLoginConfirmingRef = useRef(false);
  const scanLoginMountedRef = useRef(false);
  const scanLoginFetchTicketRef = useRef(0);

  async function fetchQr() {
    if (fetchingQrRef.current) return;
    fetchingQrRef.current = true;
    const ticket = ++scanLoginFetchTicketRef.current;
    const isCurrentRequest = () => scanLoginMountedRef.current && scanLoginFetchTicketRef.current === ticket;
    setStatus('fetching');
    setErrorMessage(null);
    try {
      const result = await window.maka.settings.bots.wechat.fetchQrcode();
      if (!isCurrentRequest()) return;
      if (!result.ok) {
        setStatus('error');
        setErrorMessage(settingsActionErrorMessage(result.error.message));
        return;
      }
      setQr(result.data);
      setStatus('waiting');
    } catch (error) {
      if (isCurrentRequest()) {
        setStatus('error');
        setErrorMessage(settingsActionErrorMessage(error));
      }
    } finally {
      if (!scanLoginMountedRef.current || scanLoginFetchTicketRef.current === ticket) {
        fetchingQrRef.current = false;
      }
    }
  }

  useEffect(() => {
    scanLoginMountedRef.current = true;
    void fetchQr();
    return () => {
      scanLoginMountedRef.current = false;
      scanLoginFetchTicketRef.current += 1;
      fetchingQrRef.current = false;
      scanLoginPollingRef.current = false;
      scanLoginConfirmingRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (status !== 'waiting' || !qr?.qrToken) return;
    let cancelled = false;
    const interval = window.setInterval(async () => {
      if (cancelled || scanLoginPollingRef.current || scanLoginConfirmingRef.current) return;
      scanLoginPollingRef.current = true;
      try {
        const result = await window.maka.settings.bots.wechat.pollQrcodeStatus(qr.qrToken);
        if (cancelled || !scanLoginMountedRef.current) return;
        if (!result.ok) {
          setStatus('error');
          setErrorMessage(settingsActionErrorMessage(result.error.message));
          return;
        }
        if (result.data.status === 'confirmed') {
          scanLoginConfirmingRef.current = true;
          setStatus('confirmed');
          await props.onConfirmed(result.data.credentials);
          scanLoginConfirmingRef.current = false;
        } else if (result.data.status === 'expired') {
          setStatus('expired');
        }
      } catch (error) {
        if (cancelled || !scanLoginMountedRef.current) return;
        scanLoginConfirmingRef.current = false;
        setStatus('error');
        setErrorMessage(settingsActionErrorMessage(error));
      } finally {
        if (!scanLoginConfirmingRef.current) {
          scanLoginPollingRef.current = false;
        }
      }
    }, 2500);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      scanLoginPollingRef.current = false;
    };
  }, [status, qr?.qrToken]);

  const statusCopy = (() => {
    switch (status) {
      case 'fetching': return '正在获取二维码…';
      case 'waiting': return '请使用 iOS / Android 微信 8.0.70+ 扫描二维码';
      case 'expired': return '二维码已过期，请刷新';
      case 'confirmed': return '已扫码登录';
      case 'error': return errorMessage ?? '扫码登录失败';
    }
  })();

  return (
    <DialogRoot
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent
        className="settingsBotScanLoginModal"
        aria-label="微信扫码登录"
        showClose={false}
      >
        <header className="settingsBotScanLoginHeader">
          <h3>微信扫码登录</h3>
          <Button
            type="button"
            variant="quiet"
            size="icon-sm"
            className="settingsCloseButton"
            aria-label="关闭微信扫码登录"
            onClick={props.onClose}
          >
            <X aria-hidden="true" />
          </Button>
        </header>
        <div className="settingsBotScanLoginBody">
          {qr?.qrcodeUrl && (status === 'waiting' || status === 'confirmed') ? (
            <img
              className="settingsBotScanLoginQr"
              src={qr.qrcodeUrl}
              alt="微信扫码登录二维码"
            />
          ) : (
            <div className="settingsBotScanLoginQrPlaceholder" aria-hidden="true">
              {status === 'fetching' ? '…' : status === 'expired' ? '⟳' : '!'}
            </div>
          )}
          <p className="settingsBotScanLoginStatus" data-status={status}>{statusCopy}</p>
          <p className="settingsHelpText">
            扫码确认后会保存个人微信机器人凭据；Maka 不保存二维码轮询的中间状态。
          </p>
        </div>
        <div className="settingsBotScanLoginActions" role="group" aria-label="微信扫码登录操作">
          {(status === 'expired' || status === 'error') && (
            <Button type="button" variant="secondary" onClick={() => void fetchQr()}>
              刷新二维码
            </Button>
          )}
          <Button type="button" variant="secondary" onClick={props.onClose}>
            {status === 'confirmed' ? '关闭' : '取消'}
          </Button>
        </div>
      </DialogContent>
    </DialogRoot>
  );
}

export function WechatQrLoginModal(props: {
  onClose(): void;
  onRefreshStatuses(): void | Promise<unknown>;
}) {
  const [result, setResult] = useState<WechatBridgeQrCodeResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadNonce, setReloadNonce] = useState(0);
  const notifiedLoggedInRef = useRef(false);
  const loadingQrRef = useRef(false);

  function reloadQrCode() {
    if (loadingQrRef.current) return;
    loadingQrRef.current = true;
    setLoading(true);
    setReloadNonce((current) => current + 1);
  }

  useEffect(() => {
    let active = true;
    loadingQrRef.current = true;
    setLoading(true);
    void window.maka.settings.bots.wechatQrCode()
      .then((next) => {
        if (!active) return;
        setResult(next);
        if (next.ok && next.loggedIn && !notifiedLoggedInRef.current) {
          notifiedLoggedInRef.current = true;
          void props.onRefreshStatuses();
        }
      })
      .catch((error) => {
        if (!active) return;
        setResult({
          ok: false,
          error: settingsActionErrorMessage(error),
          hint: '读取本机 wechat-bridge 二维码失败，请确认 bridge 已启动。',
        });
      })
      .finally(() => {
        if (active) {
          setLoading(false);
          loadingQrRef.current = false;
        }
      });
    return () => {
      active = false;
    };
  }, [reloadNonce]);

  // PR-FE-BUG-HUNT-2 (kenji bug-hunt 2026-06-24 MEDIUM): the previous
  // dep `[result]` re-armed the 3-second polling interval every time
  // the QR refresh produced a new `result` object reference — even
  // when the meaningful state (`ok` / `loggedIn` / `expired`) was
  // unchanged. The interval clock drifted on every refresh,
  // sometimes pushing the next poll 2.9s past the intended cadence.
  // Depend on the gating booleans directly so the interval stays
  // armed continuously while the user is actively scanning.
  const shouldPollQr = !!result?.ok && !result.loggedIn && !result.expired;
  useEffect(() => {
    if (!shouldPollQr) return undefined;
    const interval = window.setInterval(() => {
      reloadQrCode();
    }, 3_000);
    return () => window.clearInterval(interval);
  }, [shouldPollQr]);

  const qrDataUrl = result?.ok ? result.qrcode : null;
  const expired = result?.ok ? result.expired : false;
  const loggedIn = result?.ok ? result.loggedIn : false;
  const error = result && !result.ok ? result : null;

  return (
    <DialogRoot
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent
        className="settingsWechatQrModal"
        aria-labelledby="settingsWechatQrTitle"
        showClose={false}
      >
        <div className="settingsWechatQrHeader">
          <div>
            <h3 id="settingsWechatQrTitle">微信扫码登录</h3>
            <p>使用手机微信扫描二维码，并在手机上确认登录本机 wechat-bridge。</p>
          </div>
          <Button
            type="button"
            variant="quiet"
            size="icon-sm"
            className="settingsWechatQrClose"
            aria-label="关闭微信扫码登录"
            onClick={props.onClose}
          >
            <X size={17} aria-hidden="true" />
          </Button>
        </div>

        <div className="settingsWechatQrBody">
          {loading ? (
            <div className="settingsWechatQrState" data-tone="loading">
              正在生成二维码…
            </div>
          ) : loggedIn ? (
            <div className="settingsWechatQrState" data-tone="success">
              微信已登录，返回后可以测试连接或重启监听。
            </div>
          ) : expired ? (
            <div className="settingsWechatQrState" data-tone="warning">
              二维码已过期
              <Button type="button" variant="secondary" className="settingsWechatQrSecondary" disabled={loading} onClick={reloadQrCode}>
                {loading ? '刷新中…' : '刷新二维码'}
              </Button>
            </div>
          ) : qrDataUrl ? (
            <>
              <div className="settingsWechatQrFrame">
                <img src={qrDataUrl} alt="微信扫码登录二维码" />
              </div>
              <p className="settingsWechatQrCaption">等待扫码确认… 窗口会每 3 秒刷新登录状态。</p>
            </>
          ) : error ? (
            <div className="settingsWechatQrState" data-tone="error" role="alert">
              <strong>{error.error}</strong>
              <span>{error.hint}</span>
              <Button type="button" variant="secondary" className="settingsWechatQrSecondary" disabled={loading} onClick={reloadQrCode}>
                {loading ? '重试中…' : '重试'}
              </Button>
            </div>
          ) : (
            <div className="settingsWechatQrState" data-tone="loading">
              bridge 正在生成二维码
              <Button type="button" variant="secondary" className="settingsWechatQrSecondary" disabled={loading} onClick={reloadQrCode}>
                {loading ? '获取中…' : '重新获取'}
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </DialogRoot>
  );
}
