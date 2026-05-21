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
