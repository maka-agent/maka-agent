/**
 * Backend → UI unified event stream.
 *
 * Runtime backends normalize their provider-native streams to
 * this `SessionEvent` union. The UI never imports SDK types directly.
 *
 * Source: V0.1_TECH_SPEC.md §4.1
 *
 * Connection-setup events live in ./connections.ts (separate channel).
 */

import type { PermissionMode, PermissionRequest, PermissionResponse, ToolCategory } from './permission.js';
import type {
  CacheMissInputSource,
  ContextBudgetDiagnostic,
  PrefixChangeReason,
  PromptSegmentEstimate,
} from './usage-stats/types.js';

export const TOOL_OUTPUT_STREAMS = ['stdout', 'stderr'] as const;
export const TOOL_OUTPUT_DELTA_MAX_CHARS = 8192;

// ============================================================================
// Storage refs (shared by attachments, image tool results, etc.)
// ============================================================================

export type StorageRef =
  | { kind: 'session_file'; sessionId: string; relativePath: string }
  | { kind: 'workspace_file'; relativePath: string }
  | { kind: 'external_file'; absolutePath: string };

export interface AttachmentRef {
  kind: 'image' | 'pdf' | 'doc' | 'code' | 'other';
  name: string;
  mimeType: string;
  bytes: number;
  ref: StorageRef;
}

// ============================================================================
// Event union
// ============================================================================

interface BaseEvent {
  /** Event uuid — used for dedup on reconnect/replay. */
  id: string;
  /** Groups all events from one agent turn. */
  turnId: string;
  /** Unix ms timestamp. */
  ts: number;
}

export type SessionEvent =
  | TextDeltaEvent
  | TextCompleteEvent
  | ThinkingDeltaEvent
  | ThinkingCompleteEvent
  | ToolStartEvent
  | ToolOutputDeltaEvent
  | ToolProgressEvent
  | ToolResultEvent
  | PermissionRequestEvent
  | PermissionDecisionAckEvent
  | PlanSubmittedEvent
  | TokenUsageEvent
  | ErrorEvent
  | CompleteEvent
  | AbortEvent;

export interface TextDeltaEvent extends BaseEvent {
  type: 'text_delta';
  messageId: string;
  text: string;
}

export interface TextCompleteEvent extends BaseEvent {
  type: 'text_complete';
  messageId: string;
  text: string;
}

export interface ThinkingDeltaEvent extends BaseEvent {
  type: 'thinking_delta';
  messageId: string;
  text: string;
}

export interface ThinkingCompleteEvent extends BaseEvent {
  type: 'thinking_complete';
  messageId: string;
  text: string;
  /** Anthropic signed thinking — MUST be re-sent on replay. */
  signature?: string;
}

export interface ToolStartEvent extends BaseEvent {
  type: 'tool_start';
  toolUseId: string;
  toolName: string;
  args: unknown;
  displayName?: string;
  intent?: string;
}

export type ToolOutputStream = typeof TOOL_OUTPUT_STREAMS[number];

/**
 * Live output side-channel for long-running tools.
 *
 * This is intentionally separate from ToolResultEvent: deltas are transient UI
 * updates, while tool_result remains the terminal persisted result. `seq` is
 * monotonic per toolCallId/toolUseId so renderers can de-dupe and repair
 * event/result races without relying on arrival order.
 */
export interface ToolOutputDeltaEvent extends BaseEvent {
  type: 'tool_output_delta';
  sessionId: string;
  toolCallId: string;
  /** Existing UI/runtime name for the same identifier. */
  toolUseId: string;
  seq: number;
  stream: ToolOutputStream;
  chunk: string;
  redacted: boolean;
  createdAt: number;
}

export interface ToolProgressEvent extends BaseEvent {
  type: 'tool_progress';
  toolUseId: string;
  chunk: string | { kind: 'stdout' | 'stderr'; text: string };
}

export interface ToolResultEvent extends BaseEvent {
  type: 'tool_result';
  toolUseId: string;
  isError: boolean;
  content: ToolResultContent;
  durationMs?: number;
}

export type ToolResultContent =
  | { kind: 'text'; text: string }
  | { kind: 'json'; value: unknown }
  | { kind: 'file_diff'; paths: string[]; diff: string }
  | { kind: 'file_write'; path: string; bytes: number }
  | {
      kind: 'archived_tool_result';
      status: 'not_loaded' | 'missing' | 'corrupt';
      runtimeEventId: string;
      toolCallId: string;
      toolName: string;
      artifactId?: string;
      bodySha256?: string;
      originalEstimatedTokens: number;
      originalBytes: number;
      rewriteVersion: number;
      reason: 'stale_tool_result_pruned_before_compact';
    }
  | {
      kind: 'terminal';
      cwd: string;
      cmd: string;
      exitCode: number;
      stdout: string;
      stderr: string;
    }
  | { kind: 'image'; mimeType: string; ref: StorageRef }
  | { kind: 'summary'; original: string; summarized: string; reason: 'too_large' }
  /**
   * PR-CHAT-WEB-SEARCH-RENDER-0: structured tool-result for the gated
   * WebSearch agent tool. The chat renderer surfaces these as plain
   * text cards (title + url + snippet + source); never markdown, never
   * HTML, matching the Settings → 联网搜索 live-query verification surface.
   *
   * Rows are an opaque `unknown[]` here so the storage layer does not
   * need to import the `@maka/core/web-search` row type; the renderer
   * narrows each row at render time.
   */
  | {
      kind: 'web_search';
      provider: string;
      query: string;
      rows: ReadonlyArray<{
        title: string;
        url: string;
        snippet: string;
        source: string;
      }>;
    }
  | {
      kind: 'web_search_error';
      ok: false;
      provider: string;
      query?: string;
      reason: string;
      message: string;
      credentialSource?: string;
    }
  | {
      kind: 'office_document';
      ok: boolean;
      operation?: string;
      path?: string;
      args?: string[];
      stdout?: string;
      stderr?: string;
      truncated?: boolean;
      reason?: string;
      message?: string;
    }
  | {
      kind: 'explore_agent';
      ok: boolean;
      partial?: boolean;
      terminalStatus?: 'completed' | 'completed_empty' | 'failed' | 'canceled' | 'canceled_partial';
      mode: 'read_only';
      objective: string;
      roots: string[];
      queries: string[];
      ignoredPaths?: string[];
      stoppingCondition?: string;
      limitReasons?: ReadonlyArray<'candidate_budget' | 'file_budget' | 'match_budget' | 'byte_budget'>;
      filesDiscovered?: number;
      filesInspected: number;
      filesSkipped: number;
      sensitiveFilesSkipped?: number;
      bytesRead: number;
      startedAt?: number;
      completedAt?: number;
      durationMs?: number;
      progress: string[];
      recentEvents?: ReadonlyArray<{ type: string; at: number; message: string }>;
      evidence?: ReadonlyArray<{
        type: 'match' | 'candidate';
        path: string;
        line?: number;
        label: string;
        score?: number;
      }>;
      summary?: string;
      report?: string;
      candidateFiles: ReadonlyArray<{ path: string; score: number; reasons: string[] }>;
      matches: ReadonlyArray<{ path: string; line: number; query: string; snippet: string }>;
      notes: string[];
      reason?: 'invalid_objective' | 'invalid_root' | 'no_readable_roots' | 'aborted';
      message?: string;
    }
  | {
      kind: 'subagent';
      agentId?: string;
      agentName: string;
      turnId: string;
      runId?: string;
      status: 'completed' | 'failed' | 'cancelled' | 'running' | 'waiting_permission';
      permissionMode: PermissionMode;
      summary: string;
      artifactIds: readonly string[];
      startedAt?: number;
      completedAt?: number;
      durationMs?: number;
      eventCount?: number;
      failureClass?: string;
    }
  | {
      kind: 'rive_workflow';
      ok: boolean;
      action: string;
      command: string[];
      state?: string;
      ids: {
        workflowRunId?: string;
        schedulerRunId?: string;
        rootWorkNodeId?: string;
      };
      summary: string;
      projection?: {
        templateId?: string;
        version?: number;
        templateHash?: string;
        idempotencyStatus?: string;
        workflowRunId?: string;
        schedulerRunId?: string;
        rootWorkNodeId?: string;
        state?: string;
        schedulerState?: string;
        rootState?: string;
      };
      nodes?: ReadonlyArray<{
        id?: string;
        templateId?: string;
        title?: string;
        state?: string;
        runner?: string;
        worker?: string;
      }>;
      stdoutTail?: string;
      stderrTail?: string;
      error?: {
        reason: string;
        message: string;
        code?: string;
        suggestedAction?: string;
      };
    };

export interface PermissionRequestEvent extends BaseEvent {
  type: 'permission_request';
  requestId: string;
  toolUseId: string;
  toolName: string;
  category: ToolCategory;
  reason:
    | 'shell_dangerous'
    | 'file_write'
    | 'fs_destructive'
    | 'network'
    | 'git_destructive'
    | 'privileged'
    | 'browser'
    | 'custom';
  args: unknown;
  hint?: string;
}

/**
 * Echo of the user's permission decision back through the event stream so
 * all UI observers (and JSONL audit) see the same outcome. Mirrors the
 * PermissionDecisionMessage that storage appends.
 */
export interface PermissionDecisionAckEvent extends BaseEvent {
  type: 'permission_decision_ack';
  requestId: string;
  toolUseId: string;
  decision: 'allow' | 'deny';
  rememberForTurn?: boolean;
}

export interface PlanSubmittedEvent extends BaseEvent {
  type: 'plan_submitted';
  planId: string;
  title: string;
  markdownPath: string;
  steps?: PlanStep[];
}

export interface PlanStep {
  id: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'skipped';
  files?: string[];
  complexity?: 'low' | 'medium' | 'high';
}

export interface TokenUsageEvent extends BaseEvent {
  type: 'token_usage';
  input: number;
  output: number;
  cacheHitInput?: number;
  cacheMissInput?: number;
  cacheWriteInput?: number;
  cacheMissInputSource?: CacheMissInputSource;
  reasoning?: number;
  total?: number;
  rawFinishReason?: string;
  /** Number of provider runtime/tool-loop steps represented by this usage. */
  runtimeSteps?: number;
  /** Backward-compatible alias for cacheHitInput. */
  cacheRead?: number;
  /** Backward-compatible alias for cacheWriteInput. */
  cacheCreation?: number;
  costUsd?: number;
  systemPromptHash?: string;
  contextRemaining?: number;
  prefixHash?: string;
  prefixChangeReason?: PrefixChangeReason;
  requestShapeHash?: string;
  requestShapeChangeReason?: PrefixChangeReason;
  promptSegments?: PromptSegmentEstimate[];
  contextBudget?: ContextBudgetDiagnostic;
}

export interface ErrorEvent extends BaseEvent {
  type: 'error';
  recoverable: boolean;
  code?: string;
  /** Stable machine-readable reason for UI / telemetry routing. */
  reason?: string;
  message: string;
  /** Adapter MUST scrub secrets before populating this field. */
  details?: string[] | Record<string, unknown>;
}

export interface CompleteEvent extends BaseEvent {
  type: 'complete';
  stopReason:
    | 'end_turn'
    | 'user_stop'
    | 'error'
    | 'plan_handoff'
    | 'permission_handoff'
    | 'max_tokens';
}

export interface AbortEvent extends BaseEvent {
  type: 'abort';
  reason: 'user_stop' | 'redirect' | 'timeout' | 'crash';
}

// ============================================================================
// UI → Backend commands
// ============================================================================

/**
 * SessionCommand: commands that target a specific session.
 *
 * Connection-management commands live in ConnectionCommand (./connections.ts).
 *
 * `permission_response` composes PermissionResponse rather than flattening
 * its fields, so there is exactly ONE shape for a permission decision in
 * the codebase.
 */
export type AttachmentIngestItem =
  | { approvalId: string; name: string; mimeType?: string }
  | { name: string; mimeType?: string; base64: string };

export type SessionCommand =
  | {
      type: 'send';
      turnId: string;
      text: string;
      attachmentItems?: AttachmentIngestItem[];
    }
  | { type: 'stop' }
  | { type: 'permission_response'; response: PermissionResponse }
  | {
      type: 'plan_response';
      planId: string;
      action: 'approve' | 'refine';
      feedback?: string;
    };
