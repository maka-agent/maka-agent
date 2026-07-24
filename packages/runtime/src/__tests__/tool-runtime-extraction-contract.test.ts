import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, test } from 'node:test';

const REPO_ROOT = resolveRepoRoot();
const RENDERER_SETTINGS_DIR = 'apps/desktop/src/renderer/settings';

async function readRepo(path: string): Promise<string> {
  return readFile(join(REPO_ROOT, path), 'utf8');
}

async function readRendererSettingsSources(): Promise<string> {
  const entries = await readdir(join(REPO_ROOT, RENDERER_SETTINGS_DIR), { withFileTypes: true });
  const sourcePaths = entries
    .filter((entry) => entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name))
    .map((entry) => `${RENDERER_SETTINGS_DIR}/${entry.name}`)
    .sort();
  const sources = await Promise.all(sourcePaths.map((path) => readRepo(path)));
  return sources.join('\n');
}

function resolveRepoRoot(): string {
  const cwd = resolve(process.cwd());
  if (existsSync(join(cwd, 'packages', 'runtime', 'src', 'ai-sdk-backend.ts'))) return cwd;
  const fromWorkspace = resolve(cwd, '..', '..');
  if (existsSync(join(fromWorkspace, 'packages', 'runtime', 'src', 'ai-sdk-backend.ts')))
    return fromWorkspace;
  return cwd;
}

describe('ToolRuntime extraction contract', () => {
  test('AiSdkBackend keeps only the ai-sdk loop around direct ToolRuntime settlement', async () => {
    const backend = await readRepo('packages/runtime/src/ai-sdk-backend.ts');

    assert.match(backend, /from '\.\/tool-runtime\.js'/);
    assert.match(backend, /private readonly toolRuntime: ToolRuntime;/);
    assert.match(
      backend,
      /this\.toolRuntime\.settleToolCall\(\{/,
      'the SDK execute callback must call the direct ToolRuntime settlement operation',
    );
    assert.match(backend, /toModelOutput:[\s\S]*?\(output as ToolSettlement\)\.modelOutput/);
    assert.match(
      backend,
      /isPlanToolResult\(settlement\.result\)[\s\S]*?handlePlanToolResult\(settlement\.result/,
      'plan handoff remains a backend-owned post-settlement loop decision',
    );
    assert.doesNotMatch(backend, /wrapToolExecute/);
    assert.doesNotMatch(backend, /providerToolError/);
    assert.doesNotMatch(backend, /currentStepToolExecutions/);
    assert.match(backend, /!this\.toolRuntime\.hasStepAdmission\(this\.currentStepMessageId\)/);
    assert.match(
      backend,
      /this\.toolRuntime\.beginTurn\(turnId\);/,
      'turn start must establish ToolRuntime-owned per-turn state',
    );
    assert.match(
      backend,
      /cleanupAfterTurn\(turnId: string\): void \{[\s\S]*?this\.toolRuntime\.endTurn\(turnId,[\s\S]*?\);[\s\S]*?\}/,
      'turn cleanup must settle and reset ToolRuntime-owned per-turn state',
    );

    assert.doesNotMatch(backend, /private (?:async )?writeSyntheticToolResult/);
    assert.doesNotMatch(backend, /private coerceResultContent/);
    assert.doesNotMatch(backend, /private coerceTerminalFailure/);
    assert.doesNotMatch(backend, /private async awaitPermissionDecision/);
    assert.doesNotMatch(backend, /private activeSubagentToolCount/);
    assert.doesNotMatch(backend, /private reserveSubagentSlot/);
    assert.doesNotMatch(backend, /private releaseSubagentSlot/);
  });

  test('ToolRuntime owns permission, watchdog pause, telemetry, artifacts, and result classification', async () => {
    const runtime = await readRepo('packages/runtime/src/tool-runtime.ts');
    const toolOutput = await readRepo('packages/runtime/src/tool-result-output.ts');

    assert.match(runtime, /export class ToolRuntime/);
    assert.match(runtime, /settleToolCall\(/);
    assert.match(runtime, /hasStepAdmission\(/);
    assert.doesNotMatch(runtime, /wrapToolExecute\(/);
    assert.doesNotMatch(runtime, /ToolModelOutput/);
    assert.match(toolOutput, /ToolResultOutput/);
    assert.doesNotMatch(toolOutput, /AiSdkToolResultOutput/);
    assert.match(runtime, /permissionEngine\.evaluate/);
    assert.match(runtime, /getPermissionPauseTarget/);
    assert.match(runtime, /recordToolInvocation/);
    assert.match(runtime, /recordToolArtifactsSafely/);
    assert.match(runtime, /deriveToolResultStatus/);
    assert.match(runtime, /coerceTerminalFailure/);
    assert.match(runtime, /formatSyntheticToolErrorText/);
    assert.match(runtime, /providerToolErrorMessage/);
    assert.match(runtime, /materializeDefaultToolResultOutput/);
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
    // #1381 slice 1: the backend consumes the Maka-owned event stream and
    // never parses raw SDK chunk names, calls normalizeAiSdkUsage, or reads
    // result.stream. It iterates result.events and switches on event.kind.
    assert.match(backend, /for await \(const event of result\.events\)/);
    assert.match(backend, /event\.kind/);
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
    assert.doesNotMatch(backend, /const \{ streamText, isStepCount \}/);
    assert.doesNotMatch(backend, /this\.modelAdapter\.handleStreamChunk\(/);
    assert.doesNotMatch(backend, /switch \(chunk\.type\)/);
    assert.doesNotMatch(backend, /case 'reasoning-delta'/);
    assert.doesNotMatch(backend, /normalizeAiSdkUsage\(await result\.usage/);
    assert.doesNotMatch(backend, /result\.stream/);
    assert.doesNotMatch(backend, /function finiteToken/);
  });

  test('ModelAdapter owns provider stream, error, finish, and usage normalization', async () => {
    const adapter = await readRepo('packages/runtime/src/model-adapter.ts');

    assert.match(adapter, /export class ModelAdapter/);
    assert.match(adapter, /resolveModel\(\)/);
    assert.match(adapter, /startStream\(/);
    assert.match(adapter, /await import\('ai'\)/);
    assert.match(adapter, /streamText\(/);
    // The step budget stays adapter-owned, with a per-call override so the
    // backend's reactive overflow retry passes only the remaining budget.
    assert.match(adapter, /input\.maxSteps \?\? this\.input\.maxSteps/);
    assert.match(adapter, /isStepCount\(maxSteps\)/);
    // #1381 slice 1: raw SDK chunk interpretation is adapter-internal via
    // translateChunk, which emits the Maka-owned ModelStreamEvent. The retired
    // handleStreamChunk/callbacks boundary is gone.
    assert.match(adapter, /translateChunk\(/);
    assert.match(adapter, /switch \(chunk\.type\)/);
    assert.match(adapter, /case 'reasoning-delta'/);
    assert.match(adapter, /normalizeModelFailure\(/);
    assert.match(adapter, /include: \{ requestMessages: true \}/);
    assert.match(adapter, /makeErrorEvent\(/);
    assert.match(adapter, /mapFinishReason\(/);
    assert.match(adapter, /export function normalizeAiSdkUsage/);
    assert.match(adapter, /function finiteToken/);
  });
});

describe('Provider error classification extraction contract', () => {
  test('ToolRuntime and ModelAdapter depend on a dedicated classification leaf', async () => {
    const classifier = await readRepo('packages/runtime/src/provider-error-classification.ts');
    const runtime = await readRepo('packages/runtime/src/tool-runtime.ts');
    const adapter = await readRepo('packages/runtime/src/model-adapter.ts');

    assert.match(classifier, /export function isContextOverflowErrorText/);
    assert.match(classifier, /export function classifyError/);
    assert.match(classifier, /export function errorPresentationFromClass/);
    assert.match(classifier, /interface ProviderErrorEvidence/);
    assert.match(classifier, /CONTEXT_OVERFLOW_PROVIDER_CODES/);
    assert.match(classifier, /CONTEXT_OVERFLOW_PATTERNS/);
    assert.match(classifier, /NON_CONTEXT_OVERFLOW_PATTERNS/);
    assert.doesNotMatch(classifier, /from '\.\/(?:tool-runtime|model-adapter)\.js'/);

    assert.match(
      runtime,
      /import \{ classifyError \} from '\.\/provider-error-classification\.js'/,
    );
    assert.doesNotMatch(runtime, /interface ProviderErrorEvidence/);
    assert.doesNotMatch(runtime, /CONTEXT_OVERFLOW_PROVIDER_CODES/);
    assert.doesNotMatch(runtime, /export function isContextOverflowErrorText/);
    assert.doesNotMatch(runtime, /export function classifyError/);
    assert.doesNotMatch(runtime, /export function errorPresentationFromClass/);

    assert.match(adapter, /from '\.\/provider-error-classification\.js'/);
    assert.doesNotMatch(adapter, /from '\.\/tool-runtime\.js'/);
  });
});

describe('RunTrace extraction contract', () => {
  test('AiSdkBackend owns turn/model/usage/abort tracing as an internal hook', async () => {
    const backend = await readRepo('packages/runtime/src/ai-sdk-backend.ts');
    const barrel = await readRepo('packages/runtime/src/index.ts');

    assert.match(backend, /from '\.\/run-trace\.js'/);
    assert.match(backend, /recordRunTrace\?: RunTraceRecorder/);
    assert.match(backend, /private currentRunTrace: RunTrace \| null = null;/);
    assert.match(backend, /trace\.turnStarted\(\{/);
    assert.match(backend, /orchestrationMode: this\.currentOrchestration\.mode/);
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
    const settings = await readRendererSettingsSources();

    assert.match(trace, /export class RunTrace/);
    assert.match(trace, /export interface RunTraceEvent/);
    assert.match(
      trace,
      // Whitespace-tolerant: the formatter may lay the union out on one line
      // or one variant per line; the contract is the variant set, not layout.
      /type RunTracePhase =\s*\|?\s*'turn'\s*\|\s*'model'\s*\|\s*'tool'\s*\|\s*'permission'\s*\|\s*'sandbox'\s*\|\s*'skill'\s*\|\s*'plan'\s*\|\s*'abort'\s*\|\s*'usage'/,
    );
    assert.doesNotMatch(events, /RunTrace/);
    assert.doesNotMatch(events, /trace_/);
    assert.doesNotMatch(adapter, /RunTrace|recordRunTrace/);
    assert.doesNotMatch(preload, /RunTrace|recordRunTrace|runTrace|trace_/);
    assert.doesNotMatch(main, /ipcMain\.handle\([^)]*(?:RunTrace|recordRunTrace|runTrace|trace_)/);
    assert.doesNotMatch(settings, /RunTrace|recordRunTrace|runTrace|trace_/);
  });
});
