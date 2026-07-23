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
    const toolAssembly = await readFile(
      fileURLToPath(new URL('../../../src/main/tool-assembly.ts', import.meta.url)),
      'utf8',
    );
    const sessionStream = await readFile(
      fileURLToPath(new URL('../../../src/main/session-stream.ts', import.meta.url)),
      'utf8',
    );
    const builtinTools = toolAssembly.match(
      /const builtinTools: MakaTool\[\] = \[[\s\S]*?\n\];/,
    )?.[0] ?? '';
    const candidateTools = sessionStream.match(
      /const candidateTools = ctx\.tools[\s\S]*?const candidateToolAvailability/,
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
      /ctx\.tools\s*\?\s*\[\.\.\.ctx\.tools\]\s*:\s*isComputerUseRealModelE2e[\s\S]*isDeepResearchSession\(ctx\.header\.labels\) \? deepResearchTools : \[\]/,
      'child tool scopes must win before computer-use and root-only Deep Research expansion',
    );
  });

  it('protects ledger-owned artifacts from generic deletion', async () => {
    const ipc = await readFile(
      fileURLToPath(new URL('../../../src/main/workspace-resources-ipc-main.ts', import.meta.url)),
      'utf8',
    );
    const pane = await readFile(
      fileURLToPath(new URL('../../../src/renderer/artifact-pane.tsx', import.meta.url)),
      'utf8',
    );

    assert.match(ipc, /artifact\?\.source === 'deep_research'/);
    assert.match(ipc, /protected by the durable research ledger/);
    assert.match(pane, /artifactActionBusy \|\| selected\.source === 'deep_research'/);
  });
});
