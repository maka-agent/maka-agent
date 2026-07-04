import { type ToolResultContent } from '@maka/core';
import { previewVariants } from '../primitives/chat.js';
import { redactSecrets } from '../redact.js';
import { capLines } from './preview-utils.js';

export function RiveWorkflowPreview(props: {
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
    result.stdoutTail ? `stdout_tail:\n${redactSecrets(result.stdoutTail)}` : '',
    result.stderrTail ? `stderr_tail:\n${redactSecrets(result.stderrTail)}` : '',
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
  const cappedPreview = capLines(body);
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
