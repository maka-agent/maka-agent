import { useEffect, useId, useRef, useState } from 'react';
import { Volume2 } from '@maka/ui/icons';
import type { VoicePermissionStatus } from '@maka/core';
import { defaultVoiceCaptureCaps, validateVoiceCaptureRequest } from '@maka/core';
import { Button, PageHeader, formatBytes, useMountedRef, useToast } from '@maka/ui';
import { useActionGuard } from './use-action-guard';

type VoiceSmokeState =
  | { status: 'idle'; message: string }
  | { status: 'checking'; message: string }
  | { status: 'recording'; message: string }
  | { status: 'ok'; message: string; durationMs: number; audioBytes: number }
  | { status: 'error'; message: string };

export function VoiceModelsSettingsPage() {
  const [permission, setPermission] = useState<VoicePermissionStatus>('unknown');
  const [smoke, setSmoke] = useState<VoiceSmokeState>({
    status: 'idle',
    message: '等待运行本机录音自检。',
  });
  const [isBusy, setIsBusy] = useState(false);
  const captureSmokeGuard = useActionGuard<'smoke'>();
  const voicePageMountedRef = useMountedRef();
  const activeVoiceCaptureStreamRef = useRef<MediaStream | null>(null);
  const toast = useToast();
  const caps = defaultVoiceCaptureCaps();
  const smokeStatusId = useId();

  useEffect(() => {
    return () => {
      activeVoiceCaptureStreamRef.current?.getTracks().forEach((track) => track.stop());
      activeVoiceCaptureStreamRef.current = null;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void readBrowserMicrophonePermission().then((next) => {
      if (!cancelled) setPermission(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function runCaptureSmoke() {
    if (captureSmokeGuard.current !== null) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      setPermission('unsupported');
      setSmoke({ status: 'error', message: '当前运行环境不支持浏览器麦克风 API。' });
      return;
    }
    if (typeof MediaRecorder === 'undefined') {
      setPermission('unsupported');
      setSmoke({ status: 'error', message: '当前运行环境不支持 MediaRecorder，无法做本地录音自检。' });
      return;
    }

    captureSmokeGuard.begin('smoke');
    setIsBusy(true);
    setSmoke({ status: 'checking', message: '正在请求 macOS / 浏览器麦克风权限…' });
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: caps.maxChannels,
          sampleRate: caps.maxSampleRate,
        },
      });
      activeVoiceCaptureStreamRef.current = stream;
      if (!voicePageMountedRef.current) return;
      setPermission('granted');
      setSmoke({ status: 'recording', message: '正在录制 2 秒本地样本；样本只在内存里计算大小，结束后立即丢弃。' });
      const startedAt = performance.now();
      const chunks: Blob[] = [];
      const recorder = new MediaRecorder(stream);
      recorder.addEventListener('dataavailable', (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      });
      const stopped = new Promise<void>((resolve, reject) => {
        recorder.addEventListener('stop', () => resolve(), { once: true });
        recorder.addEventListener('error', () => reject(new Error('录音自检失败')), { once: true });
      });
      recorder.start();
      await waitMs(2_000);
      if (recorder.state !== 'inactive') recorder.stop();
      await stopped;
      const durationMs = Math.round(performance.now() - startedAt);
      const audioBytes = chunks.reduce((sum, chunk) => sum + chunk.size, 0);
      const validation = validateVoiceCaptureRequest({
        mode: 'push_to_talk',
        permission: 'granted',
        durationMs,
        audioBytes,
        sampleRate: caps.maxSampleRate,
        channels: caps.maxChannels,
      });
      if (!validation.ok) {
        if (voicePageMountedRef.current) {
          setSmoke({ status: 'error', message: voiceValidationCopy(validation.reason) });
        }
        return;
      }
      const message = `录音链路可用：${formatVoiceDuration(durationMs)}，${formatBytes(audioBytes)}。样本未保存。`;
      if (voicePageMountedRef.current) {
        setSmoke({ status: 'ok', message, durationMs, audioBytes });
        toast.success('语音自检通过', message);
      }
    } catch (error) {
      const next = classifyVoicePermissionError(error);
      const message = next === 'denied'
        ? '麦克风权限被拒绝；请在系统设置里允许 Maka 访问麦克风后重试。'
        : '录音自检失败；请确认系统权限和音频设备可用。';
      if (voicePageMountedRef.current) {
        setPermission(next);
        setSmoke({ status: 'error', message });
        toast.error('语音自检失败', message);
      }
    } finally {
      stream?.getTracks().forEach((track) => track.stop());
      if (activeVoiceCaptureStreamRef.current === stream) {
        activeVoiceCaptureStreamRef.current = null;
      }
      captureSmokeGuard.finish();
      if (voicePageMountedRef.current) {
        setIsBusy(false);
      }
    }
  }

  return (
    <section className="settingsFeatureStatusPage" aria-label="语音模型">
      {/* Detail sweep: the always-on shipped-feature announcement banner is
          gone — release notes don't live in settings, and its privacy copy
          duplicated the 隐私 tile + 当前边界 section below. (daily-review
          made the same banner exception-only earlier.) */}
      <PageHeader
        as_wrapper="div"
        className="settingsFeatureStatusHero"
        as="h3"
        icon={<Volume2 size={24} />}
        iconClassName="settingsFeatureStatusIcon"
        headingRowClassName="settingsFeatureStatusHeroHeading"
        title="语音模型"
        badge={<span className="settingsFeatureStatusBadge">本地自检</span>}
        subtitle="这页现在可以验证麦克风权限和本地录音链路。语音转写和语音朗读模型必须遵守这个边界：转写结果必须先回到消息输入框，由用户编辑确认后才能发送；音频样本默认不落盘。"
      />

      <dl className="settingsBotStatusGrid" aria-label="语音能力状态">
        <div>
          <dt>麦克风权限</dt>
          <dd>{voicePermissionLabel(permission)}</dd>
        </div>
        <div>
          <dt>采集上限</dt>
          <dd>{Math.round(caps.maxDurationMs / 1000)} 秒 · {Math.round(caps.maxAudioBytes / 1024 / 1024)} MB</dd>
        </div>
        <div>
          <dt>通道</dt>
          <dd>单声道 · ≤ {Math.round(caps.maxSampleRate / 1000)} kHz</dd>
        </div>
        <div>
          <dt>隐私</dt>
          <dd>不保存音频 · 不进遥测</dd>
        </div>
      </dl>

      <div className="settingsActionRow">
        <Button
          type="button"
          onClick={() => void runCaptureSmoke()}
          disabled={isBusy}
          aria-busy={isBusy}
          aria-describedby={smokeStatusId}
          data-pending={isBusy ? 'true' : undefined}
        >
          {isBusy ? '自检中…' : '运行录音自检'}
        </Button>
      </div>

      <div id={smokeStatusId} className="settingsNotice" data-tone={smoke.status === 'error' ? undefined : 'passive'} role="status">
        {smoke.message}
      </div>

      <div className="settingsFeatureStatusHeroHeading">
        <h3>当前边界</h3>
      </div>
      <ul className="settingsFeatureStatusList" aria-label="语音能力边界说明">
        <li>录音样本只在本机内存里用于计算时长和大小；自检结束后立即停止采集并丢弃样本。</li>
        <li>配置语音转写模型之前，不会把音频传给任何云端服务。</li>
        <li>转写文本只进入消息输入框草稿；用户发送前必须能编辑。</li>
      </ul>
    </section>
  );
}

async function readBrowserMicrophonePermission(): Promise<VoicePermissionStatus> {
  const query = (navigator.permissions as { query?: (descriptor: { name: string }) => Promise<{ state: string }> } | undefined)?.query;
  if (!query) return 'unknown';
  try {
    const result = await query.call(navigator.permissions, { name: 'microphone' });
    if (result.state === 'granted') return 'granted';
    if (result.state === 'denied') return 'denied';
    if (result.state === 'prompt') return 'not_determined';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

function classifyVoicePermissionError(error: unknown): VoicePermissionStatus {
  const name = error instanceof DOMException ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied';
  if (name === 'NotFoundError' || name === 'NotReadableError') return 'unsupported';
  return 'unknown';
}

function voicePermissionLabel(status: VoicePermissionStatus): string {
  switch (status) {
    case 'granted': return '已授权';
    case 'denied': return '已拒绝';
    case 'restricted': return '受系统限制';
    case 'not_determined': return '待授权';
    case 'unsupported': return '不支持';
    case 'unknown': return '未知';
  }
}

function voiceValidationCopy(reason: string): string {
  switch (reason) {
    case 'duration_exceeded': return '录音超过时长上限。';
    case 'audio_too_large': return '录音样本超过大小上限。';
    case 'invalid_audio_shape': return '录音格式不符合当前采集契约。';
    case 'permission_not_granted': return '麦克风权限未授予。';
    default: return '语音采集自检未通过。';
  }
}

function formatVoiceDuration(durationMs: number): string {
  return `${Math.max(0, durationMs / 1000).toFixed(1)} 秒`;
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
