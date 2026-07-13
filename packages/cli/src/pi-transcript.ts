import { Markdown } from '@earendil-works/pi-tui';
import type {
  PermissionRequestEvent,
  SessionEvent,
  ToolOutputStream,
  ToolResultContent,
} from '@maka/core/events';
import { failureClassFromCompleteStopReason } from '@maka/core/events';
import { STEP_LIMIT_NOTICE_TEXT, type StoredMessage, type SystemNoteMessage } from '@maka/core/session';
import type { ContextBudgetDiagnostic } from '@maka/core/usage-stats/types';
import type { ThinkingLevel } from '@maka/core/model-thinking';
import {
  mergeShellRunStateWithDiagnostics,
  projectToolActivityArgs,
  readWriteStdinInputPreview,
  type ShellRunUpdate,
} from '@maka/core';
import { materializeSession, type ChatItem, type ToolActivityItem } from '@maka/runtime';
import type { MakaSessionDriver } from './session-driver.js';
import { BoundedChunkBuffer } from './bounded-chunk-buffer.js';
import { ansi } from './tui-ansi.js';
import {
  fitLine,
  formatToolResultContent,
  formatUnknown,
  limitText,
  markdownTheme,
  renderIndented,
} from './pi-transcript-format.js';
import { renderToolBlock } from './pi-transcript-tools.js';

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

const LIVE_TOOL_BUFFER_MAX_CHARS = 64 * 1024;
const LIVE_TOOL_BUFFER_MAX_CHUNKS = 512;

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
      /** In-memory revision for render-cache invalidation when a result is replaced. */
      resultVersion: number;
      progress: BoundedChunkBuffer<string>;
      outputDeltas: BoundedChunkBuffer<MakaPiToolOutputDelta>;
      durationMs?: number;
      status: 'running' | 'done' | 'error' | 'failed' | 'aborted' | 'detached' | 'unavailable';
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

export function refreshRunningShellRunElapsed(
  state: MakaPiTranscriptState,
  now = Date.now(),
): boolean {
  let found = false;
  for (const entry of state.entries) {
    if (entry.kind !== 'tool' || entry.status !== 'running' || entry.result?.kind !== 'shell_run') continue;
    entry.durationMs = Math.max(0, now - entry.result.startedAt);
    found = true;
  }
  return found;
}

export function applyShellRunViewUpdateToTranscript(
  state: MakaPiTranscriptState,
  update: ShellRunUpdate,
): boolean {
  const applied = applyShellRunUpdateToTranscript(state, update.sourceToolCallId, update.result);
  const tool = findToolEntry(state, update.sourceToolCallId);
  if (!tool
    || tool.toolName !== 'Bash'
    || tool.result?.kind !== 'shell_run'
    || tool.result.ref !== update.result.ref
    || tool.result.status !== 'running') return applied;
  const status = update.ownership.kind === 'local'
    ? 'running'
    : update.ownership.kind === 'source_owned' ? 'detached' : 'unavailable';
  if (tool.status === status) return applied;
  tool.status = status;
  return true;
}

export function applyShellRunUpdateToTranscript(
  state: MakaPiTranscriptState,
  sourceToolCallId: string,
  update: Extract<ToolResultContent, { kind: 'shell_run' }>,
): boolean {
  const tool = findToolEntry(state, sourceToolCallId);
  if (!tool || tool.toolName !== 'Bash') return false;
  if (tool.result?.kind === 'shell_run' && tool.result.ref !== update.ref) return false;
  return applyShellRunResult(tool, update);
}

export function replaceTranscriptWithStoredMessages(
  state: MakaPiTranscriptState,
  messages: readonly StoredMessage[],
): void {
  const view = materializeSession(messages);
  state.entries = foldStoredShellRunChildren(view.items.flatMap(chatItemToTranscriptEntries));
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

export interface TurnOutcome {
  /** The turn was user-stopped or aborted (double-Escape → driver.stop()). */
  aborted: boolean;
  /** The turn ended in an error (stream `error` event or thrown failure). */
  errored: boolean;
}

export async function submitPromptToTranscript(input: {
  state: MakaPiTranscriptState;
  driver: Pick<MakaSessionDriver, 'sendPrompt'>;
  prompt: string;
  onChange?: () => void;
  /**
   * An error surfaced during the turn — either a stream `error` event or a
   * thrown `sendPrompt` failure. Distinct from `onChange` so a caller can raise
   * attention on failures without diffing transcript entries every render.
   */
  onError?: () => void;
}): Promise<TurnOutcome> {
  appendUserPrompt(input.state, input.prompt);
  input.onChange?.();

  // Surface how the turn ended so the host can gate goal auto-continuation: a
  // user_stop/abort (the Stop affordance) or an errored turn must NOT trigger
  // another autonomous turn — mirrors the desktop `turnAborted` guard.
  let aborted = false;
  let errored = false;
  try {
    for await (const event of input.driver.sendPrompt(input.prompt)) {
      applyMakaSessionEventToTranscript(input.state, event);
      if (event.type === 'abort' || (event.type === 'complete' && event.stopReason === 'user_stop')) {
        aborted = true;
      }
      if (event.type === 'error') {
        errored = true;
        input.onError?.();
      }
      // A non-throwing error finish (e.g. content-filter) arrives as
      // complete{stopReason:'error'} with no separate `error` event — treat it as
      // errored too, so goal continuation never re-injects into a failed turn
      // (self-sufficient, not reliant on the session-status backstop).
      if (
        event.type === 'complete'
        && failureClassFromCompleteStopReason(event.stopReason) !== undefined
      ) {
        errored = true;
      }
      input.onChange?.();
    }
  } catch (error) {
    errored = true;
    input.state.entries.push({
      kind: 'notice',
      level: 'error',
      text: error instanceof Error ? error.message : String(error),
    });
    input.onError?.();
    input.onChange?.();
  }
  return { aborted, errored };
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
        input: projectToolActivityArgs(event.toolName, event.args),
        resultVersion: 0,
        progress: createProgressBuffer(),
        outputDeltas: createOutputBuffer(),
        status: 'running',
      });
      break;

    case 'tool_result': {
      const tool = findToolEntry(state, event.toolUseId);
      const shellRun = event.content.kind === 'shell_run' ? event.content : undefined;
      const parent = shellRun
        ? findShellRunParent(state, shellRun.ref, event.toolUseId)
        : undefined;
      if (tool && parent && shellRun) {
        applyShellRunResult(parent, shellRun);
        if (tool.toolName === 'Read' || tool.toolName === 'StopBackgroundTask') {
          state.entries.splice(state.entries.indexOf(tool), 1);
        } else {
          applyOwnShellRunResult(tool, shellRun, event.durationMs);
        }
        break;
      }
      if (tool) {
        if (shellRun) {
          if (tool.toolName === 'Bash') {
            applyShellRunResult(tool, shellRun);
          } else {
            applyOwnShellRunResult(tool, shellRun, event.durationMs);
          }
        } else {
          tool.status = event.isError ? 'error' : 'done';
          tool.result = event.content;
          tool.output = formatToolResultContent(event.content);
          tool.durationMs = event.durationMs;
          tool.resultVersion += 1;
        }
      } else {
        state.entries.push({
          kind: 'tool',
          toolUseId: event.toolUseId,
          toolName: event.toolUseId,
          input: undefined,
          progress: createProgressBuffer(),
          outputDeltas: createOutputBuffer(),
          result: event.content,
          output: formatToolResultContent(event.content),
          resultVersion: 1,
          durationMs: event.durationMs,
          status: event.isError ? 'error' : 'done',
        });
      }
      break;
    }

    case 'tool_progress': {
      const tool = findToolEntry(state, event.toolUseId);
      if (tool) {
        const progress = typeof event.chunk === 'string'
          ? event.chunk
          : event.chunk.text
            ? `[${event.chunk.kind}] ${event.chunk.text}`
            : '';
        if (progress) tool.progress.append(progress);
      }
      break;
    }

    case 'tool_output_delta': {
      const tool = findToolEntry(state, event.toolUseId);
      if (tool && (event.chunk || event.redacted)) {
        tool.outputDeltas.append({
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
      if (event.stopReason === 'step_limit') {
        state.entries.push({ kind: 'notice', level: 'info', text: STEP_LIMIT_NOTICE_TEXT });
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

function toolActivityToTranscriptEntry(item: ToolActivityItem): MakaPiToolEntry {
  const output = item.result
    ? formatToolResultContent(item.result)
    : item.status === 'interrupted'
      ? 'Interrupted before the tool returned a result.'
      : undefined;
  const entry: MakaPiToolEntry = {
    kind: 'tool',
    toolUseId: item.toolUseId,
    toolName: item.toolName,
    ...(item.displayName ? { title: item.displayName } : {}),
    input: item.args,
    progress: createProgressBuffer(),
    outputDeltas: createOutputBuffer(),
    ...(item.result ? { result: item.result } : {}),
    ...(output ? { output } : {}),
    resultVersion: item.result ? 1 : 0,
    ...(item.durationMs !== undefined ? { durationMs: item.durationMs } : {}),
    status: transcriptToolStatus(item.status),
  };
  if (item.result?.kind === 'shell_run') applyOwnShellRunResult(entry, item.result);
  return entry;
}

function foldStoredShellRunChildren(entries: MakaPiTranscriptEntry[]): MakaPiTranscriptEntry[] {
  const folded: MakaPiTranscriptEntry[] = [];
  for (const entry of entries) {
    if (entry.kind === 'tool' && entry.result?.kind === 'shell_run') {
      const shellRun = entry.result;
      const parent = [...folded]
        .reverse()
        .find((candidate): candidate is MakaPiToolEntry => candidate.kind === 'tool'
          && candidate.toolName === 'Bash'
          && candidate.result?.kind === 'shell_run'
          && candidate.result.ref === shellRun.ref);
      if (parent) {
        applyShellRunResult(parent, shellRun);
        if (entry.toolName === 'Read' || entry.toolName === 'StopBackgroundTask') continue;
      }
    }
    folded.push(entry);
  }
  return folded;
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

function shellRunTranscriptStatus(
  status: Extract<ToolResultContent, { kind: 'shell_run' }>['status'],
): MakaPiToolEntry['status'] {
  switch (status) {
    case 'running':
      return 'running';
    case 'completed':
      return 'done';
    case 'cancelled':
      return 'aborted';
    case 'failed':
    case 'timed_out':
    case 'orphaned':
      return 'failed';
  }
}

function applyShellRunResult(
  entry: MakaPiToolEntry,
  result: Extract<ToolResultContent, { kind: 'shell_run' }>,
): boolean {
  const current = entry.result?.kind === 'shell_run' ? entry.result : undefined;
  const merged = mergeShellRunStateWithDiagnostics(current, result, 'cli.transcript');
  if (!merged.changed) return false;
  entry.status = shellRunTranscriptStatus(merged.result.status);
  entry.result = merged.result;
  entry.output = formatToolResultContent(merged.result);
  entry.durationMs = Math.max(
    0,
    (merged.result.completedAt ?? merged.result.updatedAt) - merged.result.startedAt,
  );
  entry.resultVersion += 1;
  return true;
}

function applyOwnShellRunResult(
  entry: MakaPiToolEntry,
  result: Extract<ToolResultContent, { kind: 'shell_run' }>,
  operationDurationMs = entry.durationMs,
): void {
  entry.status = entry.toolName === 'WriteStdin'
    ? result.operation?.kind === 'pty_control' && result.operation.failed ? 'error' : 'done'
    : shellRunTranscriptStatus(result.status);
  entry.result = result;
  entry.output = formatToolResultContent(result);
  if (entry.toolName === 'WriteStdin') {
    entry.durationMs = operationDurationMs;
  } else {
    entry.durationMs = Math.max(0, (result.completedAt ?? result.updatedAt) - result.startedAt);
  }
  entry.resultVersion += 1;
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
    case 'context_compaction_failed_open':
      return 'Context summary failed; the session continued without a new summary.';
    case 'step_limit':
      return STEP_LIMIT_NOTICE_TEXT;
    case 'error':
      return 'Session recorded an error.';
    case 'abort':
      return 'Session was stopped.';
  }
}

export function renderMakaPiTranscript(
  state: MakaPiTranscriptState,
  metadata: MakaPiTranscriptMetadata,
  width: number,
): string[] {
  const safeWidth = Math.max(1, width);
  const lines: string[] = [];

  // A fresh session (no history, nothing pending) opens on a welcome block so the
  // first screen greets and orients instead of showing an empty pane. Once the
  // first prompt lands, entries take over and it never renders again.
  if (state.entries.length === 0 && !state.pendingPermission) {
    return renderWelcomeBlock(metadata, safeWidth);
  }

  for (const entry of state.entries) {
    // A blank spacer above every entry, then its (memoized) rendered block.
    lines.push('');
    lines.push(...renderTranscriptEntryMemoized(entry, safeWidth, state.expandAllTools, state.expandAllThinking));
  }

  if (state.pendingPermission) {
    lines.push('');
    lines.push(...renderPermissionPrompt(state.pendingPermission, safeWidth));
  }

  return lines;
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
// caller, renderMakaPiTranscript, spreads the lines into its own buffer.
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
      // A tool entry mutates in place as it runs: status/duration flip,
      // progress/output deltas append, and resultVersion advances whenever a
      // result is accepted. Count those revisions instead of duplicating the
      // result's rendering contract in this cache key. `input` and
      // `toolName` are omitted deliberately: both are set once at `tool_start`,
      // before the first render, and never change, so they can't go stale.
      return [
        'tool',
        width,
        expandAllTools ? 1 : 0,
        entry.status,
        entry.durationMs ?? '',
        entry.title ?? entry.toolName,
        entry.progress.version,
        entry.outputDeltas.version,
        entry.resultVersion,
      ].join('|');
  }
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

export type MakaPiToolEntry = Extract<MakaPiTranscriptEntry, { kind: 'tool' }>;
type MakaPiNoticeEntry = Extract<MakaPiTranscriptEntry, { kind: 'notice' }>;

function findToolEntry(state: MakaPiTranscriptState, toolUseId: string): MakaPiToolEntry | undefined {
  return [...state.entries]
    .reverse()
    .find((entry): entry is MakaPiToolEntry => entry.kind === 'tool' && entry.toolUseId === toolUseId);
}

function createProgressBuffer(): BoundedChunkBuffer<string> {
  return new BoundedChunkBuffer({
    maxChars: LIVE_TOOL_BUFFER_MAX_CHARS,
    maxChunks: LIVE_TOOL_BUFFER_MAX_CHUNKS,
    textOf: (chunk) => chunk,
    withText: (_chunk, text) => text,
  });
}

function createOutputBuffer(): BoundedChunkBuffer<MakaPiToolOutputDelta> {
  return new BoundedChunkBuffer({
    maxChars: LIVE_TOOL_BUFFER_MAX_CHARS,
    maxChunks: LIVE_TOOL_BUFFER_MAX_CHUNKS,
    textOf: (delta) => delta.chunk,
    withText: (delta, chunk) => ({ ...delta, chunk }),
    sequence: (delta) => delta.seq,
  });
}

function findShellRunParent(
  state: MakaPiTranscriptState,
  ref: string,
  childToolUseId: string,
): MakaPiToolEntry | undefined {
  return [...state.entries]
    .reverse()
    .find((entry): entry is MakaPiToolEntry => entry.kind === 'tool'
      && entry.toolName === 'Bash'
      && entry.toolUseId !== childToolUseId
      && entry.result?.kind === 'shell_run'
      && entry.result.ref === ref);
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

function renderNotice(entry: MakaPiNoticeEntry, width: number): string[] {
  const label = entry.level === 'error' ? ansi.red('Error') : ansi.dim('Note');
  return renderIndented(`${label}: ${entry.text}`, width, 0).map((line) => fitLine(line, width));
}

// Shown on a fresh, empty session. Greets, states where we are (model /
// connection / folder), and lists the handful of commands and keys worth
// knowing up front — enough to start without reading docs.
function renderWelcomeBlock(metadata: MakaPiTranscriptMetadata, width: number): string[] {
  // Point at /help for the full command list rather than duplicating it here —
  // the autocomplete already teaches commands as you type. Just the greeting plus
  // the keys you cannot discover by typing `/`.
  const tips: [string, string][] = [
    ['/help', '查看全部命令与快捷键'],
    ['Ctrl+O', '展开或折叠工具输出'],
    ['Esc Esc', '回退到较早的轮次'],
  ];
  const keyWidth = Math.max(...tips.map(([key]) => key.length));
  const lines = [
    fitLine(ansi.accent('maka'), width),
    fitLine(ansi.dim(`${metadata.model} · ${metadata.connectionSlug} · ${metadata.cwd}`), width),
    '',
    fitLine('输入消息开始对话，或用斜杠命令：', width),
  ];
  for (const [key, description] of tips) {
    lines.push(fitLine(ansi.dim(`  ${key.padEnd(keyWidth)}  ${description}`), width));
  }
  return lines;
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
  if (request.toolName === 'WriteStdin') {
    const input = readWriteStdinInputPreview(args);
    if (input) return input.truncated ? `${input.text}… · ${input.bytes} bytes total` : input.text;
  }
  if ((request.toolName === 'Write' || request.toolName === 'Edit') && args !== null && typeof args === 'object') {
    const path = (args as { path?: unknown }).path;
    if (typeof path === 'string' && path.trim()) return path;
  }
  return limitText(formatUnknown(request.args), 600);
}
