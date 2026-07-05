import { useEffect, useRef, useState } from 'react';
import { Button, clearGlobalInputHistory, useToast } from '@maka/ui';
import { openPathFailureCopy, openPathActionLabel } from '../open-path';
import { SettingsRows, SettingRow } from './settings-rows';
import { settingsActionErrorMessage } from './settings-error-copy';

export function DataSettingsPage() {
  const [info, setInfo] = useState<Awaited<ReturnType<typeof window.maka.app.info>> | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [pendingDataAction, setPendingDataAction] = useState<string | null>(null);
  const pendingDataActionRef = useRef<string | null>(null);
  const dataPageMountedRef = useRef(false);
  const toast = useToast();

  useEffect(() => {
    let cancelled = false;
    dataPageMountedRef.current = true;
    void window.maka.app.info().then((next) => {
      if (!cancelled) {
        setInfo(next);
        setInfoError(null);
      }
    }).catch((error) => {
      if (cancelled) return;
      const message = settingsActionErrorMessage(error);
      setInfo(null);
      setInfoError(message);
      toast.error('载入数据目录失败', message);
    });
    return () => {
      cancelled = true;
      dataPageMountedRef.current = false;
      pendingDataActionRef.current = null;
    };
  }, [toast]);

  async function runDataAction(action: string, run: () => Promise<void>) {
    if (pendingDataActionRef.current) return;
    pendingDataActionRef.current = action;
    setPendingDataAction(action);
    try {
      await run();
    } finally {
      pendingDataActionRef.current = null;
      if (dataPageMountedRef.current) {
        setPendingDataAction(null);
      }
    }
  }

  const isDataActionPending = (action: string) => pendingDataAction === action;
  const dataActionDisabled = Boolean(pendingDataAction);

  async function openWorkspace() {
    if (!info) return;
    await runDataAction('workspace:open', async () => {
      try {
        const result = await window.maka.app.openPath('workspace');
        if (!dataPageMountedRef.current) return;
        if (!result.ok) {
          toast.error(`无法打开${openPathActionLabel('workspace')}`, openPathFailureCopy(result.reason));
        }
      } catch (error) {
        if (dataPageMountedRef.current) {
          toast.error(`无法打开${openPathActionLabel('workspace')}`, settingsActionErrorMessage(error));
        }
      }
    });
  }

  async function copyPath() {
    if (!info) return;
    await runDataAction('workspace:path:copy', async () => {
      try {
        await navigator.clipboard.writeText(info.workspacePath);
        if (dataPageMountedRef.current) {
          toast.success('已复制工作区路径');
        }
      } catch {
        if (dataPageMountedRef.current) {
          toast.error('复制失败', '剪贴板不可用或被系统拒绝。');
        }
      }
    });
  }

  async function clearInputHistory() {
    await runDataAction('input-history:clear', async () => {
      clearGlobalInputHistory();
      if (dataPageMountedRef.current) {
        toast.success('已清空输入历史', '已发送的提示词记录已从本机移除。');
      }
    });
  }

  return (
    <div className="settingsStructuredPage">
      <SettingsRows>
        <SettingRow
          title="工作区路径"
          detail="会话、设置、凭据和技能文件都存在这个目录下。"
          value={info?.workspacePath ?? (infoError ? '载入失败' : '正在加载…')}
          mono
        />
        <SettingRow
          title="存储引擎"
          detail="会话记录、外观与账号设置、本地使用统计，以及本机凭据文件。"
          value="本地文件"
        />
        <SettingRow
          title="输入历史"
          detail="上箭头 / 下箭头调出的已发送提示词记录，保存在浏览器本地存储里，跨重启保留。清空后无法恢复。"
          value="本机 localStorage"
        />
      </SettingsRows>
      <div className="settingsActionRow" role="group" aria-label="工作区数据操作">
        <Button
          type="button"
          onClick={() => void openWorkspace()}
          disabled={!info || dataActionDisabled}
        >
          {isDataActionPending('workspace:open') ? '打开中…' : '打开工作区文件夹'}
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={() => void copyPath()}
          disabled={!info || dataActionDisabled}
        >
          {isDataActionPending('workspace:path:copy') ? '复制中…' : '复制路径'}
        </Button>
      </div>
      <div className="settingsActionRow" role="group" aria-label="输入历史操作">
        <Button
          type="button"
          variant="secondary"
          onClick={() => void clearInputHistory()}
          disabled={dataActionDisabled}
        >
          {isDataActionPending('input-history:clear') ? '清空中…' : '清空输入历史'}
        </Button>
      </div>
      <div className="settingsNotice">
        本机数据保存在工作区。需要备份时先退出 Maka，再复制整个目录；恢复时替换同一路径后重启。
        模型连接凭据随工作区恢复后需要重新测试；订阅账号令牌通常需要重新登录。
      </div>
      {infoError && (
        <div className="settingsNotice" role="alert">
          无法载入工作区路径：{infoError}
        </div>
      )}
    </div>
  );
}
