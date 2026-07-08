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

/**
 * Identifies which transcript entry (and which line within its rendered block)
 * a given transcript row came from. Spacer rows and the permission prompt have
 * no stable entry identity and are reported as `null` owners. The scroll layout
 * uses this to anchor the viewport to a piece of content rather than a line
 * offset, so it stays pinned to what the reader is looking at across arbitrary
 * re-renders (blocks growing, shrinking, above or below the fold, or all at
 * once in one coalesced frame).
 */
export interface TranscriptLineOwner {
  entry: MakaPiTranscriptEntry;
  /** 0-based line index within the entry's rendered block. */
  row: number;
}

export interface RenderedTranscript {
  lines: string[];
  owners: (TranscriptLineOwner | null)[];
}

export function renderMakaPiTranscriptSource(
  state: MakaPiTranscriptState,
  _metadata: MakaPiTranscriptMetadata,
  width: number,
): RenderedTranscript {
  const safeWidth = Math.max(1, width);
  const lines: string[] = [];
  const owners: (TranscriptLineOwner | null)[] = [];

  for (const entry of state.entries) {
    // A blank spacer above every entry, then its (memoized) rendered block. The
    // spacer belongs to the entry (row 0) so the scroll anchor stays stable when
    // the viewport top lands on it — otherwise anchoring to the block's first line
    // would drop the spacer and drift the view up a row on the next re-render.
    lines.push('');
    owners.push({ entry, row: 0 });
    const block = renderTranscriptEntryMemoized(entry, safeWidth, state.expandAllTools, state.expandAllThinking);
    block.forEach((line, row) => {
      lines.push(line);
      owners.push({ entry, row: row + 1 });
    });
  }

  if (state.pendingPermission) {
    lines.push('');
    owners.push(null);
    for (const line of renderPermissionPrompt(state.pendingPermission, safeWidth)) {
      lines.push(line);
      owners.push(null);
    }
  }

  return { lines, owners };
}

export function renderMakaPiTranscript(
  state: MakaPiTranscriptState,
  metadata: MakaPiTranscriptMetadata,
  width: number,
): string[] {
  return renderMakaPiTranscriptSource(state, metadata, width).lines;
}

/**
 * Per-entry render cache. The transcript re-renders on every keystroke and
 * stream delta, but only the tail entry actually changes; caching the rendered
 * lines of unchanged entries avoids rebuilding a `Markdown` instance per block
 * on each pass. Keyed by entry identity (a fresh entry object is a cache miss);
 * the signature busts the cache when anything that affects the entry's rendered
 * lines changes (its growing text, tool status, width, or an expansion toggle).
 */
interface TranscriptEntryRender {
  signature: string;
  lines: string[];
}

const transcriptEntryRenderCache = new WeakMap<MakaPiTranscriptEntry, TranscriptEntryRender>();

// Returns the cached line array by reference on a hit — callers must treat it as
// read-only (copy the lines into their own buffer rather than mutating in place),
// or a later render would serve corrupted content for that entry. The only
// caller, renderMakaPiTranscriptSource, copies each line out.
function renderTranscriptEntryMemoized(
  entry: MakaPiTranscriptEntry,
  width: number,
  expandAllTools: boolean,
  expandAllThinking: boolean,
): string[] {
  const signature = transcriptEntrySignature(entry, width, expandAllTools, expandAllThinking);
  const cached = transcriptEntryRenderCache.get(entry);
  if (cached && cached.signature === signature) return cached.lines;
  const lines = renderTranscriptEntryBlock(entry, width, expandAllTools, expandAllThinking);
  transcriptEntryRenderCache.set(entry, { signature, lines });
  return lines;
}

function renderTranscriptEntryBlock(
  entry: MakaPiTranscriptEntry,
  width: number,
  expandAllTools: boolean,
  expandAllThinking: boolean,
): string[] {
  switch (entry.kind) {
    case 'user':
      return renderTextBlock('User', entry.text, width, { markdown: false, heading: ansi.accent });
    case 'assistant':
      return renderTextBlock('maka', entry.text, width, { markdown: true, heading: ansi.accent });
    case 'thinking':
      return renderThinkingBlock(entry, width, expandAllThinking);
    case 'tool':
      return renderToolBlock(entry, width, expandAllTools);
    case 'notice':
      return renderNotice(entry, width);
  }
}

function transcriptEntrySignature(
  entry: MakaPiTranscriptEntry,
  width: number,
  expandAllTools: boolean,
  expandAllThinking: boolean,
): string {
  switch (entry.kind) {
    // user and assistant text is append-only (user is immutable; assistant only
    // grows via appendAssistantText, and text_complete is guarded from replacing
    // it), so length is a safe change key. If a path ever replaces their text in
    // place, switch these to full-text keys like thinking below.
    case 'user':
      return `user|${width}|${entry.text.length}`;
    case 'assistant':
      return `assistant|${width}|${entry.text.length}`;
    case 'thinking':
      // Not just the length: `thinking_complete` can replace the streamed text
      // in place with a same-length final, which a length-only key would miss and
      // then serve stale reasoning from the cache. Key on the full text.
      return `thinking|${width}|${expandAllThinking ? 1 : 0}|${entry.text}`;
    case 'notice':
      return `notice|${width}|${entry.level}|${entry.text.length}`;
    case 'tool':
      // A tool entry mutates in place as it runs: status/duration flip on the
      // result, and progress/output deltas append while running. Its result
      // object is set once and never rewritten, so counting these fields is
      // enough to detect every change to the rendered block. `input` and
      // `toolName` are omitted deliberately: both are set once at `tool_start`,
      // before the first render, and never change, so they can't go stale.
      return [
        'tool',
        width,
        expandAllTools ? 1 : 0,
        entry.status,
        entry.durationMs ?? '',
        entry.title ?? entry.toolName,
        entry.progress.length,
        entry.outputDeltas.length,
        entry.output?.length ?? '',
        entry.result ? entry.result.kind : '',
      ].join('|');
  }
}

export interface TranscriptWindow {
  /** The viewport-sized slice of transcript lines, including a scroll indicator row when scrolled. */
  lines: string[];
  /** Clamped scroll offset actually applied — lines hidden below the viewport bottom (0 = following the tail). */
  scrollOffset: number;
  /** Lines hidden above the top of the viewport. */
  hiddenAbove: number;
  /** Lines hidden below the bottom of the viewport. */
  hiddenBelow: number;
  /** True when the transcript is taller than the viewport (a scroll indicator is shown). */
  scrollable: boolean;
}

/**
 * Window a fully rendered transcript to the viewport. When the transcript fits,
 * every line is returned unchanged. When it overflows, one row is reserved for a
 * dim scroll indicator so the remaining rows show a `scrollOffset`-anchored slice
 * — offset 0 follows the live tail, larger offsets reveal older lines.
 */
export function windowTranscriptLines(
  allLines: readonly string[],
  viewportRows: number,
  scrollOffset: number,
  width: number,
): TranscriptWindow {
  const rows = Math.max(0, Math.trunc(viewportRows));
  if (rows === 0) {
    return { lines: [], scrollOffset: 0, hiddenAbove: 0, hiddenBelow: 0, scrollable: false };
  }
  if (allLines.length <= rows) {
    return { lines: [...allLines], scrollOffset: 0, hiddenAbove: 0, hiddenBelow: 0, scrollable: false };
  }
  // Reserve one row for the scroll indicator — but only when the viewport is at
  // least two rows tall. A one-row viewport (very short terminal, or a tall
  // editor/autocomplete area) can hold either a content line or the indicator,
  // not both; showing the content keeps the total within the layout budget.
  const showIndicator = rows >= 2;
  const contentRows = showIndicator ? rows - 1 : rows;
  const maxOffset = allLines.length - contentRows;
  const offset = Math.min(Math.max(0, Math.trunc(scrollOffset)), maxOffset);
  const end = allLines.length - offset;
  const start = Math.max(0, end - contentRows);
  const hiddenAbove = start;
  const hiddenBelow = allLines.length - end;
  const windowLines = allLines.slice(start, end);
  const lines = showIndicator
    ? [...windowLines, fitLine(transcriptScrollIndicator(hiddenAbove, hiddenBelow), Math.max(1, width))]
    : [...windowLines];
  return { lines, scrollOffset: offset, hiddenAbove, hiddenBelow, scrollable: true };
}

function transcriptScrollIndicator(hiddenAbove: number, hiddenBelow: number): string {
  // Only reached from the scrollable path, where the window is smaller than the
  // transcript, so at least one side always has hidden lines.
  const counts: string[] = [];
  if (hiddenAbove > 0) counts.push(`↑ ${hiddenAbove} more`);
  if (hiddenBelow > 0) counts.push(`↓ ${hiddenBelow} more`);
  const keys = hiddenBelow > 0 ? 'PgUp/PgDn scroll · PgDn to follow' : 'PgUp/PgDn scroll';
  return ansi.dim(`── ${counts.join('  ')} · ${keys} ──`);
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
  // Only a successful filesystem Read that carries real file content gets the
  // line/byte summary — the same guard the expanded card uses. A runtime
  // resource, errored, or archived Read falls through to the generic first-line
  // summary so its status shows instead of a fabricated count.
  if (entry.toolName === 'Read'
    && entry.status !== 'error'
    && isFilesystemReadPath(entry)
    && isReadBodyResult(result)) {
    const lineCount = readBodyLineCount(text);
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

// Expanding a tool card should reveal enough to orient, not replay a whole
// file or command dump into the transcript. Long output collapses to its first
// and last few lines with a hidden-count marker; diffs are the deliberate
// exception (rendered in full) because the whole change is the point.
const EXPANDED_TOOL_HEAD_LINES = 3;
const EXPANDED_TOOL_TAIL_LINES = 3;

/**
 * Render tool output for the expanded card, keeping at most the first
 * `EXPANDED_TOOL_HEAD_LINES` and last `EXPANDED_TOOL_TAIL_LINES` source lines
 * with a dim marker in between. `style` colors the content lines (e.g. dim for
 * stderr); the marker is always dim.
 */
function renderCappedResultText(
  text: string,
  width: number,
  style: (line: string) => string = (line) => line,
): string[] {
  // Command output almost always ends in a newline; splitting raw would count
  // that trailing empty string as a line, capping 7 real lines as if they were
  // 8 and spending a tail slot on a blank. Drop trailing newlines before both
  // the cap decision and the slice so the head/tail counts are real lines.
  const trimmed = text.replace(/\n+$/, '');
  const sourceLines = trimmed.split('\n');
  if (sourceLines.length <= EXPANDED_TOOL_HEAD_LINES + EXPANDED_TOOL_TAIL_LINES + 1) {
    return renderToolText(trimmed, width).map(style);
  }
  const hidden = sourceLines.length - EXPANDED_TOOL_HEAD_LINES - EXPANDED_TOOL_TAIL_LINES;
  const head = sourceLines.slice(0, EXPANDED_TOOL_HEAD_LINES).join('\n');
  const tail = sourceLines.slice(sourceLines.length - EXPANDED_TOOL_TAIL_LINES).join('\n');
  return [
    ...renderToolText(head, width).map(style),
    ...renderIndented(ansi.dim(`⋯ ${hidden} lines hidden ⋯`), width, 2),
    ...renderToolText(tail, width).map(style),
  ];
}

/**
 * Line count for a Read body, dropping only the single conventional EOF newline
 * so `foo\n` counts as one line while a real trailing blank line is preserved
 * (`a\n\n` is two lines, `\n` is one). Shared by the compact and expanded
 * summaries so the same card can never flip its line count when toggled.
 */
function readBodyLineCount(text: string): number {
  if (text === '') return 0;
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  return body.split('\n').length;
}

function renderReadSummary(entry: MakaPiToolEntry, width: number): string[] {
  const text = plainResultText(entry);
  // Byte count keeps the full content, since that is the file's real size on
  // disk; the line count drops the trailing newline (see readBodyLineCount).
  const lineCount = readBodyLineCount(text);
  const summary = `Read ${lineCount} line${lineCount === 1 ? '' : 's'}, ${byteLength(text)} bytes`;
  return renderIndented(ansi.dim(summary), width, 2);
}

function readInputPath(entry: MakaPiToolEntry): string | undefined {
  const input = entry.input;
  const path = input !== null && typeof input === 'object'
    ? (input as { path?: unknown }).path
    : undefined;
  return typeof path === 'string' && path.length > 0 ? path : undefined;
}

/** A Read whose path is a real file, not a `maka://runtime/...` resource. */
function isFilesystemReadPath(entry: MakaPiToolEntry): boolean {
  const path = readInputPath(entry);
  return path !== undefined && !path.startsWith('maka://runtime/');
}

/** A Read of a `maka://runtime/...` resource (background-task output, etc.). */
function isRuntimeResourceReadPath(entry: MakaPiToolEntry): boolean {
  return readInputPath(entry)?.startsWith('maka://runtime/') ?? false;
}

/**
 * True only for the result shapes a filesystem Read uses to carry actual file
 * content. An `archived_tool_result` placeholder (or any other kind) is not a
 * read body, so it renders its own status instead of a fabricated line count.
 */
function isReadBodyResult(result: ToolResultContent | undefined): boolean {
  if (result?.kind === 'text') return true;
  // A json Read body is the `{ content: string }` shape the file loader
  // returns; any other json (e.g. an `{ error }` payload) is a status object,
  // not file content, and should render its real shape rather than a
  // fabricated line/byte count.
  if (result?.kind === 'json') {
    const value = result.value;
    return value !== null
      && typeof value === 'object'
      && typeof (value as { content?: unknown }).content === 'string';
  }
  return false;
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
    lines.push(...renderCappedResultText(group.text, width, ansi.dim));
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
  // A `maka://runtime/...` resource Read surfaces live state (background-task
  // metadata + stdout/stderr) that only lives in the transcript. Its body opens
  // with several metadata/separator lines, so a head/tail cap would hide the very
  // output the user expanded to see — render it in full.
  if (entry.toolName === 'Read' && isRuntimeResourceReadPath(entry)) {
    return renderToolText(plainResultText(entry), width);
  }
  // A successful filesystem Read that returned real file content pulled it into
  // the model's context; the transcript only needs to note that it happened, so
  // skip the content and keep a summary. Everything else falls through to render
  // its content: a failed Read (its error), and — critically — an
  // `archived_tool_result` placeholder, so its not_loaded/missing status stays
  // visible instead of being mistaken for a one-line file.
  if (entry.toolName === 'Read'
    && entry.status !== 'error'
    && isFilesystemReadPath(entry)
    && isReadBodyResult(result)) {
    return renderReadSummary(entry, width);
  }
  if (result?.kind === 'terminal') return renderTerminalResult(result, width);
  // A background `shell_run` carries process metadata (ref, status, exit) the
  // head/tail cap must never hide — otherwise a failed or timed-out background
  // command looks the same as a successful one. Render the status in full and
  // cap only the stdout/stderr stream bodies.
  if (result?.kind === 'shell_run') return renderShellRunResult(entry, result, width);
  // Diffs are the deliberate exception to the head/tail cap: the whole change
  // is what the user is expanding to see.
  if (result?.kind === 'file_diff') return renderDiffResult(result.diff, width);
  if (result?.kind === 'file_write') {
    return renderIndented(`Wrote ${result.bytes} bytes to ${result.path}`, width, 2);
  }
  // A generic `text` dump — a Bash body or raw tool text — is what the head/tail
  // cap targets: the model already holds the full body, so the transcript only
  // needs enough to orient. An undefined result with a formatted `output` string
  // is treated the same way. `json` is deliberately excluded: a Read json is
  // summarized above, a Grep/Glob json is a structured list the user expands to
  // scan in full, and any other json collapses to a single inline line where the
  // cap would be a no-op anyway.
  if (result === undefined || result.kind === 'text') {
    return renderCappedResultText(plainResultText(entry), width);
  }
  // Everything else — json lists (Grep/Glob), agent reports, web-search results,
  // subagent / workflow summaries, office-doc output — is content the user
  // expands to read in full, so render it without the cap, like a diff.
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
    lines.push(...renderCappedResultText(content.stdout, width));
  }
  if (content.stderr) {
    lines.push(...renderIndented(ansi.dim('[stderr]'), width, 2));
    lines.push(...renderCappedResultText(content.stderr, width, ansi.dim));
  }
  return lines;
}

/**
 * Render a `shell_run` (background-process) result. The status line — status,
 * exit code, failure message, and the run `ref` — is always shown in full so a
 * head/tail cap can never hide whether the command failed or timed out; only
 * the stdout/stderr stream bodies are capped.
 */
function renderShellRunResult(
  entry: MakaPiToolEntry,
  content: Extract<ToolResultContent, { kind: 'shell_run' }>,
  width: number,
): string[] {
  const lines: string[] = [];
  // The command/cwd live on the result. The Bash input summary shows only the
  // command's first line (`command.split('\n')[0]`), so skip the result-side
  // `$ cmd` only when the input already shows the whole command — a single-line
  // command. A multiline command, or a ref-only StopBackgroundTask input,
  // renders the full command here so none of it is lost. The cwd is in neither
  // input summary, so show it once here.
  const input = entry.input;
  const command = input !== null && typeof input === 'object'
    ? (input as { command?: unknown }).command
    : undefined;
  const inputShowsFullCommand = typeof command === 'string'
    && command.trim() !== ''
    && !command.includes('\n');
  if (!inputShowsFullCommand) {
    lines.push(...renderIndented(ansi.dim(`$ ${content.cmd}`), width, 2));
  }
  lines.push(...renderIndented(ansi.dim(`cwd: ${content.cwd}`), width, 2));
  const settled = content.status !== 'running' && content.status !== 'completed';
  const parts: string[] = [content.status];
  if (content.exitCode !== undefined) parts.push(`exit ${content.exitCode}`);
  if (content.failureMessage) parts.push(content.failureMessage);
  const head = parts.join(' · ');
  // Keep the colored status and the dim ref as separate ansi spans; nesting one
  // inside the other would let the inner reset terminate the outer color early.
  const statusLine = `${settled ? ansi.red(head) : ansi.dim(head)} ${ansi.dim(`(${content.ref})`)}`;
  lines.push(...renderIndented(statusLine, width, 2));
  if (content.stdout) {
    lines.push(...renderCappedResultText(content.stdout, width));
  }
  if (content.stderr) {
    lines.push(...renderIndented(ansi.dim('[stderr]'), width, 2));
    lines.push(...renderCappedResultText(content.stderr, width, ansi.dim));
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
