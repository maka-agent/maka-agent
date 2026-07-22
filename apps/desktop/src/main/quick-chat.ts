/**
 * Quick Chat handler (PR110b).
 *
 * Extracted from `main.ts` so the discriminated-union behavior can be
 * unit-tested without spinning up an Electron app. Deps are injected;
 * the live wiring in main.ts binds them to the real runtime + stores.
 *
 * Contract (locked by @kenji + @xuan PR110b review):
 *   - Input shape is `{ prompt?: string }`. Anything else is ignored;
 *     no `connectionSlug` / `model` override (PR110c will revisit).
 *   - Result is a discriminated union; the raw
 *     `ChatConfigurationReason` enum never reaches the renderer.
 *   - Empty / whitespace-only prompt creates the session but does NOT
 *     call send and does NOT write an empty user message.
 *   - Non-empty prompt walks the existing send path so message
 *     validation / status transitions reuse the canonical helper.
 */

import type { OnboardingState, QuickChatMode, SessionSummary } from '@maka/core';
import { generalizedErrorMessageChinese, normalizeQuickChatMode } from '@maka/core';
import type { PreparedSkillInvocationMessage, SkillInvocationResult } from '@maka/runtime';
import { normalizeSessionSkillIds } from './permission-response-guard.js';
import { isSessionWorkspaceUnavailableError } from './project-context-root.js';

/**
 * PR110b: Quick Chat IPC result. The renderer pattern-matches on
 * `ok` + `reason` to route to the right surface.
 *
 * @xuan PR110b review: the success branch carries ONLY `sessionId`.
 * Earlier drafts included `firstMessageId` but the value was actually
 * a `turnId` produced by the handler (the real user message id is
 * created inside `SessionManager.sendMessage()` and is not visible
 * here). PR110c can add a properly-named `firstTurnId` if the UI
 * needs a scroll anchor — not before.
 */
export type QuickChatResult =
  | { ok: true; sessionId: string; skillInvocation?: SkillInvocationResult }
  | { ok: false; reason: 'setup_required'; state: OnboardingState }
  | { ok: false; reason: 'workspace_unavailable' }
  | { ok: false; reason: 'skill_invocation_failed'; skillInvocation: SkillInvocationResult }
  | { ok: false; reason: 'send_failed'; message: string };

export interface QuickChatDeps {
  /**
   * Fresh derived state. The handler always re-reads this so a stale
   * snapshot from the renderer cannot bypass the readiness gate.
   */
  getOnboardingState(): Promise<OnboardingState>;
  /**
   * Create a new session bound to the derived ready default. The
   * caller's `createSession` should re-run `requireReadyConnection`
   * internally to close the race window between snapshot read and
   * session create.
   */
  createSession(input: {
    defaultConnectionSlug: string;
    defaultModel: string;
    mode: QuickChatMode;
  }): Promise<SessionSummary>;
  /**
   * Emit a session-created event on the global bus (the renderer
   * subscribes to this to refresh the sidebar).
   */
  emitCreated(sessionId: string): void;
  /**
   * Pre-flight gate identical to the existing `sessions:send` path.
   */
  ensureCanSend(sessionId: string): Promise<void>;
  /** Resolve structured ids and direct `/skill:<id>` tokens for this session. */
  prepareSkillInvocation(
    sessionId: string,
    text: string,
    skillIds: readonly string[],
  ): Promise<PreparedSkillInvocationMessage>;
  /** Remove a brand-new session when invocation fails before any turn starts. */
  removeSession(sessionId: string): Promise<void>;
  /**
   * Send the first user message via the existing send path. The
   * implementation is expected to fire-and-stream — the handler does
   * not need any return value from this call. Returning `void` makes
   * it obvious that PR110b does not own a turn/message anchor.
   */
  sendFirstMessage(sessionId: string, text: string, displayText?: string): Promise<void>;
}

export async function handleQuickChatStart(
  rawInput: unknown,
  deps: QuickChatDeps,
): Promise<QuickChatResult> {
  // Keep the Quick Chat IPC boundary as strict as sessions:send for the
  // structured Skill ids, while ignoring unrelated legacy fields.
  const promptRaw =
    rawInput && typeof rawInput === 'object' && 'prompt' in rawInput
      ? (rawInput as { prompt?: unknown }).prompt
      : undefined;
  const prompt = typeof promptRaw === 'string' ? promptRaw : '';
  const trimmed = prompt.trim();
  const skillIds = normalizeSessionSkillIds(
    rawInput && typeof rawInput === 'object' && 'skillIds' in rawInput
      ? (rawInput as { skillIds?: unknown }).skillIds
      : undefined,
  );
  const mode = normalizeQuickChatMode(
    rawInput && typeof rawInput === 'object' && 'mode' in rawInput
      ? (rawInput as { mode?: unknown }).mode
      : undefined,
  );

  // Fresh state to defeat any stale snapshot the renderer might hold.
  const state = await deps.getOnboardingState();
  if (state.kind !== 'ready_empty' && state.kind !== 'ready_with_history') {
    return { ok: false, reason: 'setup_required', state };
  }

  let session: SessionSummary;
  try {
    session = await deps.createSession({
      defaultConnectionSlug: state.defaultConnectionSlug,
      defaultModel: state.defaultModel,
      mode,
    });
  } catch (error) {
    if (isSessionWorkspaceUnavailableError(error)) {
      return { ok: false, reason: 'workspace_unavailable' };
    }
    return {
      ok: false,
      reason: 'send_failed',
      message: generalizedErrorMessageChinese(error, '无法创建会话，请稍后再试。'),
    };
  }

  // Empty / whitespace prompt with no explicit Skill: only open the session;
  // do not call send and do not write an empty user message.
  if (!trimmed && skillIds.length === 0) {
    deps.emitCreated(session.id);
    return { ok: true, sessionId: session.id };
  }

  let sessionEmitted = false;
  let cleanupAttempted = false;
  try {
    const preparation = await deps.prepareSkillInvocation(session.id, trimmed, skillIds);
    if (preparation.disposition === 'blocked') {
      cleanupAttempted = true;
      await deps.removeSession(session.id);
      return {
        ok: false,
        reason: 'skill_invocation_failed',
        skillInvocation: preparation.skillInvocation,
      };
    }
    deps.emitCreated(session.id);
    sessionEmitted = true;
    await deps.ensureCanSend(session.id);
    const displayText =
      trimmed.length > 0
        ? trimmed
        : preparation.skillInvocation.loaded.map((skill) => `/skill:${skill.id}`).join(' ');
    await deps.sendFirstMessage(
      session.id,
      preparation.sendText,
      preparation.disposition === 'ready' ? displayText : undefined,
    );
    return {
      ok: true,
      sessionId: session.id,
      ...(preparation.disposition === 'ready'
        ? { skillInvocation: preparation.skillInvocation }
        : {}),
    };
  } catch (error) {
    if (!sessionEmitted && !cleanupAttempted) {
      // Preparation happens after the temporary session is created but before
      // it is announced. Do not leave an invisible empty session behind when
      // discovery or project-context resolution fails unexpectedly.
      try {
        await deps.removeSession(session.id);
      } catch {
        // Preserve the original failure; the renderer refresh below will make
        // any session that could not be removed visible and recoverable.
      }
    }
    if (isSessionWorkspaceUnavailableError(error)) {
      return { ok: false, reason: 'workspace_unavailable' };
    }
    return {
      ok: false,
      reason: 'send_failed',
      message: generalizedErrorMessageChinese(error, '会话已创建但发送失败，请重试。'),
    };
  }
}
