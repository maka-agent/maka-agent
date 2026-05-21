import type { StoredMessage, ToolResultContent } from '@maka/core';

export interface ChatItem {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  /** Wall-clock timestamp of the source StoredMessage; surfaced for hover meta. */
  ts?: number;
}

export interface ToolActivityItem {
  toolUseId: string;
  toolName: string;
  displayName?: string;
  intent?: string;
  status: 'pending' | 'waiting_permission' | 'running' | 'completed' | 'errored' | 'interrupted';
  args: unknown;
  result?: ToolResultContent;
  durationMs?: number;
}

// system_note kinds that we surface inline to the user. Everything else
// (session_resume, connection_locked, mode_change-as-internal-audit, …)
// stays in the JSONL audit trail but is hidden from the chat surface so
// the conversation reads like a conversation, not a debug log.
const VISIBLE_SYSTEM_NOTES = new Set<string>([
  // Reserved for future user-relevant notices, e.g. 'turn_aborted'.
]);

const SYSTEM_NOTE_LABELS: Record<string, string> = {
  mode_change: 'Permission mode changed',
  turn_aborted: 'Turn aborted',
};

export function materializeChat(messages: StoredMessage[]): ChatItem[] {
  const items: ChatItem[] = [];
  for (const message of messages) {
    if (message.type === 'user') items.push({ id: message.id, role: 'user', text: message.text, ts: message.ts });
    if (message.type === 'assistant') items.push({ id: message.id, role: 'assistant', text: message.text, ts: message.ts });
    if (message.type === 'system_note' && VISIBLE_SYSTEM_NOTES.has(message.kind)) {
      items.push({
        id: message.id,
        role: 'system',
        text: SYSTEM_NOTE_LABELS[message.kind] ?? message.kind,
        ts: message.ts,
      });
    }
  }
  return items;
}

export function materializeTools(messages: StoredMessage[]): ToolActivityItem[] {
  const results = new Map(messages.filter((message) => message.type === 'tool_result').map((message) => [message.toolUseId, message]));
  return messages
    .filter((message) => message.type === 'tool_call')
    .map((call) => {
      const result = results.get(call.id);
      return {
        toolUseId: call.id,
        toolName: call.toolName,
        displayName: call.displayName,
        intent: call.intent,
        status: result ? (result.isError ? 'errored' : 'completed') : 'interrupted',
        args: call.args,
        result: result?.content,
        durationMs: result?.durationMs,
      };
    });
}

/**
 * A single conversational turn — typically one user message, the assistant's
 * tool calls (if any), and the assistant's final answer. Derived as a
 * read-only projection from `messages` + live tools (no storage changes
 * needed — every StoredMessage already carries a `turnId`).
 *
 * Per @kenji UI-04 (turn narrative): replaces the previous "message stack
 * + tools panel at end" layout with a per-turn rendering so a single user
 * → assistant exchange reads as one work unit instead of fragments.
 */
export interface TurnViewModel {
  turnId: string;
  user?: ChatItem;
  tools: ToolActivityItem[];
  assistant?: ChatItem;
  /**
   * Anthropic-style reasoning that some providers expose alongside the
   * assistant's final answer. Rendered in a collapsed `<details>` so the
   * answer reads cleanly but the thinking is one click away when the
   * user wants to verify the chain of reasoning.
   */
  assistantThinking?: string;
  /** System notes inside this turn that survive the VISIBLE_SYSTEM_NOTES gate. */
  notes: ChatItem[];
  /** Wall-clock ts of the earliest message in this turn — used for sorting. */
  startedAt: number;
  /** Model id from the assistant message (if any), e.g. claude-sonnet-4-5. */
  modelId?: string;
  /** Wall-clock ms between earliest user/tool message and assistant message. */
  durationMs?: number;
  /** Token totals summed across all `token_usage` messages within the turn. */
  tokens?: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheCreation?: number;
    costUsd?: number;
  };
}

/**
 * Group materialized chat + tool items by `turnId` into ordered turns. Items
 * without a turnId (e.g. fake-backend echo, or older sessions) fall into a
 * synthetic `__loose` bucket rendered first so they remain visible.
 */
export function materializeTurns(
  messages: StoredMessage[],
  liveTools: ToolActivityItem[] = [],
): TurnViewModel[] {
  const turnsByMsg = new Map<string, string>();
  const order: string[] = [];
  const byId = new Map<string, TurnViewModel>();
  const looseTurnId = '__loose';

  function ensureTurn(turnId: string, startedAt: number): TurnViewModel {
    let turn = byId.get(turnId);
    if (!turn) {
      turn = { turnId, tools: [], notes: [], startedAt };
      byId.set(turnId, turn);
      order.push(turnId);
    } else if (startedAt < turn.startedAt) {
      turn.startedAt = startedAt;
    }
    return turn;
  }

  // First pass: assign each message to its turn and walk chat-relevant
  // messages into the projection.
  for (const message of messages) {
    const turnId = (message as { turnId?: string }).turnId ?? looseTurnId;
    const ts = (message as { ts?: number }).ts ?? 0;
    const turn = ensureTurn(turnId, ts);
    if (message.type === 'user') {
      turn.user = { id: message.id, role: 'user', text: message.text, ts: message.ts };
    } else if (message.type === 'assistant') {
      turn.assistant = { id: message.id, role: 'assistant', text: message.text, ts: message.ts };
      turn.modelId = message.modelId;
      if (message.thinking?.text) {
        turn.assistantThinking = message.thinking.text;
      }
      // Time-to-answer measured from the earliest message in this turn (usually
      // the user's send) to the assistant message ts. Tool runs are inside
      // this window, so the same metric captures both LLM latency and tool
      // wall-time. We only compute this once the assistant message lands, so
      // a streaming turn stays at undefined ("进行中" per kenji's PR82
      // review) instead of ticking up against the current clock and forcing
      // visible re-renders.
      if (message.ts !== undefined && message.ts >= turn.startedAt) {
        turn.durationMs = message.ts - turn.startedAt;
      }
    } else if (message.type === 'system_note' && VISIBLE_SYSTEM_NOTES.has(message.kind)) {
      turn.notes.push({
        id: message.id,
        role: 'system',
        text: SYSTEM_NOTE_LABELS[message.kind] ?? message.kind,
        ts: message.ts,
      });
    } else if (message.type === 'tool_call') {
      turnsByMsg.set(message.id, turnId);
    } else if (message.type === 'token_usage') {
      const totals = turn.tokens ?? { input: 0, output: 0 };
      totals.input += message.input;
      totals.output += message.output;
      if (message.cacheRead !== undefined) totals.cacheRead = (totals.cacheRead ?? 0) + message.cacheRead;
      if (message.cacheCreation !== undefined) totals.cacheCreation = (totals.cacheCreation ?? 0) + message.cacheCreation;
      if (message.costUsd !== undefined) totals.costUsd = (totals.costUsd ?? 0) + message.costUsd;
      turn.tokens = totals;
    }
  }

  // Second pass: tools, persisted then live. Tools land in the turn matching
  // their tool_call's turnId. Live tools without a matching persisted call
  // (e.g. streaming-in-flight before persistence) attach to the latest
  // active turn so they still surface in the right turn.
  const persistedTools = materializeTools(messages);
  const liveById = new Map(liveTools.map((tool) => [tool.toolUseId, tool]));
  for (const tool of persistedTools) {
    const live = liveById.get(tool.toolUseId);
    const merged = live ? { ...tool, ...live } : tool;
    const turnId = turnsByMsg.get(tool.toolUseId) ?? order[order.length - 1] ?? looseTurnId;
    const turn = ensureTurn(turnId, Date.now());
    turn.tools.push(merged);
    liveById.delete(tool.toolUseId);
  }
  for (const liveOnly of liveById.values()) {
    const turnId = order[order.length - 1] ?? looseTurnId;
    const turn = ensureTurn(turnId, Date.now());
    turn.tools.push(liveOnly);
  }

  return order.map((turnId) => byId.get(turnId)!);
}
