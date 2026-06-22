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
  if (existsSync(join(fromWorkspace, 'packages', 'runtime', 'src', 'ai-sdk-backend.ts'))) return fromWorkspace;
  return cwd;
}

describe('ToolRuntime extraction contract', () => {
  test('AiSdkBackend keeps only the ai-sdk loop and delegates tool execution internally', async () => {
    const backend = await readRepo('packages/runtime/src/ai-sdk-backend.ts');

    assert.match(backend, /from '\.\/tool-runtime\.js'/);
    assert.match(backend, /private readonly toolRuntime: ToolRuntime;/);
    assert.match(
      backend,
      /private wrapToolExecute\([\s\S]*?\)\s*\{\s*return this\.toolRuntime\.wrapToolExecute\(tool, turnId, queue\);\s*\}/,
      'AiSdkBackend.wrapToolExecute must be a narrow compatibility shim',
    );
    assert.match(
      backend,
      /cleanupAfterTurn\(turnId: string\): void \{[\s\S]*?this\.toolRuntime\.resetTurnState\(\);[\s\S]*?\}/,
      'turn cleanup must reset ToolRuntime-owned per-turn state',
    );

    assert.doesNotMatch(backend, /private async writeSyntheticToolResult/);
    assert.doesNotMatch(backend, /private coerceResultContent/);
    assert.doesNotMatch(backend, /private coerceTerminalFailure/);
    assert.doesNotMatch(backend, /private async awaitPermissionDecision/);
    assert.doesNotMatch(backend, /private activeSubagentToolCount/);
    assert.doesNotMatch(backend, /private reserveSubagentSlot/);
    assert.doesNotMatch(backend, /private releaseSubagentSlot/);
  });

  test('ToolRuntime owns permission, watchdog pause, telemetry, artifacts, and result classification', async () => {
    const runtime = await readRepo('packages/runtime/src/tool-runtime.ts');

    assert.match(runtime, /export class ToolRuntime/);
    assert.match(runtime, /wrapToolExecute\(/);
    assert.match(runtime, /permissionEngine\.evaluate/);
    assert.match(runtime, /getPermissionPauseTarget/);
    assert.match(runtime, /recordToolInvocation/);
    assert.match(runtime, /recordToolArtifactsSafely/);
    assert.match(runtime, /deriveToolResultStatus/);
    assert.match(runtime, /coerceTerminalFailure/);
    assert.match(runtime, /formatSyntheticToolErrorText/);
    assert.match(runtime, /activeSubagentToolCount/);
  });
});

describe('ModelAdapter extraction contract', () => {
  test('AiSdkBackend delegates provider model, stream, error, finish, and usage normalization', async () => {
    const backend = await readRepo('packages/runtime/src/ai-sdk-backend.ts');

    assert.match(backend, /from '\.\/model-adapter\.js'/);
    assert.match(backend, /private readonly modelAdapter: ModelAdapter;/);
    assert.match(backend, /this\.modelAdapter\.resolveModel\(\)/);
    assert.match(backend, /this\.modelAdapter\.startStream\(/);
    assert.match(backend, /this\.modelAdapter\.handleStreamChunk\(/);
    assert.match(backend, /normalizeAiSdkUsage\(await \(result\.totalUsage \?\? result\.usage\),[\s\S]*?rawFinishReason[\s\S]*?\)/);
    assert.match(backend, /this\.modelAdapter\.classifyError\(/);
    assert.match(
      backend,
      /private mapFinishReason\(reason: unknown\): CompleteEvent\['stopReason'\] \{\s*return this\.modelAdapter\.mapFinishReason\(reason\);\s*\}/,
      'AiSdkBackend.mapFinishReason must remain a compatibility shim',
    );
    assert.match(
      backend,
      /private makeErrorEvent\(turnId: string, err: unknown\): ErrorEvent \{\s*return this\.modelAdapter\.makeErrorEvent\(turnId, err\);\s*\}/,
      'AiSdkBackend.makeErrorEvent must remain a compatibility shim',
    );

    assert.doesNotMatch(backend, /await import\('ai'\)/);
    assert.doesNotMatch(backend, /const \{ streamText, stepCountIs \}/);
    assert.doesNotMatch(backend, /switch \(chunk\.type\)/);
    assert.doesNotMatch(backend, /case 'reasoning-delta'/);
    assert.doesNotMatch(backend, /function finiteToken/);
  });

  test('ModelAdapter owns provider stream, error, finish, and usage normalization', async () => {
    const adapter = await readRepo('packages/runtime/src/model-adapter.ts');

    assert.match(adapter, /export class ModelAdapter/);
    assert.match(adapter, /resolveModel\(\)/);
    assert.match(adapter, /startStream\(/);
    assert.match(adapter, /await import\('ai'\)/);
    assert.match(adapter, /streamText\(/);
    assert.match(adapter, /stepCountIs\(this\.input\.maxSteps\)/);
    assert.match(adapter, /handleStreamChunk\(/);
    assert.match(adapter, /switch \(chunk\.type\)/);
    assert.match(adapter, /case 'reasoning-delta'/);
    assert.match(adapter, /makeErrorEvent\(/);
    assert.match(adapter, /mapFinishReason\(/);
    assert.match(adapter, /export function normalizeAiSdkUsage/);
    assert.match(adapter, /function finiteToken/);
  });
});

describe('RunTrace extraction contract', () => {
  test('AiSdkBackend owns turn/model/usage/abort tracing as an internal hook', async () => {
    const backend = await readRepo('packages/runtime/src/ai-sdk-backend.ts');
    const barrel = await readRepo('packages/runtime/src/index.ts');

    assert.match(backend, /from '\.\/run-trace\.js'/);
    assert.match(backend, /recordRunTrace\?: RunTraceRecorder/);
    assert.match(backend, /private currentRunTrace: RunTrace \| null = null;/);
    assert.match(backend, /trace\.turnStarted\(\)/);
    assert.match(backend, /trace\.modelResolved\(\)/);
    assert.match(backend, /trace\.modelStreamStarted\(activeTools, \{/);
    assert.match(backend, /trace\.usageRecorded\(\{\n\s+\.\.\.tokenUsage,/);
    assert.match(backend, /this\.currentRunTrace\?\.abortRequested\(_reason\)/);
    assert.match(barrel, /RunTraceEvent/);
    assert.match(barrel, /RunTraceRecorder/);
  });

  test('ToolRuntime traces permission and tool lifecycle without owning model tracing', async () => {
    const runtime = await readRepo('packages/runtime/src/tool-runtime.ts');

    assert.match(runtime, /getRunTrace\?: \(\) => RunTraceLike \| null/);
    assert.match(runtime, /'tool_started'/);
    assert.match(runtime, /'tool_completed'/);
    assert.match(runtime, /'tool_failed'/);
    assert.match(runtime, /'permission_requested'/);
    assert.match(runtime, /'permission_decided'/);
    assert.match(runtime, /'permission_failed'/);
    assert.doesNotMatch(runtime, /modelStreamStarted/);
    assert.doesNotMatch(runtime, /usageRecorded/);
  });

  test('RunTrace stays diagnostic-only and does not extend SessionEvent', async () => {
    const trace = await readRepo('packages/runtime/src/run-trace.ts');
    const events = await readRepo('packages/core/src/events.ts');
    const adapter = await readRepo('packages/runtime/src/model-adapter.ts');
    const preload = await readRepo('apps/desktop/src/preload/preload.ts');
    const main = await readRepo('apps/desktop/src/main/main.ts');
    const settings = await readRepo('apps/desktop/src/renderer/settings/SettingsModal.tsx');

    assert.match(trace, /export class RunTrace/);
    assert.match(trace, /export interface RunTraceEvent/);
    assert.match(trace, /type RunTracePhase = 'turn' \| 'model' \| 'tool' \| 'permission' \| 'abort' \| 'usage'/);
    assert.doesNotMatch(events, /RunTrace/);
    assert.doesNotMatch(events, /trace_/);
    assert.doesNotMatch(adapter, /RunTrace|recordRunTrace/);
    assert.doesNotMatch(preload, /RunTrace|recordRunTrace|runTrace|trace_/);
    assert.doesNotMatch(main, /ipcMain\.handle\([^)]*(?:RunTrace|recordRunTrace|runTrace|trace_)/);
    assert.doesNotMatch(settings, /RunTrace|recordRunTrace|runTrace|trace_/);
  });
});
