import { useRef, useState } from 'react';
import type { AppSettings, UpdateAppSettingsResult, WebSearchCredentialStatus } from '@maka/core';
import { normalizeSearchUrl, webSearchCredentialStatusFromResponse } from '@maka/core';
import { Button, Chip, Input, RelativeTime, SettingsSwitch as Switch, redactSecrets, useMountedRef, useToast } from '@maka/ui';
import { PasswordInput } from './password-input';
import { settingsActionErrorMessage } from './settings-error-copy';
import { SettingsRows } from './settings-rows';
import { useKeyedActionGuard } from './use-action-guard';

/**
 * PR-WEB-SEARCH-TAVILY-0: Settings → 联网搜索.
 *
 * Current provider support is Tavily only. Renderer never sees the cleartext API
 * key — `props.settings.webSearch.providers.tavily.apiKey` arrives
 * pre-masked from the IPC store boundary (the bullet sentinel
 * `MASKED_TOKEN_SENTINEL`). Re-submitting the sentinel is treated as
 * "keep current" in `mergeWebSearchSettings`.
 *
 * The "测试" button calls `web-search:test` (main-process Tavily call)
 * and surfaces ok/fail via toast. The live-query verifier runs a real query
 * and renders 3-5 plain-text rows.
 */
export function WebSearchSettingsPage(props: {
  settings: AppSettings;
  onUpdate(patch: Parameters<typeof window.maka.settings.update>[0]): Promise<UpdateAppSettingsResult>;
}) {
  const webSearch = props.settings.webSearch;
  const tavily = webSearch.providers.tavily;
  const tavilyKey = tavily.apiKey;
  const credentialSource = tavily.credentialSource;
  const usingEnvKey = credentialSource === 'env';
  const [draftKey, setDraftKey] = useState('');
  const [pendingWebSearchEnabled, setPendingWebSearchEnabled] = useState(false);
  const [pendingCredentialAction, setPendingCredentialAction] = useState<'save' | 'clear' | null>(null);
  const [testing, setTesting] = useState(false);
  const [liveQuery, setLiveQuery] = useState('');
  const [liveQueryRunning, setLiveQueryRunning] = useState(false);
  const [liveQueryResults, setLiveQueryResults] = useState<readonly { title: string; url: string; snippet: string; source: string }[] | null>(null);
  const [liveQueryError, setLiveQueryError] = useState<string | null>(null);
  const webSearchMountedRef = useMountedRef();
  const webSearchActionGuard = useKeyedActionGuard<'set-enabled' | 'credential' | 'test' | 'live-query'>();
  const liveQueryInputRef = useRef(liveQuery);
  const toast = useToast();

  function updateLiveQuery(next: string) {
    liveQueryInputRef.current = next;
    setLiveQuery(next);
    setLiveQueryError(null);
    setLiveQueryResults(null);
  }

  function isCurrentLiveQuery(queryOwner: string): boolean {
    return webSearchMountedRef.current && liveQueryInputRef.current === queryOwner;
  }

  async function runCredentialAction(action: 'save' | 'clear', run: () => Promise<void>) {
    if (webSearchActionGuard.has('credential') || webSearchActionGuard.has('test')) return;
    const releaseCredential = webSearchActionGuard.begin('credential');
    if (!releaseCredential) return;
    setPendingCredentialAction(action);
    try {
      await run();
    } finally {
      releaseCredential();
      if (webSearchMountedRef.current) {
        setPendingCredentialAction(null);
      }
    }
  }

  async function updateWebSearch(
    patch: NonNullable<Parameters<typeof window.maka.settings.update>[0]['webSearch']>,
    failureTitle = '保存联网搜索设置失败',
  ): Promise<boolean> {
    try {
      await props.onUpdate({ webSearch: patch });
      return true;
    } catch (error) {
      if (webSearchMountedRef.current) {
        toast.error(failureTitle, settingsActionErrorMessage(error));
      }
      return false;
    }
  }

  async function setEnabled(enabled: boolean) {
    const releaseEnabled = webSearchActionGuard.begin('set-enabled');
    if (!releaseEnabled) return;
    setPendingWebSearchEnabled(true);
    try {
      await updateWebSearch({ enabled });
    } finally {
      releaseEnabled();
      if (webSearchMountedRef.current) {
        setPendingWebSearchEnabled(false);
      }
    }
  }

  async function persistCredentialStatus(status: WebSearchCredentialStatus, credentialVersion: number): Promise<boolean> {
    return updateWebSearch(
      {
        providers: {
          tavily: {
            credentialVersion,
            credentialStatus: status,
            credentialCheckedAt: new Date().toISOString(),
          },
        },
      },
      '保存联网搜索状态失败',
    );
  }

  async function saveDraftKey() {
    if (usingEnvKey || draftKey.length === 0) return;
    await runCredentialAction('save', async () => {
      const saved = await updateWebSearch({ providers: { tavily: { apiKey: draftKey } } });
      if (!saved) return;
      if (!webSearchMountedRef.current) return;
      setDraftKey('');
      toast.success('已保存 Tavily 密钥', '可点击「测试」做一次真实请求验证。');
    });
  }

  async function clearKey() {
    await runCredentialAction('clear', async () => {
      const saved = await updateWebSearch({ enabled: false, providers: { tavily: { apiKey: '' } } });
      if (!saved) return;
      if (!webSearchMountedRef.current) return;
      setDraftKey('');
      toast.success('已清空 Tavily 凭据', '联网搜索已自动关闭。');
    });
  }

  async function runTest() {
    if (webSearchActionGuard.has('test') || webSearchActionGuard.has('credential')) return;
    const releaseTest = webSearchActionGuard.begin('test');
    if (!releaseTest) return;
    setTesting(true);
    const usesDraftKey = draftKey.trim().length > 0;
    const testedCredentialVersion = tavily.credentialVersion;
    try {
      const result = await window.maka.webSearch.test({
        provider: 'tavily',
        apiKey: usesDraftKey ? draftKey : undefined,
      });
      if (!webSearchMountedRef.current) return;
      if (!usesDraftKey && hasUsableKey) {
        void persistCredentialStatus(webSearchCredentialStatusFromResponse(result), testedCredentialVersion);
      }
      if (result.ok) {
        toast.success('Tavily 凭据可用', `返回 ${result.results.length} 条结果。`);
      } else {
        toast.error('Tavily 测试失败', result.message);
      }
    } catch (err) {
      if (webSearchMountedRef.current) {
        toast.error('Tavily 测试出错', settingsActionErrorMessage(err));
      }
    } finally {
      releaseTest();
      if (webSearchMountedRef.current) {
        setTesting(false);
      }
    }
  }

  async function runLiveQuery() {
    if (webSearchActionGuard.has('live-query')) return;
    const queryOwner = liveQueryInputRef.current;
    const trimmed = queryOwner.trim();
    if (trimmed.length === 0) return;
    const releaseLiveQuery = webSearchActionGuard.begin('live-query');
    if (!releaseLiveQuery) return;
    setLiveQueryRunning(true);
    setLiveQueryError(null);
    setLiveQueryResults(null);
    const queriedCredentialVersion = tavily.credentialVersion;
    try {
      const result = await window.maka.webSearch.query({
        provider: 'tavily',
        query: trimmed,
        limit: 5,
      });
      if (!isCurrentLiveQuery(queryOwner)) return;
      if (result.ok) {
        setLiveQueryResults(result.results);
        if (hasUsableKey) {
          void persistCredentialStatus('valid', queriedCredentialVersion);
        }
      } else {
        setLiveQueryError(result.message);
        if (hasUsableKey) {
          void persistCredentialStatus(webSearchCredentialStatusFromResponse(result), queriedCredentialVersion);
        }
      }
    } catch (err) {
      if (isCurrentLiveQuery(queryOwner)) {
        setLiveQueryError(settingsActionErrorMessage(err));
      }
    } finally {
      releaseLiveQuery();
      if (webSearchMountedRef.current) {
        setLiveQueryRunning(false);
      }
    }
  }

  const hasStoredKey = tavilyKey.length > 0;
  const hasUsableKey = hasStoredKey || usingEnvKey;
  const statusCopy = presentWebSearchCredentialStatus(
    credentialSource,
    webSearch.enabled,
    tavily.credentialStatus,
  );
  const queryDisabledReason = webSearchQueryDisabledReason({
    hasUsableKey,
    enabled: webSearch.enabled,
    query: liveQuery,
  });
  const checkedAtMs = tavily.credentialCheckedAt
    ? Date.parse(tavily.credentialCheckedAt)
    : Number.NaN;
  const hasCheckedAt = Number.isFinite(checkedAtMs);
  const credentialActionBusy = pendingCredentialAction !== null || testing;

  return (
    <div className="settingsStructuredPage">
      <SettingsRows className="settingsWebSearchCredentialCard">
        <div className="settingsRow settingsWebSearchEnableRow">
          <div>
            <strong>启用联网搜索</strong>
            <small>开关启用后，界面里显式触发的查询才会真的请求 Tavily。模型不会自动调用。</small>
          </div>
          <div className="settingsWebSearchControlCluster">
            <div className="settingsWebSearchStatusCluster" role="group" aria-label="联网搜索凭据状态">
              <Chip variant={statusCopy.tone}>
                {statusCopy.label}
              </Chip>
              {hasCheckedAt && (
                <small>
                  最近测试 <RelativeTime ts={checkedAtMs} />
                </small>
              )}
              <small>{presentWebSearchCredentialSource(credentialSource, hasStoredKey)}</small>
            </div>
            <Switch
              ariaLabel="启用联网搜索"
              checked={webSearch.enabled}
              disabled={!hasUsableKey || pendingWebSearchEnabled}
              onChange={(enabled) => void setEnabled(enabled)}
            />
          </div>
        </div>

        <div className="settingsRow settingsWebSearchKeyRow">
          <div>
            <strong>Tavily 密钥</strong>
            <small>
              {usingEnvKey
                ? '当前使用环境变量 TAVILY_API_KEY / MAKA_TAVILY_API_KEY；如需改用保存的密钥，请移除环境变量后重启。'
                : <>保存在主进程设置中，渲染器永远看不到明文。在 <a href="https://tavily.com" target="_blank" rel="noreferrer noopener">tavily.com</a> 申请。</>}
            </small>
          </div>
          <PasswordInput
            value={draftKey}
            onChange={setDraftKey}
            disabled={usingEnvKey || credentialActionBusy}
            placeholder={usingEnvKey ? '由环境变量提供' : hasStoredKey ? '已保存（输入新密钥可替换）' : 'tvly-xxxxxxxx'}
            ariaLabel="Tavily 密钥"
          />
        </div>

        <div className="settingsRow settingsWebSearchCredentialActionRow">
          <div>
            <strong>凭据操作</strong>
            <small>保存后可以测试一次真实请求；清空凭据会同步关闭联网搜索。</small>
          </div>
          <div className="settingsActionRow settingsWebSearchActionButtons">
            <Button
              type="button"
              disabled={credentialActionBusy || usingEnvKey || draftKey.length === 0}
              onClick={() => void saveDraftKey()}
            >
              {pendingCredentialAction === 'save' ? '保存中…' : '保存密钥'}
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={credentialActionBusy || (draftKey.length === 0 && !hasUsableKey)}
              onClick={() => void runTest()}
            >
              {testing ? '测试中…' : '测试凭据'}
            </Button>
            {hasStoredKey && (
              <Button
                type="button"
                variant="ghost"
                disabled={credentialActionBusy}
                onClick={() => void clearKey()}
              >
                {pendingCredentialAction === 'clear' ? '清空中…' : '清空密钥'}
              </Button>
            )}
          </div>
        </div>
      </SettingsRows>

      <SettingsRows className="settingsWebSearchQueryCard">
        <div className="settingsRow settingsWebSearchQueryIntroRow">
          <div>
            <strong>真实查询验证</strong>
            <small>直接发一条真实查询，看到 Tavily 返回的标题 / 摘要 / 来源域名。结果只显示在此页面，不写入会话也不写入遥测。</small>
          </div>
        </div>
        <div className="settingsRow settingsWebSearchQueryInputRow">
          <div>
            <strong>查询</strong>
            <small>输入一条用于验证联网搜索配置的真实请求。</small>
          </div>
          <Input
            value={liveQuery}
            onChange={(event) => updateLiveQuery(event.currentTarget.value)}
            placeholder="例如：本周 AI 产品发布动态"
            aria-label="联网搜索真实查询"
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !liveQueryRunning) {
                event.preventDefault();
                void runLiveQuery();
              }
            }}
          />
        </div>
        <div className="settingsRow settingsWebSearchSearchRow">
          <div>
            <strong>执行查询</strong>
            <small>按钮可用时会走主进程 Tavily 请求并刷新下方结果。</small>
          </div>
          <div className="settingsWebSearchSearchControls">
            <Button
              type="button"
              disabled={liveQueryRunning || queryDisabledReason !== null}
              onClick={() => void runLiveQuery()}
            >
              {liveQueryRunning ? '搜索中…' : '搜索'}
            </Button>
            {!liveQueryRunning && queryDisabledReason && (
              <small className="settingsWebSearchDisabledReason">
                {queryDisabledReason}
              </small>
            )}
          </div>
        </div>
      </SettingsRows>

      {liveQueryError && (
        <div className="settingsConnectionMeta" role="alert">
          <span>查询失败：{liveQueryError}</span>
        </div>
      )}
      {(() => {
        // PR-SETTINGS-WEB-SEARCH-URL-HARDEN-0: match the chat-side
        // WebSearchPreview hardening (xuan `e511aa5`): the renderer
        // does NOT trust raw URLs / text coming back over IPC even
        // though the main-process Tavily client filters first. Drop
        // non-http(s) / malformed rows and redact every text cell
        // before it reaches the DOM.
        const safeRows: ReadonlyArray<{ title: string; url: string; source: string; snippet: string }> | null =
          liveQueryResults
            ? liveQueryResults
                .map((row) => {
                  const normalized = normalizeSearchUrl(row.url);
                  if (!normalized.ok) return null;
                  return {
                    title: redactSecrets(row.title),
                    url: redactSecrets(normalized.value),
                    source: redactSecrets(row.source),
                    snippet: redactSecrets(row.snippet),
                  };
                })
                .filter(
                  (
                    row,
                  ): row is { title: string; url: string; source: string; snippet: string } =>
                    row !== null,
                )
            : null;
        if (safeRows && safeRows.length === 0 && !liveQueryError) {
          return <div className="settingsConnectionMeta">没有结果。</div>;
        }
        if (safeRows && safeRows.length > 0) {
          return (
            <ul className="settingsWebSearchResults" aria-label="联网搜索真实查询结果">
              {safeRows.map((row, idx) => (
                <li key={`${row.url}-${idx}`} className="settingsWebSearchResult">
                  <a href={row.url} target="_blank" rel="noreferrer noopener">{row.title}</a>
                  <small>{row.source}</small>
                  <p>{row.snippet}</p>
                </li>
              ))}
            </ul>
          );
        }
        return null;
      })()}
    </div>
  );
}

function webSearchQueryDisabledReason(input: { hasUsableKey: boolean; enabled: boolean; query: string }): string | null {
  if (!input.hasUsableKey) return '先保存 Tavily 密钥，或设置 TAVILY_API_KEY 环境变量';
  if (!input.enabled) return '先启用联网搜索';
  if (input.query.trim().length === 0) return '输入查询后再搜索';
  return null;
}

function presentWebSearchCredentialStatus(
  credentialSource: AppSettings['webSearch']['providers']['tavily']['credentialSource'],
  enabled: boolean,
  status: WebSearchCredentialStatus,
): { label: string; tone: 'success' | 'info' | 'warning' | 'destructive' } {
  if (credentialSource === 'none') return { label: '等待保存密钥', tone: 'warning' };
  if (status === 'valid') {
    return enabled
      ? { label: '已验证 · 已启用', tone: 'success' }
      : { label: '已验证 · 未启用', tone: 'info' };
  }
  if (status === 'invalid_credentials') return { label: '密钥无效', tone: 'destructive' };
  if (status === 'rate_limited') return { label: 'Tavily 限流', tone: 'warning' };
  if (status === 'timeout') return { label: '测试超时', tone: 'warning' };
  if (status === 'network_error') return { label: '网络异常', tone: 'warning' };
  if (status === 'not_configured') return { label: '等待配置', tone: 'warning' };
  return enabled
    ? { label: '未测试 · 已启用', tone: 'warning' }
    : { label: '未测试', tone: 'info' };
}

function presentWebSearchCredentialSource(
  credentialSource: AppSettings['webSearch']['providers']['tavily']['credentialSource'],
  hasStoredKey: boolean,
): string {
  if (credentialSource === 'env') {
    return hasStoredKey ? '来源：环境变量（已保存密钥备用）' : '来源：环境变量';
  }
  if (credentialSource === 'saved') return '来源：本机已保存密钥';
  return '来源：未配置';
}
