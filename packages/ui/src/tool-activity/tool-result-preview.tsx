import { useEffect, useRef } from 'react';
import {
  isShellOutput,
  normalizeSearchUrl,
  ptyHumanTerminalText,
  readWriteStdinInputPreview,
  type ShellOutput,
  type ToolResultContent,
} from '@maka/core';
import { AlertCircle, Ban, Check, Clock, GitBranch, Loader2, Plug } from '../icons.js';
import { previewVariants } from '../primitives/chat.js';
import { redactSecrets } from '../redact.js';
import { cn } from '../ui.js';
import { ExploreAgentPreview, SubagentPreview } from './agent-preview.js';
import { formatQuietJsonValue } from './builtin-preview.js';
import { TOOL_LINE_CAP, capLines, formatUserVisibleToolText } from './preview-utils.js';

/**
 * Shared Codex-like tool output well — one surface for live and settled
 * mono/command output. Tokens only: foreground-3 + border + radius-surface.
 * Body type uses font-size-base (13px), not caption.
 */
export const TOOL_OUTPUT_PANEL_CLASS =
  'mt-1 grid gap-2 rounded-[var(--radius-surface)] border border-[var(--border)] bg-[var(--foreground-3)] px-3 py-2.5';

export const TOOL_OUTPUT_COMMAND_CLASS =
  'block min-w-0 [font-family:var(--font-mono)] [font-variant-ligatures:none] text-[length:var(--font-size-base)] leading-normal text-[color:var(--foreground)] [white-space:pre-wrap] [word-break:break-word]';

export const TOOL_OUTPUT_BODY_CLASS =
  'm-0 max-h-64 overflow-y-auto whitespace-pre-wrap [word-break:break-word] [font-family:var(--font-mono)] [font-variant-ligatures:none] text-[length:var(--font-size-base)] leading-normal text-[color:var(--muted-foreground)] [scroll-behavior:auto]';

export const TOOL_OUTPUT_NOTE_CLASS =
  'm-0 text-[length:var(--font-size-base)] leading-normal text-[color:var(--muted-foreground)]';

/** Routes persisted tool results to bounded, kind-specific preview cards. */
export function ToolResultPreview(props: {
  content: ToolResultContent;
  toolName?: string;
  args?: unknown;
  shellRunSource?: 'owned' | 'unavailable';
}) {
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
        status={content.status}
        failureMessage={content.failureMessage}
        output={isShellOutput(content.output) ? content.output : undefined}
      />
    );
  }

  if (content.kind === 'shell_run') {
    if (props.toolName === 'WriteStdin') return <PtyControlPreview result={content} args={props.args} />;
    return <ShellRunPreview result={content} source={props.shellRunSource} />;
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
    // Never pretty-print JSON with escaped newlines — quiet plain text only.
    const quiet = formatQuietJsonValue(content.value);
    return (
      <div className="grid gap-1.5" data-kind="json">
        {quiet.headline ? (
          <code className={TOOL_OUTPUT_COMMAND_CLASS}>{formatUserVisibleToolText(quiet.headline)}</code>
        ) : null}
        <pre className={TOOL_OUTPUT_BODY_CLASS}>{formatUserVisibleToolText(quiet.body)}</pre>
      </div>
    );
  }

  if (content.kind === 'text') {
    const { body, capped } = capLines(formatUserVisibleToolText(redactSecrets(content.text)));
    return (
      <pre className={TOOL_OUTPUT_BODY_CLASS} data-kind="text">
        {body}
        {capped > 0 && `\n\n… 已隐藏 ${capped} 行`}
      </pre>
    );
  }

  // file_write / image / summary / unknown — show a compact descriptor so the
  // user knows what kind landed without dumping binary or storage refs.
  return (
    <pre className={TOOL_OUTPUT_BODY_CLASS} data-kind={content.kind}>
      [{content.kind}]
    </pre>
  );
}

function PtyControlPreview(props: {
  result: Extract<ToolResultContent, { kind: 'shell_run' }>;
  args?: unknown;
}) {
  const operation = props.result.operation;
  if (operation?.kind !== 'pty_control') {
    return <p className={cn(TOOL_OUTPUT_NOTE_CLASS, 'text-[color:var(--destructive)]')}>后台终端交互失败</p>;
  }
  const parts: string[] = [];
  if (operation.input) {
    const preview = readWriteStdinInputPreview(props.args);
    const action = operation.input.applied ? '已发送' : '未发送';
    if (preview) {
      parts.push(preview.truncated
        ? `${action}：${preview.text}… · 共 ${operation.input.bytes} 字节`
        : `${action}：${preview.text}`);
    } else {
      parts.push(`${action} ${operation.input.bytes} 字节`);
    }
  }
  if (operation.resize) {
    const size = `${operation.resize.cols}x${operation.resize.rows}`;
    if (!operation.resize.applied) parts.push(`未调整为 ${size}`);
    else if (operation.resize.changed) parts.push(`已调整为 ${size}`);
    else if (!operation.input) parts.push(`尺寸已是 ${size}`);
  }
  if (operation.failed) parts.push('后台终端交互失败');
  return (
    <p className={cn(
      TOOL_OUTPUT_NOTE_CLASS,
      'min-w-0 [overflow-wrap:anywhere]',
      operation.failed && 'text-[color:var(--destructive)]',
    )}>
      {parts.join(' · ') || '后台终端交互已完成'}
    </p>
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
  // Structure kept (paths + colored lines); no second card chrome — parent panel
  // is the only surface when embedded in a tool row.
  return (
    <div className="grid gap-1.5" data-kind="file_diff">
      {props.paths.length > 0 && (
        <div className="flex flex-wrap gap-1.5 [font-family:var(--font-mono)] text-[length:var(--font-size-base)] text-[color:var(--muted-foreground)]">
          {props.paths.map((path) => (
            <code key={path} className="bg-transparent text-[color:var(--foreground-secondary)]">{path}</code>
          ))}
        </div>
      )}
      <pre className={cn(TOOL_OUTPUT_BODY_CLASS, '[white-space:pre] [word-break:normal]')}>
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
 * Terminal output preview — quiet single well: command (no $) + stdout/stderr.
 * Honors runtime `status` and stream truncated flags (not only UI line caps).
 */
function TerminalPreview(props: {
  cwd: string;
  cmd: string;
  exitCode?: number;
  status?: string;
  failureMessage?: string;
  output?: ShellOutput;
}) {
  const cancelled = isCancelledStatus(props.status);
  const timedOut = props.status === 'timed_out';
  const succeeded = props.status === 'completed';
  // The cmd line is also user-runtime text — don't echo a `--api-key=...`
  // arg into the chat without masking it.
  const safeCmd = redactSecrets(props.cmd);
  const attention = !succeeded || cancelled || timedOut;

  return (
    <div
      data-slot="tool-output"
      data-kind="terminal"
      className={cn(TOOL_OUTPUT_PANEL_CLASS, attention && 'border-[oklch(from_var(--destructive)_l_c_h_/_0.28)]')}
    >
      {safeCmd.length > 0 && (
        <code className={TOOL_OUTPUT_COMMAND_CLASS}>{safeCmd}</code>
      )}
      {props.output ? (
        <ShellOutputBody output={props.output} failed={!succeeded} />
      ) : (
        <p className={TOOL_OUTPUT_NOTE_CLASS}>终端输出不可用</p>
      )}
      {props.failureMessage && (
        <p className={cn(TOOL_OUTPUT_NOTE_CLASS, 'text-[color:var(--destructive)]')}>
          {redactSecrets(props.failureMessage)}
        </p>
      )}
      {cancelled && (
        <p className={cn(TOOL_OUTPUT_NOTE_CLASS, 'text-[color:var(--destructive)]')}>
          {props.exitCode !== undefined ? `已取消 · 退出码 ${props.exitCode}` : '已取消'}
        </p>
      )}
      {timedOut && !cancelled && (
        <p className={cn(TOOL_OUTPUT_NOTE_CLASS, 'text-[color:var(--destructive)]')}>
          {props.exitCode !== undefined ? `已超时 · 退出码 ${props.exitCode}` : '已超时'}
        </p>
      )}
      {!succeeded && !cancelled && !timedOut && (
        <p className={cn(TOOL_OUTPUT_NOTE_CLASS, 'text-[color:var(--destructive)]')}>
          {props.exitCode !== undefined ? `失败 · 退出码 ${props.exitCode}` : '失败'}
        </p>
      )}
    </div>
  );
}

/** Background Bash after handoff: a live terminal surface for PTY, the existing
 * command/status/ref preview for pipes. Never collapse either to `[shell_run]`. */
function ShellRunPreview(props: {
  result: Extract<ToolResultContent, { kind: 'shell_run' }>;
  source?: 'owned' | 'unavailable';
}) {
  const { result } = props;
  const safeCmd = redactSecrets(result.cmd);
  const output = isShellOutput(result.output) ? result.output : undefined;
  const attention = result.status === 'failed' || result.status === 'orphaned' || (result.exitCode !== undefined && result.exitCode !== 0);

  if (result.mode === 'pty') {
    return (
      <PtyShellSurface
        result={result}
        output={output?.mode === 'pty' ? output : undefined}
        safeCmd={safeCmd}
        attention={attention}
        source={props.source}
      />
    );
  }
  const safeRef = redactSecrets(result.ref);
  const statusLabel = props.source === 'owned'
    ? '由源会话管理'
    : props.source === 'unavailable' ? '源会话不可用' : shellRunStatusLabel(result.status);
  const pipeOutput = output?.mode === 'pipes' ? output : undefined;

  return (
    <div
      data-slot="tool-output"
      data-kind="shell_run"
      className={cn(TOOL_OUTPUT_PANEL_CLASS, attention && 'border-[oklch(from_var(--destructive)_l_c_h_/_0.28)]')}
    >
      {safeCmd.length > 0 && (
        <code className={TOOL_OUTPUT_COMMAND_CLASS}>{safeCmd}</code>
      )}
      <p className={TOOL_OUTPUT_NOTE_CLASS}>
        {statusLabel}
        {result.exitCode !== undefined ? ` · 退出码 ${result.exitCode}` : ''}
        {safeRef ? ` · ${safeRef}` : ''}
      </p>
      {result.failureMessage && (
        <p className={cn(TOOL_OUTPUT_NOTE_CLASS, 'text-[color:var(--destructive)]')}>
          {redactSecrets(result.failureMessage)}
        </p>
      )}
      {pipeOutput ? (
        <ShellOutputBody
          output={pipeOutput}
          failed={result.status === 'failed' || result.status === 'orphaned'}
        />
      ) : (
        <p className={TOOL_OUTPUT_NOTE_CLASS}>（尚无输出）</p>
      )}
    </div>
  );
}

function PtyShellSurface(props: {
  result: Extract<ToolResultContent, { kind: 'shell_run' }>;
  output?: Extract<ShellOutput, { mode: 'pty' }>;
  safeCmd: string;
  attention: boolean;
  source?: 'owned' | 'unavailable';
}) {
  const { result, output } = props;
  return (
    <div
      data-slot="tool-output"
      data-kind="pty-shell"
      className={cn(
        TOOL_OUTPUT_PANEL_CLASS,
        'gap-0 overflow-hidden p-0',
        props.attention && 'border-[oklch(from_var(--destructive)_l_c_h_/_0.28)]',
      )}
    >
      <header className="flex min-w-0 items-center px-3 pt-2.5 pb-1">
        <span className="text-[length:var(--font-size-base)] font-medium text-[color:var(--foreground-secondary)]">
          Shell
        </span>
      </header>
      <div className="grid min-w-0 gap-2 px-3 py-1.5">
        {props.safeCmd.length > 0 && (
          <code className={TOOL_OUTPUT_COMMAND_CLASS}>$ {props.safeCmd}</code>
        )}
        {output ? (
          <ShellOutputBody
            output={output}
            failed={result.status === 'failed' || result.status === 'orphaned'}
          />
        ) : (
          <p className={TOOL_OUTPUT_NOTE_CLASS}>
            {result.status === 'failed' || result.status === 'orphaned'
              ? '（无可用终端画面）'
              : '（尚无输出）'}
          </p>
        )}
        {result.failureMessage && (
          <p className={cn(TOOL_OUTPUT_NOTE_CLASS, 'text-[color:var(--destructive)]')}>
            {redactSecrets(result.failureMessage)}
          </p>
        )}
      </div>
      <footer className="flex min-h-8 items-center justify-end gap-1.5 px-3 pt-1 pb-2.5 text-[length:var(--font-size-base)] text-[color:var(--muted-foreground)]">
        <ShellRunStatus status={result.status} exitCode={result.exitCode} source={props.source} />
      </footer>
    </div>
  );
}

function ShellRunStatus(props: {
  status: Extract<ToolResultContent, { kind: 'shell_run' }>['status'];
  exitCode?: number;
  source?: 'owned' | 'unavailable';
}) {
  if (props.source === 'owned') return <><GitBranch size={15} aria-hidden="true" />由源会话管理</>;
  if (props.source === 'unavailable') return <><GitBranch size={15} aria-hidden="true" />源会话不可用</>;
  const suffix = props.exitCode !== undefined && props.exitCode !== 0 ? ` · 退出码 ${props.exitCode}` : '';
  switch (props.status) {
    case 'running':
      return <><Loader2 size={15} aria-hidden="true" className="animate-spin" />运行中</>;
    case 'completed':
      return <><Check size={15} aria-hidden="true" />成功</>;
    case 'failed':
      return <><AlertCircle size={15} aria-hidden="true" />失败{suffix}</>;
    case 'timed_out':
      return <><Clock size={15} aria-hidden="true" />已超时{suffix}</>;
    case 'cancelled':
      return <><Ban size={15} aria-hidden="true" />已取消{suffix}</>;
    case 'orphaned':
      return <><Plug size={15} aria-hidden="true" />已断开</>;
  }
}

function ShellOutputBody(props: { output: ShellOutput; failed: boolean }) {
  if (props.output.mode === 'pty') {
    const text = redactSecrets(ptyHumanTerminalText(props.output));
    return (
      <>
        {text ? <PtyTerminalSurface text={text} /> : (
          <p className={TOOL_OUTPUT_NOTE_CLASS}>
            {props.failed ? '（无可用终端画面）' : '（尚无输出）'}
          </p>
        )}
        {props.output.truncated && <p className={TOOL_OUTPUT_NOTE_CLASS}>终端输出已截断</p>}
        {props.output.redacted && <p className={TOOL_OUTPUT_NOTE_CLASS}>终端输出已脱敏</p>}
      </>
    );
  }
  const stdout = capLines(redactSecrets(props.output.stdout));
  const stderr = capLines(redactSecrets(props.output.stderr));
  const hiddenLines = stdout.capped + stderr.capped;
  const runtimeTruncated = props.output.stdoutTruncated || props.output.stderrTruncated;
  const hasOutput = props.output.stdout.length > 0 || props.output.stderr.length > 0;
  return (
    <>
      {!hasOutput && <p className={TOOL_OUTPUT_NOTE_CLASS}>（无输出）</p>}
      {props.output.stdout.length > 0 && (
        <pre className={TOOL_OUTPUT_BODY_CLASS} data-stream="stdout">
          {stdout.body}
          {stdout.capped > 0 && `\n\n… stdout 已隐藏 ${stdout.capped} 行`}
        </pre>
      )}
      {props.output.stderr.length > 0 && (
        <pre className={cn(TOOL_OUTPUT_BODY_CLASS, 'text-[color:var(--destructive)]')} data-stream="stderr">
          {stderr.body}
          {stderr.capped > 0 && `\n\n… stderr 已隐藏 ${stderr.capped} 行`}
        </pre>
      )}
      {(runtimeTruncated || hiddenLines > 0) && (
        <p className={TOOL_OUTPUT_NOTE_CLASS}>
          {hiddenLines > 0 ? `输出已截断 · 每路仅展示前 ${TOOL_LINE_CAP} 行` : '输出已截断'}
        </p>
      )}
      {props.output.redacted && <p className={TOOL_OUTPUT_NOTE_CLASS}>输出已脱敏</p>}
    </>
  );
}

function PtyTerminalSurface(props: { text: string }) {
  const ref = useRef<HTMLPreElement>(null);
  const followTail = useRef(true);
  useEffect(() => {
    const element = ref.current;
    if (element && followTail.current) element.scrollTop = element.scrollHeight;
  }, [props.text]);
  return (
    <pre
      ref={ref}
      className={cn(TOOL_OUTPUT_BODY_CLASS, 'overflow-auto [white-space:pre] [word-break:normal]')}
      data-stream="pty"
      style={{ whiteSpace: 'pre', wordBreak: 'normal' }}
      onScroll={(event) => {
        const element = event.currentTarget;
        followTail.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 2;
      }}
    >
      {props.text}
    </pre>
  );
}

function isCancelledStatus(status: string | undefined): boolean {
  return status === 'cancelled';
}

function shellRunStatusLabel(status: string): string {
  switch (status) {
    case 'running':
      return '后台运行中';
    case 'completed':
      return '后台已完成';
    case 'failed':
      return '后台失败';
    case 'timed_out':
      return '后台超时';
    case 'cancelled':
      return '后台已取消';
    case 'orphaned':
      return '后台任务已断开';
    default:
      return `后台 · ${status}`;
  }
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
    <div className="grid gap-1.5" data-kind="office_document" data-ok={result.ok ? 'true' : 'false'}>
      <header className="grid gap-0.5">
        <strong className="text-[length:var(--font-size-base)] text-[color:var(--foreground)]">{title}</strong>
        <small className="text-[length:var(--font-size-base)] text-[color:var(--muted-foreground)]">
          {operation}
          {result.ok ? ' · 已完成' : ' · 未完成'}
          {result.truncated ? ' · 输出已截断' : ''}
        </small>
      </header>
      {args && <code className={TOOL_OUTPUT_COMMAND_CLASS}>officecli {args}</code>}
      {!result.ok && (
        <div className="grid gap-0.5 text-[length:var(--font-size-base)] text-[color:var(--destructive)]" role="note">
          <span>{message || 'Office 文档操作未完成。'}</span>
          {reason && <small className="text-[color:var(--muted-foreground)]">诊断：{reason}</small>}
        </div>
      )}
      {result.ok && !hasOutput && <p className={TOOL_OUTPUT_NOTE_CLASS}>（无输出）</p>}
      {stdout.body.length > 0 && (
        <pre className={TOOL_OUTPUT_BODY_CLASS} data-stream="stdout">
          {stdout.body}
          {stdout.capped > 0 && `\n\n… stdout 已隐藏 ${stdout.capped} 行`}
        </pre>
      )}
      {stderr.body.length > 0 && (
        <pre className={cn(TOOL_OUTPUT_BODY_CLASS, 'text-[color:var(--destructive)]')} data-stream="stderr">
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
    <pre className={TOOL_OUTPUT_BODY_CLASS} data-kind="rive_workflow">
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
      <div className="grid gap-1.5 [font-family:var(--font-sans)]" data-kind="web_search">
        <header className="grid gap-0.5">
          <strong className="text-[length:var(--font-size-base)] text-[color:var(--foreground)]">{redactSecrets(props.query)}</strong>
          <small className="text-[length:var(--font-size-base)] text-[color:var(--muted-foreground)]">{props.provider} · 没有结果</small>
        </header>
      </div>
    );
  }
  return (
    <div className="grid gap-2 [font-family:var(--font-sans)]" data-kind="web_search">
      <header className="grid gap-0.5">
        <strong className="text-[length:var(--font-size-base)] text-[color:var(--foreground)]">{redactSecrets(props.query)}</strong>
        <small className="text-[length:var(--font-size-base)] text-[color:var(--muted-foreground)]">
          {props.provider} · {rows.length} 条结果
        </small>
      </header>
      <ul className="m-0 grid list-none gap-2 p-0">
        {rows.map((row, idx) => (
          <li key={`${row.url}-${idx}`} className="grid gap-0.5">
            <a
              href={row.url}
              target="_blank"
              rel="noreferrer noopener"
              className="text-[length:var(--font-size-base)] font-medium text-[color:var(--link)]"
            >
              {redactSecrets(row.title)}
            </a>
            <small className="text-[length:var(--font-size-base)] text-[color:var(--muted-foreground)]">{redactSecrets(row.source)}</small>
            <p className="m-0 text-[length:var(--font-size-base)] leading-snug text-[color:var(--foreground-secondary)]">{redactSecrets(row.snippet)}</p>
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
    <div className="grid gap-1.5 [font-family:var(--font-sans)]" data-kind="web_search_error">
      <header className="grid gap-0.5">
        <strong className="text-[length:var(--font-size-base)] text-[color:var(--foreground)]">{redactSecrets(props.query ?? '联网搜索')}</strong>
        <small className="text-[length:var(--font-size-base)] text-[color:var(--muted-foreground)]">{redactSecrets(props.provider)} · 搜索失败 · {sourceCopy}</small>
      </header>
      <p className="m-0 text-[length:var(--font-size-base)] text-[color:var(--destructive)]">{redactSecrets(props.message)}</p>
      <p className="m-0 text-[length:var(--font-size-base)] text-[color:var(--muted-foreground)]">{repairCopy}</p>
    </div>
  );
}
