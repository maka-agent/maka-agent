import { strict as assert } from 'node:assert';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createDefaultSettings, type LocalMemoryAgentReadResult } from '@maka/core';
import { createSystemPromptMainService } from '../system-prompt-main.js';

describe('system prompt memory gates', () => {
  it('passes session/workspace scope with the captured snapshot and rechecks privacy each render', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-system-prompt-memory-'));
    const reads: Array<{ workspaceRoot: string; sessionId: string; contentSnapshot?: string }> = [];
    let readResult: LocalMemoryAgentReadResult = {
      status: 'visible',
      promptBody: 'workspace-visible',
      trace: {
        schemaVersion: 'maka.local_memory.read_trace.v1',
        status: 'visible',
        totalActiveEntries: 1,
        selectedEntries: 1,
        decisions: [],
      },
    };
    const service = createSystemPromptMainService({
      settingsStore: { get: async () => createDefaultSettings() },
      workspaceRoot,
      localMemory: {
        captureAgentMemoryContent: async () => 'captured-at-backend-creation',
        readForAgent: async (input) => {
          reads.push(input);
          return readResult;
        },
        consumePendingPromptUpdates: () => [],
      },
      taskLedger: { list: async () => [] },
    });
    const header = { id: 'session-a', workspaceRoot, labels: [] };

    const visible = await service.buildBackendSystemPrompt(header, workspaceRoot, {
      memoryContentSnapshot: 'captured-at-backend-creation',
    });
    assert.match(visible ?? '', /workspace-visible/);
    assert.deepEqual(reads, [{
      workspaceRoot,
      sessionId: 'session-a',
      contentSnapshot: 'captured-at-backend-creation',
    }]);

    readResult = {
      status: 'empty',
      reason: 'incognito_active',
      trace: {
        schemaVersion: 'maka.local_memory.read_trace.v1',
        status: 'empty',
        reason: 'incognito_active',
        totalActiveEntries: 0,
        selectedEntries: 0,
        decisions: [],
      },
    };
    const hidden = await service.buildBackendSystemPrompt(header, workspaceRoot, {
      memoryContentSnapshot: 'captured-at-backend-creation',
    });
    assert.doesNotMatch(hidden ?? '', /captured-at-backend-creation|workspace-visible|<local-memory>/);

    const readCountBeforeChild = reads.length;
    const child = await service.buildBackendSystemPrompt(header, workspaceRoot, {
      memoryContentSnapshot: 'captured-at-backend-creation',
      childInstruction: 'Inspect the failing test.',
    });
    assert.equal(reads.length, readCountBeforeChild);
    assert.match(child ?? '', /Inspect the failing test/);
    assert.doesNotMatch(child ?? '', /captured-at-backend-creation|workspace-visible|<local-memory>/);
  });
});
