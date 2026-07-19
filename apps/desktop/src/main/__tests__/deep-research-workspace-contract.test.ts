import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

describe('Deep Research durable workspace wiring', () => {
  it('gates Maka-owned research tools to labeled root sessions', async () => {
    const main = await readFile(
      fileURLToPath(new URL('../../../src/main/main.ts', import.meta.url)),
      'utf8',
    );
    const builtinTools = main.match(
      /const builtinTools: MakaTool\[\] = \[[\s\S]*?\n\];/,
    )?.[0] ?? '';
    const candidateTools = main.match(
      /const candidateTools = isComputerUseRealModelE2e[\s\S]*?const candidateToolAvailability/,
    )?.[0] ?? '';
    const preload = await readFile(
      fileURLToPath(new URL('../../../src/preload/preload.ts', import.meta.url)),
      'utf8',
    );

    assert.match(main, /const deepResearchStore = createDeepResearchStore\(workspaceRoot\)/);
    assert.match(main, /const deepResearchTools = buildDeepResearchTools\(\{/);
    assert.match(main, /onArtifactCreated: \(event\) => safeSendToRenderer\('artifacts:changed', event\)/);
    assert.match(
      main,
      /deepResearchStore\.subscribe\(\(event\) => safeSendToRenderer\('deepResearch:changed', event\)\)/,
    );
    assert.match(main, /ipcMain\.handle\('deepResearch:get'/);
    assert.match(preload, /deepResearch:\s*\{[\s\S]*ipcRenderer\.invoke\('deepResearch:get'/);
    assert.match(preload, /ipcRenderer\.on\('deepResearch:changed'/);
    assert.doesNotMatch(
      builtinTools,
      /deepResearchTools/,
      'ordinary root sessions must not advertise Deep Research workspace tools',
    );
    assert.match(
      candidateTools,
      /ctx\.tools\s*\?\s*\[\.\.\.ctx\.tools\][\s\S]*isDeepResearchSession\(ctx\.header\.labels\) \? deepResearchTools : \[\]/,
      'child tool scopes must win before the root-only Deep Research label gate',
    );
  });
});
