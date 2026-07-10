import { strict as assert } from 'node:assert';
import { it } from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

it('renders live thinking and text from timeline items instead of a trailing live content path', async () => {
  const source = await readFile(
    resolve(import.meta.dirname, '../../../../../packages/ui/src/chat-view.tsx'),
    'utf8',
  );

  assert.match(
    source,
    /item\.kind === 'thinking'[\s\S]*?<DeepThinking[\s\S]*?live=\{item\.live === true\}/,
  );
  assert.match(
    source,
    /item\.kind === 'text' && item\.live[\s\S]*?<StreamingAssistantBubble/,
  );
  assert.doesNotMatch(
    source,
    /turn\.timeline\.map[\s\S]*?props\.liveStreaming[\s\S]*?<LiveStreamingEntries/,
  );
  assert.match(
    source,
    /const settledTurns = useMemo\([\s\S]*?materializeTurns\(visibleMessages\)[\s\S]*?\[visibleMessages\][\s\S]*?const turns = useMemo\([\s\S]*?overlayLiveTurn\(settledTurns, props\.liveTurn\)/,
  );
  assert.doesNotMatch(source, /materializeTurns\(visibleMessages, props\.liveTurn\)/);

  const shell = await readFile(
    resolve(import.meta.dirname, '../../../../../apps/desktop/src/renderer/app-shell.tsx'),
    'utf8',
  );
  assert.match(shell, /const activeLiveTurn = activeId \? liveTurnBySession\[activeId\] : undefined;/);
  assert.match(shell, /<ChatView[\s\S]*?liveTurn=\{activeLiveTurn\}/);
});
