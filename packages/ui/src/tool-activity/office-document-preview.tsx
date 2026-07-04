import { type ToolResultContent } from '@maka/core';
import { previewVariants } from '../primitives/chat.js';
import { redactSecrets } from '../redact.js';
import { cn } from '../ui.js';
import { capLines } from './preview-utils.js';

export function OfficeDocumentPreview(props: {
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
