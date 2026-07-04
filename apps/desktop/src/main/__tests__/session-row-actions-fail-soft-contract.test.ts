import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readRendererShellCombinedSource } from './renderer-shell-source-helpers.js';
import { readRenderedSessionHistorySource } from './session-history-owner-source-helpers.js';

describe('session row actions fail soft', () => {
  it('surfaces sidebar session action failures instead of leaving fire-and-forget rejections', async () => {
    const main = await readRendererShellCombinedSource();

    assert.match(main, /async function runSessionRowAction\([\s\S]*errorTitle: string,[\s\S]*try \{[\s\S]*await action\(\);[\s\S]*\} catch \(error\) \{[\s\S]*toastApi\.error\(errorTitle, generalizedErrorMessageChinese\(error, '会话操作失败，请稍后重试。'\)\)/);
    assert.match(main, /async function flagSession\(sessionId: string, flagged: boolean\) \{[\s\S]*runSessionRowAction\(sessionId, 'flag', flagged \? '标记会话失败' : '取消标记失败'[\s\S]*window\.maka\.sessions\.setFlagged\(sessionId, flagged\)[\s\S]*refreshSessions\(\)/);
    assert.match(main, /async function archiveSession\(sessionId: string\) \{[\s\S]*runSessionRowAction\(sessionId, 'archive', '归档会话失败'[\s\S]*window\.maka\.sessions\.archive\(sessionId\)[\s\S]*activeIdRef\.current === sessionId[\s\S]*setActiveId\(undefined\)[\s\S]*setMessages\(\[\]\)[\s\S]*refreshSessions\(\)/);
    assert.match(main, /async function unarchiveSession\(sessionId: string\) \{[\s\S]*runSessionRowAction\(sessionId, 'archive', '恢复会话失败'[\s\S]*window\.maka\.sessions\.unarchive\(sessionId\)[\s\S]*refreshSessions\(\)/);
    assert.match(main, /async function renameSession\(sessionId: string, name: string\) \{[\s\S]*runSessionRowAction\(sessionId, 'rename', '重命名会话失败'[\s\S]*window\.maka\.sessions\.rename\(sessionId, name\)[\s\S]*refreshSessions\(\)/);
    assert.match(main, /async function deleteSession\(sessionId: string\) \{[\s\S]*runSessionRowAction\(sessionId, 'delete', '删除会话失败'[\s\S]*toastApi\.confirm\([\s\S]*window\.maka\.sessions\.remove\(sessionId\)[\s\S]*activeIdRef\.current === sessionId[\s\S]*setActiveId\(undefined\)[\s\S]*setMessages\(\[\]\)[\s\S]*refreshSessions\(\)[\s\S]*toastApi\.success\(`已删除 \$\{name\}`\)/);
    assert.doesNotMatch(
      main,
      /toastApi\.error\((?:flagged \? '标记会话失败' : '取消标记失败'|'归档会话失败'|'恢复会话失败'|'重命名会话失败'|'删除会话失败'), cleanErrorMessage\(error\)\)/,
      'sidebar row action failures must not echo raw cleaned Error.message in visible toast feedback',
    );
  });

  it('gates duplicate sidebar row actions before IPC or confirm dialogs can double-fire', async () => {
    const main = await readRendererShellCombinedSource();
    const sessionListBlock = main.match(/<SessionListPanel[\s\S]*?\/>/)?.[0] ?? '';

    assert.match(main, /const pendingSessionRowActionsRef = useRef<Set<string>>\(new Set\(\)\);/);
    assert.match(main, /const sessionPrefix = `\$\{sessionId\}:`;/);
    assert.match(main, /Array\.from\(pendingSessionRowActionsRef\.current\)\.some\(\(key\) => key\.startsWith\(sessionPrefix\)\)/);
    assert.match(main, /pendingSessionRowActionsRef\.current\.add\(key\);[\s\S]*catch \(error\) \{[\s\S]*toastApi\.error\(errorTitle, generalizedErrorMessageChinese\(error, '会话操作失败，请稍后重试。'\)\)[\s\S]*finally \{[\s\S]*pendingSessionRowActionsRef\.current\.delete\(key\);/);
    assert.match(main, /const sessionRowActions = useMemo<NonNullable<Parameters<typeof SessionListPanel>\[0\]\['rowActions'\]>>\([\s\S]*onToggleFlag: \(sessionId, next\) => sessionRowActionHandlersRef\.current\.flagSession\(sessionId, next\),[\s\S]*onArchive: \(sessionId\) => sessionRowActionHandlersRef\.current\.archiveSession\(sessionId\),[\s\S]*onUnarchive: \(sessionId\) => sessionRowActionHandlersRef\.current\.unarchiveSession\(sessionId\),[\s\S]*onRename: \(sessionId, name\) => sessionRowActionHandlersRef\.current\.renameSession\(sessionId, name\),[\s\S]*onDelete: \(sessionId\) => sessionRowActionHandlersRef\.current\.deleteSession\(sessionId\),/);
    assert.match(main, /rowActions=\{sessionRowActions\}/);
    assert.match(sessionListBlock, /onSelectSession=\{[^}]+\}/);
    assert.match(sessionListBlock, /rowActions=\{[^}]+\}/);
    assert.doesNotMatch(sessionListBlock, /onSelectSession=\{\(sessionId\)/);
    assert.doesNotMatch(sessionListBlock, /rowActions=\{\{/);
    assert.doesNotMatch(main, /onDelete: \(sessionId\) => void sessionRowActionHandlersRef\.current\.deleteSession\(sessionId\)/);
    assert.doesNotMatch(main, /onToggleFlag: \(sessionId, next\) => void sessionRowActionHandlersRef\.current\.flagSession\(sessionId, next\)/);
  });

  it('cleans active session renderer state consistently after archive or delete', async () => {
    const main = await readRendererShellCombinedSource();
    const cleanupBlock = main.slice(
      main.indexOf('function clearSessionRendererState'),
      main.indexOf('// PR109e: per-turn auxiliary view-model'),
    );

    assert.match(cleanupBlock, /messageRetryPendingRef\.current\.delete\(sessionId\);/);
    assert.match(cleanupBlock, /stopPendingRef\.current\.delete\(sessionId\);/);
    assert.match(cleanupBlock, /clearPendingTurnActionsForSession\(sessionId\);/);
    assert.match(cleanupBlock, /pendingPermissionModeChangesRef\.current\.delete\(sessionId\);/);
    assert.match(cleanupBlock, /pendingSessionModelChangesRef\.current\.delete\(sessionId\);/);
    assert.match(
      cleanupBlock,
      /clearSessionUiState\(sessionId\);/,
      'archive/delete cleanup must use the centralized per-session UI state cleanup',
    );

    assert.match(
      main,
      /event\.reason === 'deleted'[\s\S]*setActiveId\(undefined\);[\s\S]*setMessages\(\[\]\);[\s\S]*clearSessionRendererState\(deletedSessionId\);/,
      'session deleted events must use the same renderer cleanup as row actions',
    );
    assert.match(
      main,
      /async function archiveSession\(sessionId: string\) \{[\s\S]*window\.maka\.sessions\.archive\(sessionId\)[\s\S]*activeIdRef\.current === sessionId[\s\S]*setActiveId\(undefined\);[\s\S]*setMessages\(\[\]\);[\s\S]*clearSessionRendererState\(sessionId\);/,
      'archiving the active session must clear streaming, permission, pending, and health state',
    );
    assert.match(
      main,
      /async function deleteSession\(sessionId: string\) \{[\s\S]*window\.maka\.sessions\.remove\(sessionId\)[\s\S]*activeIdRef\.current === sessionId[\s\S]*setActiveId\(undefined\);[\s\S]*setMessages\(\[\]\);[\s\S]*clearSessionRendererState\(sessionId\);/,
      'deleting a session must clear renderer state even after the row unmounts',
    );
  });

  it('renders visible busy state while a sidebar row action is pending', async () => {
    const ui = await readRenderedSessionHistorySource();

    assert.match(ui, /type SessionRowActionId = 'flag' \| 'archive' \| 'rename' \| 'delete';/);
    assert.match(ui, /onToggleFlag\(sessionId: string, next: boolean\): void \| Promise<void>;/);
    assert.match(ui, /onDelete\(sessionId: string\): void \| Promise<void>;/);
    assert.match(ui, /const \[pendingAction,\s*setPendingAction\] = useState<SessionRowActionId \| null>\(null\);/);
    assert.match(ui, /const rowMountedRef = useRef\(true\);/);
    assert.match(ui, /const pendingActionRef = useRef<SessionRowActionId \| null>\(null\);/);
    assert.match(
      ui,
      /if \(pendingActionRef\.current\) return;[\s\S]*pendingActionRef\.current = actionId;[\s\S]*void \(async \(\) => \{[\s\S]*try \{[\s\S]*await action\(\);[\s\S]*\} catch \{[\s\S]*\} finally \{/,
    );
    assert.match(
      ui,
      /useEffect\(\(\) => \{\s*rowMountedRef\.current = true;[\s\S]*?return \(\) => \{\s*rowMountedRef\.current = false;\s*pendingActionRef\.current = null;\s*\};\s*\}, \[\]\)/,
      'SessionRow must release pending ownership when archive/delete/filter changes unmount the row',
    );
    assert.match(
      ui,
      /pendingActionRef\.current = null;[\s\S]*if \(rowMountedRef\.current\) setPendingAction\(null\);/,
      'SessionRow action cleanup must not write pending state after the row unmounts',
    );
    assert.match(ui, /disabled=\{actionBusy\}/);
    assert.match(ui, /aria-busy=\{pendingAction === 'flag' \? 'true' : undefined\}/);
    assert.match(ui, /data-pending=\{pendingAction === 'archive' \? 'true' : undefined\}/);
    assert.match(ui, /aria-busy=\{pendingAction === 'delete' \? 'true' : undefined\}/);
    const rowActionVariantCalls = [...ui.matchAll(/cn\('maka-list-row-action', rowActionVariants/g)];
    assert.equal(rowActionVariantCalls.length, 4, 'all 4 row action buttons (flag, rename, archive, delete) must call rowActionVariants');
    assert.match(
      ui,
      /data-\[pending=true\]:cursor-progress data-\[pending=true\]:bg-foreground\/5 data-\[pending=true\]:text-foreground data-\[pending=true\]:opacity-78/,
      'rowActionVariants cva must carry a visible pending state (cursor + bg + opacity)',
    );
  });
});
