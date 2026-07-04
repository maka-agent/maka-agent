import { type ToolResultContent } from '@maka/core';
import { Check, Copy } from '../icons.js';
import { useClipboardCopyFeedback } from '../clipboard-feedback.js';
import { previewVariants } from '../primitives/chat.js';
import { redactSecrets } from '../redact.js';
import { Button as UiButton, cn } from '../ui.js';
import { formatBytes, formatDuration } from './preview-utils.js';

type SubagentResult = Extract<ToolResultContent, { kind: 'subagent' }>;
type ExploreAgentResult = Extract<ToolResultContent, { kind: 'explore_agent' }>;

const SUBAGENT_STATUS_LABEL: Record<SubagentResult['status'], string> = {
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  running: '运行中',
  waiting_permission: '等待权限',
};

export function SubagentPreview(props: {
  result: SubagentResult;
}) {
  const { result } = props;
  const duration = formatDuration(result.durationMs);
  const status = presentSubagentStatus(result.status);
  const summary = typeof result.summary === 'string' ? result.summary.trim() : '';
  const artifactCount = result.artifactIds.length;
  const meta = [
    status,
    presentSubagentPermission(result.permissionMode),
    duration ? `耗时 ${duration}` : '',
  ].filter(Boolean).join(' · ');

  return (
    <div className={cn(previewVariants({ part: 'overlay' }), previewVariants({ part: 'agent' }))} data-kind="subagent" data-status={result.status}>
      <header className={previewVariants({ part: 'agent-head' })}>
        <strong>{redactSecrets(result.agentName || 'Subagent')}</strong>
        <small>{meta}</small>
      </header>
      {summary.length > 0 && (
        <section className={previewVariants({ part: 'agent-section' })} aria-label="子代理结果摘要">
          <strong>结果摘要</strong>
          <p>{redactSecrets(summary)}</p>
        </section>
      )}
      {result.failureClass && (
        <div className={previewVariants({ part: 'agent-message' })} role="note">
          {redactSecrets(result.failureClass)}
        </div>
      )}
      {artifactCount > 0 && (
        <section className={previewVariants({ part: 'agent-section' })} aria-label="子代理产物">
          <strong>产物</strong>
          <p>{artifactCount} 个</p>
        </section>
      )}
    </div>
  );
}

function presentSubagentStatus(status: SubagentResult['status']): string {
  return SUBAGENT_STATUS_LABEL[status] ?? status;
}

function presentSubagentPermission(permissionMode: SubagentResult['permissionMode']): string {
  if (permissionMode === 'explore') return '只读';
  return permissionMode;
}

export function ExploreAgentPreview(props: {
  result: ExploreAgentResult;
}) {
  const { result } = props;
  const copyFeedback = useClipboardCopyFeedback();
  const {
    candidateFiles,
    matches,
    progress,
    evidence,
    resultSummary,
    terminalStatus,
    status,
    reportLines,
    notes,
    roots,
    queries,
    ignoredPaths,
    stoppingCondition,
    limitReasons,
    filesDiscovered,
    skippedSummary,
    duration,
    continuationReason,
    continuationText,
    copyPayloads,
  } = buildExploreAgentPreviewModel(result);

  function copyButtonState(key: string, idleLabel: string, copiedAria: string) {
    const phase = copyFeedback.phaseFor(key);
    return {
      phase,
      disabled: copyFeedback.isPending,
      label: phase === 'pending'
        ? '复制中…'
        : phase === 'copied'
          ? '已复制'
          : phase === 'failed'
            ? '复制失败'
            : idleLabel,
      ariaLabel: phase === 'pending'
        ? `${idleLabel}中`
        : phase === 'copied'
          ? copiedAria
          : phase === 'failed'
            ? `${idleLabel}失败`
            : idleLabel,
    };
  }

  const summaryCopy = copyButtonState('summary', '复制摘要', '已复制探索摘要');
  const continuationCopy = copyButtonState('continuation', '复制续研提示', '已复制续研提示');
  const processCopy = copyButtonState('process', '复制过程', '已复制探索过程');
  const evidenceCopy = copyButtonState('evidence', '复制证据', '已复制证据锚点');
  const reportCopy = copyButtonState('report', '复制报告', '已复制研究报告');
  const candidateCopy = copyButtonState('candidate', '复制候选', '已复制候选文件');
  const matchesCopy = copyButtonState('matches', '复制片段', '已复制命中片段');

  return (
    <div className={cn(previewVariants({ part: 'overlay' }), previewVariants({ part: 'agent' }))} data-kind="explore_agent" data-ok={result.ok ? 'true' : 'false'}>
      <header className={previewVariants({ part: 'agent-head' })}>
        <strong>{redactSecrets(result.objective || '只读探索')}</strong>
        <small>
          {status} · 发现/读 {filesDiscovered} / {result.filesInspected} 个文件 · {skippedSummary} · {formatBytes(result.bytesRead)}
          {limitReasons ? ' · 受预算限制' : ''}
          {continuationReason ? ` · 建议续研：${continuationReason}` : ''}
          {duration ? ` · 耗时 ${duration}` : ''}
        </small>
        {resultSummary.length > 0 && (
          <div className={previewVariants({ part: 'agent-summary-line' })}>
            <small>{redactSecrets(resultSummary)}</small>
            <UiButton
              type="button"
              variant="ghost"
              size="sm"
              className={previewVariants({ part: 'agent-copy' })}
              onClick={() => void copyFeedback.copy('summary', copyPayloads.summary)}
              disabled={summaryCopy.disabled}
              aria-label={summaryCopy.ariaLabel}
              aria-busy={summaryCopy.phase === 'pending' ? 'true' : undefined}
              data-pending={summaryCopy.phase === 'pending' ? 'true' : undefined}
              data-copied={summaryCopy.phase === 'copied' ? 'true' : 'false'}
              data-copy-error={summaryCopy.phase === 'failed' ? 'true' : undefined}
            >
              {summaryCopy.phase === 'copied' ? <Check size={13} strokeWidth={2} aria-hidden="true" /> : <Copy size={13} strokeWidth={1.75} aria-hidden="true" />}
              <span>{summaryCopy.label}</span>
            </UiButton>
          </div>
        )}
        {continuationText.length > 0 && (
          <div className={previewVariants({ part: 'agent-actions' })} aria-label="只读探索后续操作">
            <UiButton
              type="button"
              variant="ghost"
              size="sm"
              className={previewVariants({ part: 'agent-copy' })}
              onClick={() => void copyFeedback.copy('continuation', copyPayloads.continuation)}
              disabled={continuationCopy.disabled}
              aria-label={continuationCopy.ariaLabel}
              aria-busy={continuationCopy.phase === 'pending' ? 'true' : undefined}
              data-pending={continuationCopy.phase === 'pending' ? 'true' : undefined}
              data-copied={continuationCopy.phase === 'copied' ? 'true' : 'false'}
              data-copy-error={continuationCopy.phase === 'failed' ? 'true' : undefined}
              title="复制一段可继续只读探索的提示"
            >
              {continuationCopy.phase === 'copied' ? <Check size={13} strokeWidth={2} aria-hidden="true" /> : <Copy size={13} strokeWidth={1.75} aria-hidden="true" />}
              <span>{continuationCopy.label}</span>
            </UiButton>
          </div>
        )}
      </header>
      {!result.ok && (
        <div className={previewVariants({ part: 'agent-message' })} role="note">
          {redactSecrets(result.message ?? '只读探索未完成。')}
        </div>
      )}
      <dl className={previewVariants({ part: 'agent-meta' })}>
        <div>
          <dt>终态</dt>
          <dd>{terminalStatus}</dd>
        </div>
        <div>
          <dt>发现/读</dt>
          <dd>{filesDiscovered} / {result.filesInspected} 个文件</dd>
        </div>
        <div>
          <dt>范围</dt>
          <dd>{redactSecrets(roots)}</dd>
        </div>
        <div>
          <dt>查询</dt>
          <dd>{redactSecrets(queries)}</dd>
        </div>
        {ignoredPaths && (
          <div>
            <dt>忽略</dt>
            <dd>{redactSecrets(ignoredPaths)}</dd>
          </div>
        )}
        {stoppingCondition && (
          <div>
            <dt>停止</dt>
            <dd>{redactSecrets(stoppingCondition)}</dd>
          </div>
        )}
        {limitReasons && (
          <div>
            <dt>边界</dt>
            <dd>{redactSecrets(limitReasons)}</dd>
          </div>
        )}
        {continuationReason && (
          <div>
            <dt>后续</dt>
            <dd>建议续研：{redactSecrets(continuationReason)}</dd>
          </div>
        )}
      </dl>
      {progress.length > 0 && (
        <section className={previewVariants({ part: 'agent-section' })} aria-label="探索过程">
          <div className={previewVariants({ part: 'agent-section-head' })}>
            <strong>过程</strong>
            <UiButton
              type="button"
              variant="ghost"
              size="sm"
              className={previewVariants({ part: 'agent-copy' })}
              onClick={() => void copyFeedback.copy('process', copyPayloads.process)}
              disabled={processCopy.disabled}
              aria-label={processCopy.ariaLabel}
              aria-busy={processCopy.phase === 'pending' ? 'true' : undefined}
              data-pending={processCopy.phase === 'pending' ? 'true' : undefined}
              data-copied={processCopy.phase === 'copied' ? 'true' : 'false'}
              data-copy-error={processCopy.phase === 'failed' ? 'true' : undefined}
            >
              {processCopy.phase === 'copied' ? <Check size={13} strokeWidth={2} aria-hidden="true" /> : <Copy size={13} strokeWidth={1.75} aria-hidden="true" />}
              <span>{processCopy.label}</span>
            </UiButton>
          </div>
          <ul>
            {progress.map((item, index) => (
              <li key={`${index}:${item.slice(0, 24)}`}>
                <span>{redactSecrets(item)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {evidence.length > 0 && (
        <section className={previewVariants({ part: 'agent-section' })} aria-label="证据锚点">
          <div className={previewVariants({ part: 'agent-section-head' })}>
            <strong>证据锚点</strong>
            <UiButton
              type="button"
              variant="ghost"
              size="sm"
              className={previewVariants({ part: 'agent-copy' })}
              onClick={() => void copyFeedback.copy('evidence', copyPayloads.evidence)}
              disabled={evidenceCopy.disabled}
              aria-label={evidenceCopy.ariaLabel}
              aria-busy={evidenceCopy.phase === 'pending' ? 'true' : undefined}
              data-pending={evidenceCopy.phase === 'pending' ? 'true' : undefined}
              data-copied={evidenceCopy.phase === 'copied' ? 'true' : 'false'}
              data-copy-error={evidenceCopy.phase === 'failed' ? 'true' : undefined}
            >
              {evidenceCopy.phase === 'copied' ? <Check size={13} strokeWidth={2} aria-hidden="true" /> : <Copy size={13} strokeWidth={1.75} aria-hidden="true" />}
              <span>{evidenceCopy.label}</span>
            </UiButton>
          </div>
          <ul>
            {evidence.map((item, index) => (
              <li key={`${item.path}:${item.line ?? 'file'}:${index}`}>
                <code>
                  {redactSecrets(item.path)}
                  {typeof item.line === 'number' ? `:${item.line}` : ''}
                </code>
                <small>
                  {redactSecrets(item.label)}
                  {typeof item.score === 'number' ? ` · 分数 ${item.score}` : ''}
                </small>
              </li>
            ))}
          </ul>
        </section>
      )}
      {reportLines.length > 0 && (
        <section className={previewVariants({ part: 'agent-section' })} aria-label="研究报告">
          <div className={previewVariants({ part: 'agent-section-head' })}>
            <strong>研究报告</strong>
            <UiButton
              type="button"
              variant="ghost"
              size="sm"
              className={previewVariants({ part: 'agent-copy' })}
              onClick={() => void copyFeedback.copy('report', copyPayloads.report)}
              disabled={reportCopy.disabled}
              aria-label={reportCopy.ariaLabel}
              aria-busy={reportCopy.phase === 'pending' ? 'true' : undefined}
              data-pending={reportCopy.phase === 'pending' ? 'true' : undefined}
              data-copied={reportCopy.phase === 'copied' ? 'true' : 'false'}
              data-copy-error={reportCopy.phase === 'failed' ? 'true' : undefined}
            >
              {reportCopy.phase === 'copied' ? <Check size={13} strokeWidth={2} aria-hidden="true" /> : <Copy size={13} strokeWidth={1.75} aria-hidden="true" />}
              <span>{reportCopy.label}</span>
            </UiButton>
          </div>
          <ul>
            {reportLines.map((line, index) => (
              <li key={`${index}:${line.slice(0, 24)}`}>
                <span>{redactSecrets(line)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {candidateFiles.length > 0 && (
        <section className={previewVariants({ part: 'agent-section' })} aria-label="候选文件">
          <div className={previewVariants({ part: 'agent-section-head' })}>
            <strong>候选文件</strong>
            <UiButton
              type="button"
              variant="ghost"
              size="sm"
              className={previewVariants({ part: 'agent-copy' })}
              onClick={() => void copyFeedback.copy('candidate', copyPayloads.candidate)}
              disabled={candidateCopy.disabled}
              aria-label={candidateCopy.ariaLabel}
              aria-busy={candidateCopy.phase === 'pending' ? 'true' : undefined}
              data-pending={candidateCopy.phase === 'pending' ? 'true' : undefined}
              data-copied={candidateCopy.phase === 'copied' ? 'true' : 'false'}
              data-copy-error={candidateCopy.phase === 'failed' ? 'true' : undefined}
            >
              {candidateCopy.phase === 'copied' ? <Check size={13} strokeWidth={2} aria-hidden="true" /> : <Copy size={13} strokeWidth={1.75} aria-hidden="true" />}
              <span>{candidateCopy.label}</span>
            </UiButton>
          </div>
          <ul>
            {candidateFiles.map((file) => (
              <li key={file.path}>
                <code>{redactSecrets(file.path)}</code>
                <small>
                  分数 {file.score}
                  {file.reasons.length > 0 ? ` · ${presentExploreAgentCandidateReasons(file.reasons)}` : ''}
                </small>
              </li>
            ))}
          </ul>
        </section>
      )}
      {matches.length > 0 && (
        <section className={previewVariants({ part: 'agent-section' })} aria-label="命中片段">
          <div className={previewVariants({ part: 'agent-section-head' })}>
            <strong>命中片段</strong>
            <UiButton
              type="button"
              variant="ghost"
              size="sm"
              className={previewVariants({ part: 'agent-copy' })}
              onClick={() => void copyFeedback.copy('matches', copyPayloads.matches)}
              disabled={matchesCopy.disabled}
              aria-label={matchesCopy.ariaLabel}
              aria-busy={matchesCopy.phase === 'pending' ? 'true' : undefined}
              data-pending={matchesCopy.phase === 'pending' ? 'true' : undefined}
              data-copied={matchesCopy.phase === 'copied' ? 'true' : 'false'}
              data-copy-error={matchesCopy.phase === 'failed' ? 'true' : undefined}
            >
              {matchesCopy.phase === 'copied' ? <Check size={13} strokeWidth={2} aria-hidden="true" /> : <Copy size={13} strokeWidth={1.75} aria-hidden="true" />}
              <span>{matchesCopy.label}</span>
            </UiButton>
          </div>
          <ul>
            {matches.map((match, index) => (
              <li key={`${match.path}:${match.line}:${index}`}>
                <code>{redactSecrets(match.path)}:{match.line}</code>
                <small>{redactSecrets(match.query)}</small>
                <p>{redactSecrets(match.snippet)}</p>
              </li>
            ))}
          </ul>
        </section>
      )}
      {notes.length > 0 && (
        <section className={previewVariants({ part: 'agent-section' })} aria-label="探索说明">
          <strong>说明</strong>
          <ul>
            {notes.map((note, index) => (
              <li key={`${index}:${note.slice(0, 24)}`}>
                <span>{redactSecrets(note)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

export function buildExploreAgentCopyPayloads(result: ExploreAgentResult): Record<'summary' | 'process' | 'evidence' | 'report' | 'candidate' | 'matches' | 'continuation', string> {
  return buildExploreAgentPreviewModel(result).copyPayloads;
}

function buildExploreAgentPreviewModel(result: ExploreAgentResult) {
  const candidateFiles = result.candidateFiles.slice(0, 8);
  const matches = result.matches.slice(0, 8);
  const processLines = Array.isArray(result.recentEvents) && result.recentEvents.length > 0
    ? result.recentEvents.slice(0, 20).map((event) => formatExploreAgentEvent(event, result.startedAt))
    : (result.progress ?? []).slice(0, 12);
  const progress = processLines.slice(0, 6);
  const evidence = (result.evidence ?? []).slice(0, 6);
  const resultSummary = typeof result.summary === 'string' ? result.summary.trim() : '';
  const reportText = typeof result.report === 'string' ? result.report.trim() : '';
  const terminalStatus = presentExploreAgentTerminalStatus(result.terminalStatus, result.ok, result.partial === true, result.reason);
  const status = result.ok
    ? '已完成'
    : result.reason === 'aborted' && result.partial === true
      ? '已取消 · 保留部分结果'
      : presentExploreAgentReason(result.reason) ?? '未完成';
  const reportLines = reportText.split('\n').filter((line) => line.trim().length > 0).slice(0, 8);
  const notes = result.notes.slice(0, 4);
  const roots = result.roots.length > 0 ? result.roots.join(', ') : '.';
  const queries = result.queries.length > 0 ? result.queries.join(', ') : '未指定';
  const ignoredPaths = Array.isArray(result.ignoredPaths) && result.ignoredPaths.length > 0
    ? result.ignoredPaths.join(', ')
    : '';
  const stoppingCondition = typeof result.stoppingCondition === 'string'
    ? result.stoppingCondition.trim()
    : '';
  const limitReasons = Array.isArray(result.limitReasons)
    ? result.limitReasons.map(presentExploreAgentLimitReason).filter(Boolean).join('、')
    : '';
  const filesDiscovered = typeof result.filesDiscovered === 'number' && Number.isFinite(result.filesDiscovered)
    ? Math.max(0, Math.floor(result.filesDiscovered))
    : result.filesInspected;
  const skippedSummary = result.sensitiveFilesSkipped && result.sensitiveFilesSkipped > 0
    ? `跳过 ${result.filesSkipped} 个（含敏感 ${result.sensitiveFilesSkipped} 个）`
    : `跳过 ${result.filesSkipped} 个`;
  const duration = formatDuration(result.durationMs);
  const summaryText = resultSummary.length > 0
    ? [
      `状态：${status}`,
      `终态：${terminalStatus}`,
      `目标：${result.objective || '只读探索'}`,
      `摘要：${resultSummary}`,
      `范围：${roots}`,
      `查询：${queries}`,
      `发现/读取：${filesDiscovered} / ${result.filesInspected} 个文件`,
      duration ? `耗时：${duration}` : '',
      ignoredPaths ? `忽略：${ignoredPaths}` : '',
      stoppingCondition ? `停止条件：${stoppingCondition}` : '',
      limitReasons ? `预算边界：${limitReasons}` : '',
    ].filter((line) => line.length > 0).join('\n')
    : '';
  const processText = [
    summaryText,
    processLines.length > 0 ? `事件：${processLines.length}` : '',
    processLines.join('\n'),
  ].filter((line) => line.trim().length > 0).join('\n').trim();
  const evidenceText = evidence.length > 0
    ? [
      `状态：${status}`,
      `终态：${terminalStatus}`,
      `目标：${result.objective || '只读探索'}`,
      `证据：${evidence.length}`,
      ...evidence.map((item) => [
        `- ${item.path}${typeof item.line === 'number' ? `:${item.line}` : ''}`,
        item.label,
        typeof item.score === 'number' ? `分数 ${item.score}` : '',
      ].filter(Boolean).join(' — ')),
    ].join('\n')
    : '';
  const candidateText = candidateFiles.length > 0
    ? [
      `状态：${status}`,
      `终态：${terminalStatus}`,
      `目标：${result.objective || '只读探索'}`,
      `发现/读取：${filesDiscovered} / ${result.filesInspected} 个文件`,
      `候选：${candidateFiles.length}`,
      ...candidateFiles.map((file) => [
        `- ${file.path}`,
        `分数 ${file.score}`,
        file.reasons.length > 0 ? presentExploreAgentCandidateReasons(file.reasons) : '',
      ].filter(Boolean).join(' — ')),
    ].join('\n')
    : '';
  const matchesText = matches.length > 0
    ? [
      `状态：${status}`,
      `终态：${terminalStatus}`,
      `目标：${result.objective || '只读探索'}`,
      `查询：${queries}`,
      `命中片段：${matches.length}`,
      ...matches.map((match) => `- ${match.path}:${match.line} [${match.query}] ${match.snippet}`),
    ].join('\n')
    : '';
  const needsContinuation =
    result.partial === true ||
    !result.ok ||
    Boolean(limitReasons) ||
    result.terminalStatus === 'completed_empty';
  const continuationReason = needsContinuation
    ? presentExploreAgentContinuationReason({
      partial: result.partial === true,
      ok: result.ok,
      hasLimitReasons: Boolean(limitReasons),
      terminalStatus: result.terminalStatus,
    })
    : '';
  const continuationText = needsContinuation
    ? [
      '继续这次只读探索，不要修改文件。',
      continuationReason ? `续研原因：${continuationReason}` : '',
      `上一轮状态：${status}`,
      `上一轮终态：${terminalStatus}`,
      `目标：${result.objective || '只读探索'}`,
      `范围：${roots}`,
      `查询：${queries}`,
      `发现/读取：${filesDiscovered} / ${result.filesInspected} 个文件`,
      duration ? `上一轮耗时：${duration}` : '',
      ignoredPaths ? `继续忽略：${ignoredPaths}` : '',
      stoppingCondition ? `停止条件：${stoppingCondition}` : '',
      limitReasons ? `上一轮预算边界：${limitReasons}` : '',
      resultSummary ? `上一轮摘要：${resultSummary}` : '',
      candidateFiles.length > 0
        ? [
          '优先补读候选：',
          ...candidateFiles.slice(0, 5).map((file) => `- ${file.path}（分数 ${file.score}）`),
        ].join('\n')
        : '',
      matches.length > 0
        ? [
          '已有命中片段：',
          ...matches.slice(0, 5).map((match) => `- ${match.path}:${match.line} [${match.query}] ${match.snippet}`),
        ].join('\n')
        : '',
      '请只读检查仍缺证据的部分，输出新的证据锚点、候选文件、结论和下一步 gate。',
    ].filter((line) => line.trim().length > 0).join('\n')
    : '';
  const copyPayloads = {
    summary: redactSecrets(summaryText),
    process: redactSecrets(processText),
    evidence: redactSecrets(evidenceText),
    report: redactSecrets(reportText),
    candidate: redactSecrets(candidateText),
    matches: redactSecrets(matchesText),
    continuation: redactSecrets(continuationText),
  };

  return {
    candidateFiles,
    matches,
    progress,
    evidence,
    resultSummary,
    reportLines,
    notes,
    roots,
    queries,
    ignoredPaths,
    stoppingCondition,
    limitReasons,
    filesDiscovered,
    skippedSummary,
    duration,
    terminalStatus,
    status,
    continuationReason,
    continuationText,
    copyPayloads,
  };
}

function presentExploreAgentTerminalStatus(
  terminalStatus: Extract<ToolResultContent, { kind: 'explore_agent' }>['terminalStatus'],
  ok: boolean,
  partial: boolean,
  reason: Extract<ToolResultContent, { kind: 'explore_agent' }>['reason'],
): string {
  switch (terminalStatus) {
    case 'completed':
      return '完成，有证据';
    case 'completed_empty':
      return '完成，无证据';
    case 'failed':
      return '失败';
    case 'canceled':
      return '已取消';
    case 'canceled_partial':
      return '已取消，有部分结果';
    case undefined:
      if (reason === 'aborted' && partial) return '已取消，有部分结果';
      if (reason === 'aborted') return '已取消';
      if (!ok) return '失败';
      return '完成';
    default:
      return '未知终态';
  }
}

function presentExploreAgentReason(
  reason: Extract<ToolResultContent, { kind: 'explore_agent' }>['reason'],
): string | undefined {
  switch (reason) {
    case 'invalid_objective':
      return '目标无效';
    case 'invalid_root':
      return '范围无效';
    case 'no_readable_roots':
      return '没有可读取范围';
    case 'aborted':
      return '已取消';
    case undefined:
      return undefined;
    default:
      return '未知诊断';
  }
}

function presentExploreAgentLimitReason(reason: string): string {
  switch (reason) {
    case 'candidate_budget':
      return '候选文件预算已满';
    case 'file_budget':
      return '读取文件预算已满';
    case 'match_budget':
      return '命中预算已满';
    case 'byte_budget':
      return '读取字节预算已满';
    default:
      return '';
  }
}

function presentExploreAgentContinuationReason(input: {
  partial: boolean;
  ok: boolean;
  hasLimitReasons: boolean;
  terminalStatus: Extract<ToolResultContent, { kind: 'explore_agent' }>['terminalStatus'];
}): string {
  if (input.partial) return '已有部分结果，仍需补证据';
  if (!input.ok) return '上一轮未完成';
  if (input.hasLimitReasons) return '达到预算边界';
  if (input.terminalStatus === 'completed_empty') return '没有找到证据';
  return '仍缺证据';
}

function formatExploreAgentEvent(event: { type: string; message: string; at?: number }, startedAt?: number): string {
  const label = presentExploreAgentEventType(event.type);
  const message = typeof event.message === 'string' ? event.message.trim() : '';
  const offset = formatExploreAgentEventOffset(event.at, startedAt);
  const prefix = [label, offset].filter(Boolean).join(' ');
  return prefix ? `${prefix}：${message}` : message;
}

function formatExploreAgentEventOffset(at: number | undefined, startedAt: number | undefined): string {
  if (typeof at !== 'number' || typeof startedAt !== 'number') return '';
  if (!Number.isFinite(at) || !Number.isFinite(startedAt)) return '';
  const delta = Math.max(0, Math.floor(at - startedAt));
  const formatted = formatDuration(delta);
  return formatted ? `+${formatted}` : '';
}

function presentExploreAgentEventType(type: string): string {
  switch (type) {
    case 'started':
      return '开始';
    case 'scope_resolved':
      return '范围';
    case 'scan':
      return '扫描';
    case 'read':
      return '读取';
    case 'checkpoint':
      return '进度';
    case 'completed':
      return '完成';
    case 'failed':
      return '失败';
    case 'aborted':
      return '取消';
    default:
      return '';
  }
}

function presentExploreAgentCandidateReasons(reasons: string[]): string {
  return reasons.map((reason) => {
    if (reason === 'content match') return '内容命中';
    if (reason === 'project manifest') return '项目配置';
    if (reason === 'project documentation') return '项目文档';
    if (reason === 'project entrypoint') return '入口文件';
    if (reason === 'project test surface') return '测试线索';
    if (reason === 'project source surface') return '源码线索';
    const pathMatch = reason.match(/^path contains "(.+)"$/);
    if (pathMatch) return `路径命中 ${redactSecrets(pathMatch[1] ?? '')}`;
    return '探索线索';
  }).join(', ');
}
