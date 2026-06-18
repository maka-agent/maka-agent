import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');

describe('subagent UI contract', () => {
  it('renders agent_spawn as a dedicated subagent card instead of raw JSON', async () => {
    const [events, tools, components, styles] = await Promise.all([
      readFile(join(REPO_ROOT, 'packages/core/src/events.ts'), 'utf8'),
      readFile(join(REPO_ROOT, 'packages/runtime/src/subagent-tools.ts'), 'utf8'),
      readFile(join(REPO_ROOT, 'packages/ui/src/components.tsx'), 'utf8'),
      readFile(join(REPO_ROOT, 'apps/desktop/src/renderer/styles.css'), 'utf8'),
    ]);

    assert.match(events, /kind: 'subagent'/);
    assert.match(events, /permissionMode: 'explore'/);
    assert.match(events, /artifactIds: readonly string\[\]/);
    assert.match(tools, /kind: 'subagent'/);
    assert.match(components, /content\.kind === 'subagent'/);
    assert.match(components, /function SubagentPreview/);
    assert.match(styles, /\.maka-subagent-preview/);

    const previewBlock = components.match(/function SubagentPreview[\s\S]*?function ExploreAgentPreview/)?.[0] ?? '';
    assert.match(previewBlock, /data-kind="subagent"/);
    assert.match(previewBlock, /result\.agentName/);
    assert.match(previewBlock, /result\.status/);
    assert.match(previewBlock, /result\.permissionMode/);
    assert.match(previewBlock, /formatDuration\(result\.durationMs\)/);
    assert.match(previewBlock, /result\.summary/);
    assert.match(previewBlock, /result\.artifactIds/);
  });
});
