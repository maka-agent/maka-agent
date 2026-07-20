import type { SessionSummary, StoredMessage, UiLocale } from '@maka/core';
import { userFacingText } from '@maka/core';
import type { ComposerHandle } from '@maka/ui';
import { getDesktopConversationCopy } from './locales/conversation-copy.js';
import { localizedShellErrorMessage } from './locales/shell-copy.js';
import {
  isSessionWorkspaceUnavailableError,
  showSessionWorkspaceUnavailableToast,
} from './session-workspace-errors.js';

type RefBox<T> = { current: T };
type MessageListUpdater = (next: StoredMessage[] | ((current: StoredMessage[]) => StoredMessage[])) => void;

type ToastApi = {
  info(title: string, description?: string): void;
  success(title: string, description?: string): void;
  error(title: string, description?: string): void;
};

/** Active edit-and-resend draft owned by the desktop shell. */
export type TurnRevisionDraft = {
  /** Session the user clicked edit on (may differ from the new branch after commit prep). */
  sourceSessionId: string;
  sourceTurnId: string;
  /** Session currently holding the pre-turn context (branch child after prepare). */
  draftSessionId: string;
  originalText: string;
};

export interface AppShellRevisionActions {
  beginEditUserMessage(turnId: string): Promise<void>;
  /** Refill only after React has committed the child session's composer key. */
  refillRevisionComposer(): void;
  cancelRevisionDraft(): void;
  /** Clear draft when the user leaves the draft session without sending. */
  clearRevisionIfSessionLeft(nextSessionId: string | undefined): void;
}

/**
 * Edit-and-resend = CLI rewind productized for Desktop:
 *   1. Capture the user-facing prompt from the source turn.
 *   2. branchBeforeTurn (non-destructive; original session kept).
 *   3. Switch onto the child and refill the composer for edit + send.
 *
 * Sending itself reuses the normal send path once the active session is the
 * branch child. Cancel only drops the local draft marker — the empty branch
 * remains as a normal session the user can still use or archive.
 */
export function createAppShellRevisionActions(deps: {
  uiLocale: UiLocale;
  activeIdRef: RefBox<string | undefined>;
  composerRef: RefBox<ComposerHandle | null>;
  messages: readonly StoredMessage[];
  addPendingTurnAction: (key: string) => boolean;
  clearPendingTurnAction: (key: string) => void;
  openSessionInChat: (sessionId: string, turnId?: string) => void;
  pendingKeyOf: (sessionId: string, turnId: string, actionId: string) => string;
  refreshMessages: (sessionId: string) => Promise<boolean>;
  refreshSessions: () => Promise<SessionSummary[]>;
  setMessages: MessageListUpdater;
  commitRevisionDraft: (draft: TurnRevisionDraft | null) => void;
  revisionDraftRef: RefBox<TurnRevisionDraft | null>;
  toastApi: ToastApi;
  upsertSessionSummary: (session: SessionSummary) => void;
}): AppShellRevisionActions {
  const {
    uiLocale,
    activeIdRef,
    composerRef,
    messages,
    addPendingTurnAction,
    clearPendingTurnAction,
    openSessionInChat,
    pendingKeyOf,
    refreshMessages,
    refreshSessions,
    setMessages,
    commitRevisionDraft,
    revisionDraftRef,
    toastApi,
    upsertSessionSummary,
  } = deps;
  const copy = getDesktopConversationCopy(uiLocale).actions;

  async function beginEditUserMessage(turnId: string): Promise<void> {
    const sessionId = activeIdRef.current;
    if (!sessionId) return;
    const key = pendingKeyOf(sessionId, turnId, 'edit');
    if (!addPendingTurnAction(key)) return;
    try {
      const userMessage = messages.find(
        (message): message is Extract<StoredMessage, { type: 'user' }> =>
          message.type === 'user' && message.turnId === turnId,
      );
      if (!userMessage) {
        toastApi.error(copy.operationFailedTitle, copy.operationFailedFallback);
        return;
      }
      if (userMessage.attachments && userMessage.attachments.length > 0) {
        toastApi.info(copy.revisionUnavailableTitle, copy.revisionAttachmentsUnsupported);
        return;
      }
      if (userMessage.displayText !== undefined && userMessage.displayText !== userMessage.text) {
        toastApi.info(copy.revisionUnavailableTitle, copy.revisionTransformedTextUnsupported);
        return;
      }
      // Prefer human-facing text so skill envelopes never leak into the editor.
      const prompt = userFacingText(userMessage);

      const newSession = await window.maka.sessions.branchBeforeTurn(sessionId, {
        sourceTurnId: turnId,
      });
      upsertSessionSummary(newSession);
      if (activeIdRef.current !== sessionId) {
        // User left the source session mid-branch; keep the branch in the list
        // but do not steal focus or refill a foreign composer.
        await refreshSessions();
        return;
      }

      const draft: TurnRevisionDraft = {
        sourceSessionId: sessionId,
        sourceTurnId: turnId,
        draftSessionId: newSession.id,
        originalText: prompt,
      };
      // Commit ref + state together so the activeId effect observes the draft
      // even before React renders the child session.
      commitRevisionDraft(draft);
      openSessionInChat(newSession.id);
      setMessages([]);
      await refreshMessages(newSession.id);
      // Refresh can outlive a cancel or navigation. Do not announce a stale
      // revision after the user has already left or dismissed it.
      if (activeIdRef.current === newSession.id && revisionDraftRef.current === draft) {
        toastApi.info(copy.revisionReadyTitle, copy.revisionReadyDescription);
      }
      await refreshSessions();
    } catch (error) {
      if (activeIdRef.current !== sessionId) return;
      if (isSessionWorkspaceUnavailableError(error)) {
        showSessionWorkspaceUnavailableToast(toastApi, uiLocale);
      } else {
        toastApi.error(
          copy.operationFailedTitle,
          localizedShellErrorMessage(error, copy.operationFailedFallback, uiLocale),
        );
      }
    } finally {
      clearPendingTurnAction(key);
    }
  }

  function refillRevisionComposer(): void {
    const draft = revisionDraftRef.current;
    if (!draft || activeIdRef.current !== draft.draftSessionId) return;
    composerRef.current?.setText(draft.originalText);
    composerRef.current?.focus();
  }

  function cancelRevisionDraft(): void {
    const draft = revisionDraftRef.current;
    if (!draft) return;
    commitRevisionDraft(null);
    // Clear only when the user is still on the draft session; otherwise leave
    // whatever draft they are composing in the destination session alone.
    if (activeIdRef.current === draft.draftSessionId) {
      composerRef.current?.setText('');
    }
  }

  function clearRevisionIfSessionLeft(nextSessionId: string | undefined): void {
    const draft = revisionDraftRef.current;
    if (!draft) return;
    if (nextSessionId !== draft.draftSessionId) {
      commitRevisionDraft(null);
    }
  }

  return {
    beginEditUserMessage,
    refillRevisionComposer,
    cancelRevisionDraft,
    clearRevisionIfSessionLeft,
  };
}
