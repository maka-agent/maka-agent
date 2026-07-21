import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readRendererShellSources } from './renderer-shell-source-helpers.js';
import { readMainProcessCombinedSource } from './main-process-contract-source-helpers.js';

describe('new-chat Plan Mode contract', () => {
  it('keeps the Plan switch available before a session exists', async () => {
    const source = await readRendererShellSources(['app-shell.tsx']);

    assert.match(source, /const \[newChatPlanModeActive, setNewChatPlanModeActive\] = useState\(false\);/);
    assert.match(source, /if \(!sessionId\) \{\s*setNewChatPlanModeActive\(active\);\s*return;\s*\}/);
    assert.match(source, /onPlanModeChange=\{setPlanMode\}/);
    assert.doesNotMatch(source, /onPlanModeChange=\{activeId \? setPlanMode : undefined\}/);
  });

  it('carries the selected collaboration mode into first-message session creation', async () => {
    const renderer = await readRendererShellSources(['app-shell.tsx', 'app-shell-chat-actions.ts']);
    const main = await readMainProcessCombinedSource();

    assert.match(renderer, /newChatCollaborationMode: newChatPlanModeActive \? 'plan' : 'agent'/);
    assert.match(renderer, /collaborationMode: newChatCollaborationMode/);
    assert.match(main, /const collaborationMode = input\?\.collaborationMode \?\? 'agent';/);
    assert.ok(
      (main.match(/\s+collaborationMode,\s/g) ?? []).length >= 2,
      'both fake and ai-sdk session creation must persist the selected collaboration mode',
    );
  });
});
