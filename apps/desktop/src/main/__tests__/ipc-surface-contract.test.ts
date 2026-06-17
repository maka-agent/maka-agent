import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const repoRoot = process.cwd().endsWith('apps/desktop')
  ? join(process.cwd(), '..', '..')
  : process.cwd();

async function readRepo(path: string): Promise<string> {
  return readFile(join(repoRoot, path), 'utf8');
}

function extractChannels(source: string, pattern: RegExp): string[] {
  return [...source.matchAll(pattern)].map((match) => match[1]).sort();
}

describe('IPC surface contract', () => {
  it('keeps main handlers paired with preload invocations', async () => {
    const [main, preload] = await Promise.all([
      readRepo('apps/desktop/src/main/main.ts'),
      readRepo('apps/desktop/src/preload/preload.ts'),
    ]);
    const mainChannels = extractChannels(main, /ipcMain\.handle\(\s*['"]([^'"]+)['"]/g);
    const preloadChannels = extractChannels(preload, /ipcRenderer\.invoke\(\s*['"]([^'"]+)['"]/g);
    const mainSet = new Set(mainChannels);
    const preloadSet = new Set(preloadChannels);
    const missingMainHandlers = preloadChannels.filter((channel) => !mainSet.has(channel));
    const staleMainHandlers = mainChannels.filter((channel) => !preloadSet.has(channel));

    assert.deepEqual(missingMainHandlers, [], 'every preload invoke channel must have a main handler');
    assert.deepEqual(staleMainHandlers, [], 'main process must not expose stale invoke handlers outside the preload bridge');
  });

  it('exposes memory lifecycle IPC without renderer-forged metadata', async () => {
    const [main, preload] = await Promise.all([
      readRepo('apps/desktop/src/main/main.ts'),
      readRepo('apps/desktop/src/preload/preload.ts'),
    ]);
    for (const channel of [
      'memory:listProposals',
      'memory:propose',
      'memory:remember',
      'memory:approveProposal',
      'memory:rejectProposal',
      'memory:archiveEntry',
      'memory:restoreEntry',
    ]) {
      assert.match(main, new RegExp(`ipcMain\\.handle\\('${channel}'`));
      assert.match(preload, new RegExp(`ipcRenderer\\.invoke\\('${channel}'`));
    }

    const normalizeBlock = main.match(/function normalizeMemoryTextInput[\s\S]*?\n}\n\nasync function buildSystemPrompt/)?.[0] ?? '';
    assert.match(normalizeBlock, /title/);
    assert.match(normalizeBlock, /content/);
    assert.match(normalizeBlock, /scope/);
    assert.doesNotMatch(normalizeBlock, /confirmedAt|status|sourceTurnId|source:/);
  });

  it('wires memory to main-owned privacy state and current-turn update tail', async () => {
    const main = await readRepo('apps/desktop/src/main/main.ts');

    assert.match(main, /async function getWorkspacePrivacyContext\(\)/);
    assert.match(main, /settings\.privacy\.incognitoActive === true/);
    assert.match(main, /new LocalMemoryService\([\s\S]*getPrivacyContext: getWorkspacePrivacyContext/);
    assert.doesNotMatch(main, /defaultWorkspacePrivacyContext/);

    assert.match(main, /const memoryPromptSnapshot = await buildLocalMemoryPromptFragment\(\)/);
    assert.match(main, /buildSystemPrompt\(ctx\.header, cwd, \{ memoryFragment: memoryPromptSnapshot \}\)/);
    assert.match(main, /consumePendingPromptUpdates\(\)/);
    assert.match(main, /<memory-update>/);
  });
});
