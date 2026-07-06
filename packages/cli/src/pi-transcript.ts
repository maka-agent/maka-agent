import {
  Markdown,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type MarkdownTheme,
} from '@earendil-works/pi-tui';
import type {
  PermissionRequestEvent,
  SessionEvent,
  ToolOutputStream,
  ToolResultContent,
} from '@maka/core/events';
import type { StoredMessage, SystemNoteMessage } from '@maka/core/session';
import type { ContextBudgetDiagnostic } from '@maka/core/usage-stats/types';
import type { ThinkingLevel } from '@maka/core/model-thinking';
import { materializeSession, type ChatItem, type ToolActivityItem } from '@maka/runtime';
import type { MakaSessionDriver } from './session-driver.js';
import { ansi } from './tui-ansi.js';
import { colorDiff } from './tui-diff.js';

export interface MakaPiTranscriptState {
  entries: MakaPiTranscriptEntry[];
  sawTextDeltaMessageIds: Set<string>;
  pendingPermission?: PermissionRequestEvent;
  /**
   * Per-tool expansion state, keyed by toolUseId. Ctrl+O toggles the latest
   * tool, but earlier tools stay expanded across later turns within a session.
   * In-memory only; never persisted to storage. Resume starts empty.
   */
  expandedToolUseIds: Set<string>;
  expandedThinkingMessageId?: string;
}

/** A single live output chunk from a `tool_output_delta` event. */
export interface MakaPiToolOutputDelta {
  seq: number;
  stream: ToolOutputStream;
  chunk: string;
  redacted: boolean;
}

export type MakaPiTranscriptEntry =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; messageId: string; text: string; thinking?: string }
  | {
      kind: 'tool';
      toolUseId: string;
      toolName: string;
      title?: string;
      input: unknown;
      /** Structured result; preferred over `output` when present. */
      result?: ToolResultContent;
      /** Flattened result text, kept as a fallback for text/json/unknown kinds. */
      output?: string;
      progress: string[];
      outputDeltas: MakaPiToolOutputDelta[];
      durationMs?: number;
      status: 'running' | 'done' | 'error';
    }
  | { kind: 'notice'; level: 'info' | 'error'; text: string };

export interface MakaPiTranscriptMetadata {
  title: string;
  cwd: string;
  model: string;
  connectionSlug: string;
  permissionMode: string;
  thinkingLevel?: ThinkingLevel;
  thinkingLevels?: readonly ThinkingLevel[];
  sessionId?: string | null;
  busy?: boolean;
}

export function createMakaPiTranscriptState(): MakaPiTranscriptState {
  return {
    entries: [],
    sawTextDeltaMessageIds: new Set(),
    expandedToolUseIds: new Set(),
  };
}

export function appendUserPrompt(state: MakaPiTranscriptState, text: string): void {
  state.entries.push({ kind: 'user', text });
}

export function replaceTranscriptWithStoredMessages(
  state: MakaPiTranscriptState,
  messages: readonly StoredMessage[],
): void {
  const view = materializeSession(messages);
  state.entries = view.items
    .map(chatItemToTranscriptEntry)
    .filter((entry): entry is MakaPiTranscriptEntry => entry !== undefined);
  state.sawTextDeltaMessageIds = new Set(
    state.entries
      .filter((entry): entry is Extract<MakaPiTranscriptEntry, { kind: 'assistant' }> => entry.kind === 'assistant')
      .map((entry) => entry.messageId),
  );
  state.pendingPermission = undefined;
  state.expandedToolUseIds = new Set();
  state.expandedThinkingMessageId = undefined;
}

export function toggleLatestToolExpansion(state: MakaPiTranscriptState): boolean {
  const latestTool = [...state.entries]
    .reverse()
    .find((entry): entry is MakaPiToolEntry => entry.kind === 'tool');
  if (!latestTool) return false;
  if (state.expandedToolUseIds.has(latestTool.toolUseId)) {
    state.expandedToolUseIds.delete(latestTool.toolUseId);
  } else {
    state.expandedToolUseIds.add(latestTool.toolUseId);
  }
  return true;
}

export function toggleLatestThinkingExpansion(state: MakaPiTranscriptState): boolean {
  const latestThinking = [...state.entries]
    .reverse()
    .find(
      (entry): entry is MakaPiAssistantEntry =>
        entry.kind === 'assistant' && Boolean(entry.thinking?.trim()),
    );
  if (!latestThinking) return false;
  state.expandedThinkingMessageId = state.expandedThinkingMessageId === latestThinking.messageId
    ? undefined
    : latestThinking.messageId;
  return true;
}

export async function submitPromptToTranscript(input: {
  state: MakaPiTranscriptState;
  driver: Pick<MakaSessionDriver, 'sendPrompt'>;
  prompt: string;
  onChange?: () => void;
}): Promise<void> {
  appendUserPrompt(input.state, input.prompt);
  input.onChange?.();

  try {
    for await (const event of input.driver.sendPrompt(input.prompt)) {
      applyMakaSessionEventToTranscript(input.state, event);
      input.onChange?.();
    }
  } catch (error) {
    input.state.entries.push({
      kind: 'notice',
      level: 'error',
      text: error instanceof Error ? error.message : String(error),
    });
    input.onChange?.();
  }
}

export async function submitCompactToTranscript(input: {
  state: MakaPiTranscriptState;
  driver: Pick<MakaSessionDriver, 'compactSession'>;
  onChange?: () => void;
}): Promise<void> {
  let completed = false;
  let sawCompactionNotice = false;
  try {
    for await (const event of input.driver.compactSession()) {
      if (event.type === 'token_usage' && contextBudgetOutcomeNotice(event.contextBudget)) sawCompactionNotice = true;
      if (event.type === 'complete' && event.stopReason === 'end_turn') completed = true;
      applyMakaSessionEventToTranscript(input.state, event);
      input.onChange?.();
    }
    if (completed && !sawCompactionNotice) {
      input.state.entries.push({
        kind: 'notice',
        level: 'info',
        text: 'Nothing to compact.',
      });
      input.onChange?.();
    }
  } catch (error) {
    input.state.entries.push({
      kind: 'notice',
      level: 'error',
      text: error instanceof Error ? error.message : String(error),
    });
    input.onChange?.();
  }
}

export function applyMakaSessionEventToTranscript(
  state: MakaPiTranscriptState,
  event: SessionEvent,
): void {
  switch (event.type) {
    case 'text_delta':
      state.sawTextDeltaMessageIds.add(event.messageId);
      appendAssistantText(state, event.messageId, event.text);
      break;

    case 'text_complete':
      if (!state.sawTextDeltaMessageIds.has(event.messageId) && event.text) {
        appendAssistantText(state, event.messageId, event.text);
      }
      break;

    case 'thinking_delta':
      appendAssistantThinking(state, event.messageId, event.text);
      break;

    case 'thinking_complete':
      if (event.text) setAssistantThinking(state, event.messageId, event.text);
      break;

    case 'tool_start':
      state.entries.push({
        kind: 'tool',
        toolUseId: event.toolUseId,
        toolName: event.toolName,
        ...(event.displayName ? { title: event.displayName } : {}),
        input: event.args,
        progress: [],
        outputDeltas: [],
        status: 'running',
      });
      break;

    case 'tool_result': {
      const tool = findToolEntry(state, event.toolUseId);
      if (tool) {
        tool.status = event.isError ? 'error' : 'done';
        tool.result = event.content;
        tool.output = formatToolResultContent(event.content);
        tool.durationMs = event.durationMs;
      } else {
        state.entries.push({
          kind: 'tool',
          toolUseId: event.toolUseId,
          toolName: event.toolUseId,
          input: undefined,
          progress: [],
          outputDeltas: [],
          result: event.content,
          output: formatToolResultContent(event.content),
          durationMs: event.durationMs,
          status: event.isError ? 'error' : 'done',
        });
      }
      break;
    }

    case 'tool_progress': {
      const tool = findToolEntry(state, event.toolUseId);
      if (tool) {
        tool.progress.push(typeof event.chunk === 'string' ? event.chunk : `[${event.chunk.kind}] ${event.chunk.text}`);
      }
      break;
    }

    case 'tool_output_delta': {
      const tool = findToolEntry(state, event.toolUseId);
      if (tool) {
        tool.outputDeltas.push({
          seq: event.seq,
          stream: event.stream,
          chunk: event.chunk,
          redacted: event.redacted,
        });
      }
      break;
    }

    case 'permission_request':
      state.pendingPermission = event;
      break;

    case 'permission_decision_ack':
      if (state.pendingPermission?.requestId === event.requestId) {
        const toolName = state.pendingPermission.toolName;
        state.pendingPermission = undefined;
        state.entries.push({
          kind: 'notice',
          level: 'info',
          text: `Permission ${event.decision}ed for ${toolName}`,
        });
      }
      break;

    case 'plan_submitted':
      state.entries.push({
        kind: 'notice',
        level: 'info',
        text: `Plan submitted: ${event.title}`,
      });
      break;

    case 'token_usage': {
      const notice = contextBudgetOutcomeNotice(event.contextBudget);
      if (notice) {
        state.entries.push({
          kind: 'notice',
          level: notice.level,
          text: notice.text,
        });
      }
      break;
    }

    case 'error':
      state.pendingPermission = undefined;
      state.entries.push({
        kind: 'notice',
        level: 'error',
        text: event.message,
      });
      break;

    case 'abort':
      state.pendingPermission = undefined;
      state.entries.push({
        kind: 'notice',
        level: 'info',
        text: `Stopped: ${event.reason}`,
      });
      break;

    case 'complete':
      // The turn is over; any unresolved permission request is no longer actionable.
      state.pendingPermission = undefined;
      if (event.stopReason === 'max_tokens') {
        state.entries.push({
          kind: 'notice',
          level: 'info',
          text: 'Stopped: max tokens',
        });
      }
      break;
  }
}

function chatItemToTranscriptEntry(item: ChatItem): MakaPiTranscriptEntry | undefined {
  switch (item.kind) {
    case 'user':
      return { kind: 'user', text: item.message.text };
    case 'assistant':
      return {
        kind: 'assistant',
        messageId: item.message.id,
        text: item.message.text,
        ...(item.message.thinking?.text ? { thinking: item.message.thinking.text } : {}),
      };
    case 'tool':
      return toolActivityToTranscriptEntry(item.item);
    case 'system_note':
      return systemNoteToTranscriptEntry(item.message);
  }
}

function toolActivityToTranscriptEntry(item: ToolActivityItem): MakaPiTranscriptEntry {
  const output = item.result
    ? formatToolResultContent(item.result)
    : item.status === 'interrupted'
      ? 'Interrupted before the tool returned a result.'
      : undefined;
  return {
    kind: 'tool',
    toolUseId: item.toolUseId,
    toolName: item.toolName,
    ...(item.displayName ? { title: item.displayName } : {}),
    input: item.args,
    progress: [],
    outputDeltas: [],
    ...(item.result ? { result: item.result } : {}),
    ...(output ? { output } : {}),
    ...(item.durationMs !== undefined ? { durationMs: item.durationMs } : {}),
    status: transcriptToolStatus(item.status),
  };
}

function transcriptToolStatus(status: ToolActivityItem['status']): MakaPiToolEntry['status'] {
  switch (status) {
    case 'completed':
      return 'done';
    case 'errored':
    case 'interrupted':
      return 'error';
    case 'pending':
    case 'waiting_permission':
    case 'running':
      return 'running';
  }
}

function systemNoteToTranscriptEntry(message: SystemNoteMessage): MakaPiTranscriptEntry | undefined {
  const text = systemNoteText(message);
  if (!text) return undefined;
  return {
    kind: 'notice',
    level: message.kind === 'error' ? 'error' : 'info',
    text,
  };
}

function contextBudgetOutcomeNotice(
  contextBudget: ContextBudgetDiagnostic | undefined,
): { level: 'info' | 'error'; text: string } | undefined {
  const failedOpen = contextBudgetFailureNoticeText(contextBudget);
  if (failedOpen) return { level: 'error', text: failedOpen };
  const replaced = contextBudgetNoticeText(contextBudget);
  if (replaced) return { level: 'info', text: replaced };
  return undefined;
}

function contextBudgetNoticeText(contextBudget: ContextBudgetDiagnostic | undefined): string | undefined {
  const decision = contextBudget?.compactionDecisions?.find((candidate) => candidate.decision === 'replaced');
  if (!contextBudget || !decision) return undefined;
  const kind = decision.boundaryKind ?? contextBudget.highWaterReason ?? 'context';
  const coveredTurns = decision.coveredTurns ?? contextBudget.historyCompactedTurns;
  const coveredEvents = decision.coveredRuntimeEvents ?? contextBudget.historyCompactedEvents;
  const savedTokens = decision.estimatedTokensSaved
    ?? tokenDelta(contextBudget.historyCompactedEstimatedTokensBefore, contextBudget.historyCompactedEstimatedTokensAfter)
    ?? tokenDelta(contextBudget.estimatedTokensBefore, contextBudget.estimatedTokensAfter);
  const parts = [`Context compacted: ${kind}`];
  if (coveredTurns !== undefined || coveredEvents !== undefined) {
    parts.push(`${coveredTurns ?? '?'} turns / ${coveredEvents ?? '?'} events`);
  }
  if (savedTokens !== undefined && savedTokens > 0) parts.push(`saved ~${Math.round(savedTokens)} tokens`);
  return `${parts.join('; ')}.`;
}

function contextBudgetFailureNoticeText(contextBudget: ContextBudgetDiagnostic | undefined): string | undefined {
  const decision = contextBudget?.compactionDecisions?.find((candidate) => candidate.decision === 'failedOpen');
  const reason = decision?.failOpenReason ?? decision?.reason;
  if (!decision || !reason) return undefined;
  return `Context compaction skipped: ${reason}.`;
}

function tokenDelta(before: number | undefined, after: number | undefined): number | undefined {
  if (before === undefined || after === undefined) return undefined;
  return Math.max(0, before - after);
}

function systemNoteText(message: SystemNoteMessage): string | undefined {
  switch (message.kind) {
    case 'session_start':
    case 'session_resume':
      return undefined;
    case 'mode_change':
      return 'Permission mode changed.';
    case 'model_change':
      return 'Model changed.';
    case 'error':
      return 'Session recorded an error.';
    case 'abort':
      return 'Session was stopped.';
  }
}

export function renderMakaPiTranscript(
  state: MakaPiTranscriptState,
  _metadata: MakaPiTranscriptMetadata,
  width: number,
): string[] {
  const safeWidth = Math.max(1, width);
  const lines: string[] = [];

  for (const entry of state.entries) {
    lines.push('');
    switch (entry.kind) {
      case 'user':
        lines.push(...renderTextBlock('User', entry.text, safeWidth, { markdown: false, heading: ansi.accent }));
        break;
      case 'assistant':
        lines.push(...renderAssistantBlock(entry, safeWidth, state.expandedThinkingMessageId === entry.messageId));
        break;
      case 'tool':
        lines.push(...renderToolBlock(entry, safeWidth, state.expandedToolUseIds.has(entry.toolUseId)));
        break;
      case 'notice':
        lines.push(...renderNotice(entry, safeWidth));
        break;
    }
  }

  if (state.pendingPermission) {
    lines.push('');
    lines.push(...renderPermissionPrompt(state.pendingPermission, safeWidth));
  }

  return lines;
}

export function renderMakaPiStatusLine(metadata: MakaPiTranscriptMetadata, width: number): string {
  const safeWidth = Math.max(1, width);
  const thinking = metadata.thinkingLevel ? ansi.dim(` thinking:${metadata.thinkingLevel}`) : '';
  return fitLine(
    `${ansi.bold(metadata.title)} ${ansi.dim(metadata.model)} ${ansi.dim(metadata.connectionSlug)} ${ansi.dim(metadata.permissionMode)}${thinking} ${ansi.dim(metadata.cwd)}`,
    safeWidth,
  );
}

function appendAssistantText(state: MakaPiTranscriptState, messageId: string, text: string): void {
  const last = state.entries[state.entries.length - 1];
  if (last?.kind === 'assistant' && last.messageId === messageId) {
    last.text += text;
    return;
  }
  state.entries.push({ kind: 'assistant', messageId, text });
}

function appendAssistantThinking(state: MakaPiTranscriptState, messageId: string, text: string): void {
  const last = state.entries[state.entries.length - 1];
  if (last?.kind === 'assistant' && last.messageId === messageId) {
    last.thinking = (last.thinking ?? '') + text;
    return;
  }
  state.entries.push({ kind: 'assistant', messageId, text: '', thinking: text });
}

function setAssistantThinking(state: MakaPiTranscriptState, messageId: string, text: string): void {
  const last = state.entries[state.entries.length - 1];
  if (last?.kind === 'assistant' && last.messageId === messageId) {
    last.thinking = text;
    return;
  }
  state.entries.push({ kind: 'assistant', messageId, text: '', thinking: text });
}

function renderAssistantBlock(entry: MakaPiAssistantEntry, width: number, thinkingExpanded: boolean): string[] {
  const lines = renderTextBlock('maka', entry.text, width, { markdown: true, heading: ansi.accent });
  // Thinking stays collapsed to a one-line marker by default so reasoning
  // never floods the scrollback; Ctrl+T expands the latest block on demand.
  if (entry.thinking && entry.thinking.trim()) {
    if (thinkingExpanded) {
      lines.push(fitLine(ansi.dim('思考'), width));
      lines.push(...renderIndented(entry.thinking, width, 2).map((line) => fitLine(ansi.dim(line), width)));
    } else {
      lines.push(ansi.dim('思考（Ctrl+T 展开）'));
    }
  }
  return lines;
}

type MakaPiAssistantEntry = Extract<MakaPiTranscriptEntry, { kind: 'assistant' }>;

type MakaPiToolEntry = Extract<MakaPiTranscriptEntry, { kind: 'tool' }>;
type MakaPiNoticeEntry = Extract<MakaPiTranscriptEntry, { kind: 'notice' }>;

function findToolEntry(state: MakaPiTranscriptState, toolUseId: string): MakaPiToolEntry | undefined {
  return [...state.entries]
    .reverse()
    .find((entry): entry is MakaPiToolEntry => entry.kind === 'tool' && entry.toolUseId === toolUseId);
}

function renderTextBlock(
  label: string,
  text: string,
  width: number,
  options: { markdown: boolean; heading: (text: string) => string },
): string[] {
  const lines = [fitLine(options.heading(label), width)];
  if (!text.trim()) return lines;

  const bodyLines = options.markdown
    ? new Markdown(text, 2, 0, markdownTheme, undefined, { preserveOrderedListMarkers: true }).render(width)
    : renderIndented(text, width, 2);
  lines.push(...bodyLines.map((line) => fitLine(line, width)));
  return lines;
}

interface RenderedToolPart {
  lines: string[];
  /** True when compact rendering hides detail that expanding would reveal. */
  truncated: boolean;
}

function renderToolBlock(entry: MakaPiToolEntry, width: number, expanded: boolean): string[] {
  const status = entry.status === 'running'
    ? ansi.yellow('running')
    : entry.status === 'error'
      ? ansi.red('error')
      : ansi.green('done');
  const duration = entry.durationMs === undefined ? '' : ansi.dim(` ${entry.durationMs}ms`);
  const lines = [
    fitLine(`${ansi.yellow('Tool')} ${entry.title ?? entry.toolName} ${status}${duration}`, width),
  ];
  let truncated = false;

  const inputSummary = toolInputSummary(entry);
  if (inputSummary) lines.push(...renderIndented(inputSummary, width, 2).map(ansi.dim));

  if (entry.progress.length > 0) {
    const progress = renderToolText(entry.progress.join(''), width, expanded);
    lines.push(...progress.lines.map(ansi.dim));
    truncated = truncated || progress.truncated;
  }

  const streams = renderToolStreams(entry.outputDeltas, width, expanded);
  lines.push(...streams.lines);
  truncated = truncated || streams.truncated;

  if (entry.result || entry.output) {
    const result = renderToolResult(entry, width, expanded);
    lines.push(...result.lines);
    truncated = truncated || result.truncated;
  }

  if (!expanded && truncated) {
    lines.push(fitLine(ansi.dim('Ctrl+O expand'), width));
  }
  return lines.map((line) => fitLine(line, width));
}

function renderToolText(text: string, width: number, expanded: boolean): RenderedToolPart {
  const limit = expanded ? 12_000 : 600;
  return {
    lines: renderIndented(limitText(text, limit), width, 2),
    truncated: !expanded && text.length > limit,
  };
}

/**
 * Render live `tool_output_delta` chunks. Chunks are de-duped and ordered by
 * `seq` (so a late or repeated seq cannot corrupt the display), consecutive
 * same-stream chunks are grouped under a single dim `[stream]` label, and any
 * redacted chunk shows a `[redacted]` marker instead of its raw content.
 */
function renderToolStreams(
  deltas: readonly MakaPiToolOutputDelta[],
  width: number,
  expanded: boolean,
): RenderedToolPart {
  const groups = groupOutputDeltas(deltas);
  if (groups.length === 0) return { lines: [], truncated: false };
  const lines: string[] = [];
  let truncated = false;
  for (const group of groups) {
    lines.push(fitLine(ansi.dim(`[${group.stream}]`), width));
    const body = renderToolText(group.text, width, expanded);
    lines.push(...body.lines.map(ansi.dim));
    truncated = truncated || body.truncated;
  }
  return { lines, truncated };
}

function groupOutputDeltas(
  deltas: readonly MakaPiToolOutputDelta[],
): Array<{ stream: ToolOutputStream; text: string }> {
  const bySeq = new Map<number, MakaPiToolOutputDelta>();
  for (const delta of deltas) {
    if (!bySeq.has(delta.seq)) bySeq.set(delta.seq, delta);
  }
  const ordered = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  const groups: Array<{ stream: ToolOutputStream; text: string }> = [];
  for (const delta of ordered) {
    const chunk = delta.redacted ? '[redacted]' : delta.chunk;
    const last = groups[groups.length - 1];
    if (last && last.stream === delta.stream) {
      last.text += chunk;
    } else {
      groups.push({ stream: delta.stream, text: chunk });
    }
  }
  return groups;
}

function renderToolResult(entry: MakaPiToolEntry, width: number, expanded: boolean): RenderedToolPart {
  const result = entry.result;
  if (result?.kind === 'terminal') return renderTerminalResult(result, width, expanded);
  if (result?.kind === 'file_diff') return renderDiffResult(result.diff, width, expanded);
  if (result?.kind === 'file_write') {
    return { lines: renderIndented(`Wrote ${result.bytes} bytes to ${result.path}`, width, 2), truncated: false };
  }

  const text = plainResultText(entry);
  if (entry.toolName === 'Read') return renderReadResult(text, width, expanded);
  if (entry.toolName === 'Grep') return renderGrepResult(text, width, expanded);
  return renderToolText(text, width, expanded);
}

/** Best-effort extraction of the human-readable body from a tool result. */
function plainResultText(entry: MakaPiToolEntry): string {
  const result = entry.result;
  if (result?.kind === 'text') return result.text;
  if (result?.kind === 'json') {
    const value = result.value;
    if (value !== null && typeof value === 'object') {
      const content = (value as { content?: unknown }).content;
      if (typeof content === 'string') return content;
      const matches = (value as { matches?: unknown }).matches;
      if (Array.isArray(matches)) return matches.map((row) => String(row)).join('\n');
    }
    return formatUnknown(value);
  }
  return entry.output ?? '';
}

function renderTerminalResult(
  content: Extract<ToolResultContent, { kind: 'terminal' }>,
  width: number,
  expanded: boolean,
): RenderedToolPart {
  const lines: string[] = [];
  let truncated = false;
  if (content.exitCode !== 0) {
    lines.push(...renderIndented(ansi.red(`exit ${content.exitCode}`), width, 2));
  }

  if (expanded) {
    if (content.stdout) {
      const body = renderToolText(content.stdout, width, true);
      lines.push(...body.lines);
    }
    if (content.stderr) {
      lines.push(...renderIndented(ansi.dim('[stderr]'), width, 2));
      const body = renderToolText(content.stderr, width, true);
      lines.push(...body.lines.map(ansi.dim));
    }
    return { lines, truncated: false };
  }

  // Compact: the tail of combined output is where results and errors land.
  const combined = [content.stdout, content.stderr].filter(Boolean).join('\n');
  const tail = tailLines(combined, 5);
  if (tail.text) lines.push(...renderIndented(tail.text, width, 2));
  truncated = truncated || tail.hidden > 0;
  return { lines, truncated };
}

function renderReadResult(text: string, width: number, expanded: boolean): RenderedToolPart {
  if (expanded) {
    return { lines: renderIndented(limitText(text, 12_000), width, 2), truncated: false };
  }
  if (!text) return { lines: [], truncated: false };
  const lineCount = text.split('\n').length;
  const summary = `${lineCount} line${lineCount === 1 ? '' : 's'}, ${byteLength(text)} bytes`;
  return { lines: renderIndented(summary, width, 2).map(ansi.dim), truncated: true };
}

function renderGrepResult(text: string, width: number, expanded: boolean): RenderedToolPart {
  if (expanded) {
    return { lines: renderIndented(limitText(text, 12_000), width, 2), truncated: false };
  }
  const allLines = text ? text.split('\n') : [];
  const head = allLines.slice(0, 5);
  const hidden = allLines.length - head.length;
  const lines = head.length > 0 ? renderIndented(head.join('\n'), width, 2) : [];
  if (hidden > 0) {
    lines.push(...renderIndented(ansi.dim(`… +${hidden} more matches`), width, 2));
  }
  return { lines, truncated: hidden > 0 };
}

function renderDiffResult(diff: string, width: number, expanded: boolean): RenderedToolPart {
  const capped = expanded ? limitText(diff, 12_000) : diff;
  const allLines = capped.split('\n');
  const maxLines = expanded ? allLines.length : 8;
  const shown = allLines.slice(0, maxLines);
  const hidden = allLines.length - shown.length;
  const lines = renderIndented(colorDiff(shown.join('\n')), width, 2);
  if (!expanded && hidden > 0) {
    lines.push(...renderIndented(ansi.dim(`… +${hidden} more lines`), width, 2));
  }
  return { lines, truncated: !expanded && hidden > 0 };
}

/** Return the last `count` lines of `text` plus how many earlier lines were dropped. */
function tailLines(text: string, count: number): { text: string; hidden: number } {
  if (!text) return { text: '', hidden: 0 };
  const allLines = text.split('\n');
  if (allLines.length <= count) return { text, hidden: 0 };
  return { text: allLines.slice(-count).join('\n'), hidden: allLines.length - count };
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function toolInputSummary(entry: MakaPiToolEntry): string {
  const input = entry.input;
  const obj = input !== null && typeof input === 'object' ? (input as Record<string, unknown>) : undefined;
  switch (entry.toolName) {
    case 'Bash': {
      const command = obj?.command;
      if (typeof command === 'string' && command.trim()) {
        return `$ ${command.split('\n')[0]}`;
      }
      break;
    }
    case 'Read': {
      const path = obj?.path;
      if (typeof path === 'string' && path.trim()) {
        const parts = [path];
        if (typeof obj?.offset === 'number') parts.push(`offset ${obj.offset}`);
        if (typeof obj?.limit === 'number') parts.push(`limit ${obj.limit}`);
        return parts.join(' ');
      }
      break;
    }
    case 'Write':
    case 'Edit': {
      const path = obj?.path;
      if (typeof path === 'string' && path.trim()) return path;
      break;
    }
    case 'Grep': {
      const pattern = obj?.pattern;
      if (typeof pattern === 'string' && pattern.trim()) {
        const parts = [pattern];
        if (typeof obj?.path === 'string' && obj.path.trim()) parts.push(`in ${obj.path}`);
        if (typeof obj?.glob === 'string' && obj.glob.trim()) parts.push(`glob ${obj.glob}`);
        return parts.join(' ');
      }
      break;
    }
  }
  if (input === undefined) return '';
  return `input: ${limitText(formatUnknown(input), 600)}`;
}

function renderNotice(entry: MakaPiNoticeEntry, width: number): string[] {
  const label = entry.level === 'error' ? ansi.red('Error') : ansi.dim('Note');
  return renderIndented(`${label}: ${entry.text}`, width, 0).map((line) => fitLine(line, width));
}

function renderPermissionPrompt(request: PermissionRequestEvent, width: number): string[] {
  const lines = [
    fitLine(`${ansi.yellow('Permission required')} ${ansi.bold(request.toolName)} ${ansi.dim(request.category)}`, width),
  ];
  const summary = permissionRequestSummary(request);
  if (summary) lines.push(...renderIndented(summary, width, 2));
  if (request.hint) lines.push(...renderIndented(request.hint, width, 2).map(ansi.dim));
  lines.push(fitLine(ansi.dim('y/Enter allow  n/Esc deny'), width));
  return lines;
}

function permissionRequestSummary(request: PermissionRequestEvent): string {
  const args = request.args;
  if (request.toolName === 'Bash' && args !== null && typeof args === 'object') {
    const command = (args as { command?: unknown }).command;
    if (typeof command === 'string' && command.trim()) return `$ ${command}`;
  }
  if ((request.toolName === 'Write' || request.toolName === 'Edit') && args !== null && typeof args === 'object') {
    const path = (args as { path?: unknown }).path;
    if (typeof path === 'string' && path.trim()) return path;
  }
  return limitText(formatUnknown(request.args), 600);
}

function renderIndented(text: string, width: number, indent: number): string[] {
  const prefix = ' '.repeat(indent);
  const contentWidth = Math.max(1, width - indent);
  const out: string[] = [];
  for (const rawLine of text.split('\n')) {
    const wrapped = wrapTextWithAnsi(rawLine, contentWidth);
    for (const line of wrapped.length > 0 ? wrapped : ['']) {
      out.push(prefix + line);
    }
  }
  return out;
}

function fitLine(line: string, width: number): string {
  return visibleWidth(line) > width ? truncateToWidth(line, width, '') : line;
}

function formatToolResultContent(content: ToolResultContent): string {
  switch (content.kind) {
    case 'text':
      return content.text;
    case 'json':
      return formatUnknown(content.value);
    case 'terminal':
      return [
        `$ ${content.cmd}`,
        `cwd: ${content.cwd}`,
        `exit: ${content.exitCode}`,
        content.stdout ? `stdout:\n${content.stdout}` : '',
        content.stderr ? `stderr:\n${content.stderr}` : '',
      ].filter(Boolean).join('\n\n');
    case 'file_diff':
      return content.diff;
    case 'file_write':
      return `Wrote ${content.bytes} bytes to ${content.path}`;
    case 'summary':
      return content.summarized;
    case 'image':
      return `${content.mimeType} image result`;
    case 'web_search':
      return [
        `Search ${content.provider}: ${content.query}`,
        ...content.rows.map((row) => `${row.title}\n${row.url}\n${row.snippet}`),
      ].join('\n\n');
    case 'web_search_error':
      return content.message;
    case 'office_document':
      return content.message ?? [content.operation, content.path, content.stdout, content.stderr].filter(Boolean).join('\n');
    case 'explore_agent':
      return content.report ?? content.summary ?? content.message ?? `Inspected ${content.filesInspected} files`;
    case 'subagent':
      return content.summary;
    case 'rive_workflow':
      return content.summary;
    case 'archived_tool_result':
      return `Archived tool result: ${content.status}`;
  }
}

function formatUnknown(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function limitText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n... ${text.length - maxChars} chars truncated`;
}

const markdownTheme: MarkdownTheme = {
  heading: ansi.accent,
  link: ansi.underline,
  linkUrl: ansi.dim,
  code: ansi.yellow,
  codeBlock: (text) => text,
  codeBlockBorder: ansi.dim,
  quote: ansi.dim,
  quoteBorder: ansi.dim,
  hr: ansi.dim,
  listBullet: ansi.accent,
  bold: ansi.bold,
  italic: ansi.italic,
  strikethrough: ansi.strikethrough,
  underline: ansi.underline,
};
