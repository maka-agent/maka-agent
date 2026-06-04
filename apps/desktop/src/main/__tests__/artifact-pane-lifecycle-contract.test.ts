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
    const refreshBlock = src.match(/const refresh = useCallback\(async \(\) => \{[\s\S]*?\}, \[sessionId\]\);/)?.[0] ?? '';
    const subscriptionEffect = src.match(/useEffect\(\(\) => \{[\s\S]*?window\.maka\.artifacts\.subscribeChanges[\s\S]*?\}, \[sessionId, refresh\]\);/)?.[0] ?? '';

    assert.match(
      src,
      /const artifactListRequestSeqRef = useRef\(0\)/,
      'ArtifactPane must keep a monotonic request sequence across renders',
    );
    assert.match(
      refreshBlock,
      /const requestSeq = \+\+artifactListRequestSeqRef\.current/,
      'each artifact list refresh must claim a fresh request sequence',
    );
    assert.match(
      refreshBlock,
      /const next = await window\.maka\.artifacts\.list\(sessionId\)[\s\S]*if \(requestSeq === artifactListRequestSeqRef\.current\) \{[\s\S]*setRecords\(next\)/,
      'artifact list responses may set records only if they are still the latest request',
    );
    assert.match(
      refreshBlock,
      /catch \{[\s\S]*if \(requestSeq === artifactListRequestSeqRef\.current\) \{[\s\S]*setRecords\(\[\]\)/,
      'latest artifact list failures must clear stale records instead of becoming unhandled rejections',
    );
    assert.match(
      subscriptionEffect,
      /return \(\) => \{[\s\S]*artifactListRequestSeqRef\.current \+= 1;[\s\S]*unsubscribe\(\);[\s\S]*\};/,
      'session-change cleanup must invalidate in-flight artifact list responses before unsubscribing',
    );
  });

  it('surfaces thrown artifact action failures instead of leaving toolbar clicks silent', async () => {
    const src = await readFile(ARTIFACT_PANE_SOURCE, 'utf8');
    const openBlock = src.match(/async function openInFinder[\s\S]*?async function copyText/)?.[0] ?? '';
    const copyBlock = src.match(/async function copyText[\s\S]*?async function saveAs/)?.[0] ?? '';
    const saveBlock = src.match(/async function saveAs[\s\S]*?async function deleteArtifact/)?.[0] ?? '';
    const deleteBlock = src.match(/async function deleteArtifact[\s\S]*?\n  \}\n\n  \/\/ ---- render/)?.[0] ?? '';

    assert.match(src, /function artifactActionErrorMessage\(error: unknown\)/);
    assert.match(openBlock, /catch \(error\) \{[\s\S]*toast\.error\('无法在 Finder 中打开生成文件', artifactActionErrorMessage\(error\)\)/);
    assert.match(copyBlock, /catch \(error\) \{[\s\S]*toast\.error\('复制失败', artifactActionErrorMessage\(error\)\)/);
    assert.match(saveBlock, /catch \(error\) \{[\s\S]*toast\.error\('另存失败', artifactActionErrorMessage\(error\)\)/);
    assert.match(deleteBlock, /catch \(error\) \{[\s\S]*toast\.error\(`删除 \$\{name\} 失败`, artifactActionErrorMessage\(error\)\)/);
  });
});
