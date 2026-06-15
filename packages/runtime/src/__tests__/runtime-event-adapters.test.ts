/**
 * Tests for runtime-event-adapters and model-history projection.
 *
 * Run: `npm --workspace @maka/runtime run test`
 *
 * Proves the policy from the work node body:
 *   - partial model chunks are not included in durable model history;
 *   - tool/function response events can be included when model-visible;
 *   - diagnostics/token/permission-only events are excluded;
 *   - legacy user/assistant/system stored messages convert safely.
 */

import { describe, test } from 'node:test';
import { expect } from '../test-helpers.js';
import type { AttachmentRef } from '@maka/core/events';
import type {
  UserMessage,
  AssistantMessage,
  SystemNoteMessage,
  ToolCallMessage,
  ToolResultMessage,
  TokenUsageMessage,
  PermissionDecisionMessage,
  TurnStateMessage,
  StoredMessage,
} from '@maka/core/session';
import type {
  RuntimeEvent,
  RuntimeEventContent,
} from '@maka/core/runtime-event';
import {
  storedMessageToRuntimeEvent,
  storedMessageToRuntimeEvents,
  runtimeEventToStoredMessageDraft,
} from '../runtime-event-adapters.js';
import {
  buildModelHistoryFromRuntimeEvents,
  buildRuntimeEventModelReplayPlan,
  buildTextModelMessagesFromRuntimeEvents,
  type ModelHistoryEntry,
} from '../model-history.js';

// ---------- StoredMessage fixtures ----------

const ts = 1_700_000_000_000;
const turnId = 't1';

const attachment: AttachmentRef = {
  kind: 'pdf',
  name: 'brief.pdf',
  mimeType: 'application/pdf',
  bytes: 2048,
  ref: { kind: 'session_file', sessionId: 'sess-1', relativePath: 'attachments/brief.pdf' },
};

const user = (id: string, text: string): UserMessage => ({
  type: 'user',
  id,
  turnId,
  ts: ts + 1,
  text,
});

const assistant = (
  id: string,
  text: string,
  thinking?: { text: string; signature?: string },
): AssistantMessage => ({
  type: 'assistant',
  id,
  turnId,
  ts: ts + 2,
  text,
  modelId: 'claude-sonnet-4-5',
  ...(thinking ? { thinking } : {}),
});

const note = (id: string, kind: SystemNoteMessage['kind']): SystemNoteMessage => ({
  type: 'system_note',
  id,
  ts: ts + 3,
  kind,
});

const toolCall = (id: string, name: string, args: unknown = {}): ToolCallMessage => ({
  type: 'tool_call',
  id,
  turnId,
  ts: ts + 4,
  toolName: name,
  args,
});

const toolResult = (
  toolUseId: string,
  isError: boolean,
  text: string,
): ToolResultMessage => ({
  type: 'tool_result',
  id: `r-${toolUseId}`,
  turnId,
  ts: ts + 5,
  toolUseId,
  isError,
  content: { kind: 'text', text },
});

const tokens = (id: string): TokenUsageMessage => ({
  type: 'token_usage',
  id,
  turnId,
  ts: ts + 6,
  input: 10,
  output: 5,
});

const permission = (id: string): PermissionDecisionMessage => ({
  type: 'permission_decision',
  id,
  turnId,
  ts: ts + 7,
  toolUseId: 'tu-1',
  toolName: 'Write',
  decision: 'allow',
});

const turnState = (id: string): TurnStateMessage => ({
  type: 'turn_state',
  id,
  turnId,
  ts: ts + 8,
  status: 'completed',
  partialOutputRetained: false,
});

const ctx = {
  sessionId: 'sess-1',
  invocationId: 'inv-1',
  runId: 'run-1',
};

// ---------- RuntimeEvent fixtures ----------

let __seq = 0;
function ev(overrides: Partial<RuntimeEvent> & { content?: RuntimeEventContent } = {}): RuntimeEvent {
  __seq += 1;
  return {
    id: `evt-${__seq}`,
    invocationId: 'inv-1',
    runId: 'run-1',
    sessionId: 'sess-1',
    turnId: 'turn-1',
    ts: ts + __seq,
    partial: false,
    role: 'user',
    author: 'user',
    ...overrides,
  };
}

// ============================================================================
// storedMessageToRuntimeEvent (singular)
// ============================================================================

describe('storedMessageToRuntimeEvent', () => {
  test('user message → role user, text content, refs link', () => {
    const e = storedMessageToRuntimeEvent(user('u1', 'hello'), ctx);
    expect(e).not.toBeNull();
    if (!e) return;
    expect(e.role).toBe('user');
    expect(e.author).toBe('user');
    expect(e.partial).toBe(false);
    expect(e.content).toEqual({ kind: 'text', text: 'hello' });
    expect(e.refs?.storedMessageId).toBe('u1');
    expect(e.sessionId).toBe('sess-1');
    expect(e.turnId).toBe(turnId);
    expect(e.ts).toBe(ts + 1);
  });

  test('user message with attachments preserves attachment refs in text content', () => {
    const e = storedMessageToRuntimeEvent(
      { ...user('u-attach', 'see attached'), attachments: [attachment] },
      ctx,
    );
    expect(e).not.toBeNull();
    if (!e) return;
    expect(e.content).toEqual({
      kind: 'text',
      text: 'see attached',
      attachments: [attachment],
    });
  });

  test('assistant message (text only) → role model, text content; thinking dropped', () => {
    const e = storedMessageToRuntimeEvent(assistant('a1', 'hi'), ctx);
    if (!e) throw new Error('expected event');
    expect(e.role).toBe('model');
    expect(e.author).toBe('agent');
    expect(e.content).toEqual({ kind: 'text', text: 'hi' });
  });

  test('system_note → role system, text content labels the note kind', () => {
    const e = storedMessageToRuntimeEvent(note('n1', 'session_start'), ctx);
    if (!e) throw new Error('expected event');
    expect(e.role).toBe('system');
    expect(e.author).toBe('system');
    expect(e.content).toEqual({ kind: 'text', text: 'system_note:session_start' });
  });

  test('tool_call → null (needs runtime-runner-owned mapping)', () => {
    expect(storedMessageToRuntimeEvent(toolCall('tc1', 'Read'), ctx)).toBeNull();
  });

  test('tool_result → null', () => {
    expect(storedMessageToRuntimeEvent(toolResult('tc1', false, 'data'), ctx)).toBeNull();
  });

  test('token_usage → null', () => {
    expect(storedMessageToRuntimeEvent(tokens('tu1'), ctx)).toBeNull();
  });

  test('permission_decision → null', () => {
    expect(storedMessageToRuntimeEvent(permission('pd1'), ctx)).toBeNull();
  });

  test('turn_state → null', () => {
    expect(storedMessageToRuntimeEvent(turnState('ts1'), ctx)).toBeNull();
  });

  test('context ts override is honored', () => {
    const e = storedMessageToRuntimeEvent(user('u', 'x'), { ...ctx, ts: 9999 });
    if (!e) throw new Error('expected event');
    expect(e.ts).toBe(9999);
  });

  test('context turnId override is honored (session-level note has no turnId)', () => {
    const e = storedMessageToRuntimeEvent(note('n', 'session_start'), {
      ...ctx,
      turnId: 'override-turn',
    });
    if (!e) throw new Error('expected event');
    expect(e.turnId).toBe('override-turn');
  });

  test('session-level note without turnId defaults to empty string', () => {
    const e = storedMessageToRuntimeEvent(note('n', 'session_resume'), ctx);
    if (!e) throw new Error('expected event');
    expect(e.turnId).toBe('');
  });

  test('custom newId is used for generated event ids', () => {
    const e = storedMessageToRuntimeEvent(user('u', 'x'), {
      ...ctx,
      newId: () => 'fixed-id',
    });
    if (!e) throw new Error('expected event');
    expect(e.id).toBe('fixed-id');
  });
});

// ============================================================================
// storedMessageToRuntimeEvents (plural — captures thinking)
// ============================================================================

describe('storedMessageToRuntimeEvents', () => {
  test('assistant without thinking → single text event', () => {
    const out = storedMessageToRuntimeEvents(assistant('a1', 'hi'), ctx);
    expect(out).toHaveLength(1);
    expect(out[0]?.content?.kind).toBe('text');
  });

  test('assistant with thinking → [text event, thinking event]', () => {
    const out = storedMessageToRuntimeEvents(
      assistant('a2', 'answer', { text: 'reasoning', signature: 'sig-1' }),
      ctx,
    );
    expect(out).toHaveLength(2);
    expect(out[0]?.content).toEqual({ kind: 'text', text: 'answer' });
    expect(out[1]?.content).toEqual({
      kind: 'thinking',
      text: 'reasoning',
      signature: 'sig-1',
    });
    expect(out[1]?.role).toBe('model');
    expect(out[1]?.refs?.storedMessageId).toBe('a2');
  });

  test('user message → single event (same as singular)', () => {
    const out = storedMessageToRuntimeEvents(user('u', 'hello'), ctx);
    expect(out).toHaveLength(1);
    expect(out[0]?.content).toEqual({ kind: 'text', text: 'hello' });
  });

  test('user message with attachments → single attachment-preserving event', () => {
    const out = storedMessageToRuntimeEvents(
      { ...user('u-attach', 'see attached'), attachments: [attachment] },
      ctx,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.content).toEqual({
      kind: 'text',
      text: 'see attached',
      attachments: [attachment],
    });
  });

  test('tool_call → empty array', () => {
    expect(storedMessageToRuntimeEvents(toolCall('tc', 'Read'), ctx)).toEqual([]);
  });

  test('assistant with empty thinking text → single text event only', () => {
    const out = storedMessageToRuntimeEvents(
      assistant('a3', 'hi', { text: '' }),
      ctx,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.content?.kind).toBe('text');
  });
});

// ============================================================================
// runtimeEventToStoredMessageDraft
// ============================================================================

describe('runtimeEventToStoredMessageDraft', () => {
  test('user text event → UserMessage', () => {
    const event = ev({
      role: 'user',
      author: 'user',
      content: { kind: 'text', text: 'hello' },
      refs: { storedMessageId: 'u1' },
    });
    const draft = runtimeEventToStoredMessageDraft(event);
    expect(draft).not.toBeNull();
    if (!draft) return;
    expect(draft.type).toBe('user');
    if (draft.type !== 'user') return;
    expect(draft.id).toBe('u1');
    expect(draft.text).toBe('hello');
    expect(draft.turnId).toBe(event.turnId);
    expect(draft.ts).toBe(event.ts);
  });

  test('user text event with attachments → UserMessage with attachments', () => {
    const event = ev({
      role: 'user',
      author: 'user',
      content: { kind: 'text', text: 'see attached', attachments: [attachment] },
      refs: { storedMessageId: 'u-attach' },
    });
    const draft = runtimeEventToStoredMessageDraft(event);
    expect(draft).not.toBeNull();
    if (!draft || draft.type !== 'user') return;
    expect(draft.attachments).toEqual([attachment]);
  });

  test('model text event with modelId → AssistantMessage', () => {
    const event = ev({
      role: 'model',
      author: 'agent',
      content: { kind: 'text', text: 'answer' },
      refs: { storedMessageId: 'a1' },
    });
    const draft = runtimeEventToStoredMessageDraft(event, { modelId: 'gpt-4o' });
    expect(draft).not.toBeNull();
    if (!draft) return;
    expect(draft.type).toBe('assistant');
    if (draft.type !== 'assistant') return;
    expect(draft.id).toBe('a1');
    expect(draft.text).toBe('answer');
    expect(draft.modelId).toBe('gpt-4o');
  });

  test('model text event without modelId → null (no safe legacy shape)', () => {
    const event = ev({
      role: 'model',
      author: 'agent',
      content: { kind: 'text', text: 'answer' },
    });
    expect(runtimeEventToStoredMessageDraft(event)).toBeNull();
  });

  test('partial user and model text events → null', () => {
    const partialUser = ev({
      partial: true,
      role: 'user',
      author: 'user',
      content: { kind: 'text', text: 'typing...' },
    });
    const partialModel = ev({
      partial: true,
      role: 'model',
      author: 'agent',
      content: { kind: 'text', text: 'streaming...' },
    });

    expect(runtimeEventToStoredMessageDraft(partialUser)).toBeNull();
    expect(runtimeEventToStoredMessageDraft(partialModel, { modelId: 'gpt-4o' })).toBeNull();
  });

  test('thinking event → null', () => {
    const event = ev({
      role: 'model',
      author: 'agent',
      content: { kind: 'thinking', text: 'hmm' },
    });
    expect(runtimeEventToStoredMessageDraft(event, { modelId: 'm' })).toBeNull();
  });

  test('function_call event → null (tool projection owned elsewhere)', () => {
    const event = ev({
      role: 'model',
      author: 'agent',
      content: { kind: 'function_call', id: 'fc1', name: 'Read', args: {} },
    });
    expect(runtimeEventToStoredMessageDraft(event)).toBeNull();
  });

  test('function_response event → null', () => {
    const event = ev({
      role: 'tool',
      author: 'tool',
      content: {
        kind: 'function_response',
        id: 'fc1',
        name: 'Read',
        result: 'data',
        isError: false,
      },
    });
    expect(runtimeEventToStoredMessageDraft(event)).toBeNull();
  });

  test('actions-only event (token usage) → null', () => {
    const event = ev({
      role: 'system',
      author: 'system',
      actions: {
        tokenUsage: { input: 10, output: 5 },
      },
    });
    expect(runtimeEventToStoredMessageDraft(event)).toBeNull();
  });

  test('error-content event → null', () => {
    const event = ev({
      role: 'model',
      author: 'agent',
      content: { kind: 'error', message: 'boom' },
    });
    expect(runtimeEventToStoredMessageDraft(event)).toBeNull();
  });

  test('round-trip: user message → event → draft preserves text', () => {
    const original = user('orig', 'round-trip text');
    const event = storedMessageToRuntimeEvent(original, ctx);
    if (!event) throw new Error('expected event');
    const draft = runtimeEventToStoredMessageDraft(event);
    if (!draft || draft.type !== 'user') throw new Error('expected user draft');
    expect(draft.text).toBe('round-trip text');
    expect(draft.id).toBe('orig');
  });
});

// ============================================================================
// buildModelHistoryFromRuntimeEvents — policy
// ============================================================================

describe('buildModelHistoryFromRuntimeEvents', () => {
  test('empty input → empty history', () => {
    expect(buildModelHistoryFromRuntimeEvents([])).toEqual([]);
  });

  test('user + final model text → two entries in order', () => {
    const events: RuntimeEvent[] = [
      ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'q' } }),
      ev({ role: 'model', author: 'agent', content: { kind: 'text', text: 'a' } }),
    ];
    const out = buildModelHistoryFromRuntimeEvents(events);
    expect(out).toHaveLength(2);
    expect(out[0]?.role).toBe('user');
    expect(out[1]?.role).toBe('model');
    expect(out[0]?.content).toEqual({ kind: 'text', text: 'q' });
  });

  test('POLICY: partial model chunks are excluded', () => {
    const events: RuntimeEvent[] = [
      ev({
        partial: true,
        role: 'model',
        author: 'agent',
        content: { kind: 'text', text: 'streaming chunk...' },
      }),
      ev({
        role: 'model',
        author: 'agent',
        content: { kind: 'text', text: 'final answer' },
      }),
    ];
    const out = buildModelHistoryFromRuntimeEvents(events);
    expect(out).toHaveLength(1);
    expect(out[0]?.content).toEqual({ kind: 'text', text: 'final answer' });
  });

  test('POLICY: function_call + function_response included by default', () => {
    const events: RuntimeEvent[] = [
      ev({
        role: 'user',
        author: 'user',
        content: { kind: 'text', text: 'read the file' },
      }),
      ev({
        role: 'model',
        author: 'agent',
        content: {
          kind: 'function_call',
          id: 'fc1',
          name: 'Read',
          args: { path: '/x' },
        },
      }),
      ev({
        role: 'tool',
        author: 'tool',
        content: {
          kind: 'function_response',
          id: 'fc1',
          name: 'Read',
          result: 'file contents',
          isError: false,
        },
      }),
      ev({
        role: 'model',
        author: 'agent',
        content: { kind: 'text', text: 'done' },
      }),
    ];
    const out = buildModelHistoryFromRuntimeEvents(events);
    expect(out).toHaveLength(4);
    expect(out.map((e) => e.role)).toEqual(['user', 'model', 'tool', 'model']);
    expect(out[1]?.content?.kind).toBe('function_call');
    expect(out[2]?.content?.kind).toBe('function_response');
  });

  test('POLICY: function_response with isError stays model-visible', () => {
    const events: RuntimeEvent[] = [
      ev({
        role: 'tool',
        author: 'tool',
        content: {
          kind: 'function_response',
          id: 'fc1',
          name: 'Write',
          result: 'denied',
          isError: true,
        },
      }),
    ];
    const out = buildModelHistoryFromRuntimeEvents(events);
    expect(out).toHaveLength(1);
    expect((out[0]?.content as { isError?: boolean }).isError).toBe(true);
  });

  test('POLICY: tool events excluded when includeToolEvents=false (text-only replay)', () => {
    const events: RuntimeEvent[] = [
      ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'q' } }),
      ev({
        role: 'model',
        author: 'agent',
        content: { kind: 'function_call', id: 'fc1', name: 'Read', args: {} },
      }),
      ev({
        role: 'tool',
        author: 'tool',
        content: {
          kind: 'function_response',
          id: 'fc1',
          name: 'Read',
          result: 'data',
        },
      }),
      ev({ role: 'model', author: 'agent', content: { kind: 'text', text: 'a' } }),
    ];
    const out = buildModelHistoryFromRuntimeEvents(events, {
      includeToolEvents: false,
    });
    expect(out).toHaveLength(2);
    expect(out.map((e) => e.role)).toEqual(['user', 'model']);
  });

  test('POLICY: token-usage (actions-only) event excluded', () => {
    const events: RuntimeEvent[] = [
      ev({
        role: 'model',
        author: 'agent',
        content: { kind: 'text', text: 'a' },
        actions: { tokenUsage: { input: 100, output: 50 } },
      }),
      ev({
        role: 'system',
        author: 'system',
        actions: { tokenUsage: { input: 0, output: 0 } },
      }),
    ];
    const out = buildModelHistoryFromRuntimeEvents(events);
    expect(out).toHaveLength(1);
    expect(out[0]?.content?.kind).toBe('text');
  });

  test('POLICY: permission ack (actions-only) event excluded', () => {
    const events: RuntimeEvent[] = [
      ev({
        role: 'system',
        author: 'system',
        actions: {
          permissionDecision: {
            requestId: 'req-1',
            decision: 'allow',
          },
        },
      }),
      ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'q' } }),
    ];
    const out = buildModelHistoryFromRuntimeEvents(events);
    expect(out).toHaveLength(1);
    expect(out[0]?.role).toBe('user');
  });

  test('POLICY: error-only content event excluded', () => {
    const events: RuntimeEvent[] = [
      ev({
        role: 'model',
        author: 'agent',
        content: { kind: 'error', message: 'something broke' },
      }),
      ev({ role: 'model', author: 'agent', content: { kind: 'text', text: 'a' } }),
    ];
    const out = buildModelHistoryFromRuntimeEvents(events);
    expect(out).toHaveLength(1);
    expect(out[0]?.content?.kind).toBe('text');
  });

  test('POLICY: system-role (UI note) event excluded by default', () => {
    const events: RuntimeEvent[] = [
      ev({
        role: 'system',
        author: 'system',
        content: { kind: 'text', text: 'system_note:session_start' },
      }),
      ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'q' } }),
    ];
    const out = buildModelHistoryFromRuntimeEvents(events);
    expect(out).toHaveLength(1);
    expect(out[0]?.role).toBe('user');
  });

  test('POLICY: system-role event included when includeSystemEvents=true', () => {
    const events: RuntimeEvent[] = [
      ev({
        role: 'system',
        author: 'system',
        content: { kind: 'text', text: 'You are a helpful assistant.' },
      }),
      ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'q' } }),
    ];
    const out = buildModelHistoryFromRuntimeEvents(events, {
      includeSystemEvents: true,
    });
    expect(out).toHaveLength(2);
    expect(out[0]?.role).toBe('system');
  });

  test('POLICY: thinking excluded by default, included when includeThinking=true', () => {
    const events: RuntimeEvent[] = [
      ev({
        role: 'model',
        author: 'agent',
        content: { kind: 'thinking', text: 'reasoning', signature: 's' },
      }),
      ev({ role: 'model', author: 'agent', content: { kind: 'text', text: 'a' } }),
    ];
    expect(buildModelHistoryFromRuntimeEvents(events)).toHaveLength(1);
    const out = buildModelHistoryFromRuntimeEvents(events, {
      includeThinking: true,
    });
    expect(out).toHaveLength(2);
    expect(out[0]?.content?.kind).toBe('thinking');
  });

  test('endInvocation terminal marker with no content → excluded', () => {
    const events: RuntimeEvent[] = [
      ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'q' } }),
      ev({
        role: 'model',
        author: 'agent',
        status: 'completed',
        actions: { endInvocation: true },
      }),
    ];
    const out = buildModelHistoryFromRuntimeEvents(events);
    expect(out).toHaveLength(1);
    expect(out[0]?.role).toBe('user');
  });

  test('entries preserve event order and carry eventId + ts', () => {
    const events: RuntimeEvent[] = [
      ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'a' } }),
      ev({ role: 'model', author: 'agent', content: { kind: 'text', text: 'b' } }),
      ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'c' } }),
    ];
    const out = buildModelHistoryFromRuntimeEvents(events);
    expect(out.map((e) => e.eventId)).toEqual(events.map((e) => e.id));
    expect(out.map((e) => e.ts)).toEqual(events.map((e) => e.ts));
  });

  test('full durable-history-shaped stream: partials + finals + diagnostics', () => {
    // Mirrors a realistic turn: streaming chunks (partial), final assistant
    // text, tool call/response, token usage, system note, terminal marker.
    const events: RuntimeEvent[] = [
      ev({
        partial: true,
        role: 'model',
        author: 'agent',
        content: { kind: 'text', text: 'Let me ' },
      }),
      ev({
        partial: true,
        role: 'model',
        author: 'agent',
        content: { kind: 'text', text: 'Let me check' },
      }),
      ev({
        role: 'model',
        author: 'agent',
        content: {
          kind: 'function_call',
          id: 'fc1',
          name: 'Read',
          args: { path: '/a' },
        },
      }),
      ev({
        role: 'tool',
        author: 'tool',
        content: {
          kind: 'function_response',
          id: 'fc1',
          name: 'Read',
          result: 'contents',
        },
      }),
      ev({
        role: 'model',
        author: 'agent',
        content: { kind: 'text', text: 'Here is the file.' },
      }),
      ev({
        role: 'system',
        author: 'system',
        actions: { tokenUsage: { input: 10, output: 5 } },
      }),
      ev({
        role: 'system',
        author: 'system',
        content: { kind: 'text', text: 'system_note:mode_change' },
      }),
      ev({
        role: 'model',
        author: 'agent',
        status: 'completed',
        actions: { endInvocation: true },
      }),
    ];
    const out = buildModelHistoryFromRuntimeEvents(events);
    // Only: function_call, function_response, final text.
    expect(out.map((e) => e.content?.kind)).toEqual([
      'function_call',
      'function_response',
      'text',
    ]);
  });

  test('text-only AI SDK projection skips unsupported entries and preserves user attachment refs', () => {
    const events: RuntimeEvent[] = [
      ev({
        role: 'user',
        author: 'user',
        content: { kind: 'text', text: 'see attached', attachments: [attachment] },
      }),
      ev({
        partial: true,
        role: 'model',
        author: 'agent',
        content: { kind: 'text', text: 'partial' },
      }),
      ev({
        role: 'system',
        author: 'system',
        content: { kind: 'text', text: 'system note' },
      }),
      ev({
        role: 'model',
        author: 'agent',
        content: { kind: 'thinking', text: 'private reasoning' },
      }),
      ev({
        role: 'model',
        author: 'agent',
        content: { kind: 'function_call', id: 'fc1', name: 'Read', args: {} },
      }),
      ev({
        role: 'tool',
        author: 'tool',
        content: { kind: 'function_response', id: 'fc1', name: 'Read', result: 'data' },
      }),
      ev({
        role: 'model',
        author: 'agent',
        content: { kind: 'text', text: 'final answer' },
      }),
      ev({
        role: 'model',
        author: 'agent',
        status: 'completed',
        actions: { endInvocation: true },
      }),
    ];

    expect(buildTextModelMessagesFromRuntimeEvents(events)).toEqual([
      {
        role: 'user',
        content: 'see attached\n\n[attachment: brief.pdf (application/pdf)]',
      },
      { role: 'assistant', content: 'final answer' },
    ]);
  });

  test('runtime replay plan preserves structured tool calls and results', () => {
    const events: RuntimeEvent[] = [
      ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'read package' } }),
      ev({
        role: 'model',
        author: 'agent',
        content: { kind: 'function_call', id: 'tool-1', name: 'Read', args: { path: 'package.json' } },
      }),
      ev({
        role: 'tool',
        author: 'tool',
        content: {
          kind: 'function_response',
          id: 'tool-1',
          name: 'Read',
          result: { ok: true, text: 'contents' },
          isError: false,
        },
      }),
    ];

    const plan = buildRuntimeEventModelReplayPlan(events);

    expect(plan.hasProviderNativeSemantics).toBe(true);
    expect(plan.semanticKinds).toEqual(['text', 'tool_call', 'tool_result']);
    expect(plan.items).toEqual([
      { kind: 'text', role: 'user', content: 'read package', eventId: events[0]?.id, ts: events[0]?.ts },
      {
        kind: 'tool_call',
        toolCallId: 'tool-1',
        toolName: 'Read',
        input: { path: 'package.json' },
        eventId: events[1]?.id,
        ts: events[1]?.ts,
      },
      {
        kind: 'tool_result',
        toolCallId: 'tool-1',
        toolName: 'Read',
        output: { ok: true, text: 'contents' },
        isError: false,
        eventId: events[2]?.id,
        ts: events[2]?.ts,
      },
    ]);
  });

  test('runtime replay plan carries thinking separately and text replay never leaks it', () => {
    const events: RuntimeEvent[] = [
      ev({
        role: 'model',
        author: 'agent',
        content: { kind: 'thinking', text: 'private reasoning', signature: 'sig-1' },
      }),
      ev({ role: 'model', author: 'agent', content: { kind: 'text', text: 'public answer' } }),
    ];

    const plan = buildRuntimeEventModelReplayPlan(events);

    expect(plan.items.map((item) => item.kind)).toEqual(['thinking', 'text']);
    expect(plan.textMessages).toEqual([{ role: 'assistant', content: 'public answer' }]);
    expect(buildTextModelMessagesFromRuntimeEvents(events)).toEqual([
      { role: 'assistant', content: 'public answer' },
    ]);
  });

  test('runtime replay plan diagnoses unsigned thinking without flattening it into text', () => {
    const events: RuntimeEvent[] = [
      ev({
        role: 'model',
        author: 'agent',
        content: { kind: 'thinking', text: 'private reasoning' },
      }),
      ev({ role: 'model', author: 'agent', content: { kind: 'text', text: 'answer' } }),
    ];

    const plan = buildRuntimeEventModelReplayPlan(events);

    expect(plan.diagnostics.map((diagnostic) => diagnostic.code)).toContain('unsigned_thinking');
    expect(plan.textMessages).toEqual([{ role: 'assistant', content: 'answer' }]);
  });

  test('terminal RuntimeEvents are diagnostic-only for replay semantics', () => {
    const events: RuntimeEvent[] = [
      ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'q' } }),
      ev({
        role: 'model',
        author: 'agent',
        status: 'completed',
        actions: { endInvocation: true },
      }),
    ];

    const plan = buildRuntimeEventModelReplayPlan(events);

    expect(plan.items).toHaveLength(1);
    expect(plan.diagnostics.map((diagnostic) => diagnostic.code)).toContain('terminal_fact_diagnostic_only');
  });
});

// ============================================================================
// Adapter + projection integration
// ============================================================================

describe('adapter → projection integration', () => {
  test('legacy messages convert to events then project to clean history', () => {
    const messages: StoredMessage[] = [
      user('u1', 'what is 2+2?'),
      assistant('a1', 'it is 4'),
      tokens('tu1'),
      note('n1', 'mode_change'),
    ];
    const events: RuntimeEvent[] = [];
    for (const m of messages) {
      events.push(...storedMessageToRuntimeEvents(m, ctx));
    }
    // Only user + assistant text survive projection (system note excluded,
    // token_usage never produced an event).
    const history = buildModelHistoryFromRuntimeEvents(events);
    expect(history).toHaveLength(2);
    expect(history[0]?.role).toBe('user');
    expect(history[1]?.role).toBe('model');
    expect((history[0]?.content as { text: string }).text).toBe('what is 2+2?');
  });

  test('ModelHistoryEntry type carries the discriminated content union', () => {
    const entry: ModelHistoryEntry = {
      role: 'model',
      content: { kind: 'function_call', id: 'fc1', name: 'Read', args: {} },
      ts: 1,
      eventId: 'e1',
    };
    if (entry.content.kind === 'function_call') {
      expect(entry.content.name).toBe('Read');
    } else {
      throw new Error('discriminator failed');
    }
  });
});
