import { Check, Copy } from '../icons.js';
import { useClipboardCopyFeedback } from '../clipboard-feedback.js';
import { previewVariants } from '../primitives/chat.js';
import { redactSecrets } from '../redact.js';
import { Button as UiButton, cn } from '../ui.js';
import { TOOL_LINE_CAP, capLines } from './preview-utils.js';

/**
 * Terminal output preview. Shows the command + working directory header,
 * an exit-code badge tinted by success/failure, then stdout and stderr
 * in separate blocks (stderr only rendered when non-empty, in destructive
 * tone). Empty output gets an explicit "(no output)" placeholder so a
 * silent successful command doesn't look like a render bug.
 */
export function TerminalPreview(props: {
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
            {handoffCopyPhase === 'copied' ? <Check size={13} strokeWidth={2} aria-hidden="true" /> : <Copy size={13} strokeWidth={1.75} aria-hidden="true" />}
            <span>{handoffCopyLabel}</span>
          </UiButton>
        </div>
      )}
    </div>
  );
}
