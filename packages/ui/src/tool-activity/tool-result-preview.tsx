import { normalizeSearchUrl, type ToolResultContent } from '@maka/core';
import { Check, Copy } from '../icons.js';
import { useClipboardCopyFeedback } from '../clipboard-feedback.js';
import { previewVariants } from '../primitives/chat.js';
import { redactSecrets } from '../redact.js';
import { Button as UiButton, cn } from '../ui.js';
import { ExploreAgentPreview, SubagentPreview } from './agent-preview.js';
import { TOOL_LINE_CAP, capLines, formatUserVisibleToolText } from './preview-utils.js';

/** Routes persisted tool results to bounded, kind-specific preview cards. */
export function ToolResultPreview(props: { content: ToolResultContent }) {
  const { content } = props;

  if (content.kind === 'file_diff') {
    return <FileDiffPreview diff={content.diff} paths={content.paths} />;
  }

  if (content.kind === 'web_search') {
    return (
      <WebSearchPreview query={content.query} provider={content.provider} rows={content.rows} />
    );
  }

  if (content.kind === 'web_search_error') {
    return (
      <WebSearchErrorPreview
        query={content.query}
        provider={content.provider}
        reason={content.reason}
        message={content.message}
        credentialSource={content.credentialSource}
      />
    );
  }

  if (content.kind === 'terminal') {
    return (
      <TerminalPreview
        cwd={content.cwd}
        cmd={content.cmd}
        exitCode={content.exitCode}
        stdout={content.stdout}
        stderr={content.stderr}
      />
    );
  }

  if (content.kind === 'office_document') {
    return <OfficeDocumentPreview result={content} />;
  }

  if (content.kind === 'explore_agent') {
    return <ExploreAgentPreview result={content} />;
  }

  if (content.kind === 'subagent') {
    return <SubagentPreview result={content} />;
  }

  if (content.kind === 'rive_workflow') {
    return <RiveWorkflowPreview result={content} />;
  }

  if (content.kind === 'json') {
    let body: string;
    try {
      body = JSON.stringify(content.value, null, 2);
    } catch {
      body = String(content.value);
    }
    // JSON shouldn't contain secrets persisted by Maka (settings + telemetry
    // are sanitized at write-time), but apply the renderer redactor as a
    // second-layer defense in case a tool returned raw provider response.
    return <pre className={previewVariants({ part: 'overlay' })} data-kind="json">{formatUserVisibleToolText(redactSecrets(body))}</pre>;
  }

  if (content.kind === 'text') {
    const { body, capped } = capLines(formatUserVisibleToolText(redactSecrets(content.text)));
    return (
      <pre className={previewVariants({ part: 'overlay' })} data-kind="text">
        {body}
        {capped > 0 && `\n\n… 已隐藏 ${capped} 行`}
      </pre>
    );
  }

  // file_write / image / summary / unknown — show a compact descriptor so the
  // user knows what kind landed without dumping binary or storage refs.
  return (
    <pre className={previewVariants({ part: 'overlay' })} data-kind={content.kind}>
      [{content.kind}]
    </pre>
  );
}

/**
 * Line-level diff coloring. Splits the unified-diff text on newlines and
 * tags each line with `data-line="add" | "del" | "hunk" | "meta" | "ctx"`
 * for CSS to color. Doesn't try to parse the hunk semantics — we leave
 * that to a future inline editor view; this is just a readable preview.
 */
function FileDiffPreview(props: { diff: string; paths: string[] }) {
  // Apply UI-level redaction then cap the displayed lines. Both are
  // @kenji's PR76 review items: never echo a token a tool happened to dump
  // into a diff (commit body, .env file diff, etc.), and never let a
  // 10k-line diff create 10k React elements.
  const { body, capped } = capLines(redactSecrets(props.diff));
  const lines = body.split('\n');
  return (
    <div className={cn(previewVariants({ part: 'overlay' }), previewVariants({ part: 'diff' }))} data-kind="file_diff">
      {props.paths.length > 0 && (
        <div className={previewVariants({ part: 'diff-paths' })}>
          {props.paths.map((path) => (
            <code key={path}>{path}</code>
          ))}
        </div>
      )}
      <pre className={previewVariants({ part: 'diff-body' })}>
        {lines.map((line, index) => (
          <span
            key={`${index}:${line.slice(0, 16)}`}
            className={previewVariants({ part: 'diff-line' })}
            data-line={diffLineKind(line)}
          >
            {line || ' '}
            {'\n'}
          </span>
        ))}
        {capped > 0 && (
          <span className={previewVariants({ part: 'diff-line' })} data-line="meta">
            {`\n… 已隐藏 ${capped} 行\n`}
          </span>
        )}
      </pre>
    </div>
  );
}

function diffLineKind(line: string): 'add' | 'del' | 'hunk' | 'meta' | 'ctx' {
  if (line.startsWith('+++') || line.startsWith('---')) return 'meta';
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  return 'ctx';
}

/**
 * Terminal output preview. Shows the command + working directory header,
 * an exit-code badge tinted by success/failure, then stdout and stderr
 * in separate blocks (stderr only rendered when non-empty, in destructive
 * tone). Empty output gets an explicit "(no output)" placeholder so a
 * silent successful command doesn't look like a render bug.
 */
function TerminalPreview(props: {
  cwd: string;
  cmd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}) {
  const copyFeedback = useClipboardCopyFeedback();
  const succeeded = props.exitCode === 0;
  const hasOutput = props.stdout.length > 0 || props.stderr.length > 0;
  // Redact + cap stdout/stderr independently. `npm test` against a misconfigured
  // provider can dump megabytes of stderr; we keep the first TOOL_LINE_CAP
  // lines and append a hidden-count marker.
  const stdout = capLines(redactSecrets(props.stdout));
  const stderr = capLines(redactSecrets(props.stderr));
  // The cmd line is also user-runtime text — don't echo a `--api-key=...`
  // arg into the chat without masking it.
  const safeCmd = redactSecrets(props.cmd);
  const safeCwd = redactSecrets(props.cwd);
  const hiddenLines = stdout.capped + stderr.capped;
  const handoffText = [
    '终端输出需要继续研读',
    `工作目录：${safeCwd}`,
    `命令：${safeCmd}`,
    `退出码：${props.exitCode}`,
    `截断：stdout 已隐藏 ${stdout.capped} 行，stderr 已隐藏 ${stderr.capped} 行`,
    stdout.body.length > 0 ? `stdout 预览：\n${stdout.body}` : '',
    stderr.body.length > 0 ? `stderr 预览：\n${stderr.body}` : '',
    '请在深度研究 / 只读探索里结合相关路径确认完整输出影响和下一步。',
  ].filter((line) => line.length > 0).join('\n\n');

  const handoffCopyPhase = copyFeedback.phaseFor('handoff');
  const handoffCopyLabel = handoffCopyPhase === 'pending'
    ? '复制中…'
    : handoffCopyPhase === 'copied'
      ? '已复制'
      : handoffCopyPhase === 'failed'
        ? '复制失败'
        : '复制研读提示';
  const handoffCopyAria = handoffCopyPhase === 'pending'
    ? '复制终端研读提示中'
    : handoffCopyPhase === 'copied'
      ? '已复制终端研读提示'
      : handoffCopyPhase === 'failed'
        ? '复制终端研读提示失败'
        : '复制终端研读提示';

  return (
    <div className={cn(previewVariants({ part: 'overlay' }), previewVariants({ part: 'terminal' }))} data-kind="terminal">
      <header className={previewVariants({ part: 'terminal-head' })}>
        <code className={previewVariants({ part: 'terminal-cwd' })}>{safeCwd}</code>
        <code className={previewVariants({ part: 'terminal-cmd' })}>$ {safeCmd}</code>
        <span
          className={previewVariants({ part: 'terminal-exit' })}
          data-ok={succeeded ? 'true' : 'false'}
          aria-label={`退出码 ${props.exitCode}`}
        >
          退出码 {props.exitCode}
        </span>
      </header>
      {!hasOutput && <p className={previewVariants({ part: 'terminal-empty' })}>（无输出）</p>}
      {props.stdout.length > 0 && (
        <pre className={previewVariants({ part: 'terminal-stream' })} data-stream="stdout">
          {stdout.body}
          {stdout.capped > 0 && `\n\n… stdout 已隐藏 ${stdout.capped} 行`}
        </pre>
      )}
      {props.stderr.length > 0 && (
        <pre className={previewVariants({ part: 'terminal-stream' })} data-stream="stderr">
          {stderr.body}
          {stderr.capped > 0 && `\n\n… stderr 已隐藏 ${stderr.capped} 行`}
        </pre>
      )}
      {hiddenLines > 0 && (
        <div className={previewVariants({ part: 'terminal-truncated-note' })}>
          <span>
            输出较长，当前只展示每路输出的前 {TOOL_LINE_CAP} 行。需要继续研读时，可以切到深度研究并把命令、相关路径和想确认的问题交给只读探索。
          </span>
          <UiButton
            type="button"
            variant="ghost"
            size="sm"
            className={previewVariants({ part: 'terminal-copy' })}
            onClick={() => void copyFeedback.copy('handoff', handoffText)}
            disabled={handoffCopyPhase === 'pending'}
            aria-label={handoffCopyAria}
            aria-busy={handoffCopyPhase === 'pending' ? 'true' : undefined}
            data-pending={handoffCopyPhase === 'pending' ? 'true' : undefined}
            data-copied={handoffCopyPhase === 'copied' ? 'true' : 'false'}
            data-copy-error={handoffCopyPhase === 'failed' ? 'true' : undefined}
          >
            {handoffCopyPhase === 'copied' ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
            <span>{handoffCopyLabel}</span>
          </UiButton>
        </div>
      )}
    </div>
  );
}

function OfficeDocumentPreview(props: {
  result: Extract<ToolResultContent, { kind: 'office_document' }>;
}) {
  const { result } = props;
  const stdout = capLines(redactSecrets(result.stdout ?? ''));
  const stderr = capLines(redactSecrets(result.stderr ?? ''));
  const message = result.message ? redactSecrets(result.message) : '';
  const args = result.args?.map((arg) => redactSecrets(arg)).join(' ');
  const title = result.path ? redactSecrets(result.path) : 'Office 文档';
  const operation = result.operation ? redactSecrets(result.operation) : '未执行';
  const reason = presentOfficeDocumentReason(result.reason);
  const hasOutput = stdout.body.length > 0 || stderr.body.length > 0;

  return (
    <div className={cn(previewVariants({ part: 'overlay' }), previewVariants({ part: 'office' }))} data-kind="office_document" data-ok={result.ok ? 'true' : 'false'}>
      <header className={previewVariants({ part: 'office-head' })}>
        <strong>{title}</strong>
        <small>
          {operation}
          {result.ok ? ' · 已完成' : ' · 未完成'}
          {result.truncated ? ' · 输出已截断' : ''}
        </small>
      </header>
      {args && <code className={previewVariants({ part: 'office-args' })}>officecli {args}</code>}
      {!result.ok && (
        <div className={previewVariants({ part: 'office-message' })} role="note">
          <span>{message || 'Office 文档操作未完成。'}</span>
          {reason && <small>诊断：{reason}</small>}
        </div>
      )}
      {result.ok && !hasOutput && <p className={previewVariants({ part: 'office-empty' })}>（无输出）</p>}
      {stdout.body.length > 0 && (
        <pre className={previewVariants({ part: 'office-stream' })} data-stream="stdout">
          {stdout.body}
          {stdout.capped > 0 && `\n\n… stdout 已隐藏 ${stdout.capped} 行`}
        </pre>
      )}
      {stderr.body.length > 0 && (
        <pre className={previewVariants({ part: 'office-stream' })} data-stream="stderr">
          {stderr.body}
          {stderr.capped > 0 && `\n\n… stderr 已隐藏 ${stderr.capped} 行`}
        </pre>
      )}
    </div>
  );
}

function presentOfficeDocumentReason(reason: string | undefined): string | undefined {
  switch (reason) {
    case 'invalid_operation':
      return '操作不支持';
    case 'invalid_path':
      return '路径无效';
    case 'unsupported_extension':
      return '文件类型不支持';
    case 'missing_file':
      return '文件不存在';
    case 'not_file':
      return '不是文件';
    case 'symlink_escape':
      return '符号链接被拒绝';
    case 'invalid_selector':
      return '选择器无效';
    case 'invalid_query':
      return '查询表达式无效';
    case 'invalid_props':
      return '属性无效';
    case 'file_exists':
      return '文件已存在';
    case 'officecli_missing':
      return 'officecli 未安装';
    case 'officecli_timeout':
      return '操作超时';
    case 'officecli_failed':
      return '操作失败';
    case undefined:
      return undefined;
    default:
      return '未知诊断';
  }
}

function RiveWorkflowPreview(props: {
  result: Extract<ToolResultContent, { kind: 'rive_workflow' }>;
}) {
  const { result } = props;
  const rows = [
    ['动作', result.action],
    ['状态', result.state ?? result.projection?.state],
    ['workflow_run', result.ids.workflowRunId ?? result.projection?.workflowRunId],
    ['scheduler_run', result.ids.schedulerRunId ?? result.projection?.schedulerRunId],
    ['root_work', result.ids.rootWorkNodeId ?? result.projection?.rootWorkNodeId],
    ['scheduler_state', result.projection?.schedulerState],
    ['root_state', result.projection?.rootState],
  ].filter((row): row is [string, string] => typeof row[1] === 'string' && row[1].length > 0);
  const nodes = (result.nodes ?? []).slice(0, 12);
  const failureLines = result.error
    ? [
        '',
        '错误',
        `reason: ${result.error.reason}`,
        `message: ${result.error.message}`,
        result.error.code ? `code: ${result.error.code}` : '',
        result.error.suggestedAction ? `suggested_action: ${result.error.suggestedAction}` : '',
      ].filter(Boolean)
    : [];
  const diagnosticLines = [
    result.stdoutTail ? `stdout_tail:\n${result.stdoutTail}` : '',
    result.stderrTail ? `stderr_tail:\n${result.stderrTail}` : '',
  ].filter(Boolean);
  const body = [
    result.ok ? 'Rive workflow completed' : 'Rive workflow failed',
    result.summary,
    '',
    ...rows.map(([label, value]) => `${label}: ${value}`),
    ...(nodes.length > 0 ? ['', '节点摘要', ...nodes.map(formatRiveWorkflowNode)] : []),
    ...failureLines,
    ...(diagnosticLines.length > 0 ? ['', '诊断片段', ...diagnosticLines] : []),
  ].join('\n');
  const cappedPreview = capLines(redactSecrets(body));
  return (
    <pre className={previewVariants({ part: 'overlay' })} data-kind="rive_workflow">
      {cappedPreview.body}
      {cappedPreview.capped > 0 && `\n\n… 已隐藏 ${cappedPreview.capped} 行`}
    </pre>
  );
}

function formatRiveWorkflowNode(node: NonNullable<Extract<ToolResultContent, { kind: 'rive_workflow' }>['nodes']>[number]): string {
  const label = node.title ?? node.templateId ?? node.id ?? 'node';
  const attrs = [
    node.state,
    node.runner ? `runner=${node.runner}` : '',
    node.worker ? `worker=${node.worker}` : '',
  ].filter(Boolean).join(' · ');
  return attrs ? `- ${label}: ${attrs}` : `- ${label}`;
}

/**
 * PR-CHAT-WEB-SEARCH-RENDER-0 — plain-text card list for the gated
 * WebSearch agent tool result. Matches the Settings → 联网搜索 live-query
 * verification layout so the user gets the same shape whether the search came
 * from a manual verification run or the agent. Never renders markdown / HTML;
 * each cell is `redactSecrets`'d as a belt-and-braces guard against
 * a provider response that happened to echo a token.
 */
function WebSearchPreview(props: {
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

function WebSearchErrorPreview(props: {
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
