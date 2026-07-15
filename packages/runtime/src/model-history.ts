/**
 * Model history projection — build the model-visible message history from a
 * RuntimeEvent stream.
 *
 * Architecture: docs/architecture/llm-compaction-events-log-projection-draft.md
 *
 * Phase 1 scope: pure, synchronous projection. Replaces the ad-hoc
 * StoredMessage filtering in AiSdkBackend.materializePriorMessages with an
 * explicit, policy-driven filter over canonical events. The output is a
 * neutral `ModelHistoryEntry[]` that callers (ai-sdk backend, flow runner)
 * translate into provider-specific message shapes.
 *
 * Policy (why an event is KEPT):
 *   - non-partial (final content, not a transient streaming chunk)
 *   - model-visible content kind: text / thinking / function_call /
 *     function_response (per runtimeEventHasModelVisibleContent)
 *   - role is user, model, or tool (system excluded unless opted in)
 *
 * Policy (why an event is DROPPED):
 *   - partial === true (streaming chunks superseded by a later final event)
 *   - error-only content (a tool error surfaced to the model is a
 *     function_response with isError, which stays visible)
 *   - actions-only / refs-only events (token usage, permission acks,
 *     state deltas, end-invocation markers)
 *   - system-role events by default (UI-only notes; system instructions
 *     are injected fresh by the runner, not replayed from history)
 *
 * Thinking and tool events are opt-in/opt-out so callers can match the
 * replay contract of their provider (V0.1 text-only replay cannot use
 * them; Anthropic replay can re-use signed thinking, etc.).
 *
 * NOTE: imports the new `@maka/core/runtime-event` subpath. The steward
 * node re-exports it from the core barrel.
 */

import {
  isPartialRuntimeEvent,
  isTerminalRuntimeEvent,
  runtimeEventHasModelVisibleContent,
  type RuntimeEvent,
  type RuntimeEventTextContent,
  type RuntimeEventContent,
  type RuntimeEventRole,
} from '@maka/core/runtime-event';
import { normalizeShellToolResultContent } from '@maka/core';
import type { AttachmentRef } from '@maka/core/events';

// ============================================================================
// Output type
// ============================================================================

/**
 * One model-facing history entry. `content` is the canonical
 * RuntimeEventContent (discriminated by `kind`); `role` is the
 * model-history lane the entry plays for the next model call.
 */
export interface ModelHistoryEntry {
  role: RuntimeEventRole;
  content: RuntimeEventContent;
  ts: number;
  eventId: string;
}

export interface TextModelMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export type RuntimeEventReplayFallbackGate =
  | 'runtime_replay_text_only'
  | 'runtime_replay_provider_native'
  | 'runtime_replay_unsupported_semantics';

export type RuntimeEventReplayDiagnosticCode =
  | 'partial_skipped'
  | 'unsupported_role'
  | 'unsupported_content'
  | 'system_runtime_fact_diagnostic_only'
  | 'terminal_fact_diagnostic_only'
  | 'empty_text_skipped'
  | 'unsigned_thinking_skipped'
  | 'signed_thinking_in_tool_turn_skipped'
  | 'unmatched_tool_result'
  | 'tool_id_mismatch';

export interface RuntimeEventReplayDiagnostic {
  code: RuntimeEventReplayDiagnosticCode;
  message: string;
  eventId?: string;
  turnId?: string;
  detail?: Record<string, unknown>;
}

export type RuntimeEventReplaySemanticKind =
  | 'text'
  | 'thinking'
  | 'tool_call'
  | 'tool_result';

export type RuntimeEventModelReplayItem =
  | {
      kind: 'text';
      role: 'user' | 'assistant' | 'system';
      content: string;
      /** Original attachments (if any) so replay can render image parts. */
      attachments?: AttachmentRef[];
      /** Assistant step id (model-role text only); groups a step's parts. */
      stepId?: string;
      eventId: string;
      ts: number;
    }
  | {
      kind: 'thinking';
      text: string;
      signature?: string;
      /** Assistant step id; pairs this reasoning with its step's tool calls. */
      stepId?: string;
      eventId: string;
      ts: number;
    }
  | {
      kind: 'tool_call';
      toolCallId: string;
      toolName: string;
      input: unknown;
      /** Assistant step id (from tool_start); groups the call with its step. */
      stepId?: string;
      eventId: string;
      ts: number;
    }
  | {
      kind: 'tool_result';
      toolCallId: string;
      toolName: string;
      output: unknown;
      isError: boolean;
      eventId: string;
      ts: number;
    };

export interface RuntimeEventModelReplayPlan {
  items: RuntimeEventModelReplayItem[];
  textMessages: TextModelMessage[];
  semanticKinds: RuntimeEventReplaySemanticKind[];
  diagnostics: RuntimeEventReplayDiagnostic[];
  hasProviderNativeSemantics: boolean;
}

// ============================================================================
// Options
// ============================================================================

export interface BuildModelHistoryOptions {
  /**
   * Include function_call / function_response entries. Default `true`.
   * Set `false` for providers whose replay format cannot represent prior
   * tool turns (the V0.1 ai-sdk text-only replay path).
   */
  includeToolEvents?: boolean;
  /**
   * Include system-role events (system notes / instructions). Default
   * `false`. System instructions are normally injected fresh by the
   * runner each turn, not replayed from durable history.
   */
  includeSystemEvents?: boolean;
  /**
   * Include thinking-content entries. Default `false`. Thinking replay
   * is provider-specific (Anthropic signed signatures); callers that
   * need it opt in and reattach signatures from the event content.
   */
  includeThinking?: boolean;
}

// ============================================================================
// Projection
// ============================================================================

/**
 * Build the model-visible history from a RuntimeEvent stream.
 *
 * Events SHOULD be supplied in causal order; the projection preserves
 * input order. Partial events are always excluded — callers MUST NOT
 * replay transient streaming chunks into the next model call.
 *
 * The default options match the durable-history policy: user/model text
 * and tool calls/responses are kept; thinking, system notes, token usage,
 * permission acks, and diagnostics are dropped.
 */
export function buildModelHistoryFromRuntimeEvents(
  events: readonly RuntimeEvent[],
  options: BuildModelHistoryOptions = {},
): ModelHistoryEntry[] {
  const includeToolEvents = options.includeToolEvents ?? true;
  const includeSystemEvents = options.includeSystemEvents ?? false;
  const includeThinking = options.includeThinking ?? false;

  const out: ModelHistoryEntry[] = [];
  for (const event of events) {
    // 1. Never replay transient streaming chunks.
    if (isPartialRuntimeEvent(event)) continue;

    // 2. Only model-visible content kinds (text/thinking/function_*).
    if (!runtimeEventHasModelVisibleContent(event)) continue;

    const content = event.content;
    if (!content) continue;

    // 3. System-role events are UI notes by default; opt in for
    //    model-injected system instructions.
    if (event.role === 'system' && !includeSystemEvents) continue;

    // 4. Thinking replay is provider-specific; opt in.
    if (content.kind === 'thinking' && !includeThinking) continue;

    // 5. Tool function_call / function_response; opt out for text-only.
    if (
      !includeToolEvents &&
      (content.kind === 'function_call' || content.kind === 'function_response')
    ) {
      continue;
    }

    out.push({
      role: event.role,
      content,
      ts: event.ts,
      eventId: event.id,
    });
  }
  return out;
}

export interface RuntimeEventTextMessageOptions {
  includeSystemEvents?: boolean;
}

export interface BuildRuntimeEventModelReplayPlanOptions {
  includeSystemEvents?: boolean;
  /**
   * Turn IDs known — from the FULL prior ledger — to contain tool activity.
   *
   * The signed-thinking-in-tool-turn skip (see `turnsWithToolActivity` in the
   * planner) is a whole-history invariant, but `events` here may be a
   * budget-pruned / history-search slice that dropped a turn's
   * tool_call/tool_response while keeping its (query-matched) signed thinking.
   * Scanning only the slice would then miss the tool activity and wrongly
   * replay that thinking provider-native. Callers that slice MUST pass the
   * full-ledger tool-turn ids (see `collectToolActivityTurnIds`); the planner
   * unions them with tool activity found in `events`.
   */
  toolActivityTurnIds?: ReadonlySet<string>;
}

/**
 * Collect the turn ids that contain tool activity (function_call /
 * function_response) from a RuntimeEvent ledger. Pass the result as
 * `toolActivityTurnIds` when the events handed to the replay planner are a
 * slice of this ledger.
 */
export function collectToolActivityTurnIds(events: readonly RuntimeEvent[]): Set<string> {
  const ids = new Set<string>();
  for (const event of events) {
    if (isPartialRuntimeEvent(event)) continue;
    const kind = event.content?.kind;
    if ((kind === 'function_call' || kind === 'function_response') && event.turnId) {
      ids.add(event.turnId);
    }
  }
  return ids;
}

export function buildRuntimeEventModelReplayPlan(
  events: readonly RuntimeEvent[],
  options: BuildRuntimeEventModelReplayPlanOptions = {},
): RuntimeEventModelReplayPlan {
  const includeSystemEvents = options.includeSystemEvents ?? false;
  const items: RuntimeEventModelReplayItem[] = [];
  const diagnostics: RuntimeEventReplayDiagnostic[] = [];
  const callsById = new Map<string, {
    name: string;
    eventId: string;
    item: Extract<RuntimeEventModelReplayItem, { kind: 'tool_call' }>;
  }>();

  // Signed thinking in a tool turn is only replayable when the turn's tool calls
  // carry a step id (RuntimeEventRefs.stepId, stamped from tool_start): the
  // materializer then merges the step's reasoning + tool calls into one provider
  // assistant message. Legacy per-turn history has no step id — its single
  // end-of-turn reasoning lands after the tool events and cannot be reattached
  // to the tool-use assistant message (Anthropic 400), so it is still skipped.
  //
  // Classify each tool turn: paired (all its function_call events carry a
  // stepId) vs unpaired (any lacks one). Union caller-supplied whole-ledger
  // tool-turn ids that this (possibly sliced) `events` view cannot confirm as
  // paired, so a sliced-away tool turn degrades safely to the legacy skip.
  //
  // The judgment is deliberately TURN-granular, not per-step: one turn is
  // written by one backend build, so old (no stepId) and new (stepId) tool
  // calls cannot mix within a turn — per-step classification would add
  // complexity for a state that cannot exist. And pairedToolTurnIds is not
  // dead state: it is what lets a caller-supplied tool-turn id (from the FULL
  // ledger) stay replayable when this sliced view can prove the turn's calls
  // are step-paired — without it every sliced tool turn would degrade.
  const pairedToolTurnIds = new Set<string>();
  const unpairedToolTurnIds = new Set<string>();
  for (const event of events) {
    if (isPartialRuntimeEvent(event)) continue;
    if (event.content?.kind === 'function_call' && event.turnId) {
      if (event.refs?.stepId) pairedToolTurnIds.add(event.turnId);
      else unpairedToolTurnIds.add(event.turnId);
    }
  }
  for (const id of options.toolActivityTurnIds ?? []) {
    if (!pairedToolTurnIds.has(id)) unpairedToolTurnIds.add(id);
  }

  for (const event of events) {
    if (isPartialRuntimeEvent(event)) {
      diagnostics.push(diagnostic(event, 'partial_skipped', 'partial RuntimeEvent skipped for model replay'));
      continue;
    }

    if (isTerminalRuntimeEvent(event)) {
      diagnostics.push(diagnostic(
        event,
        'terminal_fact_diagnostic_only',
        'terminal RuntimeEvent status is diagnostic-only for model replay',
        { status: event.status },
      ));
    }

    if (!event.content) {
      if (event.actions && !isTerminalRuntimeEvent(event)) {
        diagnostics.push(diagnostic(
          event,
          'system_runtime_fact_diagnostic_only',
          'RuntimeEvent actions are diagnostic-only for model replay',
          { actionKeys: Object.keys(event.actions) },
        ));
      }
      continue;
    }

    if (!runtimeEventHasModelVisibleContent(event)) {
      // A model-role empty text event is the step closer of a thinking-only /
      // tool-only step (the backend emits text_complete with '' so the
      // read-model gets an assistant row for the step's reasoning). It carries
      // nothing to replay but is NOT unsupported history — flagging it
      // unsupported_content would block provider-native replay of the whole
      // ledger (hasBlockingReplayDiagnostics). Skip it benignly; the
      // materializer pairs the step's parked reasoning with its tool calls by
      // stepId at flush time, so no text closer is needed.
      if (event.content.kind === 'text' && event.role === 'model') {
        diagnostics.push(diagnostic(
          event,
          'empty_text_skipped',
          'empty model text RuntimeEvent (thinking/tool-only step closer) skipped for model replay',
        ));
        continue;
      }
      diagnostics.push(diagnostic(
        event,
        'unsupported_content',
        'RuntimeEvent content kind is not model-replayable',
        { kind: event.content.kind },
      ));
      continue;
    }

    if (event.role === 'system' && !includeSystemEvents) {
      diagnostics.push(diagnostic(
        event,
        'system_runtime_fact_diagnostic_only',
        'system RuntimeEvent content is diagnostic-only unless system replay is enabled',
      ));
      continue;
    }

    switch (event.content.kind) {
      case 'text': {
        const role = modelTextRole(event.role);
        if (!role) {
          diagnostics.push(diagnostic(event, 'unsupported_role', 'text RuntimeEvent role is not model-replayable', {
            role: event.role,
          }));
          continue;
        }
        items.push({
          kind: 'text',
          role,
          content: formatTextWithAttachmentRefs(event.content),
          ...(event.content.attachments ? { attachments: event.content.attachments } : {}),
          // Model text carries its step id (the message id) so the materializer
          // can close a step and group its reasoning + tool calls.
          ...(role === 'assistant' && event.refs?.providerEventId
            ? { stepId: event.refs.providerEventId }
            : {}),
          eventId: event.id,
          ts: event.ts,
        });
        break;
      }
      case 'thinking': {
        if (event.role !== 'model') {
          diagnostics.push(diagnostic(event, 'unsupported_role', 'thinking RuntimeEvent must use model role', {
            role: event.role,
          }));
          continue;
        }
        if (!event.content.signature) {
          // Unsigned thinking cannot be replayed provider-native: Anthropic
          // rejects a thinking block without its signature, and other providers
          // accept no native thinking at all. Skip it from replay items (and its
          // semantic kind) rather than block — a non-Anthropic (e.g. GLM) turn
          // persists thinking for the UI, but must not drag the whole history
          // down to stored-message projection. The thinking stays in the
          // read-model; it just never re-enters the model request.
          diagnostics.push(diagnostic(
            event,
            'unsigned_thinking_skipped',
            'unsigned thinking RuntimeEvent skipped for model replay',
          ));
          continue;
        }
        if (event.turnId && unpairedToolTurnIds.has(event.turnId)) {
          // Signed, but its turn has tool calls with no step id to pair against
          // (legacy per-turn history) — the end-of-turn reasoning cannot be
          // reattached to the tool-use assistant message. Keep it in the
          // read-model for the UI; skip it from replay without downgrading the
          // whole history. Per-step history (paired tool calls) is not skipped:
          // the materializer merges each step's reasoning with its tool calls.
          diagnostics.push(diagnostic(
            event,
            'signed_thinking_in_tool_turn_skipped',
            'signed thinking RuntimeEvent skipped for model replay: its turn calls tools with no step id to pair the reasoning to a tool-use assistant message',
          ));
          continue;
        }
        items.push({
          kind: 'thinking',
          text: event.content.text,
          signature: event.content.signature,
          ...(event.refs?.providerEventId ? { stepId: event.refs.providerEventId } : {}),
          eventId: event.id,
          ts: event.ts,
        });
        break;
      }
      case 'function_call': {
        if (event.role !== 'model') {
          diagnostics.push(diagnostic(event, 'unsupported_role', 'function_call RuntimeEvent must use model role', {
            role: event.role,
          }));
          continue;
        }
        const item: Extract<RuntimeEventModelReplayItem, { kind: 'tool_call' }> = {
          kind: 'tool_call',
          toolCallId: event.content.id,
          toolName: event.content.name,
          input: event.content.args,
          ...(event.refs?.stepId ? { stepId: event.refs.stepId } : {}),
          eventId: event.id,
          ts: event.ts,
        };
        callsById.set(event.content.id, { name: event.content.name, eventId: event.id, item });
        items.push(item);
        break;
      }
      case 'function_response': {
        if (event.role !== 'tool') {
          diagnostics.push(diagnostic(event, 'unsupported_role', 'function_response RuntimeEvent must use tool role', {
            role: event.role,
          }));
          continue;
        }
        const normalizedShellResult = normalizeShellToolResultContent(event.content.result);
        if (normalizedShellResult.state === 'invalid') {
          const call = callsById.get(event.content.id);
          if (call) {
            const callIndex = items.indexOf(call.item);
            if (callIndex >= 0) items.splice(callIndex, 1);
            callsById.delete(event.content.id);
          }
          diagnostics.push(diagnostic(
            event,
            'unsupported_content',
            'function_response contains an invalid shell tool result',
          ));
          continue;
        }
        const call = callsById.get(event.content.id);
        if (!call) {
          diagnostics.push(diagnostic(event, 'unmatched_tool_result', 'function_response has no prior matching function_call', {
            toolCallId: event.content.id,
          }));
        } else if (call.name !== event.content.name) {
          diagnostics.push(diagnostic(event, 'tool_id_mismatch', 'function_response name differs from matching function_call', {
            toolCallId: event.content.id,
            callName: call.name,
            resultName: event.content.name,
            callEventId: call.eventId,
          }));
        }
        items.push({
          kind: 'tool_result',
          toolCallId: event.content.id,
          toolName: event.content.name,
          output: normalizedShellResult.state === 'valid'
            ? normalizedShellResult.content
            : event.content.result,
          isError: event.content.isError === true,
          eventId: event.id,
          ts: event.ts,
        });
        callsById.delete(event.content.id);
        break;
      }
      default:
        diagnostics.push(diagnostic(
          event,
          'unsupported_content',
          'RuntimeEvent content kind is not model-replayable',
          { kind: (event.content as RuntimeEventContent).kind },
        ));
        break;
    }
  }

  const textMessages = items
    .filter((item): item is Extract<RuntimeEventModelReplayItem, { kind: 'text' }> => item.kind === 'text')
    .map((item) => ({ role: item.role, content: item.content }));
  const semanticKinds = [...new Set(items.map((item) => item.kind))];
  return {
    items,
    textMessages,
    semanticKinds,
    diagnostics,
    hasProviderNativeSemantics: semanticKinds.includes('thinking')
      || semanticKinds.includes('tool_call')
      || semanticKinds.includes('tool_result'),
  };
}

/**
 * Convert projected RuntimeEvent history into the current AI SDK text-only
 * message shape. Tool/function and thinking entries are intentionally skipped.
 */
export function buildTextModelMessagesFromRuntimeEvents(
  events: readonly RuntimeEvent[],
  options: RuntimeEventTextMessageOptions = {},
): TextModelMessage[] {
  const history = buildModelHistoryFromRuntimeEvents(events, {
    includeToolEvents: false,
    includeSystemEvents: options.includeSystemEvents ?? false,
    includeThinking: false,
  });
  const out: TextModelMessage[] = [];
  for (const entry of history) {
    if (entry.content.kind !== 'text') continue;
    if (entry.role === 'tool') continue;
    if (entry.role === 'system' && !options.includeSystemEvents) continue;
    const role = entry.role === 'model'
      ? 'assistant'
      : entry.role === 'user'
        ? 'user'
        : entry.role === 'system'
          ? 'system'
          : undefined;
    if (!role) continue;
    out.push({
      role,
      content: formatTextWithAttachmentRefs(entry.content),
    });
  }
  return out;
}

function modelTextRole(role: RuntimeEventRole): TextModelMessage['role'] | undefined {
  switch (role) {
    case 'user':
      return 'user';
    case 'model':
      return 'assistant';
    case 'system':
      return 'system';
    default:
      return undefined;
  }
}

function diagnostic(
  event: RuntimeEvent,
  code: RuntimeEventReplayDiagnosticCode,
  message: string,
  detail?: Record<string, unknown>,
): RuntimeEventReplayDiagnostic {
  return {
    code,
    message,
    eventId: event.id,
    turnId: event.turnId,
    ...(detail ? { detail } : {}),
  };
}

export function formatTextWithAttachmentRefs(
  textOrContent: string | RuntimeEventTextContent,
  attachments?: AttachmentRef[],
): string {
  const text = typeof textOrContent === 'string' ? textOrContent : textOrContent.text;
  const refs = typeof textOrContent === 'string' ? attachments : textOrContent.attachments;
  if (!refs || refs.length === 0) return text;
  return `${text}\n\n${formatAttachmentRefs(refs)}`;
}

function formatAttachmentRefs(attachments: readonly AttachmentRef[]): string {
  return attachments.map((a) => `[attachment: ${a.name} (${a.mimeType})]`).join(' ');
}
