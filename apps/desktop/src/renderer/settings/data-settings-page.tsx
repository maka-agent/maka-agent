import { useEffect, useState } from 'react';
import type { ConfigCategory } from '@maka/storage';
import {
  Button,
  SettingsSelect,
  SettingsSwitch as Switch,
  clearGlobalInputHistory,
  useMountedRef,
  useToast,
  useUiLocale,
} from '@maka/ui';
import { openPathFailureCopy, openPathActionLabel } from '../open-path';
import { SettingsRows, SettingRow } from './settings-rows';
import { settingsActionErrorMessage } from './settings-error-copy';
import { useActionGuard } from './use-action-guard';

const CONFIG_CATEGORY_OPTIONS: ReadonlyArray<{
  id: ConfigCategory;
  label: string;
  detail: string;
  sensitive?: boolean;
}> = [
  {
    id: 'connections',
    label: '模型连接',
    detail: '供应商连接与默认模型（不含密钥）',
  },
  {
    id: 'settings',
    label: '应用设置',
    detail: '常规、搜索、机器人、代理等设置',
  },
  { id: 'memory', label: '本地记忆', detail: '本机 MEMORY.md 的内容' },
  {
    id: 'credentials',
    label: '凭据（API 密钥、令牌）',
    detail: '模型密钥与订阅令牌等敏感信息',
    sensitive: true,
  },
];

type ConfigImportResult = Extract<Awaited<ReturnType<typeof window.maka.config.import>>, { ok: true }>['result'];

function summarizeImportResult(result: ConfigImportResult): string {
  const parts: string[] = [];
  const conn = result.connections;
  if (conn) parts.push(`连接 新增${conn.created}·覆盖${conn.overwritten}·跳过${conn.skipped}`);
  if (result.settings?.applied) parts.push('设置已应用');
  if (result.credentials) {
    const cred = result.credentials;
    parts.push(cred.skipped > 0 ? `凭据 ${cred.applied}（跳过 ${cred.skipped}）` : `凭据 ${cred.applied}`);
  }
  if (result.memory?.applied) parts.push('记忆已应用');
  return parts.join(' · ') || '文件不含可导入的内容';
}

export function DataSettingsPage() {
  const locale = useUiLocale();
  const [info, setInfo] = useState<Awaited<ReturnType<typeof window.maka.app.info>> | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [pendingDataAction, setPendingDataAction] = useState<string | null>(null);
  const dataActionGuard = useActionGuard<string>();
  const dataPageMountedRef = useMountedRef();
  const toast = useToast();
  const [selectedCategories, setSelectedCategories] = useState<Set<ConfigCategory>>(
    () => new Set<ConfigCategory>(['connections', 'settings']),
  );
  const [importStrategy, setImportStrategy] = useState<'skip' | 'overwrite'>('skip');
  const [configBusy, setConfigBusy] = useState<null | 'export' | 'import'>(null);

  useEffect(() => {
    let cancelled = false;
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
    };
  }, [toast]);

  async function runDataAction(action: string, run: () => Promise<void>) {
    if (!dataActionGuard.begin(action)) return;
    setPendingDataAction(action);
    try {
      await run();
    } finally {
      dataActionGuard.finish();
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
          toast.error(
            `无法打开${openPathActionLabel('workspace', locale)}`,
            openPathFailureCopy(result.reason, locale),
          );
        }
      } catch (error) {
        if (dataPageMountedRef.current) {
          toast.error(`无法打开${openPathActionLabel('workspace', locale)}`, settingsActionErrorMessage(error));
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

  function toggleCategory(id: ConfigCategory) {
    setSelectedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function exportConfig() {
    if (configBusy) return;
    const categories = [...selectedCategories];
    if (categories.length === 0) {
      toast.error('请至少选择一个类别');
      return;
    }
    setConfigBusy('export');
    try {
      const res = await window.maka.config.export({ categories });
      if (res.ok) {
        toast.success('已导出配置', `包含：${res.includedData.join('、')}`);
      } else if (res.reason !== 'canceled') {
        toast.error('导出失败', res.reason === 'no_categories' ? '未选择任何类别' : '请稍后重试');
      }
    } catch (error) {
      toast.error('导出失败', settingsActionErrorMessage(error));
    } finally {
      setConfigBusy(null);
    }
  }

  async function importConfig() {
    if (configBusy) return;
    setConfigBusy('import');
    try {
      const res = await window.maka.config.import({ strategy: importStrategy });
      if (res.ok) {
        toast.success('已导入配置', summarizeImportResult(res.result));
      } else if (res.reason !== 'canceled') {
        toast.error('导入失败', res.message ?? '文件无效或版本不受支持。');
      }
    } catch (error) {
      toast.error('导入失败', settingsActionErrorMessage(error));
    } finally {
      setConfigBusy(null);
    }
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
      {/* Detail audit: was two wrapped rows with 打开文件夹 wearing primary
          (a utility action) and destructive 清空输入历史 dressed neutral.
          One row; utilities are secondary; the destructive action reads
          destructive (red outline family, same recipe as the permission
          dialog confirm). */}
      <div className="settingsActionRow" role="group" aria-label="工作区数据操作">
        <Button
          type="button"
          variant="secondary"
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
        <Button
          type="button"
          variant="destructive"
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

      <section className="settingsAboutPrivacy" aria-label="配置导入导出">
        <h3>配置导入导出</h3>
        <p className="settingsHelpText">
          勾选要导出的内容，生成一个 JSON 备份文件；换机或重装时可再导入。默认不含密钥。
        </p>
        <div role="group" aria-label="选择导出内容" className="settingsConfigCategoryList">
          {CONFIG_CATEGORY_OPTIONS.map((option) => {
            const checked = selectedCategories.has(option.id);
            return (
              <div key={option.id} className="settingsConfigCategoryItem">
                <Switch
                  ariaLabel={`导出${option.label}`}
                  checked={checked}
                  onChange={() => toggleCategory(option.id)}
                />
                <span>
                  <strong>{option.label}</strong>
                  <small>{option.detail}</small>
                  {option.sensitive && checked ? (
                    <small role="alert" data-tone="destructive">
                      ⚠️ 密钥将以明文写入导出文件。任何拿到该文件的人都能使用这些密钥，请妥善保管、不要分享。
                    </small>
                  ) : null}
                </span>
              </div>
            );
          })}
        </div>
        <div className="settingsConfigStrategy">
          <span className="settingsHelpText">导入时同名连接：</span>
          <SettingsSelect
            value={importStrategy}
            ariaLabel="导入时同名连接的处理方式"
            options={
              [
              ['skip', '跳过'],
              ['overwrite', '覆盖'],
              ] satisfies Array<readonly [typeof importStrategy, string]>
            }
            onChange={(strategy) => setImportStrategy(strategy)}
          />
        </div>
        <div className="settingsActionRow">
          <Button type="button" disabled={configBusy !== null} onClick={() => void exportConfig()}>
            {configBusy === 'export' ? '导出中…' : '导出配置…'}
          </Button>
          <Button type="button" disabled={configBusy !== null} onClick={() => void importConfig()}>
            {configBusy === 'import' ? '导入中…' : '导入配置…'}
          </Button>
        </div>
      </section>
    </div>
  );
}
