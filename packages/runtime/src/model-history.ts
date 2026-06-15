/**
 * Model history projection — build the model-visible message history from a
 * RuntimeEvent stream.
 *
 * Source: docs/runtime-v2-architecture-evolution.md §Model history
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
  | 'unsigned_thinking'
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
      eventId: string;
      ts: number;
    }
  | {
      kind: 'thinking';
      text: string;
      signature?: string;
      eventId: string;
      ts: number;
    }
  | {
      kind: 'tool_call';
      toolCallId: string;
      toolName: string;
      input: unknown;
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
}

export function buildRuntimeEventModelReplayPlan(
  events: readonly RuntimeEvent[],
  options: BuildRuntimeEventModelReplayPlanOptions = {},
): RuntimeEventModelReplayPlan {
  const includeSystemEvents = options.includeSystemEvents ?? false;
  const items: RuntimeEventModelReplayItem[] = [];
  const diagnostics: RuntimeEventReplayDiagnostic[] = [];
  const callsById = new Map<string, { name: string; eventId: string }>();
  const semanticKinds = new Set<RuntimeEventReplaySemanticKind>();

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
        semanticKinds.add('text');
        items.push({
          kind: 'text',
          role,
          content: formatTextWithAttachmentRefs(event.content),
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
          diagnostics.push(diagnostic(event, 'unsigned_thinking', 'thinking RuntimeEvent has no replay signature'));
        }
        semanticKinds.add('thinking');
        items.push({
          kind: 'thinking',
          text: event.content.text,
          ...(event.content.signature ? { signature: event.content.signature } : {}),
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
        semanticKinds.add('tool_call');
        callsById.set(event.content.id, { name: event.content.name, eventId: event.id });
        items.push({
          kind: 'tool_call',
          toolCallId: event.content.id,
          toolName: event.content.name,
          input: event.content.args,
          eventId: event.id,
          ts: event.ts,
        });
        break;
      }
      case 'function_response': {
        if (event.role !== 'tool') {
          diagnostics.push(diagnostic(event, 'unsupported_role', 'function_response RuntimeEvent must use tool role', {
            role: event.role,
          }));
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
        semanticKinds.add('tool_result');
        items.push({
          kind: 'tool_result',
          toolCallId: event.content.id,
          toolName: event.content.name,
          output: event.content.result,
          isError: event.content.isError === true,
          eventId: event.id,
          ts: event.ts,
        });
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
  return {
    items,
    textMessages,
    semanticKinds: [...semanticKinds],
    diagnostics,
    hasProviderNativeSemantics: semanticKinds.has('thinking')
      || semanticKinds.has('tool_call')
      || semanticKinds.has('tool_result'),
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
