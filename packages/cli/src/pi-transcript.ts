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
import { colorDiff, diffLineKind } from './tui-diff.js';

export interface MakaPiTranscriptState {
  entries: MakaPiTranscriptEntry[];
  sawTextDeltaMessageIds: Set<string>;
  pendingPermission?: PermissionRequestEvent;
  /**
   * Global expansion toggles: one Ctrl+O press expands every tool card in the
   * transcript, one Ctrl+T press expands every thinking entry; pressing again
   * collapses all. In-memory only; never persisted to storage. Resume resets
   * both to collapsed.
   */
  expandAllTools: boolean;
  expandAllThinking: boolean;
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
  | { kind: 'assistant'; messageId: string; text: string }
  | { kind: 'thinking'; messageId: string; text: string }
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
    expandAllTools: false,
    expandAllThinking: false,
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
  state.entries = view.items.flatMap(chatItemToTranscriptEntries);
  state.sawTextDeltaMessageIds = new Set(
    state.entries
      .filter((entry): entry is Extract<MakaPiTranscriptEntry, { kind: 'assistant' }> => entry.kind === 'assistant')
      .map((entry) => entry.messageId),
  );
  state.pendingPermission = undefined;
  state.expandAllTools = false;
  state.expandAllThinking = false;
}

/** Toggle expansion of every tool card at once; false when there is none. */
export function toggleAllToolExpansion(state: MakaPiTranscriptState): boolean {
  const hasTool = state.entries.some((entry) => entry.kind === 'tool');
  if (!hasTool) return false;
  state.expandAllTools = !state.expandAllTools;
  return true;
}

/** Toggle expansion of every thinking entry at once; false when there is none. */
export function toggleAllThinkingExpansion(state: MakaPiTranscriptState): boolean {
  const hasThinking = state.entries.some(
    (entry) => entry.kind === 'thinking' && Boolean(entry.text.trim()),
  );
  if (!hasThinking) return false;
  state.expandAllThinking = !state.expandAllThinking;
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
      appendThinking(state, event.messageId, event.text);
      break;

    case 'thinking_complete':
      if (event.text) setThinking(state, event.messageId, event.text);
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

function chatItemToTranscriptEntries(item: ChatItem): MakaPiTranscriptEntry[] {
  switch (item.kind) {
    case 'user':
      return [{ kind: 'user', text: item.message.text }];
    case 'assistant': {
      const entries: MakaPiTranscriptEntry[] = [];
      // Stored thinking happened before the reply text, so it resumes above it.
      const thinking = item.message.thinking?.text;
      if (thinking?.trim()) {
        entries.push({ kind: 'thinking', messageId: item.message.id, text: thinking });
      }
      entries.push({ kind: 'assistant', messageId: item.message.id, text: item.message.text });
      return entries;
    }
    case 'tool':
      return [toolActivityToTranscriptEntry(item.item)];
    case 'system_note': {
      const entry = systemNoteToTranscriptEntry(item.message);
      return entry ? [entry] : [];
    }
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
    case 'context_compacted':
      return 'Context compacted to keep this session within the model window.';
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
        lines.push(...renderTextBlock('maka', entry.text, safeWidth, { markdown: true, heading: ansi.accent }));
        break;
      case 'thinking':
        lines.push(...renderThinkingBlock(entry, safeWidth, state.expandAllThinking));
        break;
      case 'tool':
        lines.push(...renderToolBlock(entry, safeWidth, state.expandAllTools));
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

function appendThinking(state: MakaPiTranscriptState, messageId: string, text: string): void {
  const last = state.entries[state.entries.length - 1];
  if (last?.kind === 'thinking' && last.messageId === messageId) {
    last.text += text;
    return;
  }
  state.entries.push({ kind: 'thinking', messageId, text });
}

function setThinking(state: MakaPiTranscriptState, messageId: string, text: string): void {
  // thinking_complete can arrive after the reply text or tool events; replace
  // the streamed entry wherever it sits instead of appending a duplicate.
  for (let index = state.entries.length - 1; index >= 0; index -= 1) {
    const entry = state.entries[index];
    if (entry?.kind === 'thinking' && entry.messageId === messageId) {
      entry.text = text;
      return;
    }
  }
  state.entries.push({ kind: 'thinking', messageId, text });
}

// Thinking stays collapsed to a one-line marker by default so reasoning
// never floods the scrollback; Ctrl+T expands every thinking entry on demand.
function renderThinkingBlock(entry: MakaPiThinkingEntry, width: number, expanded: boolean): string[] {
  if (!entry.text.trim()) return [];
  if (!expanded) return [fitLine(ansi.dim('思考（Ctrl+T 展开）'), width)];
  const lines = [fitLine(ansi.dim('思考'), width)];
  lines.push(...renderIndented(entry.text, width, 2).map((line) => fitLine(ansi.dim(line), width)));
  return lines;
}

type MakaPiAssistantEntry = Extract<MakaPiTranscriptEntry, { kind: 'assistant' }>;
type MakaPiThinkingEntry = Extract<MakaPiTranscriptEntry, { kind: 'thinking' }>;

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

function renderToolBlock(entry: MakaPiToolEntry, width: number, expanded: boolean): string[] {
  return expanded ? renderExpandedToolBlock(entry, width) : renderCompactToolBlock(entry, width);
}

function toolStatusText(entry: MakaPiToolEntry): string {
  const status = entry.status === 'running'
    ? ansi.yellow('running')
    : entry.status === 'error'
      ? ansi.red('error')
      : ansi.green('done');
  const duration = entry.durationMs === undefined ? '' : ansi.dim(` ${entry.durationMs}ms`);
  return `${status}${duration}`;
}

/**
 * Compact tool card: at most two lines. Line 1 carries the tool name, an
 * inline dim input summary, and status; line 2 is a one-line result summary
 * with a dim `(Ctrl+O)` hint when expanding would reveal more.
 */
function renderCompactToolBlock(entry: MakaPiToolEntry, width: number): string[] {
  // collapseToSingleLine guards both slots: fitLine truncates width, not \n,
  // so any multi-line summary text would silently break the two-line card.
  const inputSummary = collapseToSingleLine(toolInputSummary(entry));
  const header = `${ansi.yellow('Tool')} ${entry.title ?? entry.toolName}`
    + `${inputSummary ? ` ${ansi.dim(inputSummary)}` : ''} ${toolStatusText(entry)}`;
  const lines = [fitLine(header, width)];
  const summary = compactToolSummary(entry, width);
  if (summary) {
    const hint = summary.expandable ? ansi.dim(' (Ctrl+O)') : '';
    lines.push(fitLine(`  ${collapseToSingleLine(summary.text)}${hint}`, width));
  }
  return lines;
}

function renderExpandedToolBlock(entry: MakaPiToolEntry, width: number): string[] {
  const lines = [
    fitLine(`${ansi.yellow('Tool')} ${entry.title ?? entry.toolName} ${toolStatusText(entry)}`, width),
  ];
  const inputSummary = toolInputSummary(entry);
  if (inputSummary) lines.push(...renderIndented(inputSummary, width, 2).map(ansi.dim));
  if (entry.progress.length > 0) {
    lines.push(...renderToolText(entry.progress.join(''), width).map(ansi.dim));
  }
  lines.push(...renderToolStreams(entry.outputDeltas, width));
  if (entry.result || entry.output) {
    lines.push(...renderToolResult(entry, width));
  }
  return lines.map((line) => fitLine(line, width));
}

interface CompactToolSummary {
  text: string;
  /** True when expanding would reveal more than this one-line summary. */
  expandable: boolean;
}

function compactToolSummary(entry: MakaPiToolEntry, width: number): CompactToolSummary | undefined {
  const hasLiveOutput = entry.outputDeltas.length > 0 || entry.progress.length > 0;
  if (entry.status === 'running' && hasLiveOutput) {
    const live = latestLiveOutputLine(entry);
    if (live) return { text: live, expandable: true };
  }

  const result = entry.result;
  if (result?.kind === 'terminal') return compactTerminalSummary(result, hasLiveOutput);
  if (result?.kind === 'file_diff') return compactDiffSummary(result);
  if (result?.kind === 'file_write') {
    return { text: `wrote ${result.bytes} bytes ${result.path}`, expandable: hasLiveOutput };
  }

  if (entry.toolName === 'Grep') {
    const count = jsonArrayCount(entry, 'matches');
    if (count !== undefined) {
      return {
        text: `${count} match${count === 1 ? '' : 'es'}`,
        expandable: count > 0 || hasLiveOutput,
      };
    }
  }

  if (entry.toolName === 'Glob') {
    const count = jsonArrayCount(entry, 'files');
    if (count !== undefined) {
      return {
        text: `${count} file${count === 1 ? '' : 's'}`,
        expandable: count > 0 || hasLiveOutput,
      };
    }
  }

  const text = plainResultText(entry);
  if (!text) return undefined;
  if (entry.toolName === 'Read') {
    const lineCount = text.split('\n').length;
    return {
      text: `${lineCount} line${lineCount === 1 ? '' : 's'}, ${byteLength(text)} bytes`,
      expandable: true,
    };
  }
  const firstLine = text.split('\n', 1)[0] ?? '';
  return {
    text: firstLine,
    expandable: text.includes('\n') || hasLiveOutput || firstLine.length + 2 > width,
  };
}

function compactTerminalSummary(
  content: Extract<ToolResultContent, { kind: 'terminal' }>,
  hasLiveOutput: boolean,
): CompactToolSummary {
  const hasOutput = Boolean(content.stdout || content.stderr);
  if (content.exitCode !== 0) {
    const stderrLine = lastNonEmptyLine(content.stderr);
    const exit = ansi.red(`exit ${content.exitCode}`);
    return {
      text: stderrLine ? `${exit} ${stderrLine}` : exit,
      expandable: hasOutput || hasLiveOutput,
    };
  }
  const combined = [content.stdout, content.stderr].filter(Boolean).join('\n').replace(/\n+$/, '');
  if (!combined) return { text: ansi.dim('(no output)'), expandable: hasLiveOutput };
  const totalLines = combined.split('\n').length;
  const prefix = totalLines > 1 ? ansi.dim(`(${totalLines} lines) `) : '';
  return {
    text: `${prefix}${lastNonEmptyLine(combined)}`,
    expandable: totalLines > 1 || hasLiveOutput,
  };
}

function compactDiffSummary(
  content: Extract<ToolResultContent, { kind: 'file_diff' }>,
): CompactToolSummary {
  let adds = 0;
  let dels = 0;
  for (const line of content.diff.split('\n')) {
    const kind = diffLineKind(line);
    if (kind === 'add') adds += 1;
    else if (kind === 'del') dels += 1;
  }
  const path = content.paths[0];
  return {
    text: `${ansi.green(`+${adds}`)} ${ansi.red(`-${dels}`)}${path ? ` ${path}` : ''}`,
    expandable: true,
  };
}

/**
 * Row count for list-shaped json results (Grep `matches`, Glob `files`).
 * Returns a count only when the keyed field is genuinely an array; an
 * error-shaped result (e.g. `{ error: "..." }`) returns undefined so the
 * caller falls back to a generic first-line summary rather than reporting a
 * fabricated "N matches" / "N files" from an unrelated line count.
 */
function jsonArrayCount(entry: MakaPiToolEntry, key: string): number | undefined {
  const result = entry.result;
  if (result?.kind === 'json' && result.value !== null && typeof result.value === 'object') {
    const rows = (result.value as Record<string, unknown>)[key];
    if (Array.isArray(rows)) return rows.length;
  }
  return undefined;
}

/** Latest non-empty output line from live deltas (redaction-aware), else progress. */
function latestLiveOutputLine(entry: MakaPiToolEntry): string {
  const groups = groupOutputDeltas(entry.outputDeltas);
  if (groups.length > 0) {
    const fromDeltas = lastNonEmptyLine(groups.map((group) => group.text).join('\n'));
    if (fromDeltas) return fromDeltas;
  }
  return lastNonEmptyLine(entry.progress.join(''));
}

function lastNonEmptyLine(text: string): string {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line && line.trim()) return line;
  }
  return '';
}

function renderToolText(text: string, width: number): string[] {
  return renderIndented(limitText(text, 12_000), width, 2);
}

/**
 * Render live `tool_output_delta` chunks. Chunks are de-duped and ordered by
 * `seq` (so a late or repeated seq cannot corrupt the display), consecutive
 * same-stream chunks are grouped under a single dim `[stream]` label, and any
 * redacted chunk shows a `[redacted]` marker instead of its raw content.
 */
function renderToolStreams(deltas: readonly MakaPiToolOutputDelta[], width: number): string[] {
  const lines: string[] = [];
  for (const group of groupOutputDeltas(deltas)) {
    lines.push(fitLine(ansi.dim(`[${group.stream}]`), width));
    lines.push(...renderToolText(group.text, width).map(ansi.dim));
  }
  return lines;
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

function renderToolResult(entry: MakaPiToolEntry, width: number): string[] {
  const result = entry.result;
  if (result?.kind === 'terminal') return renderTerminalResult(result, width);
  if (result?.kind === 'file_diff') return renderDiffResult(result.diff, width);
  if (result?.kind === 'file_write') {
    return renderIndented(`Wrote ${result.bytes} bytes to ${result.path}`, width, 2);
  }
  return renderToolText(plainResultText(entry), width);
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
      const record = value as { matches?: unknown; files?: unknown };
      const rows = record.matches ?? record.files;
      if (Array.isArray(rows)) return rows.map((row) => String(row)).join('\n');
    }
    // Single line: this text can land on the compact summary line, and a
    // pretty-printed JSON body would break the two-line card contract.
    return formatUnknownInline(value);
  }
  return entry.output ?? '';
}

function renderTerminalResult(
  content: Extract<ToolResultContent, { kind: 'terminal' }>,
  width: number,
): string[] {
  const lines: string[] = [];
  if (content.exitCode !== 0) {
    lines.push(...renderIndented(ansi.red(`exit ${content.exitCode}`), width, 2));
  }
  if (content.stdout) {
    lines.push(...renderToolText(content.stdout, width));
  }
  if (content.stderr) {
    lines.push(...renderIndented(ansi.dim('[stderr]'), width, 2));
    lines.push(...renderToolText(content.stderr, width).map(ansi.dim));
  }
  return lines;
}

function renderDiffResult(diff: string, width: number): string[] {
  return renderIndented(colorDiff(limitText(diff, 12_000)), width, 2);
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
    case 'Glob': {
      const pattern = obj?.pattern;
      if (typeof pattern === 'string' && pattern.trim()) {
        const cwd = obj?.cwd;
        return typeof cwd === 'string' && cwd.trim() ? `${pattern} in ${cwd}` : pattern;
      }
      break;
    }
  }
  if (input === undefined) return '';
  // Single line: this summary is inlined into the compact header, and a
  // pretty-printed JSON body would break the two-line card contract.
  return `input: ${limitText(formatUnknownInline(input), 600)}`;
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
    case 'shell_run':
      return [
        `$ ${content.cmd}`,
        `cwd: ${content.cwd}`,
        `ref: ${content.ref}`,
        `status: ${content.status}`,
        content.exitCode !== undefined ? `exit: ${content.exitCode}` : '',
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

function formatUnknownInline(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Fold line breaks into spaces so a summary can never split a one-line slot. */
function collapseToSingleLine(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ');
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
