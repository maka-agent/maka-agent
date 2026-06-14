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
  runtimeEventHasModelVisibleContent,
  type RuntimeEvent,
  type RuntimeEventContent,
  type RuntimeEventRole,
} from '@maka/core/runtime-event';

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
