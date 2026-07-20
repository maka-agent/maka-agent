import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, test } from 'node:test';

const REPO_ROOT = resolveRepoRoot();

async function readRepo(path: string): Promise<string> {
  return readFile(join(REPO_ROOT, path), 'utf8');
}

function resolveRepoRoot(): string {
  const cwd = resolve(process.cwd());
  if (existsSync(join(cwd, 'packages', 'runtime', 'src', 'ai-sdk-backend.ts'))) return cwd;
  const fromWorkspace = resolve(cwd, '..', '..');
  if (existsSync(join(fromWorkspace, 'packages', 'runtime', 'src', 'ai-sdk-backend.ts')))
    return fromWorkspace;
  return cwd;
}

describe('AiSdkCompaction extraction contract', () => {
  test('AiSdkBackend delegates compaction orchestration to AiSdkCompaction', async () => {
    const backend = await readRepo('packages/runtime/src/ai-sdk-backend.ts');

    assert.match(backend, /from '\.\/ai-sdk-compaction\.js'/);
    assert.match(backend, /private readonly compaction: AiSdkCompaction;/);

    // Public delegate plus the per-turn seams send() still drives through the collaborator.
    assert.match(backend, /this\.compaction\.compactHistory\(/);
    assert.match(backend, /this\.compaction\.abortHistoryCompact\(/);
    assert.match(backend, /this\.compaction\.prepareContextBudgetPolicy\(/);
    assert.match(backend, /this\.compaction\.buildSemanticCompactPrepareStep\(/);
    assert.match(backend, /this\.compaction\.buildActiveFullCompactPrepareStep\(/);
    assert.match(backend, /this\.compaction\.buildActiveToolResultPrunePrepareStep\(/);
    assert.match(backend, /this\.compaction\.buildMidTurnCapacityCompactState\(/);
    assert.match(backend, /this\.compaction\.buildMidTurnCapacityCompactPrepareStep\(/);
    assert.match(backend, /this\.compaction\.buildMidTurnFinalRequestVerdict\(/);
    assert.match(backend, /this\.compaction\.recoverFromOverflowError\(/);

    // The replay/tail host seam stays on AiSdkBackend and is injected as callbacks.
    assert.match(
      backend,
      /materializeRuntimeReplayPlan:\s*\(plan\)\s*=>\s*this\.materializeRuntimeReplayPlan\(plan\)/,
    );
    assert.match(
      backend,
      /canReplayProviderNative:\s*\(plan\)\s*=>\s*this\.canReplayProviderNative\(plan\)/,
    );
    assert.match(backend, /appendTurnTailPrompt:\s*\(content, turnTailPrompt\)\s*=>/);

    // The moved orchestration must no longer live on AiSdkBackend.
    assert.doesNotMatch(backend, /private async prepareContextBudgetPolicy/);
    assert.doesNotMatch(backend, /private buildActiveToolResultPrunePrepareStep/);
    assert.doesNotMatch(backend, /private buildSemanticCompactPrepareStep/);
    assert.doesNotMatch(backend, /private buildActiveFullCompactPrepareStep/);
    assert.doesNotMatch(backend, /private recordSemanticCompactSummaryCall/);
    assert.doesNotMatch(backend, /private recordSemanticCompactBlock/);
    assert.doesNotMatch(backend, /private recordActiveFullCompactBlock/);
    assert.doesNotMatch(backend, /private buildMidTurnCapacityCompactState/);
    assert.doesNotMatch(backend, /private buildMidTurnCapacityCompactPrepareStep/);
    assert.doesNotMatch(backend, /private async computeMidTurnCompactionReplacement/);
    assert.doesNotMatch(backend, /private async recoverFromOverflowError/);
    assert.doesNotMatch(backend, /private buildMidTurnFinalRequestVerdict/);
    assert.doesNotMatch(backend, /private async compactHistory/);
    assert.doesNotMatch(backend, /private async loadHistoryCompactBlocks/);
    assert.doesNotMatch(backend, /private async loadSynthesisCacheBlocks/);

    // The moved module-level helpers must no longer be defined in AiSdkBackend.
    assert.doesNotMatch(backend, /function sha256\(text: string\): string \{/);
    assert.doesNotMatch(backend, /function modelMessageSignature\(/);
    assert.doesNotMatch(backend, /function projectionSourceMessageSignature\(/);
    assert.doesNotMatch(backend, /function stableStringifyForSignature\(/);
    assert.doesNotMatch(backend, /function composeActiveCompactionPrepareStep\(/);
    assert.doesNotMatch(backend, /function activeToolResultArchiveKey\(/);
    assert.doesNotMatch(backend, /function collectPrunablePrepareStepToolCallIds\(/);
    assert.doesNotMatch(backend, /function projectAcceptedActiveFullCompactMessages\(/);
    assert.doesNotMatch(backend, /function hasActiveToolResultPruneDiagnosticPatch\(/);
    assert.doesNotMatch(backend, /function hasBlockingReplayDiagnostics\(/);
    assert.doesNotMatch(backend, /class MidTurnCapacityCompactState \{/);
    assert.doesNotMatch(backend, /function midTurnRequestPayloadChars\(/);
    assert.doesNotMatch(backend, /function buildMidTurnReplacedDiagnosticPatch\(/);
    assert.doesNotMatch(backend, /function waitForQueueProgressOrAbort\(/);
  });

  test('AiSdkCompaction owns the compaction orchestrator and never value-imports AiSdkBackend', async () => {
    const compaction = await readRepo('packages/runtime/src/ai-sdk-compaction.ts');

    assert.match(compaction, /export class AiSdkCompaction/);
    assert.match(compaction, /export interface AiSdkCompactionDeps/);

    // The host seam is injected as callbacks, not re-implemented on the collaborator.
    assert.match(compaction, /materializeRuntimeReplayPlan:/);
    assert.match(compaction, /canReplayProviderNative:/);
    assert.match(compaction, /appendTurnTailPrompt:/);
    assert.match(compaction, /modelAdapter: ModelAdapter;/);
    assert.match(compaction, /computeCostUsd:/);

    // The orchestrator owns the moved families.
    assert.match(compaction, /public async compactHistory/);
    assert.match(compaction, /public async prepareContextBudgetPolicy/);
    assert.match(compaction, /public buildSemanticCompactPrepareStep/);
    assert.match(compaction, /public buildActiveFullCompactPrepareStep/);
    assert.match(compaction, /public buildActiveToolResultPrunePrepareStep/);
    assert.match(compaction, /public buildMidTurnCapacityCompactState/);
    assert.match(compaction, /public buildMidTurnCapacityCompactPrepareStep/);
    assert.match(compaction, /public async computeMidTurnCompactionReplacement/);
    assert.match(compaction, /public async recoverFromOverflowError/);
    assert.match(compaction, /public buildMidTurnFinalRequestVerdict/);
    assert.match(compaction, /export class MidTurnCapacityCompactState/);
    assert.match(compaction, /export function composeActiveCompactionPrepareStep/);
    assert.match(compaction, /export function hasBlockingReplayDiagnostics/);

    // The collaborator may depend on AiSdkBackend's input type only (erased at
    // runtime); a value import would re-couple the adaptation loop to the orchestrator.
    assert.match(compaction, /import type \{ AiSdkBackendInput \} from '\.\/ai-sdk-backend\.js';/);
    assert.doesNotMatch(compaction, /import \{[^}]*\} from '\.\/ai-sdk-backend\.js'/);
  });
});
