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
});
