import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const UI_COMPONENTS_PATH = join(process.cwd(), '../../packages/ui/src/components.tsx');
const STYLES_PATH = join(process.cwd(), 'src/renderer/styles.css');

describe('session row actions fail soft', () => {
  it('surfaces sidebar session action failures instead of leaving fire-and-forget rejections', async () => {
    const main = await readFile(join(process.cwd(), 'src/renderer/main.tsx'), 'utf8');

    assert.match(main, /async function flagSession\(sessionId: string, flagged: boolean\) \{[\s\S]*runSessionRowAction\(sessionId, 'flag'[\s\S]*try \{[\s\S]*window\.maka\.sessions\.setFlagged\(sessionId, flagged\)[\s\S]*refreshSessions\(\)[\s\S]*toastApi\.error\(flagged \? '标记会话失败' : '取消标记失败', sessionRowActionErrorMessage\(error\)\)/);
    assert.match(main, /async function archiveSession\(sessionId: string\) \{[\s\S]*runSessionRowAction\(sessionId, 'archive'[\s\S]*try \{[\s\S]*window\.maka\.sessions\.archive\(sessionId\)[\s\S]*activeIdRef\.current === sessionId[\s\S]*setActiveId\(undefined\)[\s\S]*setMessages\(\[\]\)[\s\S]*refreshSessions\(\)[\s\S]*toastApi\.error\('归档会话失败', sessionRowActionErrorMessage\(error\)\)/);
    assert.match(main, /async function unarchiveSession\(sessionId: string\) \{[\s\S]*runSessionRowAction\(sessionId, 'archive'[\s\S]*try \{[\s\S]*window\.maka\.sessions\.unarchive\(sessionId\)[\s\S]*refreshSessions\(\)[\s\S]*toastApi\.error\('恢复会话失败', sessionRowActionErrorMessage\(error\)\)/);
    assert.match(main, /async function renameSession\(sessionId: string, name: string\) \{[\s\S]*runSessionRowAction\(sessionId, 'rename'[\s\S]*try \{[\s\S]*window\.maka\.sessions\.rename\(sessionId, name\)[\s\S]*refreshSessions\(\)[\s\S]*toastApi\.error\('重命名会话失败', sessionRowActionErrorMessage\(error\)\)/);
    assert.match(main, /async function deleteSession\(sessionId: string\) \{[\s\S]*runSessionRowAction\(sessionId, 'delete'[\s\S]*toastApi\.confirm\([\s\S]*window\.maka\.sessions\.remove\(sessionId\)[\s\S]*activeIdRef\.current === sessionId[\s\S]*setActiveId\(undefined\)[\s\S]*setMessages\(\[\]\)[\s\S]*refreshSessions\(\)[\s\S]*toastApi\.success\(`已删除 \$\{name\}`\)[\s\S]*toastApi\.error\('删除会话失败', sessionRowActionErrorMessage\(error\)\)/);
    assert.match(
      main,
      /function sessionRowActionErrorMessage\(error: unknown\): string \{[\s\S]*generalizedErrorMessageChinese\(error, '会话操作失败，请稍后重试。'\)/,
      'sidebar row action failures must be generalized before visible toast feedback',
    );
    assert.doesNotMatch(
      main,
      /toastApi\.error\((?:flagged \? '标记会话失败' : '取消标记失败'|'归档会话失败'|'恢复会话失败'|'重命名会话失败'|'删除会话失败'), cleanErrorMessage\(error\)\)/,
      'sidebar row action failures must not echo raw cleaned Error.message in visible toast feedback',
    );
  });

  it('gates duplicate sidebar row actions before IPC or confirm dialogs can double-fire', async () => {
    const main = await readFile(join(process.cwd(), 'src/renderer/main.tsx'), 'utf8');

    assert.match(main, /const pendingSessionRowActionsRef = useRef<Set<string>>\(new Set\(\)\);/);
    assert.match(main, /const sessionPrefix = `\$\{sessionId\}:`;/);
    assert.match(main, /Array\.from\(pendingSessionRowActionsRef\.current\)\.some\(\(key\) => key\.startsWith\(sessionPrefix\)\)/);
    assert.match(main, /pendingSessionRowActionsRef\.current\.add\(key\);[\s\S]*finally \{[\s\S]*pendingSessionRowActionsRef\.current\.delete\(key\);/);
    assert.match(main, /rowActions=\{\{[\s\S]*onToggleFlag: \(sessionId, next\) => flagSession\(sessionId, next\),[\s\S]*onArchive: \(sessionId\) => archiveSession\(sessionId\),[\s\S]*onUnarchive: \(sessionId\) => unarchiveSession\(sessionId\),[\s\S]*onRename: \(sessionId, name\) => renameSession\(sessionId, name\),[\s\S]*onDelete: \(sessionId\) => deleteSession\(sessionId\),/);
    assert.doesNotMatch(main, /onDelete: \(sessionId\) => void deleteSession\(sessionId\)/);
    assert.doesNotMatch(main, /onToggleFlag: \(sessionId, next\) => void flagSession\(sessionId, next\)/);
  });

  it('cleans active session renderer state consistently after archive or delete', async () => {
    const main = await readFile(join(process.cwd(), 'src/renderer/main.tsx'), 'utf8');
    const cleanupBlock = main.slice(
      main.indexOf('function clearSessionRendererState'),
      main.indexOf('// PR109e: per-turn auxiliary view-model'),
    );

    assert.match(cleanupBlock, /messageRetryPendingRef\.current\.delete\(sessionId\);/);
    assert.match(cleanupBlock, /stopPendingRef\.current\.delete\(sessionId\);/);
    assert.match(cleanupBlock, /clearPendingTurnActionsForSession\(sessionId\);/);
    assert.match(cleanupBlock, /pendingPermissionModeChangesRef\.current\.delete\(sessionId\);/);
    assert.match(cleanupBlock, /pendingSessionModelChangesRef\.current\.delete\(sessionId\);/);
    assert.match(cleanupBlock, /setMessageRetryPendingBySession\(\(current\) => omitSessionKey\(current, sessionId\)\);/);
    assert.match(cleanupBlock, /setStopPendingBySession\(\(current\) => omitSessionKey\(current, sessionId\)\);/);
    assert.match(cleanupBlock, /setPendingPermissionModeBySession\(\(current\) => omitSessionKey\(current, sessionId\)\);/);
    assert.match(cleanupBlock, /setPendingSessionModelBySession\(\(current\) => omitSessionKey\(current, sessionId\)\);/);
    assert.match(cleanupBlock, /setMessageLoadErrorBySession\(\(current\) => omitSessionKey\(current, sessionId\)\);/);
    assert.match(cleanupBlock, /setStreamingBySession\(\(current\) => omitSessionKey\(current, sessionId\)\);/);
    assert.match(cleanupBlock, /setThinkingBySession\(\(current\) => omitSessionKey\(current, sessionId\)\);/);
    assert.match(cleanupBlock, /setThinkingTruncatedBySession\(\(current\) => omitSessionKey\(current, sessionId\)\);/);
    assert.match(cleanupBlock, /setLiveToolsBySession\(\(current\) => omitSessionKey\(current, sessionId\)\);/);
    assert.match(cleanupBlock, /setPermissionBySession\(\(current\) => omitSessionKey\(current, sessionId\)\);/);
    assert.match(cleanupBlock, /setSessionEventHealthBySession\(\(current\) => omitSessionKey\(current, sessionId\)\);/);

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
    const ui = await readFile(UI_COMPONENTS_PATH, 'utf8');
    const css = await readFile(STYLES_PATH, 'utf8');
    const sessionRow = ui.slice(ui.indexOf('function SessionRow'), ui.indexOf('interface PermissionModeMeta'));

    assert.match(ui, /type SessionRowActionId = 'flag' \| 'archive' \| 'rename' \| 'delete';/);
    assert.match(ui, /onToggleFlag\(sessionId: string, next: boolean\): void \| Promise<void>;/);
    assert.match(ui, /onDelete\(sessionId: string\): void \| Promise<void>;/);
    assert.match(sessionRow, /const \[pendingAction,\s*setPendingAction\] = useState<SessionRowActionId \| null>\(null\);/);
    assert.match(sessionRow, /const rowMountedRef = useRef\(true\);/);
    assert.match(sessionRow, /const pendingActionRef = useRef<SessionRowActionId \| null>\(null\);/);
    assert.match(sessionRow, /if \(pendingActionRef\.current\) return;[\s\S]*pendingActionRef\.current = actionId;[\s\S]*Promise\.resolve\(\)\.then\(action\)\.finally/);
    assert.match(
      sessionRow,
      /useEffect\(\(\) => \{\s*rowMountedRef\.current = true;[\s\S]*?return \(\) => \{\s*rowMountedRef\.current = false;\s*pendingActionRef\.current = null;\s*\};\s*\}, \[\]\)/,
      'SessionRow must release pending ownership when archive/delete/filter changes unmount the row',
    );
    assert.match(
      sessionRow,
      /pendingActionRef\.current = null;[\s\S]*if \(rowMountedRef\.current\) setPendingAction\(null\);/,
      'SessionRow action cleanup must not write pending state after the row unmounts',
    );
    assert.match(sessionRow, /disabled=\{actionBusy\}/);
    assert.match(sessionRow, /aria-busy=\{pendingAction === 'flag' \? 'true' : undefined\}/);
    assert.match(sessionRow, /data-pending=\{pendingAction === 'archive' \? 'true' : undefined\}/);
    assert.match(sessionRow, /aria-busy=\{pendingAction === 'delete' \? 'true' : undefined\}/);
    assert.match(css, /\.maka-list-row-action\[data-pending="true"\] \{[\s\S]*cursor: progress;[\s\S]*opacity: 0\.78;[\s\S]*\}/);
  });
});
