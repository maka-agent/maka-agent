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

  it('renderer stop() and respondToPermission() surface IPC failures as toasts (PR-STOP-ERROR-SURFACE-0)', async () => {
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
    assert.match(stop[0], /try\s*\{[\s\S]*?await window\.maka\.sessions\.stop/);
    assert.match(stop[0], /catch \(error\)[\s\S]*?toastApi\.error\(['"]停止失败['"]/);
    const respond = renderer.match(/async function respondToPermission\([\s\S]*?\n  \}/);
    assert.ok(respond, 'respondToPermission() must exist');
    assert.match(respond[0], /try\s*\{[\s\S]*?await window\.maka\.sessions\.respondToPermission/);
    assert.match(respond[0], /catch \(error\)[\s\S]*?toastApi\.error\(['"]响应失败['"]/);
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
    // null out permissionBySession[sessionId] when stopReason is
    // not permission_handoff.
    const completeCase = renderer.match(/case 'complete':[\s\S]*?break;/);
    assert.ok(completeCase, "'complete' case must exist in renderer event handler");
    assert.match(
      completeCase[0],
      /setPermissionBySession\(\(current\) => \(\{\s*\.\.\.current,\s*\[sessionId\]:\s*undefined\s*\}\)\)/,
      "'complete' case must clear permissionBySession for the session — mirrors the abort handler",
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
    assert.match(submit[0], /await props\.onRespond\(/);
    assert.match(submit[0], /\}\s*finally\s*\{[\s\S]*?responsePendingRef\.current\s*=\s*false[\s\S]*?setResponsePending\(false\)/);
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
      /try \{[\s\S]*window\.maka\.sessions\.list\(\)[\s\S]*sessionsRef\.current = next[\s\S]*setSessions\(next\)[\s\S]*return next[\s\S]*\} catch \(error\) \{[\s\S]*toastApi\.error\('刷新会话列表失败', cleanErrorMessage\(error\)\)[\s\S]*return sessionsRef\.current/,
      'refreshSessions() is called fire-and-forget and must catch list failures without dropping the current list',
    );
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
      /setActiveId\(result\.sessionId\)[\s\S]*?await refreshSessions\(\)/,
      'quick chat must select the new session before refreshing the list so onboarding cannot bounce to an older chat',
    );
    assert.doesNotMatch(
      quickChat[0],
      /await refreshSessions\(\)[\s\S]*?setActiveId\(result\.sessionId\)/,
      'refreshing before selecting the quick-chat session can briefly select an older session',
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
    const newSessionBranch = sendBlock.match(/if \(!activeId\) \{[\s\S]*?return true;/)?.[0] ?? '';
    const existingSessionBranch = sendBlock.match(/const sessionId = activeId;[\s\S]*?return true;/)?.[0] ?? '';
    const refreshUntilTurn = renderer.match(
      /async function refreshMessagesUntilTurn\(sessionId: string, turnId: string\): Promise<void> \{[\s\S]*?\n  \}/,
    )?.[0] ?? '';

    assert.match(sendBlock, /const turnId = crypto\.randomUUID\(\)/);
    assert.match(
      newSessionBranch,
      /setNavSelection\(\{ section: 'sessions', filter: 'chats' \}\)[\s\S]*setActiveId\(session\.id\)[\s\S]*upsertSessionSummary\(session\)[\s\S]*setMessages\(\[\]\)[\s\S]*window\.maka\.sessions\.send\(session\.id, \{ type: 'send', turnId, text \}\)[\s\S]*refreshMessagesUntilTurn\(session\.id, turnId\)[\s\S]*refreshSessions\(\)/,
      'normal Composer first-send must switch the current view to the created session and wait for the first user turn to render',
    );
    assert.doesNotMatch(
      newSessionBranch,
      /await refreshSessions\(\)[\s\S]*window\.maka\.sessions\.send\(session\.id/,
      'refreshing the sidebar before sending leaves the current chat surface dependent on a later event-stream race',
    );
    assert.match(
      existingSessionBranch,
      /window\.maka\.sessions\.send\(sessionId, \{ type: 'send', turnId, text \}\)[\s\S]*refreshMessagesUntilTurn\(sessionId, turnId\)/,
      'existing sessions should also wait for the persisted user turn instead of relying only on stream events',
    );
    assert.match(
      refreshUntilTurn,
      /readMessages\(sessionId\)[\s\S]*setMessages\(next\)[\s\S]*message\.type === 'user' && message\.turnId === turnId/,
      'the visible-message wait must be tied to the exact turnId sent by the Composer',
    );
    assert.match(
      refreshUntilTurn,
      /USER_MESSAGE_VISIBLE_TIMEOUT_MS[\s\S]*USER_MESSAGE_VISIBLE_POLL_MS[\s\S]*refreshMessages\(sessionId\)/,
      'the wait must be bounded and fall back to the normal refresh path',
    );
  });
});
