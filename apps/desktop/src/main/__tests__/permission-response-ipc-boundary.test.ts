import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  normalizeBranchFromTurnInput,
  normalizePermissionResponse,
  normalizeRegenerateTurnInput,
  normalizeRetryTurnInput,
  normalizeSessionSendCommand,
  normalizeStopSessionInput,
} from '../permission-response-guard.js';

describe('permission response IPC boundary', () => {
  it('normalizes valid allow / deny responses into the core shape', () => {
    assert.deepEqual(
      normalizePermissionResponse({
        requestId: 'permission-1',
        decision: 'allow',
        rememberForTurn: true,
        extra: 'ignored',
      }),
      {
        requestId: 'permission-1',
        decision: 'allow',
        rememberForTurn: true,
      },
    );
    assert.deepEqual(
      normalizePermissionResponse({ requestId: 'permission-2', decision: 'deny' }),
      { requestId: 'permission-2', decision: 'deny' },
    );
  });

  it('rejects malformed renderer decisions instead of treating them as allow', () => {
    assert.throws(() => normalizePermissionResponse(null), /Invalid permission response/);
    assert.throws(() => normalizePermissionResponse({ requestId: '', decision: 'allow' }), /requestId/);
    assert.throws(
      () => normalizePermissionResponse({ requestId: 'permission-1', decision: 'approve' }),
      /decision/,
    );
    assert.throws(
      () => normalizePermissionResponse({ requestId: 'permission-1', decision: 'deny', rememberForTurn: 'yes' }),
      /rememberForTurn/,
    );
  });

  it('routes sessions:respondToPermission through the main-process normalizer', async () => {
    const mainPath = fileURLToPath(new URL('../../../src/main/main.ts', import.meta.url));
    const main = await readFile(mainPath, 'utf8');
    const handler = main.match(/ipcMain\.handle\('sessions:respondToPermission'[\s\S]*?\n  \);/)?.[0] ?? '';

    assert.match(handler, /normalizePermissionResponse\(response\)/);
    assert.doesNotMatch(handler, /runtime\.respondToPermission\(sessionId,\s*response\)/);
  });

  it('normalizes turn action inputs before retry / regenerate / branch runtime calls', () => {
    assert.deepEqual(
      normalizeRetryTurnInput({ sourceTurnId: 'turn-1', turnId: 'retry-1', extra: true }),
      { sourceTurnId: 'turn-1', turnId: 'retry-1' },
    );
    assert.deepEqual(
      normalizeRegenerateTurnInput({ sourceTurnId: 'turn-2' }),
      { sourceTurnId: 'turn-2' },
    );
    assert.deepEqual(
      normalizeBranchFromTurnInput({ sourceTurnId: 'turn-3', name: '  Branch name  ', ignored: 1 }),
      { sourceTurnId: 'turn-3', name: 'Branch name' },
    );
  });

  it('rejects malformed turn action inputs at the IPC boundary', () => {
    assert.throws(() => normalizeRetryTurnInput(null), /retry turn input/);
    assert.throws(() => normalizeRetryTurnInput({ sourceTurnId: '' }), /sourceTurnId/);
    assert.throws(() => normalizeRegenerateTurnInput({ sourceTurnId: 'turn-1', turnId: 1 }), /turnId/);
    assert.throws(() => normalizeBranchFromTurnInput({ sourceTurnId: 'turn-1', name: 1 }), /branch name/);
  });

  it('routes turn actions through main-process normalizers', async () => {
    const mainPath = fileURLToPath(new URL('../../../src/main/main.ts', import.meta.url));
    const main = await readFile(mainPath, 'utf8');
    const retryHandler = main.match(/ipcMain\.handle\('sessions:retryTurn'[\s\S]*?\n  \);/)?.[0] ?? '';
    const regenerateHandler = main.match(/ipcMain\.handle\('sessions:regenerateTurn'[\s\S]*?\n  \);/)?.[0] ?? '';
    const branchHandler = main.match(/ipcMain\.handle\('sessions:branchFromTurn'[\s\S]*?\n  \);/)?.[0] ?? '';

    assert.match(retryHandler, /normalizeRetryTurnInput\(input\)/);
    assert.doesNotMatch(retryHandler, /runtime\.retryTurn\(sessionId,\s*\{\s*\.\.\.input/);
    assert.match(regenerateHandler, /normalizeRegenerateTurnInput\(input\)/);
    assert.doesNotMatch(regenerateHandler, /runtime\.regenerateTurn\(sessionId,\s*\{\s*\.\.\.input/);
    assert.match(branchHandler, /normalizeBranchFromTurnInput\(input\)/);
    assert.doesNotMatch(branchHandler, /runtime\.branchFromTurn\(sessionId,\s*input\)/);
  });

  it('normalizes session send commands and rejects malformed send payloads', () => {
    assert.deepEqual(
      normalizeSessionSendCommand({
        type: 'send',
        turnId: 'turn-1',
        text: 'hello',
        attachments: [{ kind: 'image' }],
        extra: true,
      }),
      {
        type: 'send',
        turnId: 'turn-1',
        text: 'hello',
        attachments: [{ kind: 'image' }],
      },
    );
    assert.deepEqual(
      normalizeSessionSendCommand({ type: 'send', text: 'hello' }),
      { type: 'send', text: 'hello' },
    );
    assert.equal(normalizeSessionSendCommand({ type: 'stop' }), undefined);
    assert.throws(() => normalizeSessionSendCommand(null), /session command/);
    assert.throws(() => normalizeSessionSendCommand({ type: 'send', text: '' }), /send text/);
    assert.throws(() => normalizeSessionSendCommand({ type: 'send', turnId: 1, text: 'hello' }), /send turnId/);
  });

  it('normalizes stop session input and rejects malformed stop sources', () => {
    assert.deepEqual(normalizeStopSessionInput(undefined), {});
    assert.deepEqual(normalizeStopSessionInput({ source: 'stop_button', extra: true }), { source: 'stop_button' });
    assert.throws(() => normalizeStopSessionInput(null), /stop session input/);
    assert.throws(() => normalizeStopSessionInput({ source: 'toolbar' }), /stop session source/);
  });

  it('routes send and stop IPC payloads through main-process normalizers', async () => {
    const mainPath = fileURLToPath(new URL('../../../src/main/main.ts', import.meta.url));
    const main = await readFile(mainPath, 'utf8');
    const stopHandler = main.match(/ipcMain\.handle\('sessions:stop'[\s\S]*?\n  \);/)?.[0] ?? '';
    const sendHandler = main.match(/ipcMain\.handle\('sessions:send'[\s\S]*?\n  \);/)?.[0] ?? '';

    assert.match(stopHandler, /normalizeStopSessionInput\(input\)/);
    assert.doesNotMatch(stopHandler, /runtime\.stopSession\(sessionId,\s*input\)/);
    assert.match(stopHandler, /emitSessionsChanged\('status-change',\s*sessionId\)/);
    assert.match(stopHandler, /emitSessionsChanged\('turn-status-change',\s*sessionId\)/);
    assert.match(stopHandler, /emitSessionsChanged\('message-appended',\s*sessionId\)/);
    assert.match(sendHandler, /normalizeSessionSendCommand\(command\)/);
    assert.doesNotMatch(sendHandler, /command\.text/);
    assert.doesNotMatch(sendHandler, /command\.attachments/);
  });

  it('renderer stop() and respondToPermission() surface IPC failures only for the source session', async () => {
    // The Composer wires onStop via both the button onClick and the
    // Escape key handler, neither of which awaits the returned
    // promise. If stop() lets the IPC reject without try/catch the
    // failure dies as UnhandledPromiseRejection and the user sees
    // nothing while the model keeps streaming. Same applies to
    // respondToPermission().
    const rendererPath = fileURLToPath(new URL('../../../src/renderer/main.tsx', import.meta.url));
    const renderer = await readFile(rendererPath, 'utf8');
    // Match `async function stop()` body up to its closing brace.
    const stop = renderer.match(/async function stop\(\)\s*\{[\s\S]*?\n  \}/);
    assert.ok(stop, 'stop() must exist in main.tsx');
    assert.match(renderer, /const stopPendingRef = useRef<Set<string>>\(new Set\(\)\);/);
    assert.match(renderer, /function addPendingSessionAction\([\s\S]*?pendingRef\.current\.has\(sessionId\)[\s\S]*?pendingRef\.current\.add\(sessionId\)[\s\S]*?setPendingBySession/);
    assert.match(renderer, /function clearPendingSessionAction\([\s\S]*?pendingRef\.current\.delete\(sessionId\)[\s\S]*?omitSessionKey\(current, sessionId\)/);
    assert.match(stop[0], /const sessionId = activeIdRef\.current;/);
    assert.match(stop[0], /if \(!sessionId \|\| !addPendingSessionAction\(sessionId, stopPendingRef, setStopPendingBySession\)\) return;/);
    assert.match(stop[0], /try\s*\{[\s\S]*?await window\.maka\.sessions\.stop/);
    assert.match(stop[0], /await window\.maka\.sessions\.stop\(sessionId, \{ source: 'stop_button' \}\);/);
    assert.match(
      stop[0],
      /catch \(error\)[\s\S]*?if \(activeIdRef\.current === sessionId\) toastApi\.error\('停止失败', generalizedErrorMessageChinese\(error, '会话操作失败，请稍后重试。'\)\);/,
      'stop failure feedback must not leak onto a different active session',
    );
    assert.doesNotMatch(
      stop[0],
      /toastApi\.error\('停止失败', cleanErrorMessage\(error\)\)/,
      'stop failure feedback must not expose raw IPC/provider/storage details',
    );
    assert.match(stop[0], /finally \{[\s\S]*?clearPendingSessionAction\(sessionId, stopPendingRef, setStopPendingBySession\);[\s\S]*?\}/);
    const respond = renderer.match(/async function respondToPermission\([\s\S]*?\n  \}/);
    assert.ok(respond, 'respondToPermission() must exist');
    assert.match(respond[0], /const sessionId = activeIdRef\.current;/);
    assert.match(respond[0], /if \(!sessionId\) return;/);
    assert.match(respond[0], /try\s*\{[\s\S]*?await window\.maka\.sessions\.respondToPermission\(sessionId, response\);/);
    assert.doesNotMatch(
      respond[0],
      /respondToPermission\(activeId, response\)/,
      'permission response IPC must use the captured source session, not render-time activeId',
    );
    assert.match(
      respond[0],
      /catch \(error\)[\s\S]*?if \(activeIdRef\.current === sessionId\) toastApi\.error\('响应失败', generalizedErrorMessageChinese\(error, '会话操作失败，请稍后重试。'\)\);/,
      'permission response failure feedback must not leak onto a different active session',
    );
    assert.doesNotMatch(
      respond[0],
      /toastApi\.error\('响应失败', cleanErrorMessage\(error\)\)/,
      'permission response failure feedback must not expose raw IPC/provider/storage details',
    );
  });

  it('renderer clears permission overlay when a session completes (PR-PERMISSION-UI-CLEANUP-0)', async () => {
    // Without this, a session that finishes for a reason other than
    // permission_handoff would leave a stranded permission entry in
    // `permissionBySession[sessionId]`, keeping the overlay visible
    // and blocking the session UI until the user manually navigates
    // away. Mirrors the existing `abort` cleanup.
    const rendererPath = fileURLToPath(new URL('../../../src/renderer/main.tsx', import.meta.url));
    const renderer = await readFile(rendererPath, 'utf8');
    // Find the 'complete' case in handleSessionEvent — the body must
    // clear the session's permission queue when stopReason is not
    // permission_handoff.
    const completeCase = renderer.match(/case 'complete':[\s\S]*?break;/);
    assert.ok(completeCase, "'complete' case must exist in renderer event handler");
    assert.match(
      completeCase[0],
      /setPermissionBySession\(\(current\) => clearPermissions\(current, sessionId\)\)/,
      "'complete' case must clear the session's permission queue — mirrors the abort handler",
    );
  });

  it('PermissionDialog submit() awaits onRespond and resets pending in finally (PR-PERMISSION-UI-CLEANUP-0)', async () => {
    // Critical interaction with PR-STOP-ERROR-SURFACE-0: the parent
    // respondToPermission now swallows IPC errors via toast. If
    // submit() doesn't reset pending on resolve OR catch, the
    // dialog buttons lock up forever after a failed IPC.
    const componentsPath = fileURLToPath(new URL('../../../../../packages/ui/src/components.tsx', import.meta.url));
    const components = await readFile(componentsPath, 'utf8');
    const submit = components.match(/async function submit\(decision:[\s\S]*?\n  \}/);
    assert.ok(submit, 'PermissionDialog submit() must be async');
    assert.match(components, /const permissionMountedRef = useRef\(true\);/);
    assert.match(components, /const activePermissionRequestIdRef = useRef\(props\.request\.requestId\);/);
    assert.match(components, /activePermissionRequestIdRef\.current = props\.request\.requestId;/);
    assert.match(submit[0], /const requestId = props\.request\.requestId;/);
    assert.match(submit[0], /await props\.onRespond\(/);
    assert.match(
      submit[0],
      /\}\s*finally\s*\{[\s\S]*?if \(activePermissionRequestIdRef\.current === requestId\) \{[\s\S]*?responsePendingRef\.current\s*=\s*false[\s\S]*?if \(permissionMountedRef\.current\) setResponsePending\(false\)/,
    );
  });

  it('toast items carry role="alert" so screen readers announce them (PR-PERMISSION-UI-CLEANUP-0)', async () => {
    const toastPath = fileURLToPath(new URL('../../../../../packages/ui/src/toast.tsx', import.meta.url));
    const toast = await readFile(toastPath, 'utf8');
    assert.match(
      toast,
      /<li[^>]*role="alert"/,
      'each toast <li> must declare role="alert" — the parent aria-live region alone is unreliable on macOS VoiceOver / NVDA',
    );
  });

  it('refreshes active messages when a sessions:changed message-appended event arrives', async () => {
    const rendererPath = fileURLToPath(new URL('../../../src/renderer/main.tsx', import.meta.url));
    const renderer = await readFile(rendererPath, 'utf8');

    // PR-OAUTH-CARD-LIVE-STATE-0: the renderer uses a local
    // `changedSessionId = event.sessionId` shadow var + a truthy
    // guard before comparing to activeIdRef. Match either spelling
    // and allow the intermediate truthy check so this contract
    // doesn't rot when the implementation tweaks the guard shape.
    assert.match(
      renderer,
      /event\.reason === 'message-appended'[\s\S]{0,80}?(?:event\.sessionId|changedSessionId) === activeIdRef\.current[\s\S]*?refreshMessages\((?:event\.sessionId|changedSessionId)\)/,
    );
  });

  it('scopes session event error feedback to the active chat surface', async () => {
    const rendererPath = fileURLToPath(new URL('../../../src/renderer/main.tsx', import.meta.url));
    const renderer = await readFile(rendererPath, 'utf8');
    const errorBranch = renderer.match(/case 'error':[\s\S]*?case 'abort':/)?.[0] ?? '';
    const helper = renderer.match(/function sessionEventErrorMessage\(event: Extract<SessionEvent, \{ type: 'error' \}>\): string \{[\s\S]*?\n\}/)?.[0] ?? '';

    assert.match(
      helper,
      /generalizedErrorMessageChinese\(new Error\(event\.message\), '对话运行失败，请稍后重试。'\)/,
      'active chat error toasts must classify/redact raw SessionEvent.error.message before visible feedback',
    );

    assert.match(
      errorBranch,
      /clearStreaming\(sessionId\);[\s\S]*setPermissionBySession[\s\S]*if \(activeIdRef\.current === sessionId\) \{[\s\S]*if \(isNoRealConnectionEvent\(event\)\) \{[\s\S]*const reason = noRealConnectionReasonFromEvent\(event\);[\s\S]*showModelSetupToast\(noRealConnectionSetupDescription\(reason\), reason\);[\s\S]*\} else \{[\s\S]*toastApi\.error\('对话出错', sessionEventErrorMessage\(event\)\);[\s\S]*\}[\s\S]*\}[\s\S]*markInFlightToolsInterrupted\(sessionId\);[\s\S]*refreshSessions\(\);[\s\S]*refreshMessages\(sessionId\);/,
      'background session error events may update stored state, but must not show toasts or open Settings on the active chat surface',
    );
    assert.doesNotMatch(
      errorBranch,
      /showModelSetupToast\(cleanEventMessage\(event\.message\), noRealConnectionReasonFromEvent\(event\)\)/,
      'model-setup event failures must not expose the cleaned raw event message as visible copy',
    );
    assert.doesNotMatch(
      errorBranch,
      /toastApi\.error\('对话出错', event\.message\)/,
      'SessionEvent.error.message may contain provider/raw transport detail and must not be toasted directly',
    );
  });

  it('keeps newly created sessions selected across immediate refreshSessions() calls', async () => {
    const rendererPath = fileURLToPath(new URL('../../../src/renderer/main.tsx', import.meta.url));
    const renderer = await readFile(rendererPath, 'utf8');
    const setActiveId = renderer.match(/function setActiveId\(next: string \| undefined\): void \{[\s\S]*?\n  \}/);
    const refreshSessions = renderer.match(/async function refreshSessions\(\)(?:: Promise<SessionSummary\[]>)? \{[\s\S]*?\n  \}/);
    const bootstrapSessions = renderer.match(/async function bootstrapSessions\(\) \{[\s\S]*?\n  \}/);

    assert.ok(setActiveId, 'renderer must route active session changes through a ref-synchronized setter');
    assert.match(setActiveId[0], /activeIdRef\.current\s*=\s*next/);
    assert.match(setActiveId[0], /setActiveIdState\(next\)/);
    assert.match(
      renderer,
      /const sessionsRef = useRef<SessionSummary\[]>\(\[\]\)/,
      'session refresh failures must preserve the last successful list instead of clearing the sidebar',
    );
    assert.ok(refreshSessions, 'refreshSessions() must exist');
    assert.match(
      refreshSessions[0],
      /try \{[\s\S]*window\.maka\.sessions\.list\(\)[\s\S]*sessionsRef\.current = next[\s\S]*setSessions\(next\)[\s\S]*return next[\s\S]*\} catch \(error\) \{[\s\S]*toastApi\.error\('刷新会话列表失败', generalizedErrorMessageChinese\(error, '刷新会话列表失败，请稍后重试。'\)\)[\s\S]*return sessionsRef\.current/,
      'refreshSessions() is called fire-and-forget and must catch list failures without dropping the current list',
    );
    assert.doesNotMatch(refreshSessions[0], /toastApi\.error\('刷新会话列表失败', cleanErrorMessage\(error\)\)/);
    assert.doesNotMatch(
      refreshSessions[0],
      /setActiveId\(/,
      'refreshSessions() must stay a pure data refresh; background session events must not change selection',
    );
    assert.doesNotMatch(
      refreshSessions[0],
      /if \(!activeId && next\[0\]/,
      'stale activeId closure can re-select an old session after creating a new chat and immediately sending',
    );
    assert.ok(bootstrapSessions, 'boot-only session selection helper must exist');
    assert.match(
      bootstrapSessions[0],
      /const next = await refreshSessions\(\)/,
      'bootstrapSessions() should reuse refreshSessions() for the list pull',
    );
    assert.match(
      bootstrapSessions[0],
      /if \(!activeIdRef\.current && next\[0\] && next\[0\]\.lastMessageAt\) setActiveId\(next\[0\]\.id\)/,
      'only bootstrapSessions() may auto-select the first existing chat on app startup',
    );
    assert.match(
      renderer,
      /useEffect\(\(\) => \{[\s\S]*?void bootstrapSessions\(\)/,
      'initial mount must use the boot-only selector instead of putting selection side effects inside refreshSessions()',
    );
    assert.doesNotMatch(
      renderer,
      /useEffect\(\(\) => \{[\s\S]{0,120}?void refreshSessions\(\)/,
      'initial mount should call bootstrapSessions(), not raw refreshSessions(), for boot-only selection',
    );
    const quickChatHandler = renderer.match(
      /async function handleQuickChatSubmit\(prompt: string, mode\?: QuickChatMode\): Promise<boolean> \{[\s\S]*?\n  \}/,
    );
    assert.ok(quickChatHandler, 'handleQuickChatSubmit() must exist');
    assert.match(
      renderer,
      /const quickChatPendingRef = useRef\(false\)/,
      'quick chat must use a ref-backed pending gate so same-frame double submit cannot start two sessions',
    );
    assert.match(
      quickChatHandler[0],
      /if \(quickChatPendingRef\.current\) return false;[\s\S]*?quickChatPendingRef\.current = true/,
      'quick chat submit must synchronously reject while another start call is in flight',
    );
    const quickChat = quickChatHandler[0].match(/if \(result\.ok\) \{[\s\S]*?if \(!prompt\.trim\(\)\) \{/);
    assert.ok(quickChat, 'quick chat success branch must exist');
    assert.match(
      quickChat[0],
      /openSessionInChat\(result\.sessionId\)[\s\S]*?await refreshSessions\(\)/,
      'quick chat must open the new session on the chat surface before refreshing the list so onboarding cannot bounce to an older chat',
    );
    assert.doesNotMatch(
      quickChat[0],
      /await refreshSessions\(\)[\s\S]*?setActiveId\(result\.sessionId\)/,
      'refreshing before selecting the quick-chat session can briefly select an older session',
    );
    assert.doesNotMatch(
      quickChat[0],
      /setActiveId\(result\.sessionId\)/,
      'quick chat can be launched from non-chat modules, so raw setActiveId would leave the new session hidden',
    );
    assert.match(
      quickChatHandler[0],
      /return true;/,
      'quick chat must report success so the first-run composer can clear its draft only after a session is created',
    );
    assert.match(
      quickChatHandler[0],
      /result\.reason === 'setup_required'[\s\S]*?return false;/,
      'setup failures must return false so the first-run composer keeps the user draft',
    );
    assert.match(
      quickChatHandler[0],
      /toastApi\.error\('开始对话失败', result\.message\);[\s\S]*?return false;/,
      'send failures must return false so the first-run composer keeps the user draft',
    );
    assert.match(
      quickChatHandler[0],
      /toastApi\.error\('开始对话失败', generalizedErrorMessageChinese\(error, '对话暂时无法开始，请稍后重试。'\)\);[\s\S]*?return false;/,
      'quick chat thrown failures should use a generalized fallback instead of raw backend/path details',
    );
    assert.doesNotMatch(quickChatHandler[0], /toastApi\.error\('开始对话失败', cleanErrorMessage\(error\)\)/);
    assert.match(
      quickChatHandler[0],
      /quickChatPendingRef\.current = false;[\s\S]*?setQuickChatPending\(false\)/,
      'quick chat pending ref must be cleared with the visible pending state',
    );
  });

  it('keeps normal Composer first-send visible in the newly created session', async () => {
    const rendererPath = fileURLToPath(new URL('../../../src/renderer/main.tsx', import.meta.url));
    const renderer = await readFile(rendererPath, 'utf8');
    const sendBlock = renderer.match(
      /async function send\(text: string\): Promise<boolean> \{[\s\S]*?async function importTextFilePrompt/,
    )?.[0] ?? '';
    const newSessionBranch = sendBlock.match(/if \(!initialSessionId\) \{[\s\S]*?return true;/)?.[0] ?? '';
    const existingSessionBranch = sendBlock.match(/const sessionId = initialSessionId;[\s\S]*?return true;/)?.[0] ?? '';
    const refreshUntilTurn = renderer.match(
      /async function refreshMessagesUntilTurn\(sessionId: string, turnId: string\): Promise<void> \{[\s\S]*?\n  \}/,
    )?.[0] ?? '';

    assert.match(sendBlock, /const initialSessionId = activeIdRef\.current;/);
    assert.doesNotMatch(
      sendBlock,
      /if \(!activeId\)|const sessionId = activeId;/,
      'normal Composer send must branch from activeIdRef.current, not stale React state after clicking New Chat',
    );
    assert.match(sendBlock, /const turnId = crypto\.randomUUID\(\)/);
    assert.match(
      newSessionBranch,
      /setNavSelection\(\{ section: 'sessions', filter: 'chats' \}\)[\s\S]*setActiveId\(session\.id\)[\s\S]*upsertSessionSummary\(session\)[\s\S]*showOptimisticUserMessage\(session\.id, turnId, text, \{ replaceCurrentMessages: true \}\)[\s\S]*window\.maka\.sessions\.send\(session\.id, \{ type: 'send', turnId, text \}\)[\s\S]*refreshMessagesUntilTurn\(session\.id, turnId\)[\s\S]*refreshSessions\(\)/,
      'normal Composer first-send must switch the current view to the created session and show the user turn immediately',
    );
    assert.doesNotMatch(
      newSessionBranch,
      /setMessages\(\[\]\)/,
      'normal Composer first-send must not leave the newly created chat blank while waiting for storage refresh',
    );
    assert.doesNotMatch(
      newSessionBranch,
      /await refreshSessions\(\)[\s\S]*window\.maka\.sessions\.send\(session\.id/,
      'refreshing the sidebar before sending leaves the current chat surface dependent on a later event-stream race',
    );
    assert.match(
      existingSessionBranch,
      /showOptimisticUserMessage\(sessionId, turnId, text\)[\s\S]*window\.maka\.sessions\.send\(sessionId, \{ type: 'send', turnId, text \}\)[\s\S]*refreshMessagesUntilTurn\(sessionId, turnId\)/,
      'existing sessions should also show the user turn immediately before waiting for persisted storage',
    );
    assert.match(
      sendBlock,
      /catch \(error\) \{[\s\S]*removeOptimisticUserMessage\(optimisticSessionId, optimisticTurnId\)[\s\S]*toastApi\.error\('发送失败', generalizedErrorMessageChinese\(error, '消息暂时无法发送，请稍后重试。'\)\)/,
      'send readiness failures must remove the optimistic user turn instead of leaving a fake message behind',
    );
    assert.match(
      sendBlock,
      /const feedbackSessionId = optimisticSessionId \?\? initialSessionId;[\s\S]*const sendStillOwnsCurrentSurface = feedbackSessionId[\s\S]*activeIdRef\.current === feedbackSessionId[\s\S]*activeIdRef\.current === initialSessionId;[\s\S]*if \(!sendStillOwnsCurrentSurface\) return false;/,
      'send failure feedback must not toast or open setup from a stale session after the user switches chats',
    );
    assert.match(
      sendBlock,
      /if \(!sendStillOwnsCurrentSurface\) return false;[\s\S]*if \(isNoRealConnectionError\(error\)\) \{[\s\S]*const reason = noRealConnectionReasonFromError\(error\);[\s\S]*showModelSetupToast\(noRealConnectionSetupDescription\(reason\), reason\);[\s\S]*\} else \{[\s\S]*toastApi\.error\('发送失败', generalizedErrorMessageChinese\(error, '消息暂时无法发送，请稍后重试。'\)\)/,
      'both model-setup feedback and generic send-failure toast must be guarded by the active-session owner check',
    );
    assert.doesNotMatch(
      sendBlock,
      /showModelSetupToast\(cleanErrorMessage\(error\), noRealConnectionReasonFromError\(error\)\)/,
      'model-setup send failures must not expose the cleaned raw exception body as visible copy',
    );
    assert.doesNotMatch(
      sendBlock,
      /toastApi\.error\('发送失败', cleanErrorMessage\(error\)\)/,
      'generic send failure feedback must not expose raw IPC/provider/storage details',
    );
    assert.match(
      renderer,
      /function noRealConnectionSetupDescription\(reason: string \| undefined\): string \{[\s\S]*case 'missing_default_connection':[\s\S]*等待配置默认模型[\s\S]*case 'missing_api_key':[\s\S]*当前模型连接还没有可用凭据[\s\S]*case 'fake_backend':[\s\S]*当前会话来自旧的本地模拟连接/,
      'model-setup send failures should use reason-driven Chinese copy instead of backend exception text',
    );
    const modelSetupToast = renderer.match(/function showModelSetupToast\(description: string, reason\?: string\) \{[\s\S]*?\n  \}/)?.[0] ?? '';
    assert.match(
      modelSetupToast,
      /label: '打开设置 · 模型'[\s\S]*onClick: \(\) => openSettingsSection\('models'\)[\s\S]*openSettingsSection\('models'\)/,
      'model-setup feedback must land on Settings · Models, not the last-opened Settings tab',
    );
    assert.doesNotMatch(
      modelSetupToast,
      /onClick: openSettings|openSettings\(\);/,
      'model-setup feedback should not only open Settings because that can restore an unrelated previous section',
    );
    assert.match(
      refreshUntilTurn,
      /readMessages\(sessionId\)[\s\S]*hasSentUserTurn = next\.some\(\(message\) => message\.type === 'user' && message\.turnId === turnId\)[\s\S]*hasSentUserTurn && activeIdRef\.current === sessionId[\s\S]*setMessages\(next\)/,
      'the visible-message wait must be tied to the exact turnId sent by the Composer',
    );
    assert.match(
      refreshUntilTurn,
      /USER_MESSAGE_VISIBLE_TIMEOUT_MS[\s\S]*USER_MESSAGE_VISIBLE_POLL_MS[\s\S]*refreshMessages\(sessionId\)/,
      'the wait must be bounded and fall back to the normal refresh path',
    );
  });
});
