import { normalizeSearchUrl } from '@maka/core';
import { previewVariants } from '../primitives/chat.js';
import { redactSecrets } from '../redact.js';
import { cn } from '../ui.js';

/**
 * PR-CHAT-WEB-SEARCH-RENDER-0 — plain-text card list for the gated
 * WebSearch agent tool result. Matches the Settings → 联网搜索 live-query
 * verification layout so the user gets the same shape whether the search came
 * from a manual verification run or the agent. Never renders markdown / HTML;
 * each cell is `redactSecrets`'d as a belt-and-braces guard against
 * a provider response that happened to echo a token.
 */
export function WebSearchPreview(props: {
  query: string;
  provider: string;
  rows: ReadonlyArray<{ title: string; url: string; snippet: string; source: string }>;
}) {
  const rows = props.rows
    .map((row) => {
      const normalizedUrl = normalizeSearchUrl(row.url);
      if (!normalizedUrl.ok) return null;
      return { ...row, url: redactSecrets(normalizedUrl.value) };
    })
    .filter((row): row is { title: string; url: string; snippet: string; source: string } => row !== null);

  if (rows.length === 0) {
    return (
      <div className={cn(previewVariants({ part: 'overlay' }), previewVariants({ part: 'web-search' }))} data-kind="web_search">
        <header>
          <strong>{redactSecrets(props.query)}</strong>
          <small>{props.provider} · 没有结果</small>
        </header>
      </div>
    );
  }
  return (
    <div className={cn(previewVariants({ part: 'overlay' }), previewVariants({ part: 'web-search' }))} data-kind="web_search">
      <header>
        <strong>{redactSecrets(props.query)}</strong>
        <small>
          {props.provider} · {rows.length} 条结果
        </small>
      </header>
      <ul>
        {rows.map((row, idx) => (
          <li key={`${row.url}-${idx}`}>
            <a href={row.url} target="_blank" rel="noreferrer noopener">
              {redactSecrets(row.title)}
            </a>
            <small>{redactSecrets(row.source)}</small>
            <p>{redactSecrets(row.snippet)}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function WebSearchErrorPreview(props: {
  query?: string;
  provider: string;
  reason: string;
  message: string;
  credentialSource?: string;
}) {
  const sourceCopy =
    props.credentialSource === 'env'
      ? '环境变量'
      : props.credentialSource === 'saved'
        ? '本机已保存 key'
        : props.credentialSource === 'none'
          ? '未配置'
          : '来源未知';
  const repairCopy =
    props.reason === 'invalid_credentials' && props.credentialSource === 'env'
      ? '请检查 TAVILY_API_KEY / MAKA_TAVILY_API_KEY 后重启。'
      : props.reason === 'invalid_credentials'
        ? '请在 设置 · 联网搜索 中更新 Tavily key。'
        : props.reason === 'rate_limited'
          ? 'Tavily 当前限流，请稍后重试或更换可用凭据。'
          : props.reason === 'not_configured'
            ? '请先完成联网搜索配置后再重试。'
            : props.reason === 'timeout'
              ? '请求超时，请稍后重试。'
              : props.reason === 'incognito_active'
                ? '隐私模式下不会发起联网搜索。'
                : '请检查网络或稍后重试。';
  return (
    <div className={cn(previewVariants({ part: 'overlay' }), previewVariants({ part: 'web-search' }), previewVariants({ part: 'web-search-error' }))} data-kind="web_search_error">
      <header>
        <strong>{redactSecrets(props.query ?? '联网搜索')}</strong>
        <small>{redactSecrets(props.provider)} · 搜索失败 · {sourceCopy}</small>
      </header>
      <p className={previewVariants({ part: 'web-search-error-message' })}>{redactSecrets(props.message)}</p>
      <p className={previewVariants({ part: 'web-search-error-repair' })}>{repairCopy}</p>
    </div>
  );
}
