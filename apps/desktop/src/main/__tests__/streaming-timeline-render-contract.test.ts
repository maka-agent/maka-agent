import { strict as assert } from 'node:assert';
import { it } from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

it('renders live thinking and text from timeline items instead of a trailing live content path', async () => {
  const source = await readFile(
    resolve(import.meta.dirname, '../../../../../packages/ui/src/chat-turn.tsx'),
    'utf8',
  );

  const chatView = await readFile(
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
    chatView,
    /const settledTurns = useMemo\([\s\S]*?materializeTurns\(visibleMessages\)[\s\S]*?\[visibleMessages\][\s\S]*?const liveTurns = useMemo\([\s\S]*?overlayLiveTurn\(settledTurns, props\.liveTurn\)[\s\S]*?const turns = useMemo\([\s\S]*?overlayShellRunUpdates\(liveTurns, props\.shellRunUpdates \?\? \[\]\)/,
  );
  assert.doesNotMatch(chatView, /materializeTurns\(visibleMessages, props\.liveTurn\)/);

  const shell = await readFile(
    resolve(import.meta.dirname, '../../../../../apps/desktop/src/renderer/app-shell.tsx'),
    'utf8',
  );
  assert.match(shell, /const activeLiveTurn = activeId \? liveTurnBySession\[activeId\] : undefined;/);
  assert.match(shell, /<ChatView[\s\S]*?liveTurn=\{activeLiveTurn\}/);
});

it('keeps persisted turn materialization stable while live text grows', async () => {
  const source = await readFile(
    resolve(import.meta.dirname, '../../../../../packages/ui/src/chat-view.tsx'),
    'utf8',
  );

  assert.match(
    source,
    /const drainingMessageIdsKey = JSON\.stringify\([\s\S]*?step\.text \? \[step\.stepId\] : \[\][\s\S]*?const drainingMessageIds = useMemo\([\s\S]*?JSON\.parse\(drainingMessageIdsKey\)[\s\S]*?\[drainingMessageIdsKey\]/,
    'the persisted-message exclusion set must depend on live text ownership, not the changing liveTurn object',
  );
  assert.doesNotMatch(
    source,
    /const drainingMessageIds = useMemo\([\s\S]*?\[props\.liveTurn\]/,
    'a text delta must not invalidate every settled TurnView through full rematerialization',
  );
});
