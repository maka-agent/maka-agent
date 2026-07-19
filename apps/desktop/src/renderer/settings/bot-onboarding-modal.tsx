import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  BotOnboardingBrand,
  BotOnboardingProvider,
  BotOnboardingSnapshot,
} from '@maka/core';
import {
  Button,
  DialogContent,
  DialogHeader,
  DialogRoot,
  Spinner,
  useMountedRef,
} from '@maka/ui';
import { AlertCircle, Check } from '@maka/ui/icons';
import { BotBrandLogo, BOT_LABELS } from './bot-chat-shared';
import { settingsActionErrorMessage } from './settings-error-copy';

const COPY: Record<BotOnboardingProvider, {
  title: string;
  subtitle: string;
  waiting: string;
  scanned: string;
}> = {
  dingtalk: {
    title: '配置钉钉',
    subtitle: '在钉钉中扫码完成应用注册',
    waiting: '请使用钉钉扫描二维码并确认授权',
    scanned: '已扫码，请在钉钉中完成确认',
  },
  feishu: {
    title: '配置飞书',
    subtitle: '使用飞书扫描二维码，自动创建并配置机器人',
    waiting: '请使用飞书扫描二维码并确认创建',
    scanned: '已扫码，请在飞书中完成确认',
  },
  wecom: {
    title: '配置企业微信',
    subtitle: '快捷接入会自动创建并连接企业微信机器人',
    waiting: '打开企业微信，扫描二维码完成机器人创建',
    scanned: '已扫码，请在企业微信中完成确认',
  },
  wechat: {
    title: '连接微信',
    subtitle: '请使用微信扫描二维码完成连接',
    waiting: '请使用微信扫描二维码并在手机上确认',
    scanned: '已扫码，请在微信中完成确认',
  },
};

export function BotOnboardingModal(props: {
  provider: BotOnboardingProvider;
  brand?: BotOnboardingBrand;
  onClose(): void;
  onConnected(snapshot: BotOnboardingSnapshot): void | Promise<void>;
}) {
  const mountedRef = useMountedRef();
  const [snapshot, setSnapshot] = useState<BotOnboardingSnapshot | null>(null);
  const [starting, setStarting] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const generationRef = useRef(0);
  const connectedNotifiedRef = useRef(false);
  // PR1197 review (P2-13): main emits the (large) QR data URL only on the start
  // snapshot; poll snapshots omit it. Cache it here so re-renders driven by
  // subsequent polls keep showing the QR without re-sending it over IPC.
  const qrCacheRef = useRef<string | null>(null);
  const copy = providerCopy(props.provider, props.brand);
  const accessibleTitle = props.provider === 'feishu' && props.brand === 'lark'
    ? `${copy.title} `
    : copy.title;

  const cancelCurrent = useCallback(() => {
    generationRef.current += 1;
    const sessionId = sessionIdRef.current;
    sessionIdRef.current = null;
    if (sessionId) {
      void window.maka.settings.bots.onboarding.cancel(sessionId).catch(() => undefined);
    }
  }, []);

  const start = useCallback(async () => {
    cancelCurrent();
    const generation = generationRef.current;
    setStarting(true);
    setError(null);
    setSnapshot(null);
    connectedNotifiedRef.current = false;
    qrCacheRef.current = null;
    try {
      const result = await window.maka.settings.bots.onboarding.start({
        provider: props.provider,
        ...(props.provider === 'feishu' ? { brand: props.brand ?? 'feishu' } : {}),
      });
      if (!mountedRef.current || generation !== generationRef.current) return;
      setStarting(false);
      if (!result.ok) {
        setError(settingsActionErrorMessage(result.error.message));
        return;
      }
      sessionIdRef.current = result.data.sessionId;
      if (result.data.qrCodeDataUrl) qrCacheRef.current = result.data.qrCodeDataUrl;
      setSnapshot(result.data);
    } catch (startError) {
      if (!mountedRef.current || generation !== generationRef.current) return;
      setStarting(false);
      setError(settingsActionErrorMessage(startError));
    }
  }, [cancelCurrent, props.provider, props.brand]);

  useEffect(() => {
    void start();
    return cancelCurrent;
  }, [start, cancelCurrent]);

  useEffect(() => {
    const sessionId = snapshot?.sessionId;
    if (!sessionId || !['waiting', 'scanned'].includes(snapshot.state)) return;
    const generation = generationRef.current;
    const delay = Math.max(400, snapshot.nextPollAfterMs);
    const timer = window.setTimeout(async () => {
      try {
        const result = await window.maka.settings.bots.onboarding.poll(sessionId);
        if (!mountedRef.current || generation !== generationRef.current) return;
        if (!result.ok) {
          setError(settingsActionErrorMessage(result.error.message));
          return;
        }
        setSnapshot(result.data);
      } catch (pollError) {
        if (!mountedRef.current || generation !== generationRef.current) return;
        setError(settingsActionErrorMessage(pollError));
      }
    }, delay);
    return () => window.clearTimeout(timer);
  }, [snapshot]);

  useEffect(() => {
    if (snapshot?.state !== 'connected' || connectedNotifiedRef.current) return;
    connectedNotifiedRef.current = true;
    void Promise.resolve(props.onConnected(snapshot)).catch((connectedError) => {
      if (!mountedRef.current || sessionIdRef.current !== snapshot.sessionId) return;
      setError(`连接已完成，但状态刷新失败：${settingsActionErrorMessage(connectedError)}`);
    });
  }, [snapshot, props.onConnected]);

  async function openInBrowser() {
    if (!snapshot) return;
    try {
      const result = await window.maka.settings.bots.onboarding.openInBrowser(snapshot.sessionId);
      if (!mountedRef.current || sessionIdRef.current !== snapshot.sessionId) return;
      if (!result.ok) setError(settingsActionErrorMessage(result.error.message));
    } catch (openError) {
      if (!mountedRef.current || sessionIdRef.current !== snapshot.sessionId) return;
      setError(settingsActionErrorMessage(openError));
    }
  }

  function close() {
    cancelCurrent();
    props.onClose();
  }

  const status = statusCopy(snapshot, starting, error, copy);
  const qrDataUrl = snapshot?.qrCodeDataUrl ?? qrCacheRef.current;
  const showQr = Boolean(qrDataUrl)
    && snapshot?.state !== 'expired'
    && snapshot?.state !== 'denied'
    && snapshot?.state !== 'error';

  return (
    <DialogRoot open onOpenChange={(open) => { if (!open) close(); }}>
      <DialogContent
        className="settingsBotOnboardingModal"
        aria-label={`${accessibleTitle}扫码接入`}
        showClose={false}
      >
        <div className="settingsBotOnboardingBrand" aria-hidden="true">
          <BotBrandLogo provider={props.provider} size="large" />
        </div>
        <DialogHeader title={copy.title} subtitle={copy.subtitle} closeLabel={`关闭${copy.title}`} onClose={close} />
        <div className="settingsBotOnboardingBody" aria-live="polite">
          <div className="settingsBotOnboardingQrFrame" data-state={snapshot?.state ?? (starting ? 'starting' : 'error')}>
            {showQr ? (
              <img src={qrDataUrl ?? undefined} alt={`${accessibleTitle}二维码`} />
            ) : starting || snapshot?.state === 'connecting' ? (
              <Spinner size={28} aria-label="正在生成二维码" />
            ) : snapshot?.state === 'connected' ? (
              snapshot.warning ? (
                <span className="settingsBotOnboardingEmpty" aria-hidden="true">
                  <AlertCircle size={28} />
                </span>
              ) : (
                <span className="settingsBotOnboardingSuccess" aria-hidden="true">
                  <Check size={28} />
                </span>
              )
            ) : (
              <span className="settingsBotOnboardingEmpty" aria-hidden="true">
                <AlertCircle size={28} />
              </span>
            )}
          </div>
          <p className="settingsBotOnboardingStatus" data-state={snapshot?.state ?? (error ? 'error' : 'starting')}>
            {status}
          </p>
          <p className="settingsBotOnboardingPrivacy">凭据仅保存在本机，不会传给 renderer 或 Maka 云端。</p>
          {snapshot?.canOpenInBrowser && ['waiting', 'scanned'].includes(snapshot.state) && (
            <Button
              type="button"
              variant="quiet"
              size="sm"
              onClick={() => void openInBrowser()}
            >
              无法扫码？在浏览器中打开
            </Button>
          )}
        </div>
        <div className="settingsBotOnboardingActions">
          {snapshot?.state === 'connected' ? (
            <Button type="button" onClick={close}>完成</Button>
          ) : snapshot?.state === 'expired' || snapshot?.state === 'denied' || error ? (
            <Button type="button" onClick={() => void start()}>重新生成</Button>
          ) : (
            <>
              <Button type="button" variant="secondary" disabled={starting} onClick={() => void start()}>
                刷新二维码
              </Button>
              <Button type="button" variant="quiet" onClick={close}>取消</Button>
            </>
          )}
        </div>
      </DialogContent>
    </DialogRoot>
  );
}

function providerCopy(
  provider: BotOnboardingProvider,
  brand: BotOnboardingBrand | undefined,
): typeof COPY[BotOnboardingProvider] {
  if (provider !== 'feishu' || brand !== 'lark') return COPY[provider];
  return {
    title: '配置 Lark',
    subtitle: '使用 Lark 扫描二维码，自动创建并配置机器人',
    waiting: '请使用 Lark 扫描二维码并确认创建',
    scanned: '已扫码，请在 Lark 中完成确认',
  };
}

function statusCopy(
  snapshot: BotOnboardingSnapshot | null,
  starting: boolean,
  error: string | null,
  copy: typeof COPY[BotOnboardingProvider],
): string {
  if (starting) return '正在生成安全二维码…';
  if (error) return error;
  switch (snapshot?.state) {
    case 'waiting': return copy.waiting;
    case 'scanned': return copy.scanned;
    case 'connecting': return '授权完成，正在保存凭据并启动连接…';
    // PR1197 review (P0-3): honour the honest "saved but not connected" notice
    // instead of claiming a healthy connection.
    case 'connected': return snapshot.warning ?? `${BOT_LABELS[snapshot.provider].label} 已连接`;
    case 'expired': return '二维码已过期，请重新生成';
    case 'denied': return '授权已取消，请重新生成二维码';
    case 'cancelled': return '扫码接入已取消';
    case 'error': return snapshot.error ?? '扫码接入失败，请重试';
    default: return '准备扫码接入…';
  }
}
