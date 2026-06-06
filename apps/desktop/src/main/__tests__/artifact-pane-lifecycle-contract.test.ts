/**
 * Source contract for ArtifactPane async list lifecycle.
 *
 * The pane follows the active chat session. If a stale `artifacts.list()`
 * response from the previous session lands after the user has switched
 * sessions, it must not overwrite the current session's artifact list.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const ARTIFACT_PANE_SOURCE = join(process.cwd(), 'src', 'renderer', 'artifact-pane.tsx');

describe('ArtifactPane async lifecycle contract', () => {
  it('drops stale artifact list responses when the active session changes', async () => {
    const src = await readFile(ARTIFACT_PANE_SOURCE, 'utf8');
    const refreshBlock = src.match(/const refresh = useCallback\(async \(\) => \{[\s\S]*?\}, \[sessionId, toast\]\);/)?.[0] ?? '';
    const subscriptionEffect = src.match(/useEffect\(\(\) => \{[\s\S]*?window\.maka\.artifacts\.subscribeChanges[\s\S]*?\}, \[sessionId, refresh\]\);/)?.[0] ?? '';

    assert.match(
      src,
      /const artifactListRequestSeqRef = useRef\(0\)/,
      'ArtifactPane must keep a monotonic request sequence across renders',
    );
    assert.match(
      src,
      /const recordsSessionIdRef = useRef<string \| undefined>\(undefined\)/,
      'ArtifactPane must track which session owns the currently rendered records',
    );
    assert.match(
      refreshBlock,
      /const requestSeq = \+\+artifactListRequestSeqRef\.current/,
      'each artifact list refresh must claim a fresh request sequence',
    );
    assert.match(
      refreshBlock,
      /const next = await window\.maka\.artifacts\.list\(sessionId\)[\s\S]*if \(requestSeq === artifactListRequestSeqRef\.current\) \{[\s\S]*recordsSessionIdRef\.current = sessionId[\s\S]*setRecordsSessionId\(sessionId\)[\s\S]*setRecords\(next\)/,
      'artifact list responses may set records only if they are still the latest request and must stamp the owning session',
    );
    assert.match(
      refreshBlock,
      /catch \(error\) \{[\s\S]*const message = artifactActionErrorMessage\(error\);[\s\S]*setListError\(\{ sessionId, message \}\)[\s\S]*recordsSessionIdRef\.current !== sessionId[\s\S]*setRecords\(\[\]\)[\s\S]*toast\.error\('刷新生成文件失败', message\)/,
      'artifact list failures must keep a scoped visible error and clear only previous-session stale records',
    );
    assert.match(
      src,
      /const activeRecords = useMemo\([\s\S]*recordsSessionId === sessionId \? records : \[\][\s\S]*\[records, recordsSessionId, sessionId\]/,
      'rendering must filter artifact records by the current active session id',
    );
    assert.doesNotMatch(
      src,
      /if \(!sessionId \|\| records\.length === 0\)/,
      'the pane must not render or hide from unscoped records',
    );
    assert.match(
      src,
      /const listRef = useRef<HTMLUListElement>\(null\);[\s\S]*const previewRef = useRef<HTMLDivElement>\(null\);[\s\S]*const activeListError = listError && listError\.sessionId === sessionId \? listError\.message : null;[\s\S]*if \(!sessionId \|\| \(activeRecords\.length === 0 && !activeListError\)\) \{[\s\S]*return null;/,
      'all hooks must run before the ArtifactPane early return',
    );
    assert.match(
      src,
      /activeListError && \([\s\S]*className="maka-artifact-list-error"[\s\S]*role="alert"[\s\S]*生成文件列表载入失败[\s\S]*重试/,
      'current-session artifact list failures must render an inline retryable error instead of making the pane disappear',
    );
    assert.match(
      subscriptionEffect,
      /return \(\) => \{[\s\S]*artifactListRequestSeqRef\.current \+= 1;[\s\S]*unsubscribe\(\);[\s\S]*\};/,
      'session-change cleanup must invalidate in-flight artifact list responses before unsubscribing',
    );
    assert.match(
      refreshBlock,
      /\}, \[sessionId, toast\]\);/,
      'refresh must include the toast dependency used to surface current-session list failures',
    );
  });

  it('surfaces thrown artifact action failures instead of leaving toolbar clicks silent', async () => {
    const src = await readFile(ARTIFACT_PANE_SOURCE, 'utf8');
    const openBlock = src.match(/async function openInFinder[\s\S]*?async function copyText/)?.[0] ?? '';
    const copyBlock = src.match(/async function copyText[\s\S]*?async function saveAs/)?.[0] ?? '';
    const saveBlock = src.match(/async function saveAs[\s\S]*?async function deleteArtifact/)?.[0] ?? '';
    const deleteBlock = src.match(/async function deleteArtifact[\s\S]*?\n  \}\n\n  \/\/ ---- render/)?.[0] ?? '';

    assert.match(src, /function artifactActionErrorMessage\(error: unknown\)/);
    assert.match(
      src,
      /function artifactActionErrorMessage\(error: unknown\): string \{[\s\S]*redactSecrets\(error instanceof Error \? error\.message : String\(error \?\? ''\)\)\.trim\(\)/,
      'artifact action failures must redact raw IPC/file-system errors before toast detail',
    );
    assert.match(
      src,
      /generalizedErrorMessageChinese\(new Error\(raw\), ''\)/,
      'artifact action failures must classify raw English errors into Chinese copy',
    );
    assert.match(
      src,
      /\/\[\\u4e00-\\u9fff\]\/\.test\(raw\) \? raw : '生成文件操作失败，请稍后重试。'/,
      'artifact action failures may preserve already-Chinese diagnostics but must not echo unknown English',
    );
    assert.doesNotMatch(
      src,
      /if \(error instanceof Error && error\.message\.trim\(\)\) return error\.message\.trim\(\)/,
      'artifact action failure helper must not directly echo raw Error.message',
    );
    assert.match(openBlock, /catch \(error\) \{[\s\S]*toast\.error\('无法在 Finder 中打开生成文件', artifactActionErrorMessage\(error\)\)/);
    assert.match(copyBlock, /catch \(error\) \{[\s\S]*toast\.error\('复制失败', artifactActionErrorMessage\(error\)\)/);
    assert.match(saveBlock, /catch \(error\) \{[\s\S]*toast\.error\('另存失败', artifactActionErrorMessage\(error\)\)/);
    assert.match(deleteBlock, /catch \(error\) \{[\s\S]*toast\.error\(`删除 \$\{name\} 失败`, artifactActionErrorMessage\(error\)\)/);
  });

  it('gates artifact toolbar actions while async work is pending', async () => {
    const src = await readFile(ARTIFACT_PANE_SOURCE, 'utf8');
    const css = await readFile(join(process.cwd(), 'src', 'renderer', 'styles.css'), 'utf8');
    const gateBlock = src.match(/async function runArtifactAction[\s\S]*?async function openInFinder/)?.[0] ?? '';
    const toolbarBlock = src.match(/<div className="maka-artifact-toolbar"[\s\S]*?\n            <\/div>/)?.[0] ?? '';

    assert.match(src, /const \[pendingArtifactAction, setPendingArtifactAction\] = useState<string \| null>\(null\)/);
    assert.match(src, /const pendingArtifactActionRef = useRef<string \| null>\(null\)/);
    assert.match(src, /const artifactActionBusy = pendingArtifactAction !== null/);
    assert.match(
      gateBlock,
      /if \(pendingArtifactActionRef\.current !== null\) return;[\s\S]*pendingArtifactActionRef\.current = actionKey[\s\S]*setPendingArtifactAction\(actionKey\)[\s\S]*await action\(\)[\s\S]*pendingArtifactActionRef\.current = null[\s\S]*setPendingArtifactAction\(null\)/,
      'Artifact actions must use a ref-backed pending gate so same-frame double clicks cannot run two IPC calls',
    );
    assert.match(
      src,
      /onShowInFolder=\{\(\) => void runArtifactAction\(`\$\{selected\.id\}:open`, \(\) => openInFinder\(selected\.id\)\)\}/,
      'Unsupported-preview Finder action must share the same pending gate as the toolbar button',
    );
    for (const action of ['open', 'save', 'copy', 'delete']) {
      assert.ok(
        toolbarBlock.includes(`runArtifactAction(\`\${selected.id}:${action}\``),
        `${action} action must run through the pending gate`,
      );
    }
    assert.match(toolbarBlock, /disabled=\{artifactActionBusy\}/, 'toolbar buttons must be disabled while any artifact action is pending');
    assert.match(toolbarBlock, /aria-busy=\{pendingArtifactAction === `\$\{selected\.id\}:open` \? 'true' : undefined\}/);
    assert.match(toolbarBlock, /打开中…/);
    assert.match(toolbarBlock, /另存中…/);
    assert.match(toolbarBlock, /复制中…/);
    assert.match(toolbarBlock, /删除中…/);
    assert.match(css, /\.maka-artifact-toolbar-button:disabled \{[\s\S]*cursor: default;[\s\S]*opacity: 0\.56;[\s\S]*\}/);
    assert.match(css, /\.maka-artifact-toolbar-button\[data-pending="true"\] \{[\s\S]*opacity: 0\.78;[\s\S]*\}/);
  });
});
