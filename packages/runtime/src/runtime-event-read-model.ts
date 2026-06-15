import type {
  AgentRunHeader,
  RuntimeEvent,
  RuntimeEventStatus,
  StoredMessage,
  ToolResultContent,
  TurnStatus,
} from '@maka/core';
import {
  isPartialRuntimeEvent,
  isTerminalRuntimeEvent,
} from '@maka/core';

export type RuntimeEventReadModelDiagnosticCode =
  | 'partial_skipped'
  | 'unsupported_event'
  | 'incomplete_event'
  | 'generated_id'
  | 'context_remaining_unsupported'
  | 'tool_use_id_mismatch'
  | 'missing_legacy_message'
  | 'unexpected_projected_message';

export interface RuntimeEventReadModelDiagnostic {
  code: RuntimeEventReadModelDiagnosticCode;
  eventId?: string;
  runId?: string;
  turnId?: string;
  message: string;
  detail?: unknown;
}

export interface RuntimeEventReadModelProjection {
  messages: StoredMessage[];
  diagnostics: RuntimeEventReadModelDiagnostic[];
}

export interface ProjectRuntimeEventsToStoredMessagesOptions {
  runHeaders: readonly AgentRunHeader[] | Readonly<Record<string, AgentRunHeader>>;
}

export interface RuntimeReadModelCompatibilityResult {
  compatible: boolean;
  diagnostics: RuntimeEventReadModelDiagnostic[];
}

interface ProjectionState {
  headers: Map<string, AgentRunHeader>;
  diagnostics: RuntimeEventReadModelDiagnostic[];
  toolNameByUseId: Map<string, string>;
  permissionRequestById: Map<string, {
    requestId: string;
    toolUseId: string;
    toolName: string;
    hint?: string;
  }>;
}

export function projectRuntimeEventsToStoredMessages(
  events: readonly RuntimeEvent[],
  options: ProjectRuntimeEventsToStoredMessagesOptions,
): RuntimeEventReadModelProjection {
  const state: ProjectionState = {
    headers: normalizeHeaders(options.runHeaders),
    diagnostics: [],
    toolNameByUseId: new Map(),
    permissionRequestById: new Map(),
  };
  const messages: StoredMessage[] = [];

  for (const event of events) {
    if (isPartialRuntimeEvent(event)) {
      diagnostic(state, event, 'partial_skipped', 'partial RuntimeEvent skipped');
      continue;
    }

    let projected = false;
    const content = event.content;
    if (content) {
      switch (content.kind) {
        case 'text':
          projected = projectText(event, state, messages) || projected;
          break;
        case 'function_call':
          projected = projectFunctionCall(event, state, messages) || projected;
          break;
        case 'function_response':
          projected = projectFunctionResponse(event, state, messages) || projected;
          break;
        case 'thinking':
          diagnostic(state, event, 'unsupported_event', 'thinking content has no legacy read-model row');
          break;
        case 'error':
          if (!isTerminalRuntimeEvent(event)) {
            diagnostic(state, event, 'unsupported_event', 'non-terminal error content has no safe legacy read-model row');
          }
          break;
      }
    }

    if (event.actions?.permissionRequest) {
      const request = event.actions.permissionRequest;
      state.permissionRequestById.set(request.requestId, {
        requestId: request.requestId,
        toolUseId: request.toolUseId,
        toolName: request.toolName,
        ...(request.hint !== undefined ? { hint: request.hint } : {}),
      });
      state.toolNameByUseId.set(request.toolUseId, request.toolName);
      projected = true;
    }

    if (event.actions?.permissionDecision) {
      projected = projectPermissionDecision(event, state, messages) || projected;
    }

    if (event.actions?.tokenUsage) {
      projected = projectTokenUsage(event, state, messages) || projected;
    }

    if (isTerminalRuntimeEvent(event)) {
      projected = projectTerminalTurnState(event, state, messages) || projected;
    }

    if (event.actions?.tokenUsage?.contextRemaining !== undefined) {
      diagnostic(state, event, 'context_remaining_unsupported', 'token usage contextRemaining is diagnostic-only in StoredMessage');
    }

    if (!projected) {
      diagnostic(state, event, 'unsupported_event', 'RuntimeEvent shape is not supported by the legacy read-model projection');
    }
  }

  return { messages, diagnostics: state.diagnostics };
}

export function compareRuntimeReadModelMessages(
  projected: readonly StoredMessage[],
  legacy: readonly StoredMessage[],
): RuntimeReadModelCompatibilityResult {
  const diagnostics: RuntimeEventReadModelDiagnostic[] = [];
  const projectedCounts = countSemanticMessages(projected);
  const legacyCounts = countSemanticMessages(legacy);

  for (const [key, count] of legacyCounts) {
    const projectedCount = projectedCounts.get(key) ?? 0;
    if (projectedCount < count) {
      diagnostics.push({
        code: 'missing_legacy_message',
        message: 'projected RuntimeEvent read model is missing a legacy semantic message',
        detail: JSON.parse(key) as unknown,
      });
    }
  }

  for (const [key, count] of projectedCounts) {
    const legacyCount = legacyCounts.get(key) ?? 0;
    if (legacyCount < count) {
      diagnostics.push({
        code: 'unexpected_projected_message',
        message: 'projected RuntimeEvent read model has no matching legacy semantic message',
        detail: JSON.parse(key) as unknown,
      });
    }
  }

  return { compatible: diagnostics.length === 0, diagnostics };
}

function projectText(
  event: RuntimeEvent,
  state: ProjectionState,
  messages: StoredMessage[],
): boolean {
  if (event.content?.kind !== 'text') return false;
  if (event.role === 'user') {
    messages.push({
      type: 'user',
      id: stableMessageId(event, state, 'user'),
      turnId: event.turnId,
      ts: event.ts,
      text: event.content.text,
      ...(event.content.attachments !== undefined && event.content.attachments.length > 0
        ? { attachments: event.content.attachments }
        : {}),
    });
    return true;
  }

  if (event.role === 'model') {
    const header = state.headers.get(event.runId);
    if (!header?.modelId) {
      diagnostic(state, event, 'incomplete_event', 'model text RuntimeEvent requires AgentRunHeader.modelId');
      return false;
    }
    messages.push({
      type: 'assistant',
      id: stableMessageId(event, state, 'assistant'),
      turnId: event.turnId,
      ts: event.ts,
      text: event.content.text,
      modelId: header.modelId,
    });
    return true;
  }

  diagnostic(state, event, 'unsupported_event', `text content with role ${event.role} is not projected`);
  return false;
}

function projectFunctionCall(
  event: RuntimeEvent,
  state: ProjectionState,
  messages: StoredMessage[],
): boolean {
  if (event.content?.kind !== 'function_call') return false;
  const toolUseId = toolUseIdFor(event);
  if (!toolUseId) {
    diagnostic(state, event, 'incomplete_event', 'function_call RuntimeEvent requires content.id or refs.toolCallId');
    return false;
  }
  if (event.content.id !== toolUseId) {
    diagnostic(state, event, 'tool_use_id_mismatch', 'function_call content.id differs from refs.toolCallId', {
      contentId: event.content.id,
      refToolCallId: event.refs?.toolCallId,
    });
  }
  state.toolNameByUseId.set(toolUseId, event.content.name);
  messages.push({
    type: 'tool_call',
    id: toolUseId,
    turnId: event.turnId,
    ts: event.ts,
    toolName: event.content.name,
    ...(stringStateDelta(event, 'displayName') !== undefined
      ? { displayName: stringStateDelta(event, 'displayName') }
      : {}),
    ...(stringStateDelta(event, 'intent') !== undefined
      ? { intent: stringStateDelta(event, 'intent') }
      : {}),
    args: event.content.args,
  });
  return true;
}

function projectFunctionResponse(
  event: RuntimeEvent,
  state: ProjectionState,
  messages: StoredMessage[],
): boolean {
  if (event.content?.kind !== 'function_response') return false;
  const toolUseId = toolUseIdFor(event);
  if (!toolUseId) {
    diagnostic(state, event, 'incomplete_event', 'function_response RuntimeEvent requires content.id or refs.toolCallId');
    return false;
  }
  if (event.content.id !== toolUseId) {
    diagnostic(state, event, 'tool_use_id_mismatch', 'function_response content.id differs from refs.toolCallId', {
      contentId: event.content.id,
      refToolCallId: event.refs?.toolCallId,
    });
  }
  if (!isToolResultContent(event.content.result)) {
    diagnostic(state, event, 'incomplete_event', 'function_response result is not a legacy ToolResultContent');
    return false;
  }
  if (event.content.name) state.toolNameByUseId.set(toolUseId, event.content.name);
  messages.push({
    type: 'tool_result',
    id: stableMessageId(event, state, 'tool_result'),
    turnId: event.turnId,
    ts: event.ts,
    toolUseId,
    isError: event.content.isError === true,
    content: event.content.result,
    ...(numberStateDelta(event, 'durationMs') !== undefined
      ? { durationMs: numberStateDelta(event, 'durationMs') }
      : {}),
  });
  return true;
}

function projectPermissionDecision(
  event: RuntimeEvent,
  state: ProjectionState,
  messages: StoredMessage[],
): boolean {
  const decision = event.actions?.permissionDecision;
  if (!decision) return false;
  const request = state.permissionRequestById.get(decision.requestId);
  const toolUseId = event.refs?.toolCallId ?? request?.toolUseId;
  if (!toolUseId) {
    diagnostic(state, event, 'incomplete_event', 'permission decision requires refs.toolCallId or a paired permission request');
    return false;
  }
  const toolName = request?.toolName ?? state.toolNameByUseId.get(toolUseId);
  if (!toolName) {
    diagnostic(state, event, 'incomplete_event', 'permission decision requires a paired permission request or tool call for toolName');
    return false;
  }
  messages.push({
    type: 'permission_decision',
    id: decision.requestId,
    turnId: event.turnId,
    ts: event.ts,
    toolUseId,
    toolName,
    decision: decision.decision,
    ...(decision.rememberForTurn !== undefined ? { rememberForTurn: decision.rememberForTurn } : {}),
    ...(request?.hint !== undefined ? { hint: request.hint } : {}),
  });
  return true;
}

function projectTokenUsage(
  event: RuntimeEvent,
  state: ProjectionState,
  messages: StoredMessage[],
): boolean {
  const usage = event.actions?.tokenUsage;
  if (!usage) return false;
  messages.push({
    type: 'token_usage',
    id: stableMessageId(event, state, 'token_usage'),
    turnId: event.turnId,
    ts: event.ts,
    input: usage.input,
    output: usage.output,
    ...(usage.cacheRead !== undefined ? { cacheRead: usage.cacheRead } : {}),
    ...(usage.cacheCreation !== undefined ? { cacheCreation: usage.cacheCreation } : {}),
    ...(usage.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
  });
  return true;
}

function projectTerminalTurnState(
  event: RuntimeEvent,
  state: ProjectionState,
  messages: StoredMessage[],
): boolean {
  const header = state.headers.get(event.runId);
  if (!header) {
    diagnostic(state, event, 'incomplete_event', 'terminal RuntimeEvent requires an AgentRunHeader');
    return false;
  }
  const status = turnStatusFor(event.status, header.status);
  if (!status) {
    diagnostic(state, event, 'incomplete_event', 'terminal RuntimeEvent status cannot be mapped to a legacy TurnStatus');
    return false;
  }
  const partialOutputRetained = messages.some((message) =>
    message.turnId === event.turnId &&
    ((message.type === 'assistant' && message.text.trim().length > 0) || message.type === 'tool_result')
  );
  messages.push({
    type: 'turn_state',
    id: stableMessageId(event, state, 'turn_state'),
    turnId: event.turnId,
    ts: event.ts,
    status,
    ...(header.parentTurnId ? { parentTurnId: header.parentTurnId } : {}),
    ...(header.retriedFromTurnId ? { retriedFromTurnId: header.retriedFromTurnId } : {}),
    ...(header.regeneratedFromTurnId ? { regeneratedFromTurnId: header.regeneratedFromTurnId } : {}),
    ...(header.branchOfTurnId ? { branchOfTurnId: header.branchOfTurnId } : {}),
    ...(header.parentSessionId ? { parentSessionId: header.parentSessionId } : {}),
    ...(status === 'aborted' ? { abortedAt: event.ts } : {}),
    ...(status === 'failed' ? { errorClass: header.failureClass ?? 'unknown' } : {}),
    partialOutputRetained,
  });
  if (status === 'failed' && !header.failureClass) {
    diagnostic(state, event, 'incomplete_event', 'failed terminal event did not carry an exact AgentRunHeader.failureClass');
  }
  if (status === 'aborted') {
    diagnostic(state, event, 'incomplete_event', 'abortSource is not present in RuntimeEvent or AgentRunHeader metadata');
  }
  return true;
}

function stableMessageId(
  event: RuntimeEvent,
  state: ProjectionState,
  kind: StoredMessage['type'],
  contentId?: string,
): string {
  const stable = event.refs?.storedMessageId
    ?? event.refs?.providerEventId
    ?? contentId
    ?? event.id;
  if (stable) return stable;
  const generated = `rtproj:${event.id}:${kind}`;
  diagnostic(state, event, 'generated_id', 'projection used a deterministic generated id', { id: generated });
  return generated;
}

function toolUseIdFor(event: RuntimeEvent): string | undefined {
  if (event.content?.kind !== 'function_call' && event.content?.kind !== 'function_response') {
    return event.refs?.toolCallId;
  }
  return event.content.id || event.refs?.toolCallId;
}

function normalizeHeaders(
  headers: readonly AgentRunHeader[] | Readonly<Record<string, AgentRunHeader>>,
): Map<string, AgentRunHeader> {
  if (Array.isArray(headers)) {
    return new Map(headers.map((header) => [header.runId, header]));
  }
  return new Map(Object.values(headers).map((header) => [header.runId, header]));
}

function turnStatusFor(
  eventStatus: RuntimeEventStatus | undefined,
  runStatus: AgentRunHeader['status'],
): TurnStatus | undefined {
  if (eventStatus === 'completed') return 'completed';
  if (eventStatus === 'failed') return 'failed';
  if (eventStatus === 'aborted' || eventStatus === 'cancelled') return 'aborted';
  if (runStatus === 'completed') return 'completed';
  if (runStatus === 'failed') return 'failed';
  if (runStatus === 'cancelled') return 'aborted';
  return undefined;
}

function stringStateDelta(event: RuntimeEvent, key: string): string | undefined {
  const value = event.actions?.stateDelta?.[key];
  return typeof value === 'string' ? value : undefined;
}

function numberStateDelta(event: RuntimeEvent, key: string): number | undefined {
  const value = event.actions?.stateDelta?.[key];
  return typeof value === 'number' ? value : undefined;
}

function isToolResultContent(value: unknown): value is ToolResultContent {
  if (!value || typeof value !== 'object') return false;
  const kind = (value as { kind?: unknown }).kind;
  return kind === 'text'
    || kind === 'json'
    || kind === 'file_diff'
    || kind === 'file_write'
    || kind === 'terminal'
    || kind === 'image'
    || kind === 'summary'
    || kind === 'web_search'
    || kind === 'web_search_error'
    || kind === 'office_document'
    || kind === 'explore_agent'
    || kind === 'rive_workflow';
}

function diagnostic(
  state: ProjectionState,
  event: RuntimeEvent,
  code: RuntimeEventReadModelDiagnosticCode,
  message: string,
  detail?: unknown,
): void {
  state.diagnostics.push({
    code,
    eventId: event.id,
    runId: event.runId,
    turnId: event.turnId,
    message,
    ...(detail !== undefined ? { detail } : {}),
  });
}

function countSemanticMessages(messages: readonly StoredMessage[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const message of messages) {
    const key = stableSemanticKey(semanticMessage(message));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function stableSemanticKey(value: unknown): string {
  return JSON.stringify(sortSemanticValue(value));
}

function sortSemanticValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortSemanticValue);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => [key, sortSemanticValue((value as Record<string, unknown>)[key])]),
  );
}

function semanticMessage(message: StoredMessage): unknown {
  switch (message.type) {
    case 'user':
      return {
        type: message.type,
        turnId: message.turnId,
        text: message.text,
        attachments: message.attachments ?? [],
      };
    case 'assistant':
      return {
        type: message.type,
        turnId: message.turnId,
        text: message.text,
        modelId: message.modelId,
        thinking: message.thinking,
      };
    case 'tool_call':
      return {
        type: message.type,
        turnId: message.turnId,
        toolUseId: message.id,
        toolName: message.toolName,
        displayName: message.displayName,
        intent: message.intent,
        args: message.args,
      };
    case 'tool_result':
      return {
        type: message.type,
        turnId: message.turnId,
        toolUseId: message.toolUseId,
        isError: message.isError,
        content: message.content,
        durationMs: message.durationMs,
      };
    case 'permission_decision':
      return {
        type: message.type,
        turnId: message.turnId,
        toolUseId: message.toolUseId,
        toolName: message.toolName,
        decision: message.decision,
        rememberForTurn: message.rememberForTurn,
        hint: message.hint,
      };
    case 'token_usage':
      return {
        type: message.type,
        turnId: message.turnId,
        input: message.input,
        output: message.output,
        cacheRead: message.cacheRead,
        cacheCreation: message.cacheCreation,
        costUsd: message.costUsd,
      };
    case 'turn_state':
      return {
        type: message.type,
        turnId: message.turnId,
        status: message.status,
        parentTurnId: message.parentTurnId,
        retriedFromTurnId: message.retriedFromTurnId,
        regeneratedFromTurnId: message.regeneratedFromTurnId,
        branchOfTurnId: message.branchOfTurnId,
        parentSessionId: message.parentSessionId,
        abortedAt: message.abortedAt,
        abortSource: message.abortSource,
        errorClass: message.errorClass,
        partialOutputRetained: message.partialOutputRetained,
      };
    case 'system_note':
      return {
        type: message.type,
        turnId: message.turnId,
        kind: message.kind,
        data: message.data,
      };
  }
}
