import { useEffect, useId, useRef, useState } from 'react';
import { Sparkles } from '@maka/ui/icons';
import { Button, useToast } from '@maka/ui';
import { SettingsRows, SettingRow } from './settings-rows';
import { settingsActionErrorMessage } from './settings-error-copy';
import { SettingsSkeletonStack } from './settings-skeleton';

type AppInfo = Awaited<ReturnType<typeof window.maka.app.info>>;

const PLATFORM_LABEL: Record<string, string> = {
  darwin: 'macOS',
  win32: 'Windows',
  linux: 'Linux',
};

export function AboutSettingsPage() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [copyingEnvSummary, setCopyingEnvSummary] = useState(false);
  const copyingEnvSummaryRef = useRef(false);
  const aboutPageMountedRef = useRef(false);
  const toast = useToast();
  const envSummaryHelpId = useId();

  useEffect(() => {
    let cancelled = false;
    aboutPageMountedRef.current = true;
    window.maka.app
      .info()
      .then((next) => {
        if (!cancelled) {
          setInfo(next);
          setInfoError(null);
        }
      })
      .catch((error) => {
        if (cancelled) return;
        const message = settingsActionErrorMessage(error);
        setInfoError(message);
        toast.error('载入关于信息失败', message);
    });
    return () => {
      cancelled = true;
      aboutPageMountedRef.current = false;
      copyingEnvSummaryRef.current = false;
    };
  }, [toast]);

  if (!info && !infoError) {
    return (
      <SettingsSkeletonStack
        label="正在加载关于页"
        lines={[
          { width: '38%', size: 'lg' },
          { width: '70%' },
          { width: '52%' },
        ]}
      />
    );
  }

  if (!info) {
    return (
      <div className="settingsStructuredPage">
        <div className="settingsNotice" role="alert">
          <strong>无法载入关于信息</strong>
          <small>{infoError}</small>
        </div>
      </div>
    );
  }

  const platformPretty = PLATFORM_LABEL[info.platform] ?? info.platform;
  const platformLine = `${platformPretty} ${info.osRelease} · ${info.arch}`;

  async function copyEnvSummary() {
    if (!info) return;
    if (copyingEnvSummaryRef.current) return;
    copyingEnvSummaryRef.current = true;
    setCopyingEnvSummary(true);
    // Markdown block ready to paste into a problem report. Deliberately excludes
    // workspacePath since that can leak the OS username; user can still copy
    // it from the Data page if needed.
    const buildLine =
      info.buildMode === 'dev'
        ? `- Build: dev${info.buildCommit ? ` @ ${info.buildCommit}` : ''}`
        : '- Build: packaged';
    const summary = [
      `**Maka** v${info.appVersion}`,
      ``,
      `- Electron: ${info.electronVersion}`,
      `- Node: ${info.nodeVersion}`,
      `- Chrome: ${info.chromeVersion}`,
      `- Platform: ${platformPretty} ${info.osRelease}`,
      `- Arch: ${info.arch}`,
      buildLine,
    ].join('\n');
    try {
      await navigator.clipboard.writeText(summary);
      if (aboutPageMountedRef.current) {
        toast.success('已复制环境信息', '可直接粘贴到问题报告');
      }
    } catch {
      if (aboutPageMountedRef.current) {
        toast.error('复制失败', '剪贴板不可用或被系统拒绝。');
      }
    } finally {
      copyingEnvSummaryRef.current = false;
      if (aboutPageMountedRef.current) {
        setCopyingEnvSummary(false);
      }
    }
  }

  return (
    <div className="settingsAboutPage">
      <header className="settingsAboutHero">
        <span className="settingsAboutLogo" aria-hidden="true">
          <Sparkles size={26} />
        </span>
        <div>
          <div className="settingsAboutHeading">
            <h2>Maka</h2>
            <span className="settingsAboutVersion">v{info.appVersion}</span>
            <span className="settingsAboutChannel">
              {info.buildMode === 'dev'
                ? info.buildCommit
                  ? `本地开发版 · ${info.buildCommit}`
                  : '本地开发版'
                : '正式版'}
            </span>
          </div>
          <p className="settingsAboutTagline">本地优先的 AI 助手 · 桌面端运行环境</p>
        </div>
      </header>

      <section className="settingsAboutPrivacy" aria-label="隐私与安全">
        <h3>本地优先 · 隐私默认</h3>
        <ul aria-label="隐私与安全说明">
          <li>所有会话、设置、凭据和 Skill 指令文件都保留在本机工作区，不上传到 Maka 服务器</li>
          <li>模型供应商密钥保存在本机凭据文件内，依赖系统账号与文件权限；订阅账号令牌使用系统安全存储</li>
          <li>Maka 不发送任何使用遥测；只在你显式启用时与所选模型供应商通信</li>
          <li>权限策略会判断工具调用风险；高危操作需要在对话内明示授权</li>
          <li>每个会话都会在本机保留消息、工具调用、权限决策与模式变更记录</li>
        </ul>
      </section>

      <SettingsRows>
        <SettingRow
          title="运行时"
          detail="界面层、桌面运行时和本地 Node 版本号一并显示。"
          value={`Electron ${info.electronVersion} · Node ${info.nodeVersion} · Chrome ${info.chromeVersion}`}
        />
        <SettingRow title="平台" detail="操作系统、版本和 CPU 架构。" value={platformLine} />
        <SettingRow
          title="工作区"
          detail="会话、设置和凭据全部留在本地这条路径下。"
          value={info.workspacePath}
          mono
        />
        <SettingRow
          title="存储"
          detail="会话记录、设置文件、SQLite 使用统计、本机凭据文件和订阅账号安全存储。"
          value="本地"
        />
      </SettingsRows>

      <div className="settingsActionRow">
        <Button type="button" disabled={copyingEnvSummary} aria-describedby={envSummaryHelpId} onClick={() => void copyEnvSummary()}>
          {copyingEnvSummary ? '复制中…' : '复制环境信息'}
        </Button>
      </div>
      <p id={envSummaryHelpId} className="settingsHelpText">
        如果遇到问题，复制以上信息会同时带上版本号与平台细节，方便定位。复制内容不包含工作区路径（避免泄露用户名）。
      </p>
    </div>
  );
}
