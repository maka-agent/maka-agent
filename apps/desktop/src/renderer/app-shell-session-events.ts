import type { SessionEvent } from '@maka/core';
import {
  applyAssistantComplete,
  applyAssistantDelta,
  applyThinkingComplete,
  applyThinkingDelta,
  applyToolOutputChunk,
  clearPermissions,
  clearSettledAssistantStreamSlot,
  dequeuePermission,
  dequeuePermissionByToolUseId,
  drainAssistantStreamSlot,
  enqueuePermission,
  markAssistantStreamSlotDraining,
  type AssistantStreamSlot,
  type PermissionQueues,
  type ToolActivityItem,
  type ToolOutputChunk,
} from '@maka/ui';
import {
  isNoRealConnectionEvent,
  noRealConnectionReasonFromEvent,
  noRealConnectionSetupDescription,
  sessionEventErrorMessage,
} from './model-connection-errors.js';
import type { RefreshMessagesOptions } from './app-shell-chat-actions.js';

type RefBox<T> = { current: T };
type StateUpdater<T> = (updater: (current: T) => T) => void;

type ToastApi = {
  error(title: string, description?: string): void;
};

export interface AppShellSessionEventHandlers {
  handleEvent(sessionId: string, event: SessionEvent): void;
  settleAssistantStreaming(sessionId: string, messageId?: string): Promise<void>;
}

export function createAppShellSessionEventHandlers(options: {
  activeIdRef: RefBox<string | undefined>;
  refreshMessages: (sessionId: string, options?: RefreshMessagesOptions) => Promise<boolean>;
  refreshSessions: () => Promise<unknown>;
  setLiveToolsBySession: StateUpdater<Record<string, ToolActivityItem[]>>;
  setPermissionBySession: StateUpdater<PermissionQueues>;
  setStreamingBySession: StateUpdater<Record<string, AssistantStreamSlot>>;
  setThinkingBySession: StateUpdater<Record<string, string>>;
  setThinkingTruncatedBySession: StateUpdater<Record<string, boolean>>;
  showModelSetupToast: (description: string, reason?: string) => void;
  streamingBySessionRef: RefBox<Record<string, AssistantStreamSlot>>;
  toastApi: ToastApi;
  /** Report a terminal turn to the main process, which decides whether
   * to raise an OS notification (gated on a product toggle + window
   * focus). `body` is the start of the reply (completed) or the error
   * message (errored); the session name is resolved by the caller from
   * `sessionId`. Optional so headless/test callers can omit it. */
  notifyRunEnded?: (payload: { kind: 'completed' | 'errored'; sessionId: string; body?: string }) => void;
}): AppShellSessionEventHandlers {
  const {
    activeIdRef,
    refreshMessages,
    refreshSessions,
    setLiveToolsBySession,
    setPermissionBySession,
    setStreamingBySession,
    setThinkingBySession,
    setThinkingTruncatedBySession,
    showModelSetupToast,
    streamingBySessionRef,
    toastApi,
    notifyRunEnded,
  } = options;

  function clearThinking(sessionId: string) {
    // PR-UI-LAYOUT-42: thinking is part of the same streaming turn —
    // any clearStreaming caller (abort / error / complete) means the
    // turn is done, so the Reasoning panel should also collapse.
    setThinkingBySession((current) => ({ ...current, [sessionId]: '' }));
    // PR-UI-C0 review fixup: also clear the truncated flag so the
    // "已截断" pill doesn't stick around after the panel collapses.
    // Next turn's thinking starts with a fresh `false` flag and the
    // helper will re-set it if caps fire again.
    setThinkingTruncatedBySession((current) => {
      if (!current[sessionId]) return current;
      const next = { ...current };
      delete next[sessionId];
      return next;
    });
  }

  function clearStreaming(sessionId: string) {
    // PR-UI-Cx fixup v2 (@kenji msg 3c01e901 Blocker 2): the
    // combined-state shape means clearing the streaming buffer +
    // truncated flag is ONE functional update on `streamingBySession`,
    // not two separate setStates that could observably race.
    setStreamingBySession((current) => {
      const prev = current[sessionId];
      if (!prev || (prev.text === '' && prev.truncated === false)) return current;
      return { ...current, [sessionId]: { text: '', truncated: false, phase: 'streaming' } };
    });
    clearThinking(sessionId);
  }

  function drainAssistantStreaming(sessionId: string, text: string, messageId?: string) {
    const applied = applyAssistantComplete(text);
    if (!applied.text) {
      clearStreaming(sessionId);
      void refreshMessages(sessionId);
      return;
    }
    setStreamingBySession((current) => drainAssistantStreamSlot(current, sessionId, applied, messageId));
    clearThinking(sessionId);
  }

  async function settleAssistantStreaming(sessionId: string, messageId?: string) {
    const settledSlot = streamingBySessionRef.current[sessionId];
    if (!settledSlot || settledSlot.phase !== 'draining') return;
    if (messageId && settledSlot.messageId && settledSlot.messageId !== messageId) return;
    const requiredMessageId = messageId ?? settledSlot.messageId;
    const refreshed = await refreshMessages(
      sessionId,
      requiredMessageId ? { requiredAssistantMessageId: requiredMessageId } : undefined,
    ).catch(() => false);
    if (requiredMessageId && !refreshed) return;
    setStreamingBySession((current) => clearSettledAssistantStreamSlot(current, sessionId, settledSlot, messageId));
  }

  function upsertTool(sessionId: string, toolUseId: string, patch: Partial<ToolActivityItem> & { toolUseId: string }) {
    setLiveToolsBySession((current) => {
      const list = current[sessionId] ?? [];
      const index = list.findIndex((item) => item.toolUseId === toolUseId);
      const base: ToolActivityItem =
        index >= 0
          ? list[index]!
          : {
              toolUseId,
              toolName: patch.toolName ?? 'Tool',
              status: 'pending',
              args: patch.args,
            };
      // PR-UI-12 fixup (@xuan review): never let `tool_start` arriving
      // AFTER an in-flight `tool_output_delta` regress a `running` item
      // back to `pending`. The delta itself already proved the tool is
      // live; the status dot must not lie. Keep `base.status` whenever
      // the incoming patch wants `pending` but we have output or are
      // already in a later state.
      const wantsPending = patch.status === 'pending';
      const hasOutput = (base.outputChunks?.length ?? 0) > 0;
      const isLaterStatus =
        base.status === 'running'
        || base.status === 'waiting_permission'
        || base.status === 'completed'
        || base.status === 'errored'
        || base.status === 'interrupted';
      const nextStatus = wantsPending && (hasOutput || isLaterStatus)
        ? base.status
        : patch.status ?? base.status;
      const nextItem: ToolActivityItem = { ...base, ...patch, status: nextStatus };
      const nextList = index >= 0 ? list.map((item, itemIndex) => (itemIndex === index ? nextItem : item)) : [...list, nextItem];
      return { ...current, [sessionId]: nextList };
    });
  }

  /**
   * PR-UI-12 fixup (@xuan post-signoff cleanup): shared helper for the
   * abort + error event paths. A turn-ending event leaves any tool
   * that was `pending` / `running` / `waiting_permission` orphaned
   * because the runtime won't emit a per-tool terminal `tool_result`
   * for it. Flip those tools to `interrupted` so the `ToolOutputStream`
   * header reads "已中断 · 已收到的输出", the live pulse stops, and
   * the `materializeTurns` merge `{...persisted, ...live}` doesn't
   * mask the persisted `interrupted` status with stale live state.
   *
   * Tools that already reached terminal (`completed` / `errored` /
   * `interrupted`) are left alone. Tools without buffer are still
   * flipped — the user shouldn't see a forever-spinning status dot
   * just because the tool happened to produce no streamed output.
   */
  function markInFlightToolsInterrupted(sessionId: string) {
    setLiveToolsBySession((current) => {
      const list = current[sessionId];
      if (!list || list.length === 0) return current;
      let changed = false;
      const nextList = list.map((tool) => {
        const isInFlight =
          tool.status === 'pending'
          || tool.status === 'running'
          || tool.status === 'waiting_permission';
        if (!isInFlight) return tool;
        changed = true;
        return { ...tool, status: 'interrupted' as const };
      });
      return changed ? { ...current, [sessionId]: nextList } : current;
    });
  }

  /**
   * PR-UI-12 — append a streamed chunk to a tool's output buffer.
   *
   * Invariants enforced here, not relied on from the event source:
   *  - Dedup by `seq` (per-toolCallId monotonic from runtime). If a
   *    seq already exists, we drop the incoming chunk — important on
   *    sessionEvents replays or main-process reconnects.
   *  - Sorted insert by `seq`. The runtime emits in-order, but
   *    `tool_result` racing against the last delta could land here
   *    after a flush, and renderer reconnect could deliver fragments
   *    out of order. Always keep the array sorted so React renders
   *    stable visual order.
   *  - **Secondary redaction** (PR-UI-12 fixup #2, @kenji A3 msg
   *    365ff8b9): chunk text runs through `redactSecrets` BEFORE
   *    landing in React state. The renderer does not trust upstream
   *    redaction alone — raw secrets must not reach state /
   *    DevTools / clipboard / future serialization paths.
   *  - **Per-chunk + per-tool caps** (same fixup): single oversize
   *    chunk is tail-truncated; per-tool count + total-char caps
   *    drop oldest chunks. Defense in depth against a runaway tool
   *    flooding the renderer.
   *  - If the tool doesn't exist yet in `liveToolsBySession`, we
   *    create a minimal `pending` entry. This covers the rare race
   *    where `tool_output_delta` arrives before `tool_start` is
   *    flushed to the renderer; we'd rather show output than drop it.
   *
   * All of the above lives in the pure helper `applyToolOutputChunk`
   * (`@maka/ui/tool-output-stream`) so the redaction + cap logic is
   * unit-tested without a renderer. This function is just the React
   * state plumbing around it.
   */
  function appendToolOutputChunk(sessionId: string, toolUseId: string, chunk: ToolOutputChunk) {
    setLiveToolsBySession((current) => {
      const list = current[sessionId] ?? [];
      const index = list.findIndex((item) => item.toolUseId === toolUseId);
      const base: ToolActivityItem =
        index >= 0
          ? list[index]!
          : { toolUseId, toolName: 'Tool', status: 'running', args: undefined };
      // PR-UI-12 review fixup #2 (@kenji A3 msg 365ff8b9):
      // `applyToolOutputChunk` is the single chokepoint for
      // - dedupe-by-seq
      // - sorted insertion
      // - SECONDARY REDACTION via `redactSecrets` (never trust the
      //   upstream redactor alone; raw text must not enter React state)
      // - per-chunk size cap (tail-keep + truncation marker)
      // - per-tool count + total-char caps (drop oldest)
      // The pure helper lives in `@maka/ui/tool-output-stream` so the
      // logic is testable without a renderer.
      const applied = applyToolOutputChunk(base.outputChunks, chunk);
      // Dedupe short-circuit: helper returned the same `chunks` array
      // reference, meaning the seq was already present. Skip the
      // re-render entirely if the tool item already exists; the only
      // observable change would be re-asserting `outputTruncated`,
      // which is monotonic so no-op.
      if (index >= 0 && applied.chunks === (base.outputChunks ?? [])) {
        return current;
      }
      const nextItem: ToolActivityItem = {
        ...base,
        outputChunks: applied.chunks,
        // Once `truncated` flips true we stick — a later non-truncated
        // chunk shouldn't make the UI claim the stream is now complete.
        outputTruncated: base.outputTruncated || applied.truncated,
        // Promote `pending` → `running` once we see live output, so the
        // status dot doesn't lie about activity.
        status: base.status === 'pending' ? 'running' : base.status,
      };
      const nextList =
        index >= 0
          ? list.map((item, itemIndex) => (itemIndex === index ? nextItem : item))
          : [...list, nextItem];
      return { ...current, [sessionId]: nextList };
    });
  }

  function handleEvent(sessionId: string, event: SessionEvent) {
    switch (event.type) {
      case 'text_delta': {
        // PR-UI-Cx (@kenji msg 94b0063d / cd09bcac / fixup v2 3c01e901):
        // assistant `text_delta` chokepoint. The pure
        // `applyAssistantDelta` helper from `@maka/ui/assistant-stream`
        // is the single trust-boundary point for:
        //   1. per-delta `redactSecrets` BEFORE state,
        //   2. per-delta cap (tail-keep single misbehaving multi-MB
        //      delta with a marker),
        //   3. CROSS-DELTA `redactSecrets` on the freshly-appended
        //      candidate — catches secrets that span delta seams
        //      (e.g. `"Authorization: Bearer sk-"` + `"abcdef..."`).
        //   4. per-session total cap (head-keep + trailing marker —
        //      assistant text is read top-down).
        //
        // raw `event.text` only flows through the helper input; it
        // never enters state un-redacted or un-capped.
        //
        // Combined state shape: one functional updater owns visible
        // text, truncation, phase, and message identity, so the final
        // `text_complete` handoff can drain the same bubble instead of
        // racing a committed-message refresh.
        setStreamingBySession((current) => {
          const prevSlot = current[sessionId];
          // Per-step guard: each model step streams under its own messageId. When
          // the id changes (a new step began, or a prior step's slot is still
          // draining), start this step's bubble fresh instead of appending onto
          // the previous step's text — otherwise the next step's answer would
          // flicker duplicated onto the last one.
          const sameMessage =
            prevSlot === undefined
            || prevSlot.messageId === undefined
            || prevSlot.messageId === event.messageId;
          const prevText = sameMessage ? (prevSlot?.text ?? '') : '';
          const applied = applyAssistantDelta(prevText, event.text);
          const nextTruncated = (sameMessage ? (prevSlot?.truncated ?? false) : false) || applied.truncated;
          // Avoid a re-render when nothing materially changed (e.g.
          // a non-string `event.text` defensively dropped by the
          // helper, no truncated change).
          if (
            prevSlot !== undefined &&
            prevSlot.text === applied.text &&
            prevSlot.truncated === nextTruncated
          ) {
            return current;
          }
          return {
            ...current,
            [sessionId]: {
              text: applied.text,
              truncated: nextTruncated,
              phase: 'streaming',
              messageId: event.messageId,
            },
          };
        });
        break;
      }
      case 'text_complete':
        drainAssistantStreaming(sessionId, event.text, event.messageId);
        break;
      case 'thinking_delta':
        // PR-UI-LAYOUT-42 / C0 review fixup (@kenji msg 7885a347):
        // Anthropic extended-thinking stream. The pure
        // `applyThinkingDelta` helper from `@maka/ui/thinking-stream`
        // is the single chokepoint for:
        //   1. secondary `redactSecrets` BEFORE state (thinking can
        //      echo prompts / env / tool stderr / pasted credentials;
        //      raw text must not enter React state),
        //   2. per-delta cap (tail-keep a single misbehaving multi-MB
        //      delta with a truncation marker),
        //   3. per-session total cap (tail-keep most recent reasoning
        //      so the user sees the current chain of thought, not the
        //      start of an old run).
        // The renderer also tracks a per-session monotonic
        // `outputTruncated`-style flag so the `ReasoningPanel` header
        // can show a "已截断" pill.
        setThinkingBySession((current) => {
          const prev = current[sessionId] ?? '';
          const applied = applyThinkingDelta(prev, event.text);
          if (applied.truncated) {
            setThinkingTruncatedBySession((flags) =>
              flags[sessionId] ? flags : { ...flags, [sessionId]: true },
            );
          }
          return { ...current, [sessionId]: applied.text };
        });
        break;
      case 'thinking_complete':
        // PR-UI-LAYOUT-42 / C0 review fixup: final thinking block —
        // ProviderEvent's `text` is the FULL final reasoning string,
        // so we replace rather than append (still through the
        // redaction + cap chokepoint via `applyThinkingComplete`).
        // Keep visible until `text_complete` collapses the panel; this
        // avoids the flicker between "thinking done" and "answer streaming".
        setThinkingBySession((current) => {
          const applied = applyThinkingComplete(event.text);
          // PR-UI-C0 review nit #1 (@kenji msg 68ca6bc7): `complete`
          // is the replace path — the final payload is the source of
          // truth. If earlier deltas triggered the cap but the final
          // complete fits clean, the `已截断` pill should reset to
          // match reality, not remain monotonically true. Overwrite
          // the per-session truncated flag with `applied.truncated`.
          setThinkingTruncatedBySession((flags) => {
            if ((flags[sessionId] === true) === applied.truncated) return flags;
            if (applied.truncated) {
              return { ...flags, [sessionId]: true };
            }
            const next = { ...flags };
            delete next[sessionId];
            return next;
          });
          return { ...current, [sessionId]: applied.text };
        });
        break;
      case 'tool_start':
        upsertTool(sessionId, event.toolUseId, {
          toolUseId: event.toolUseId,
          toolName: event.toolName,
          displayName: event.displayName,
          intent: event.intent,
          status: 'pending',
          args: event.args,
        });
        break;
      case 'tool_output_delta':
        // PR-UI-12 (@yuejing 2026-05-22): consume PR-REAL-4 typed
        // streaming. We dedupe by `seq` (per-toolCallId monotonic from
        // runtime) and insert in sorted order, so out-of-order delivery
        // or `tool_result`-vs-delta races repair without flicker.
        // Runtime already redacts secrets at chunk granularity; the
        // renderer still runs a secondary redaction/cap pass inside
        // `appendToolOutputChunk` before text reaches React state.
        appendToolOutputChunk(sessionId, event.toolUseId, {
          seq: event.seq,
          stream: event.stream,
          text: event.chunk,
          redacted: event.redacted,
          createdAt: event.createdAt,
        });
        break;
      case 'permission_request':
        setPermissionBySession((current) => enqueuePermission(current, sessionId, event));
        upsertTool(sessionId, event.toolUseId, {
          toolUseId: event.toolUseId,
          toolName: event.toolName,
          status: 'waiting_permission',
          args: event.args,
        });
        break;
      case 'permission_decision_ack':
        setPermissionBySession((current) => dequeuePermission(current, sessionId, event.requestId));
        upsertTool(sessionId, event.toolUseId, {
          toolUseId: event.toolUseId,
          status: event.decision === 'allow' ? 'running' : 'errored',
        });
        break;
      case 'tool_result':
        // A permission that ended without a user decision (runtime timeout /
        // expiry) emits a tool_result, not a permission_decision_ack — drain any
        // stale queue entry for this tool so it can't resurface as an
        // un-answerable overlay. No-op when the ack already dequeued it.
        setPermissionBySession((current) => dequeuePermissionByToolUseId(current, sessionId, event.toolUseId));
        upsertTool(sessionId, event.toolUseId, {
          toolUseId: event.toolUseId,
          status: event.isError ? 'errored' : 'completed',
          result: event.content,
          durationMs: event.durationMs,
        });
        void refreshMessages(sessionId);
        break;
      case 'error':
        clearStreaming(sessionId);
        setPermissionBySession((current) => clearPermissions(current, sessionId));
        if (activeIdRef.current === sessionId) {
          if (isNoRealConnectionEvent(event)) {
            const reason = noRealConnectionReasonFromEvent(event);
            showModelSetupToast(noRealConnectionSetupDescription(reason), reason);
          } else {
            toastApi.error('对话出错', sessionEventErrorMessage(event));
          }
        }
        markInFlightToolsInterrupted(sessionId);
        notifyRunEnded?.({ kind: 'errored', sessionId, body: sessionEventErrorMessage(event) });
        void refreshSessions();
        void refreshMessages(sessionId);
        break;
      case 'abort':
        clearStreaming(sessionId);
        setPermissionBySession((current) => clearPermissions(current, sessionId));
        markInFlightToolsInterrupted(sessionId);
        void refreshSessions();
        void refreshMessages(sessionId);
        break;
      case 'complete':
        let refreshMessagesOptions: RefreshMessagesOptions | undefined;
        if (event.stopReason !== 'permission_handoff') {
          const slot = streamingBySessionRef.current[sessionId];
          if (slot?.text) {
            setStreamingBySession((current) => markAssistantStreamSlotDraining(current, sessionId));
            clearThinking(sessionId);
            if (slot.messageId) {
              refreshMessagesOptions = { requiredAssistantMessageId: slot.messageId };
            }
          } else {
            clearStreaming(sessionId);
          }
          // PR-PERMISSION-UI-CLEANUP-0: parallel the `abort` branch
          // above — drop any stranded permission request for this
          // session when it completes for non-permission-handoff
          // reasons. Without this, a session that finishes while a
          // permission overlay was mounted would leave the overlay
          // stuck on screen until the user manually switches away.
          setPermissionBySession((current) => clearPermissions(current, sessionId));
          // Notify "completed" ONLY for a genuine successful end. Use an
          // allowlist, not `!== permission_handoff`: `error` is emitted as
          // `error` then `complete(stopReason='error')`, so treating any
          // non-handoff complete as success would double-fire a misleading
          // “回答已生成” after the error banner. `user_stop` (user is present)
          // and `plan_handoff` (a pause) are likewise not turn ends.
          // `slot.text` holds the streamed reply, which main trims into the body.
          if (event.stopReason === 'end_turn' || event.stopReason === 'max_tokens') {
            notifyRunEnded?.({ kind: 'completed', sessionId, body: slot?.text });
          }
        }
        void refreshSessions();
        void refreshMessages(sessionId, refreshMessagesOptions);
        break;
      default:
        break;
    }
  }

  return { handleEvent, settleAssistantStreaming };
}
