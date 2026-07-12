import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { BackendKind, SessionEvent, SessionHeader } from '@maka/core';
import type { BackendSendInput, PermissionDecision } from '@maka/core/backend-types';
import {
  BackendRegistry,
  PermissionEngine,
  PiAgentBackend,
  type AgentBackend,
  type BackendFactoryContext,
  type PiAgentTransport,
  type SessionStore,
  type ToolResultArchiveReader,
  type ToolResultArchiveRecorder,
} from '@maka/runtime';
import { createArtifactStore } from '@maka/storage';
import type { Config } from '../contracts.js';
import type { HeadlessBackendContext, IsolatedToolExecutor } from '../isolation.js';
import {
  buildAiSdkCellBackendRegistration,
  buildHarborCellContextBudgetBackendOptions,
  buildHarborCellContextBudgetPolicySnapshot,
  buildHarborCellAiSdkTools,
  buildHarborCellTaskLedgerExperimentPolicy,
  harborCellMaxStepsFromEnv,
  createHarborCellLocalToolExecutor,
  HARBOR_CELL_CONTEXT_ENV_KEYS,
  HARBOR_CELL_OUTPUT_FILENAME,
  HARBOR_CELL_RUNTIME_EVENTS_FILENAME,
  resolveHarborCellAiSdkEnv,
  runHarborCellFromEnv,
  runHarborCell,
} from '../harbor-cell.js';

const config: Config = {
  id: 'cell-cfg',
  backend: 'fake',
  llmConnectionSlug: 'fake',
  model: 'fake-model',
  systemPrompt: 'You are a benchmark cell agent.',
};

function registerTestPiAgentBackend(
  registry: BackendRegistry,
  transportFactory: (input: { header: SessionHeader; store: SessionStore }) => PiAgentTransport,
): void {
  registry.register('pi-agent', (ctx) =>
    new PiAgentBackend({
      sessionId: ctx.sessionId,
      header: ctx.header,
      appendMessage: ctx.appendMessage ?? ((message) => ctx.store.appendMessage(ctx.sessionId, message)),
      permissionEngine: new PermissionEngine({ newId: () => 'perm-id', now: () => 123 }),
      transport: transportFactory({ header: ctx.header, store: ctx.store }),
    }),
  );
}

class CellReportingBackend implements AgentBackend {
  readonly sessionId: string;

  constructor(
    private readonly ctx: { sessionId: string; header: SessionHeader; store: SessionStore },
    readonly kind: BackendKind = 'fake',
  ) {
    this.sessionId = ctx.sessionId;
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    const ts = Date.now();
    await writeFile(join(this.ctx.header.cwd, 'cell-proof.txt'), 'ran in place\n', 'utf8');
    yield {
      type: 'token_usage',
      id: 'cell-usage',
      turnId: input.turnId,
      ts,
      input: 11,
      output: 7,
      total: 18,
      costUsd: 0.0042,
      systemPromptHash: 'sha256:cell-prompt',
    };
    yield { type: 'text_complete', id: 'cell-text', messageId: 'cell-message', turnId: input.turnId, ts, text: 'cell complete' };
    yield { type: 'complete', id: 'cell-complete', turnId: input.turnId, ts, stopReason: 'end_turn' };
  }

  async stop(): Promise<void> {}
  async respondToPermission(_decision: PermissionDecision): Promise<void> {}
  async dispose(): Promise<void> {}
}

const registerCellBackend = (registry: BackendRegistry): void => {
  registry.register('fake', (ctx) =>
    new CellReportingBackend({ sessionId: ctx.sessionId, header: ctx.header, store: ctx.store }),
  );
};

class ThrowingBackend implements AgentBackend {
  readonly kind: BackendKind = 'fake';
  readonly sessionId: string;

  constructor(private readonly ctx: { sessionId: string }) {
    this.sessionId = ctx.sessionId;
  }

  async *send(_input: BackendSendInput): AsyncIterable<SessionEvent> {
    throw new Error('backend boom');
  }

  async stop(): Promise<void> {}
  async respondToPermission(_decision: PermissionDecision): Promise<void> {}
  async dispose(): Promise<void> {}
}

const registerThrowingBackend = (registry: BackendRegistry): void => {
  registry.register('fake', (ctx) => new ThrowingBackend({ sessionId: ctx.sessionId }));
};

class StepCapThenCompleteBackend implements AgentBackend {
  readonly kind: BackendKind = 'fake';
  readonly sessionId: string;
  readonly prompts: string[] = [];
  readonly cwds: string[] = [];

  constructor(protected readonly ctx: { sessionId: string; header: SessionHeader }) {
    this.sessionId = ctx.sessionId;
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    const ts = Date.now();
    this.prompts.push(input.text);
    this.cwds.push(this.ctx.header.cwd);
    if (this.prompts.length === 1) {
      yield {
        type: 'token_usage',
        id: 'usage-step-cap',
        turnId: input.turnId,
        ts,
        input: 10,
        output: 1,
        total: 11,
        costUsd: 0.01,
        rawFinishReason: 'tool-calls',
        runtimeSteps: 50,
      };
      yield { type: 'text_complete', id: 'text-step-cap', messageId: 'step-cap-message', turnId: input.turnId, ts, text: 'continue' };
      yield { type: 'complete', id: 'complete-step-cap', turnId: input.turnId, ts, stopReason: 'end_turn' };
      return;
    }
    await writeFile(join(this.ctx.header.cwd, 'continued-proof.txt'), input.text, 'utf8');
    yield {
      type: 'token_usage',
      id: 'usage-done',
      turnId: input.turnId,
      ts,
      input: 3,
      output: 2,
      total: 5,
      costUsd: 0.02,
      rawFinishReason: 'stop',
    };
    yield { type: 'text_complete', id: 'text-done', messageId: 'done-message', turnId: input.turnId, ts, text: 'done' };
    yield { type: 'complete', id: 'complete-done', turnId: input.turnId, ts, stopReason: 'end_turn' };
  }

  async stop(): Promise<void> {}
  async respondToPermission(_decision: PermissionDecision): Promise<void> {}
  async dispose(): Promise<void> {}
}

function registerStepCapThenCompleteBackend(seen: { backend?: StepCapThenCompleteBackend }) {
  return (registry: BackendRegistry): void => {
    registry.register('fake', (ctx) => {
      const backend = new StepCapThenCompleteBackend({ sessionId: ctx.sessionId, header: ctx.header });
      seen.backend = backend;
      return backend;
    });
  };
}

class StepCapThenThrowBackend extends StepCapThenCompleteBackend {
  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    if (this.prompts.length > 0) {
      this.prompts.push(input.text);
      this.cwds.push(this.ctx.header.cwd);
      throw new Error('continuation turn crashed');
    }
    yield* super.send(input);
  }
}

function registerStepCapThenThrowBackend(seen: { backend?: StepCapThenThrowBackend }) {
  return (registry: BackendRegistry): void => {
    registry.register('fake', (ctx) => {
      const backend = new StepCapThenThrowBackend({ sessionId: ctx.sessionId, header: ctx.header });
      seen.backend = backend;
      return backend;
    });
  };
}

class NoisyStepCapThenCompleteBackend extends StepCapThenCompleteBackend {
  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    const ts = Date.now();
    if (this.prompts.length > 0) {
      yield* super.send(input);
      return;
    }

    this.prompts.push(input.text);
    this.cwds.push(this.ctx.header.cwd);
    for (let index = 0; index < 60; index += 1) {
      yield {
        type: 'token_usage',
        id: `noise-${index}`,
        turnId: input.turnId,
        ts,
        input: 0,
        output: 0,
        total: 0,
      };
    }
    yield {
      type: 'token_usage',
      id: 'usage-step-cap-noisy',
      turnId: input.turnId,
      ts,
      input: 10,
      output: 1,
      total: 11,
      costUsd: 0.01,
      rawFinishReason: 'tool-calls',
      runtimeSteps: 50,
    };
    yield { type: 'text_complete', id: 'text-step-cap-noisy', messageId: 'step-cap-noisy-message', turnId: input.turnId, ts, text: 'continue' };
    yield { type: 'complete', id: 'complete-step-cap-noisy', turnId: input.turnId, ts, stopReason: 'end_turn' };
  }
}

function registerNoisyStepCapThenCompleteBackend(seen: { backend?: NoisyStepCapThenCompleteBackend }) {
  return (registry: BackendRegistry): void => {
    registry.register('fake', (ctx) => {
      const backend = new NoisyStepCapThenCompleteBackend({ sessionId: ctx.sessionId, header: ctx.header });
      seen.backend = backend;
      return backend;
    });
  };
}

class StepCapTwiceThenCompleteBackend extends StepCapThenCompleteBackend {
  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    const ts = Date.now();
    this.prompts.push(input.text);
    this.cwds.push(this.ctx.header.cwd);
    if (this.prompts.length <= 2) {
      yield {
        type: 'token_usage',
        id: `usage-step-cap-${this.prompts.length}`,
        turnId: input.turnId,
        ts,
        input: 10,
        output: 1,
        total: 11,
        costUsd: 0.01,
        rawFinishReason: 'tool-calls',
        runtimeSteps: 50,
      };
      yield { type: 'text_complete', id: `text-step-cap-${this.prompts.length}`, messageId: `step-cap-message-${this.prompts.length}`, turnId: input.turnId, ts, text: 'continue' };
      yield { type: 'complete', id: `complete-step-cap-${this.prompts.length}`, turnId: input.turnId, ts, stopReason: 'end_turn' };
      return;
    }
    await writeFile(join(this.ctx.header.cwd, 'continued-proof.txt'), input.text, 'utf8');
    yield {
      type: 'token_usage',
      id: 'usage-done',
      turnId: input.turnId,
      ts,
      input: 3,
      output: 2,
      total: 5,
      costUsd: 0.02,
      rawFinishReason: 'stop',
    };
    yield { type: 'text_complete', id: 'text-done', messageId: 'done-message', turnId: input.turnId, ts, text: 'done' };
    yield { type: 'complete', id: 'complete-done', turnId: input.turnId, ts, stopReason: 'end_turn' };
  }
}

function registerStepCapTwiceThenCompleteBackend(seen: { backend?: StepCapTwiceThenCompleteBackend }) {
  return (registry: BackendRegistry): void => {
    registry.register('fake', (ctx) => {
      const backend = new StepCapTwiceThenCompleteBackend({ sessionId: ctx.sessionId, header: ctx.header });
      seen.backend = backend;
      return backend;
    });
  };
}

describe('runHarborCell', () => {
  test('runs in the provided workspace and writes the shared cell artifacts', async () => {
    await withDirs(async ({ workspaceDir, outputDir, storageRoot }) => {
      const result = await runHarborCell({
        config,
        instruction: 'write the answer in-place',
        cwd: workspaceDir,
        outputDir,
        storageRoot,
        pricingProfile: 'deepseek-v4-flash-tbench-v1',
        registerBackends: registerCellBackend,
      });

      assert.equal(await readFile(join(workspaceDir, 'cell-proof.txt'), 'utf8'), 'ran in place\n');
      assert.equal(result.output.status, 'completed');
      assert.equal(result.output.promptHash, 'sha256:cell-prompt');
      assert.equal(result.output.runtimeEventsPath, join(outputDir, HARBOR_CELL_RUNTIME_EVENTS_FILENAME));
      assert.equal(result.output.tokenSummary.costUsd, 0.0042);
      assert.deepEqual(result.output.executionIdentity, {
        llmConnectionSlug: 'fake',
        model: 'fake-model',
        systemPromptHash: `sha256:${createHash('sha256').update(JSON.stringify(config.systemPrompt)).digest('hex')}`,
        pricingProfile: 'deepseek-v4-flash-tbench-v1',
      });

      const outputJson = JSON.parse(await readFile(join(outputDir, HARBOR_CELL_OUTPUT_FILENAME), 'utf8'));
      assert.deepEqual(outputJson, result.output);
      const runtimeEvents = await readFile(join(outputDir, HARBOR_CELL_RUNTIME_EVENTS_FILENAME), 'utf8');
      assert.match(runtimeEvents, /"id":"cell-usage"/);
      assert.match(runtimeEvents, /"systemPromptHash":"sha256:cell-prompt"/);
    });
  });

  test('writes execution identity before the first model call', async () => {
    await withDirs(async ({ workspaceDir, outputDir, storageRoot }) => {
      let observedIdentity: unknown;
      class IdentityObservingBackend implements AgentBackend {
        readonly kind: BackendKind = 'fake';
        readonly sessionId: string;

        constructor(sessionId: string) {
          this.sessionId = sessionId;
        }

        async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
          observedIdentity = JSON.parse(await readFile(
            join(outputDir, 'maka-cell-execution-identity.json'),
            'utf8',
          ));
          yield {
            type: 'complete',
            id: 'identity-observed',
            turnId: input.turnId,
            ts: Date.now(),
            stopReason: 'end_turn',
          };
        }

        async stop(): Promise<void> {}
        async respondToPermission(_decision: PermissionDecision): Promise<void> {}
        async dispose(): Promise<void> {}
      }

      await runHarborCell({
        config,
        instruction: 'observe identity',
        cwd: workspaceDir,
        outputDir,
        storageRoot,
        pricingProfile: 'deepseek-v4-flash-tbench-v1',
        registerBackends: (registry) => {
          registry.register('fake', (ctx) => new IdentityObservingBackend(ctx.sessionId));
        },
      });

      assert.deepEqual(observedIdentity, {
        llmConnectionSlug: 'fake',
        model: 'fake-model',
        systemPromptHash: `sha256:${createHash('sha256').update(JSON.stringify(config.systemPrompt)).digest('hex')}`,
        pricingProfile: 'deepseek-v4-flash-tbench-v1',
      });
    });
  });

  test('env entrypoint reads instruction files and writes the same cell artifacts', async () => {
    await withDirs(async ({ workspaceDir, outputDir, storageRoot }) => {
      const instructionFile = join(outputDir, 'instruction.txt');
      await writeFile(instructionFile, 'solve from env\n', 'utf8');

      const result = await runHarborCellFromEnv({
        MAKA_BACKEND: 'fake',
        MAKA_INSTRUCTION_FILE: instructionFile,
        MAKA_WORKDIR: workspaceDir,
        MAKA_OUTPUT_DIR: outputDir,
        MAKA_STORAGE_ROOT: storageRoot,
        MAKA_SYSTEM_PROMPT: config.systemPrompt!,
      }, {
        registerBackends: registerCellBackend,
      });

      assert.equal(result.output.status, 'completed');
      assert.equal(await readFile(join(workspaceDir, 'cell-proof.txt'), 'utf8'), 'ran in place\n');
      assert.deepEqual(
        JSON.parse(await readFile(join(outputDir, HARBOR_CELL_OUTPUT_FILENAME), 'utf8')),
        result.output,
      );
    });
  });

  test('continues after a tool-call step cap without verifier feedback', async () => {
    await withDirs(async ({ workspaceDir, outputDir, storageRoot }) => {
      const seen: { backend?: StepCapThenCompleteBackend } = {};
      const result = await runHarborCell({
        config,
        instruction: 'solve the benchmark task',
        cwd: workspaceDir,
        outputDir,
        storageRoot,
        registerBackends: registerStepCapThenCompleteBackend(seen),
        continuationPolicy: {
          enabled: true,
          maxTurns: 3,
          maxTotalRuntimeSteps: 150,
          prompt: 'Continue neutrally from current workspace.',
        },
      });

      assert.equal(result.output.status, 'completed');
      assert.deepEqual(seen.backend?.prompts, [
        'solve the benchmark task',
        'Continue neutrally from current workspace.',
      ]);
      assert.deepEqual(seen.backend?.cwds, [workspaceDir, workspaceDir]);
      assert.equal(await readFile(join(workspaceDir, 'continued-proof.txt'), 'utf8'), 'Continue neutrally from current workspace.');
      assert.deepEqual(result.output.continuationSummary, {
        enabled: true,
        maxTurns: 3,
        maxTotalRuntimeSteps: 150,
        turnsUsed: 2,
        continuedTurns: 1,
        stepCapHits: 1,
        capExhausted: false,
        totalRuntimeSteps: 50,
        turns: [
          { turnIndex: 0, status: 'failed', stepCapHit: true, runtimeSteps: 50 },
          { turnIndex: 1, status: 'completed', stepCapHit: false, runtimeSteps: 0 },
        ],
      });
      assert.equal(result.output.tokenSummary.input, 13);
      assert.equal(result.output.tokenSummary.costUsd, 0.03);
      const runtimeEvents = await readFile(join(outputDir, HARBOR_CELL_RUNTIME_EVENTS_FILENAME), 'utf8');
      assert.match(runtimeEvents, /usage-step-cap/);
      assert.match(runtimeEvents, /usage-done/);
      assert.doesNotMatch(seen.backend?.prompts[1] ?? '', /verifier|verification|failed|taxonomy|retry/i);
    });
  });

  test('fails the cell when a continuation turn throws after a step cap', async () => {
    await withDirs(async ({ workspaceDir, outputDir, storageRoot }) => {
      const seen: { backend?: StepCapThenThrowBackend } = {};
      const result = await runHarborCell({
        config,
        instruction: 'solve the benchmark task',
        cwd: workspaceDir,
        outputDir,
        storageRoot,
        registerBackends: registerStepCapThenThrowBackend(seen),
        continuationPolicy: {
          enabled: true,
          maxTurns: 3,
          maxTotalRuntimeSteps: 150,
          prompt: 'Continue neutrally from current workspace.',
        },
      });

      assert.equal(result.output.status, 'failed');
      assert.equal(result.output.errorClass, 'Error');
      assert.match(result.invocation.failure?.message ?? '', /continuation turn crashed/);
      assert.deepEqual(seen.backend?.prompts, [
        'solve the benchmark task',
        'Continue neutrally from current workspace.',
      ]);
      assert.deepEqual(result.output.continuationSummary, {
        enabled: true,
        maxTurns: 3,
        maxTotalRuntimeSteps: 150,
        turnsUsed: 2,
        continuedTurns: 1,
        stepCapHits: 1,
        capExhausted: false,
        totalRuntimeSteps: 50,
        turns: [
          { turnIndex: 0, status: 'failed', stepCapHit: true, runtimeSteps: 50 },
          { turnIndex: 1, status: 'failed', stepCapHit: false, runtimeSteps: 0 },
        ],
      });
    });
  });

  test('stops continuation when the total runtime step budget is exhausted', async () => {
    await withDirs(async ({ workspaceDir, outputDir, storageRoot }) => {
      const seen: { backend?: StepCapThenCompleteBackend } = {};
      const result = await runHarborCell({
        config,
        instruction: 'solve the benchmark task',
        cwd: workspaceDir,
        outputDir,
        storageRoot,
        registerBackends: registerStepCapThenCompleteBackend(seen),
        continuationPolicy: {
          enabled: true,
          maxTurns: 3,
          maxTotalRuntimeSteps: 3,
          prompt: 'Continue neutrally from current workspace.',
        },
      });

      assert.equal(result.output.status, 'failed');
      assert.equal(result.output.errorClass, 'tool_step_cap_reached');
      assert.deepEqual(seen.backend?.prompts, ['solve the benchmark task']);
      assert.deepEqual(result.output.continuationSummary, {
        enabled: true,
        maxTurns: 3,
        maxTotalRuntimeSteps: 3,
        turnsUsed: 1,
        continuedTurns: 0,
        stepCapHits: 1,
        capExhausted: true,
        totalRuntimeSteps: 50,
        turns: [
          { turnIndex: 0, status: 'failed', stepCapHit: true, runtimeSteps: 50 },
        ],
      });
    });
  });

  test('does not spend continuation step budget from diagnostic event count', async () => {
    await withDirs(async ({ workspaceDir, outputDir, storageRoot }) => {
      const seen: { backend?: NoisyStepCapThenCompleteBackend } = {};
      const result = await runHarborCell({
        config,
        instruction: 'solve the benchmark task',
        cwd: workspaceDir,
        outputDir,
        storageRoot,
        registerBackends: registerNoisyStepCapThenCompleteBackend(seen),
        continuationPolicy: {
          enabled: true,
          maxTurns: 3,
          maxTotalRuntimeSteps: 51,
          prompt: 'Continue neutrally from current workspace.',
        },
      });

      assert.equal(result.output.status, 'completed');
      assert.deepEqual(seen.backend?.prompts, [
        'solve the benchmark task',
        'Continue neutrally from current workspace.',
      ]);
      assert.deepEqual(result.output.continuationSummary, {
        enabled: true,
        maxTurns: 3,
        maxTotalRuntimeSteps: 51,
        turnsUsed: 2,
        continuedTurns: 1,
        stepCapHits: 1,
        capExhausted: false,
        totalRuntimeSteps: 50,
        turns: [
          { turnIndex: 0, status: 'failed', stepCapHit: true, runtimeSteps: 50 },
          { turnIndex: 1, status: 'completed', stepCapHit: false, runtimeSteps: 0 },
        ],
      });
    });
  });

  test('records per-turn step-cap hits across continuation turns', async () => {
    await withDirs(async ({ workspaceDir, outputDir, storageRoot }) => {
      const seen: { backend?: StepCapTwiceThenCompleteBackend } = {};
      const result = await runHarborCell({
        config,
        instruction: 'solve the benchmark task',
        cwd: workspaceDir,
        outputDir,
        storageRoot,
        registerBackends: registerStepCapTwiceThenCompleteBackend(seen),
        continuationPolicy: {
          enabled: true,
          maxTurns: 3,
          maxTotalRuntimeSteps: 150,
          prompt: 'Continue neutrally from current workspace.',
        },
      });

      assert.equal(result.output.status, 'completed');
      assert.deepEqual(seen.backend?.prompts, [
        'solve the benchmark task',
        'Continue neutrally from current workspace.',
        'Continue neutrally from current workspace.',
      ]);
      assert.deepEqual(result.output.continuationSummary?.turns.map((turn) => turn.stepCapHit), [true, true, false]);
      assert.deepEqual(result.output.continuationSummary, {
        enabled: true,
        maxTurns: 3,
        maxTotalRuntimeSteps: 150,
        turnsUsed: 3,
        continuedTurns: 2,
        stepCapHits: 2,
        capExhausted: false,
        totalRuntimeSteps: 100,
        turns: [
          { turnIndex: 0, status: 'failed', stepCapHit: true, runtimeSteps: 50 },
          { turnIndex: 1, status: 'failed', stepCapHit: true, runtimeSteps: 50 },
          { turnIndex: 2, status: 'completed', stepCapHit: false, runtimeSteps: 0 },
        ],
      });
    });
  });

  test('env entrypoint wires continuation policy from env', async () => {
    await withDirs(async ({ workspaceDir, outputDir, storageRoot }) => {
      const seen: { backend?: StepCapThenCompleteBackend } = {};
      const result = await runHarborCellFromEnv({
        MAKA_BACKEND: 'fake',
        MAKA_INSTRUCTION: 'solve the benchmark task',
        MAKA_WORKDIR: workspaceDir,
        MAKA_OUTPUT_DIR: outputDir,
        MAKA_STORAGE_ROOT: storageRoot,
        MAKA_HARBOR_CONTINUATION: 'on',
        MAKA_HARBOR_CONTINUATION_MAX_TURNS: '3',
        MAKA_HARBOR_CONTINUATION_MAX_TOTAL_RUNTIME_STEPS: '3',
        MAKA_HARBOR_CONTINUATION_PROMPT: 'Continue neutrally from current workspace.',
      }, {
        registerBackends: registerStepCapThenCompleteBackend(seen),
      });

      assert.equal(result.output.status, 'failed');
      assert.deepEqual(seen.backend?.prompts, ['solve the benchmark task']);
      assert.deepEqual(result.output.continuationSummary, {
        enabled: true,
        maxTurns: 3,
        maxTotalRuntimeSteps: 3,
        turnsUsed: 1,
        continuedTurns: 0,
        stepCapHits: 1,
        capExhausted: true,
        totalRuntimeSteps: 50,
        turns: [
          { turnIndex: 0, status: 'failed', stepCapHit: true, runtimeSteps: 50 },
        ],
      });
    });
  });

  test('env entrypoint records a context budget policy snapshot', async () => {
    await withDirs(async ({ workspaceDir, outputDir, storageRoot }) => {
      const off = await runHarborCellFromEnv({
        MAKA_BACKEND: 'fake',
        MAKA_INSTRUCTION: 'solve with prune off',
        MAKA_WORKDIR: workspaceDir,
        MAKA_OUTPUT_DIR: outputDir,
        MAKA_STORAGE_ROOT: storageRoot,
        MAKA_CONTEXT_BUDGET: 'off',
      }, {
        registerBackends: registerCellBackend,
      });
      assert.deepEqual(off.output.contextBudgetPolicy, { enabled: false });
    });

    await withDirs(async ({ workspaceDir, outputDir, storageRoot }) => {
      const on = await runHarborCellFromEnv({
        MAKA_BACKEND: 'fake',
        MAKA_INSTRUCTION: 'solve with prune on',
        MAKA_WORKDIR: workspaceDir,
        MAKA_OUTPUT_DIR: outputDir,
        MAKA_STORAGE_ROOT: storageRoot,
        MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE: 'on',
        MAKA_CONTEXT_STALE_TOOL_RESULT_MAX_TOKENS: '256',
        MAKA_CONTEXT_ACTIVE_TOOL_RESULT_PRUNE: 'on',
        MAKA_CONTEXT_ACTIVE_TOOL_RESULT_MAX_ESTIMATED_TOKENS: '512',
        MAKA_CONTEXT_ACTIVE_TOOL_RESULT_MIN_STEP_NUMBER: '1',
        MAKA_CONTEXT_ACTIVE_FULL_COMPACT: 'on',
        MAKA_CONTEXT_ACTIVE_FULL_COMPACT_MIN_STEP_NUMBER: '2',
        MAKA_CONTEXT_ACTIVE_FULL_COMPACT_HIGH_WATER_RATIO: '0.5',
        MAKA_CONTEXT_ACTIVE_FULL_COMPACT_MAX_ACTIVE_ESTIMATED_TOKENS: '16384',
        MAKA_CONTEXT_ACTIVE_FULL_COMPACT_MIN_RECENT_MESSAGES: '4',
        MAKA_CONTEXT_ACTIVE_FULL_COMPACT_MAX_SUMMARY_ESTIMATED_TOKENS: '1024',
        MAKA_CONTEXT_ACTIVE_FULL_COMPACT_HIGH_WATER_NAME: 'test-active-full',
        MAKA_CONTEXT_ARCHIVE_RETRIEVAL: 'on',
        MAKA_CONTEXT_ARCHIVE_RETRIEVAL_MODE: 'eager',
      }, {
        registerBackends: registerCellBackend,
      });
      assert.deepEqual(on.output.contextBudgetPolicy, {
        enabled: true,
        name: 'harbor-cell-context-budget',
        staleToolResultPrune: {
          enabled: true,
          maxResultEstimatedTokens: 256,
          minRecentTurnsFull: 2,
        },
        activeToolResultPrune: {
          enabled: true,
          maxCurrentResultEstimatedTokens: 512,
          minStepNumber: 1,
        },
        activeFullCompact: {
          enabled: true,
          minStepNumber: 2,
          highWaterRatio: 0.5,
          maxActiveEstimatedTokens: 16384,
          minRecentMessages: 4,
          maxSummaryEstimatedTokens: 1024,
          highWaterName: 'test-active-full',
        },
        archiveRetrieval: {
          enabled: true,
          mode: 'eager',
          maxResults: 3,
          maxEstimatedTokens: 8192,
          maxBytes: 1024 * 1024,
          order: 'newest_first',
        },
        minRecentTurns: 2,
      });
    });
  });

  test('env entrypoint defaults to the process cwd when MAKA_WORKDIR is absent', async () => {
    await withDirs(async ({ workspaceDir, outputDir, storageRoot }) => {
      const instructionFile = join(outputDir, 'instruction.txt');
      await writeFile(instructionFile, 'solve from current cwd\n', 'utf8');

      const originalCwd = process.cwd();
      process.chdir(workspaceDir);
      try {
        const result = await runHarborCellFromEnv({
          MAKA_BACKEND: 'fake',
          MAKA_INSTRUCTION_FILE: instructionFile,
          MAKA_OUTPUT_DIR: outputDir,
          MAKA_STORAGE_ROOT: storageRoot,
          MAKA_SYSTEM_PROMPT: config.systemPrompt!,
        }, {
          registerBackends: registerCellBackend,
        });

        assert.equal(result.output.status, 'completed');
        assert.equal(await readFile(join(workspaceDir, 'cell-proof.txt'), 'utf8'), 'ran in place\n');
      } finally {
        process.chdir(originalCwd);
      }
    });
  });

  test('writes a failed cell artifact when the backend stream throws', async () => {
    await withDirs(async ({ workspaceDir, outputDir, storageRoot }) => {
      const result = await runHarborCell({
        config,
        instruction: 'trigger backend failure',
        cwd: workspaceDir,
        outputDir,
        storageRoot,
        registerBackends: registerThrowingBackend,
      });

      assert.equal(result.output.status, 'failed');
      assert.equal(result.output.errorClass, 'Error');
      assert.match(
        await readFile(join(outputDir, HARBOR_CELL_OUTPUT_FILENAME), 'utf8'),
        /"status": "failed"/,
      );
    });
  });

  test('env entrypoint maps provider/model env for the real backend path', async () => {
    await withDirs(async ({ workspaceDir, outputDir, storageRoot }) => {
      const seenContexts: HeadlessBackendContext[] = [];
      const registerAiSdkBackend = (registry: BackendRegistry, context: HeadlessBackendContext): void => {
        seenContexts.push(context);
        registry.register('ai-sdk', (ctx) =>
          new CellReportingBackend({ sessionId: ctx.sessionId, header: ctx.header, store: ctx.store }, 'ai-sdk'),
        );
      };

      const result = await runHarborCellFromEnv({
        MAKA_INSTRUCTION: 'solve from real-provider env',
        MAKA_MODEL: 'openai/gpt-4o-mini',
        MAKA_WORKDIR: workspaceDir,
        MAKA_OUTPUT_DIR: outputDir,
        MAKA_STORAGE_ROOT: storageRoot,
        MAKA_SYSTEM_PROMPT: 'Use the benchmark prompt.',
      }, {
        registerBackends: registerAiSdkBackend,
      });

      assert.equal(result.output.status, 'completed');
      assert.equal(seenContexts.length, 1);
      assert.equal(seenContexts[0].config.backend, 'ai-sdk');
      assert.equal(seenContexts[0].config.llmConnectionSlug, 'openai');
      assert.equal(seenContexts[0].config.model, 'gpt-4o-mini');
      assert.equal(seenContexts[0].config.systemPrompt, 'Use the benchmark prompt.');
      assert.equal(seenContexts[0].realBackendIsolation?.kind, 'external');
      assert.equal(seenContexts[0].realBackendIsolation?.label, 'Harbor task container');
      assert.equal(typeof seenContexts[0].realBackendIsolation?.toolExecutor?.exec, 'function');
      assert.equal(typeof seenContexts[0].toolExecutor?.exec, 'function');
    });
  });

  test('appends heavy-task policy to Harbor backend context only when explicitly enabled', async () => {
    await withDirs(async ({ workspaceDir, outputDir, storageRoot }) => {
      const seenPrompts: Array<string | undefined> = [];
      const registerCapturingBackend = (registry: BackendRegistry, context: HeadlessBackendContext): void => {
        seenPrompts.push(context.config.systemPrompt);
        registry.register('fake', (ctx) =>
          new CellReportingBackend({ sessionId: ctx.sessionId, header: ctx.header, store: ctx.store }),
        );
      };

      await runHarborCell({
        config,
        instruction: 'solve without heavy mode',
        cwd: workspaceDir,
        outputDir,
        storageRoot,
        registerBackends: registerCapturingBackend,
      });
      await runHarborCell({
        config: { ...config, heavyTaskMode: { enabled: true, reason: 'long cell task' } },
        instruction: 'solve with heavy mode',
        cwd: workspaceDir,
        outputDir,
        storageRoot,
        registerBackends: registerCapturingBackend,
      });

      assert.equal(seenPrompts[0], config.systemPrompt);
      assert.match(seenPrompts[1] ?? '', /Heavy-task benchmark policy/);
      assert.match(seenPrompts[1] ?? '', /self_check_submit/);
      assert.match(seenPrompts[1] ?? '', /public, task-derived semantic self-check evidence/);
    });
  });

  test('appends economy-task policy to Harbor backend context from env', async () => {
    await withDirs(async ({ workspaceDir, outputDir, storageRoot }) => {
      const seenPrompts: Array<string | undefined> = [];
      const registerCapturingBackend = (registry: BackendRegistry, context: HeadlessBackendContext): void => {
        seenPrompts.push(context.config.systemPrompt);
        registry.register('fake', (ctx) =>
          new CellReportingBackend({ sessionId: ctx.sessionId, header: ctx.header, store: ctx.store }),
        );
      };

      await runHarborCellFromEnv({
        MAKA_BACKEND: 'fake',
        MAKA_INSTRUCTION: 'Write a CSV summary of log files.',
        MAKA_WORKDIR: workspaceDir,
        MAKA_OUTPUT_DIR: outputDir,
        MAKA_STORAGE_ROOT: storageRoot,
        MAKA_SYSTEM_PROMPT: 'Use the benchmark prompt.',
        MAKA_ECONOMY_TASK_MODE: 'true',
      }, {
        registerBackends: registerCapturingBackend,
      });

      assert.match(seenPrompts[0] ?? '', /Use the benchmark prompt/);
      assert.match(seenPrompts[0] ?? '', /Economy-task benchmark policy/);
      assert.match(seenPrompts[0] ?? '', /one lightweight targeted preview/);
    });
  });

  test('explicit MAKA_ECONOMY_TASK_MODE=false disables economy-task policy from env signals', async () => {
    await withDirs(async ({ workspaceDir, outputDir, storageRoot }) => {
      const seenPrompts: Array<string | undefined> = [];
      const registerCapturingBackend = (registry: BackendRegistry, context: HeadlessBackendContext): void => {
        seenPrompts.push(context.config.systemPrompt);
        registry.register('fake', (ctx) =>
          new CellReportingBackend({ sessionId: ctx.sessionId, header: ctx.header, store: ctx.store }),
        );
      };

      await runHarborCellFromEnv({
        MAKA_BACKEND: 'fake',
        MAKA_INSTRUCTION: 'Write a CSV summary of log files.',
        MAKA_WORKDIR: workspaceDir,
        MAKA_OUTPUT_DIR: outputDir,
        MAKA_STORAGE_ROOT: storageRoot,
        MAKA_SYSTEM_PROMPT: 'Use the benchmark prompt.',
        MAKA_ECONOMY_TASK_MODE: 'false',
      }, {
        registerBackends: registerCapturingBackend,
      });

      assert.match(seenPrompts[0] ?? '', /Use the benchmark prompt/);
      assert.doesNotMatch(seenPrompts[0] ?? '', /Economy-task benchmark policy/);
    });
  });

  test('parses host-side max steps from MAKA_MAX_STEPS', () => {
    assert.equal(harborCellMaxStepsFromEnv({ MAKA_MAX_STEPS: '200' }), 200);
    assert.throws(() => harborCellMaxStepsFromEnv({ MAKA_MAX_STEPS: '0' }), /MAKA_MAX_STEPS must be a positive integer/);
    assert.throws(() => harborCellMaxStepsFromEnv({ MAKA_MAX_STEPS: 'oops' }), /MAKA_MAX_STEPS must be a positive integer/);
    assert.equal(harborCellMaxStepsFromEnv({}), undefined);
  });

  test('host-side Harbor cell config reads MAKA_ECONOMY_TASK_MODE', async () => {
    const { main } = await import(new URL('../../harbor/run-host-cell.mjs', import.meta.url).href) as {
      main: (options?: { registerBackends?: (registry: BackendRegistry, context: HeadlessBackendContext) => void }) => Promise<void>;
    };
    await withDirs(async ({ workspaceDir, outputDir, storageRoot }) => {
      const previousEnv = { ...process.env };
      const seenPrompts: string[] = [];
      const registerCapturingBackend = (registry: BackendRegistry, context: HeadlessBackendContext): void => {
        seenPrompts.push(context.config.systemPrompt ?? '');
        registry.register('ai-sdk', (ctx) =>
          new CellReportingBackend({ sessionId: ctx.sessionId, header: ctx.header, store: ctx.store }),
        );
      };
      try {
        process.env.MAKA_PROVIDER = 'openai';
        process.env.MAKA_MODEL = 'openai/gpt-4o-mini';
        process.env.MAKA_HOST_API_KEY = 'test-key';
        process.env.MAKA_HARBOR_TOOL_EXECUTOR_URL = 'http://127.0.0.1:1';
        process.env.MAKA_HARBOR_TOOL_EXECUTOR_TOKEN = 'token';
        process.env.MAKA_INSTRUCTION = 'Write a CSV summary of log files.';
        process.env.MAKA_WORKDIR = workspaceDir;
        process.env.MAKA_OUTPUT_DIR = outputDir;
        process.env.MAKA_STORAGE_ROOT = storageRoot;
        process.env.MAKA_SYSTEM_PROMPT = 'Use the host prompt.';
        process.env.MAKA_ECONOMY_TASK_MODE = 'true';
        await main({ registerBackends: registerCapturingBackend });
      } finally {
        process.env = previousEnv;
      }

      assert.match(seenPrompts[0] ?? '', /Use the host prompt/);
      assert.match(seenPrompts[0] ?? '', /Economy-task benchmark policy/);
    });
  });

  test('host-side Harbor cell config treats MAKA_ECONOMY_TASK_MODE=false as explicit disable', async () => {
    const { main } = await import(new URL('../../harbor/run-host-cell.mjs', import.meta.url).href) as {
      main: (options?: { registerBackends?: (registry: BackendRegistry, context: HeadlessBackendContext) => void }) => Promise<void>;
    };
    await withDirs(async ({ workspaceDir, outputDir, storageRoot }) => {
      const previousEnv = { ...process.env };
      const seenPrompts: string[] = [];
      const registerCapturingBackend = (registry: BackendRegistry, context: HeadlessBackendContext): void => {
        seenPrompts.push(context.config.systemPrompt ?? '');
        registry.register('ai-sdk', (ctx) =>
          new CellReportingBackend({ sessionId: ctx.sessionId, header: ctx.header, store: ctx.store }),
        );
      };
      try {
        process.env.MAKA_PROVIDER = 'openai';
        process.env.MAKA_MODEL = 'openai/gpt-4o-mini';
        process.env.MAKA_HOST_API_KEY = 'test-key';
        process.env.MAKA_HARBOR_TOOL_EXECUTOR_URL = 'http://127.0.0.1:1';
        process.env.MAKA_HARBOR_TOOL_EXECUTOR_TOKEN = 'token';
        process.env.MAKA_INSTRUCTION = 'Write a CSV summary of log files.';
        process.env.MAKA_WORKDIR = workspaceDir;
        process.env.MAKA_OUTPUT_DIR = outputDir;
        process.env.MAKA_STORAGE_ROOT = storageRoot;
        process.env.MAKA_SYSTEM_PROMPT = 'Use the host prompt.';
        process.env.MAKA_ECONOMY_TASK_MODE = 'false';
        await main({ registerBackends: registerCapturingBackend });
      } finally {
        process.env = previousEnv;
      }

      assert.match(seenPrompts[0] ?? '', /Use the host prompt/);
      assert.doesNotMatch(seenPrompts[0] ?? '', /Economy-task benchmark policy/);
    });
  });

  test('Harbor ai-sdk backend registration exposes native file tools to the provider schema', async () => {
    await withDirs(async ({ workspaceDir }) => {
      const registry = new BackendRegistry();
      const toolExecutor = fakeToolExecutor();
      const register = buildAiSdkCellBackendRegistration({
        provider: 'openai',
        model: 'gpt-4o-mini',
        env: { OPENAI_API_KEY: 'test-key' },
        now: () => 123,
        newId: () => 'id',
      });
      await register(registry, {
        config: {
          id: 'harbor-ai-sdk',
          backend: 'ai-sdk',
          llmConnectionSlug: 'openai',
          model: 'gpt-4o-mini',
        },
        task: { id: 'harbor-cell', instruction: 'solve', workspaceDir },
        workspaceDir,
        realBackendIsolation: { kind: 'external', label: 'Harbor task container', toolExecutor },
        toolExecutor,
      });

      const backend = await registry.build('ai-sdk', backendContext(workspaceDir));
      const backendInput = (backend as unknown as {
        input: {
          tools: Array<{ name: string; permissionRequired?: boolean }>;
          systemPrompt?: string;
        };
      }).input;
      const toolNames = backendInput.tools.map((tool) => tool.name);

      for (const expected of ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep']) {
        assert.ok(toolNames.includes(expected), `expected provider schema tool ${expected}`);
      }
      assert.equal(backendInput.tools.find((tool) => tool.name === 'Bash')?.permissionRequired, false);
      assert.equal(backendInput.tools.find((tool) => tool.name === 'Write')?.permissionRequired, false);
      assert.match(backendInput.systemPrompt ?? '', /Prefer Read, Glob, and Grep/);
    });
  });

  test('Harbor task experiment context flag enables task tools and replay only when requested', async () => {
    assert.ok(HARBOR_CELL_CONTEXT_ENV_KEYS.includes('MAKA_CONTEXT_TASK_TOOLS' as never));
    assert.ok(!HARBOR_CELL_CONTEXT_ENV_KEYS.includes('MAKA_CONTEXT_TASK_TOOL_SHAPE' as never));
    assert.deepEqual(buildHarborCellTaskLedgerExperimentPolicy({ MAKA_CONTEXT_TASK_TOOLS: 'off' }), undefined);
    assert.deepEqual(buildHarborCellTaskLedgerExperimentPolicy({
      MAKA_CONTEXT_TASK_TOOLS: 'on',
      MAKA_CONTEXT_TASK_REPLAY_MAX_CHARS: '700',
    }), { enabled: true, replayMaxChars: 700 });
    assert.throws(
      () => buildHarborCellTaskLedgerExperimentPolicy({
        MAKA_CONTEXT_TASK_TOOLS: 'on',
        MAKA_CONTEXT_TASK_TOOL_SHAPE: 'crud',
      } as never),
      /unsupported Harbor context env key: MAKA_CONTEXT_TASK_TOOL_SHAPE/,
    );

    await withDirs(async ({ workspaceDir }) => {
      const offRegistry = new BackendRegistry();
      const offRegister = buildAiSdkCellBackendRegistration({
        provider: 'openai',
        model: 'gpt-4o-mini',
        env: { OPENAI_API_KEY: 'test-key' },
        now: () => 123,
        newId: testIdFactory(),
      });
      const toolExecutor = fakeToolExecutor();
      await offRegister(offRegistry, {
        config: {
          id: 'harbor-ai-sdk',
          backend: 'ai-sdk',
          llmConnectionSlug: 'openai',
          model: 'gpt-4o-mini',
        },
        task: { id: 'harbor-cell', instruction: 'solve', workspaceDir },
        workspaceDir,
        realBackendIsolation: { kind: 'external', label: 'Harbor task container', toolExecutor },
        toolExecutor,
      });
      const offBackend = await offRegistry.build('ai-sdk', backendContext(workspaceDir));
      const offInput = (offBackend as unknown as {
        input: { tools: Array<{ name: string }>; turnTailPrompt?: unknown };
      }).input;
      assert.ok(!offInput.tools.some((tool) => tool.name.startsWith('task_')));
      assert.equal(offInput.turnTailPrompt, undefined);

      const todoRegistry = new BackendRegistry();
      const todoRegister = buildAiSdkCellBackendRegistration({
        provider: 'openai',
        model: 'gpt-4o-mini',
        env: {
          OPENAI_API_KEY: 'test-key',
          MAKA_CONTEXT_TASK_TOOLS: 'on',
        },
        now: () => 123,
        newId: testIdFactory(),
      });
      await todoRegister(todoRegistry, {
        config: {
          id: 'harbor-ai-sdk',
          backend: 'ai-sdk',
          llmConnectionSlug: 'openai',
          model: 'gpt-4o-mini',
        },
        task: { id: 'harbor-cell', instruction: 'solve', workspaceDir },
        workspaceDir,
        realBackendIsolation: { kind: 'external', label: 'Harbor task container', toolExecutor },
        toolExecutor,
      });
      const todoBackend = await todoRegistry.build('ai-sdk', backendContext(workspaceDir));
      const todoInput = (todoBackend as unknown as {
        input: {
          tools: Array<{ name: string; impl: Function }>;
          turnTailPrompt?: (context: { sessionId: string; cwd?: string; workspaceRoot?: string }) => Promise<string | undefined>;
        };
      }).input;
      assert.ok(todoInput.tools.some((tool) => tool.name === 'todo_write'));
      assert.ok(!todoInput.tools.some((tool) => tool.name.startsWith('task_')));
      assert.ok(todoInput.turnTailPrompt);
      const emptyTodoReplay = await todoInput.turnTailPrompt({ sessionId: 'session-todo', cwd: workspaceDir });
      assert.match(emptyTodoReplay ?? '', /Use todo_write at the start of long-running, multi-step tasks/);

      const todoWrite = todoInput.tools.find((tool) => tool.name === 'todo_write');
      assert.ok(todoWrite);
      await todoWrite.impl({
        todos: [{ content: 'Run focused benchmark slice', status: 'in_progress' }],
      }, {
        sessionId: 'session-todo',
        turnId: 'turn-1',
        cwd: workspaceDir,
        toolCallId: 'tool-todo-write',
        abortSignal: new AbortController().signal,
        emitOutput: () => {},
      });

      const todoReplay = await todoInput.turnTailPrompt({ sessionId: 'session-todo', cwd: workspaceDir });
      assert.match(todoReplay ?? '', /Use todo_write at the start of long-running, multi-step tasks/);
      assert.match(todoReplay ?? '', /Run focused benchmark slice/);
    });
  });

  test('Harbor ai-sdk backend passes an explicit system prompt through unchanged', async () => {
    await withDirs(async ({ workspaceDir }) => {
      const registry = new BackendRegistry();
      const toolExecutor = fakeToolExecutor();
      const register = buildAiSdkCellBackendRegistration({
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        env: { DEEPSEEK_API_KEY: 'test-key' },
        now: () => 123,
        newId: () => 'id',
      });
      // Trailing newline kept on purpose: the controller hashes these exact bytes.
      const candidatePrompt = 'CANDIDATE SYSTEM PROMPT — exact bytes.\n';
      await register(registry, {
        config: {
          id: 'harbor-ai-sdk',
          backend: 'ai-sdk',
          llmConnectionSlug: 'deepseek',
          model: 'deepseek-v4-flash',
          systemPrompt: candidatePrompt,
        },
        task: { id: 'harbor-cell', instruction: 'solve', workspaceDir },
        workspaceDir,
        realBackendIsolation: { kind: 'external', label: 'Harbor task container', toolExecutor },
        toolExecutor,
      });

      const backend = await registry.build('ai-sdk', backendContext(workspaceDir));
      const backendInput = (backend as unknown as { input: { systemPrompt?: string } }).input;
      assert.equal(backendInput.systemPrompt, candidatePrompt);
      assert.doesNotMatch(backendInput.systemPrompt ?? '', /Maka Runtime|Prefer Read, Glob, and Grep/);
    });
  });

  test('Harbor ai-sdk backend honors MAKA_TRIAL_* pricing override', async () => {
    await withDirs(async ({ workspaceDir }) => {
      const registry = new BackendRegistry();
      const toolExecutor = fakeToolExecutor();
      const register = buildAiSdkCellBackendRegistration({
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        env: {
          DEEPSEEK_API_KEY: 'test-key',
          MAKA_TRIAL_INPUT_USD_PER_1M: '0.145',
          MAKA_TRIAL_OUTPUT_USD_PER_1M: '0.29',
          MAKA_TRIAL_CACHE_READ_USD_PER_1M: '0.0029',
        },
        now: () => 123,
        newId: () => 'id',
      });
      await register(registry, {
        config: {
          id: 'harbor-ai-sdk',
          backend: 'ai-sdk',
          llmConnectionSlug: 'deepseek',
          model: 'deepseek-v4-flash',
        },
        task: { id: 'harbor-cell', instruction: 'solve', workspaceDir },
        workspaceDir,
        realBackendIsolation: { kind: 'external', label: 'Harbor task container', toolExecutor },
        toolExecutor,
      });

      const backend = await registry.build('ai-sdk', backendContext(workspaceDir));
      const lookupPricing = (backend as unknown as {
        input: { lookupPricing?: (key: string) => unknown };
      }).input.lookupPricing;
      assert.ok(lookupPricing, 'expected lookupPricing to be wired');
      assert.deepEqual(lookupPricing('deepseek:deepseek-v4-flash'), {
        modelKey: 'deepseek:deepseek-v4-flash',
        inputUsdPer1M: 0.145,
        outputUsdPer1M: 0.29,
        cacheReadUsdPer1M: 0.0029,
      });
    });
  });

  test('Harbor ai-sdk backend wires env-driven tool-result archive pruning', async () => {
    await withDirs(async ({ workspaceDir, outputDir }) => {
      const registry = new BackendRegistry();
      const toolExecutor = fakeToolExecutor();
      const register = buildAiSdkCellBackendRegistration({
        provider: 'openai',
        model: 'gpt-4o-mini',
        env: {
          OPENAI_API_KEY: 'test-key',
          MAKA_OUTPUT_DIR: outputDir,
          MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE: 'on',
          MAKA_CONTEXT_STALE_TOOL_RESULT_MAX_ESTIMATED_TOKENS: '1',
          MAKA_CONTEXT_STALE_TOOL_RESULT_MIN_RECENT_TURNS_FULL: '0',
          MAKA_CONTEXT_ACTIVE_TOOL_RESULT_PRUNE: 'on',
          MAKA_CONTEXT_ACTIVE_TOOL_RESULT_MAX_ESTIMATED_TOKENS: '2',
          MAKA_CONTEXT_ACTIVE_TOOL_RESULT_MIN_STEP_NUMBER: '1',
          MAKA_CONTEXT_ACTIVE_FULL_COMPACT: 'on',
          MAKA_CONTEXT_ACTIVE_FULL_COMPACT_MIN_STEP_NUMBER: '2',
          MAKA_CONTEXT_ACTIVE_FULL_COMPACT_HIGH_WATER_RATIO: '0.5',
          MAKA_CONTEXT_ACTIVE_FULL_COMPACT_MAX_ACTIVE_ESTIMATED_TOKENS: '16384',
          MAKA_CONTEXT_ACTIVE_FULL_COMPACT_MIN_RECENT_MESSAGES: '4',
          MAKA_CONTEXT_ACTIVE_FULL_COMPACT_MAX_SUMMARY_ESTIMATED_TOKENS: '1024',
          MAKA_CONTEXT_ARCHIVE_RETRIEVAL: 'on',
          MAKA_CONTEXT_ARCHIVE_RETRIEVAL_MODE: 'history_search_gated',
          MAKA_CONTEXT_ARCHIVE_RETRIEVAL_MAX_RESULTS: '1',
        },
        now: () => 123,
        newId: () => 'id',
      });
      await register(registry, {
        config: {
          id: 'harbor-ai-sdk',
          backend: 'ai-sdk',
          llmConnectionSlug: 'openai',
          model: 'gpt-4o-mini',
        },
        task: { id: 'harbor-cell', instruction: 'solve', workspaceDir },
        workspaceDir,
        realBackendIsolation: { kind: 'external', label: 'Harbor task container', toolExecutor },
        toolExecutor,
      });

      const backend = await registry.build('ai-sdk', backendContext(workspaceDir));
      const backendInput = (backend as unknown as {
        input: ReturnType<typeof buildHarborCellContextBudgetBackendOptions>;
      }).input;
      assert.equal(backendInput.contextBudget?.staleToolResultPrune?.enabled, true);
      assert.equal(backendInput.contextBudget?.staleToolResultPrune?.maxResultEstimatedTokens, 1);
      assert.equal(backendInput.contextBudget?.staleToolResultPrune?.minRecentTurnsFull, 0);
      assert.equal(backendInput.contextBudget?.activeToolResultPrune?.enabled, true);
      assert.equal(backendInput.contextBudget?.activeToolResultPrune?.maxCurrentResultEstimatedTokens, 2);
      assert.equal(backendInput.contextBudget?.activeToolResultPrune?.minStepNumber, 1);
      assert.equal(backendInput.contextBudget?.activeFullCompact?.enabled, true);
      assert.equal(backendInput.contextBudget?.activeFullCompact?.minStepNumber, 2);
      assert.equal(backendInput.contextBudget?.activeFullCompact?.highWaterRatio, 0.5);
      assert.equal(backendInput.contextBudget?.activeFullCompact?.maxActiveEstimatedTokens, 16384);
      assert.equal(backendInput.contextBudget?.activeFullCompact?.minRecentMessages, 4);
      assert.equal(backendInput.contextBudget?.activeFullCompact?.maxSummaryEstimatedTokens, 1024);
      assert.equal(backendInput.contextBudget?.archiveRetrieval?.enabled, true);
      assert.equal(backendInput.contextBudget?.archiveRetrieval?.mode, 'history_search_gated');
      assert.equal(backendInput.contextBudget?.archiveRetrieval?.maxResults, 1);
      assert.ok(backendInput.archiveToolResult, 'expected archive writer');
      assert.ok(backendInput.readToolResultArchive, 'expected archive reader');

      const serializedResult = JSON.stringify({ body: 'large tool result' });
      const bodySha256 = createHash('sha256').update(serializedResult).digest('hex');
      const originalBytes = Buffer.byteLength(serializedResult, 'utf8');
      const archived = await backendInput.archiveToolResult({
        sessionId: 'session-1',
        runtimeEventId: 'rt-result',
        turnId: 'turn-old',
        toolCallId: 'tool-1',
        toolName: 'Read',
        result: { body: 'large tool result' },
        serializedResult,
        originalEstimatedTokens: 99,
        originalBytes,
        rewriteVersion: 1,
        reason: 'stale_tool_result_pruned_before_compact',
        bodySha256,
      });
      assert.ok(archived?.artifactId);
      assert.match(
        await readFile(join(outputDir, 'tool-result-archives', archived.artifactId), 'utf8'),
        /"runtimeEventId":"rt-result"/,
      );

      const read = await backendInput.readToolResultArchive({
        kind: 'maka.archived_tool_result',
        rewriteVersion: 1,
        artifactId: archived.artifactId,
        runtimeEventId: 'rt-result',
        toolCallId: 'tool-1',
        toolName: 'Read',
        bodySha256,
        originalEstimatedTokens: 99,
        originalBytes,
        reason: 'stale_tool_result_pruned_before_compact',
        sessionId: 'session-1',
      });
      assert.deepEqual(read, { ok: true, serializedResult });
    });
  });

  // Eager retrieval only hydrates stale-kind placeholders, so a retrieval arm
  // is structurally inert unless a placeholder producer (stale prune) and the
  // archive reader are wired alongside it. The #340-era arms enabled retrieval
  // without stale prune and it never fired; this contract pins the live shape.
  test('Harbor eager archive-retrieval arm gets a placeholder producer and archive reader by default', async () => {
    await withDirs(async ({ workspaceDir, outputDir }) => {
      const registry = new BackendRegistry();
      const toolExecutor = fakeToolExecutor();
      const register = buildAiSdkCellBackendRegistration({
        provider: 'openai',
        model: 'gpt-4o-mini',
        env: {
          OPENAI_API_KEY: 'test-key',
          MAKA_OUTPUT_DIR: outputDir,
          MAKA_CONTEXT_ARCHIVE_RETRIEVAL: 'on',
        },
        now: () => 123,
        newId: () => 'id',
      });
      await register(registry, {
        config: {
          id: 'harbor-ai-sdk',
          backend: 'ai-sdk',
          llmConnectionSlug: 'openai',
          model: 'gpt-4o-mini',
        },
        task: { id: 'harbor-cell', instruction: 'solve', workspaceDir },
        workspaceDir,
        realBackendIsolation: { kind: 'external', label: 'Harbor task container', toolExecutor },
        toolExecutor,
      });

      const backend = await registry.build('ai-sdk', backendContext(workspaceDir));
      const backendInput = (backend as unknown as {
        input: ReturnType<typeof buildHarborCellContextBudgetBackendOptions>;
      }).input;
      assert.equal(backendInput.contextBudget?.staleToolResultPrune?.enabled, true);
      assert.equal(backendInput.contextBudget?.staleToolResultPrune?.minRecentTurnsFull, 2);
      assert.equal(backendInput.contextBudget?.archiveRetrieval?.enabled, true);
      assert.equal(backendInput.contextBudget?.archiveRetrieval?.mode, undefined);
      assert.ok(backendInput.archiveToolResult, 'expected archive writer for the placeholder producer');
      assert.ok(backendInput.readToolResultArchive, 'expected archive reader for eager hydration');
    });
  });

  test('Harbor ai-sdk backend leaves context budget policy off when explicitly disabled', async () => {
    await withDirs(async ({ workspaceDir }) => {
      const registry = new BackendRegistry();
      const toolExecutor = fakeToolExecutor();
      const register = buildAiSdkCellBackendRegistration({
        provider: 'openai',
        model: 'gpt-4o-mini',
        env: {
          OPENAI_API_KEY: 'test-key',
          MAKA_CONTEXT_BUDGET: 'off',
          MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE: 'on',
          MAKA_CONTEXT_ARCHIVE_RETRIEVAL: 'on',
        },
        now: () => 123,
        newId: () => 'id',
      });
      await register(registry, {
        config: {
          id: 'harbor-ai-sdk',
          backend: 'ai-sdk',
          llmConnectionSlug: 'openai',
          model: 'gpt-4o-mini',
        },
        task: { id: 'harbor-cell', instruction: 'solve', workspaceDir },
        workspaceDir,
        realBackendIsolation: { kind: 'external', label: 'Harbor task container', toolExecutor },
        toolExecutor,
      });

      const backend = await registry.build('ai-sdk', backendContext(workspaceDir));
      const backendInput = (backend as unknown as {
        input: ReturnType<typeof buildHarborCellContextBudgetBackendOptions>;
      }).input;
      assert.equal(backendInput.contextBudget, undefined);
      assert.equal(backendInput.archiveToolResult, undefined);
      assert.equal(backendInput.readToolResultArchive, undefined);
    });
  });

  test('Harbor context budget env rejects explicit malformed positive integers', async () => {
    for (const raw of ['abc', '0', '-1', '1x']) {
      await withDirs(async ({ workspaceDir }) => {
        const registry = new BackendRegistry();
        const toolExecutor = fakeToolExecutor();

        await assert.rejects(
          async () => {
            const register = buildAiSdkCellBackendRegistration({
              provider: 'openai',
              model: 'gpt-4o-mini',
              env: {
                OPENAI_API_KEY: 'test-key',
                MAKA_CONTEXT_ARCHIVE_RETRIEVAL: 'on',
                MAKA_CONTEXT_ARCHIVE_RETRIEVAL_MAX_RESULTS: raw,
              },
              now: () => 123,
              newId: () => 'id',
            });
            await register(registry, {
              config: {
                id: 'harbor-ai-sdk',
                backend: 'ai-sdk',
                llmConnectionSlug: 'openai',
                model: 'gpt-4o-mini',
              },
              task: { id: 'harbor-cell', instruction: 'solve', workspaceDir },
              workspaceDir,
              realBackendIsolation: { kind: 'external', label: 'Harbor task container', toolExecutor },
              toolExecutor,
            });
          },
          new RegExp(`MAKA_CONTEXT_ARCHIVE_RETRIEVAL_MAX_RESULTS must be a positive integer, got ${JSON.stringify(raw)}`),
        );
      });
    }
  });

  test('Harbor context budget env rejects explicit malformed numeric knobs', () => {
    assert.throws(
      () => buildHarborCellContextBudgetBackendOptions({
        MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE: 'on',
        MAKA_CONTEXT_HISTORY_BUDGET_TOKENS: '1000x',
      }),
      /MAKA_CONTEXT_HISTORY_BUDGET_TOKENS must be a non-negative integer, got "1000x"/,
    );
    assert.throws(
      () => buildHarborCellContextBudgetBackendOptions({
        MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE: 'on',
        MAKA_CONTEXT_HISTORY_BUDGET_TURNS: '-1',
      }),
      /MAKA_CONTEXT_HISTORY_BUDGET_TURNS must be a non-negative integer, got "-1"/,
    );
    assert.throws(
      () => buildHarborCellContextBudgetBackendOptions({
        MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE: 'on',
        MAKA_CONTEXT_MIN_RECENT_TURNS: '1.5',
      }),
      /MAKA_CONTEXT_MIN_RECENT_TURNS must be a non-negative integer, got "1.5"/,
    );
    assert.throws(
      () => buildHarborCellContextBudgetBackendOptions({
        MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE: 'on',
        MAKA_CONTEXT_STALE_TOOL_RESULT_MIN_RECENT_TURNS: 'old',
      }),
      /MAKA_CONTEXT_STALE_TOOL_RESULT_MIN_RECENT_TURNS must be a non-negative integer, got "old"/,
    );
  });

  test('Harbor context budget env rejects explicit malformed archive retrieval mode', async () => {
    await withDirs(async ({ workspaceDir }) => {
      const registry = new BackendRegistry();
      const toolExecutor = fakeToolExecutor();

      await assert.rejects(
        async () => {
          const register = buildAiSdkCellBackendRegistration({
            provider: 'openai',
            model: 'gpt-4o-mini',
            env: {
              OPENAI_API_KEY: 'test-key',
              MAKA_CONTEXT_ARCHIVE_RETRIEVAL: 'on',
              MAKA_CONTEXT_ARCHIVE_RETRIEVAL_MODE: 'histroy_search_gated',
            },
            now: () => 123,
            newId: () => 'id',
          });
          await register(registry, {
            config: {
              id: 'harbor-ai-sdk',
              backend: 'ai-sdk',
              llmConnectionSlug: 'openai',
              model: 'gpt-4o-mini',
            },
            task: { id: 'harbor-cell', instruction: 'solve', workspaceDir },
            workspaceDir,
            realBackendIsolation: { kind: 'external', label: 'Harbor task container', toolExecutor },
            toolExecutor,
          });
        },
        /MAKA_CONTEXT_ARCHIVE_RETRIEVAL_MODE must be one of eager, history_search_gated, got "histroy_search_gated"/,
      );
    });
  });

  test('Harbor context budget env keeps unset or blank archive retrieval knobs unspecified', async () => {
    await withDirs(async ({ workspaceDir }) => {
      const registry = new BackendRegistry();
      const toolExecutor = fakeToolExecutor();
      const register = buildAiSdkCellBackendRegistration({
        provider: 'openai',
        model: 'gpt-4o-mini',
        env: {
          OPENAI_API_KEY: 'test-key',
          MAKA_CONTEXT_ARCHIVE_RETRIEVAL: 'on',
          MAKA_CONTEXT_ARCHIVE_RETRIEVAL_MODE: '',
          MAKA_CONTEXT_ARCHIVE_RETRIEVAL_MAX_RESULTS: '',
          MAKA_CONTEXT_ARCHIVE_RETRIEVAL_MAX_ESTIMATED_TOKENS: '',
          MAKA_CONTEXT_ARCHIVE_RETRIEVAL_MAX_BYTES: '',
        },
        now: () => 123,
        newId: () => 'id',
      });
      await register(registry, {
        config: {
          id: 'harbor-ai-sdk',
          backend: 'ai-sdk',
          llmConnectionSlug: 'openai',
          model: 'gpt-4o-mini',
        },
        task: { id: 'harbor-cell', instruction: 'solve', workspaceDir },
        workspaceDir,
        realBackendIsolation: { kind: 'external', label: 'Harbor task container', toolExecutor },
        toolExecutor,
      });

      const backend = await registry.build('ai-sdk', backendContext(workspaceDir));
      const backendInput = (backend as unknown as {
        input: ReturnType<typeof buildHarborCellContextBudgetBackendOptions>;
      }).input;
      assert.equal(backendInput.contextBudget?.archiveRetrieval?.mode, undefined);
      assert.equal(backendInput.contextBudget?.archiveRetrieval?.maxResults, undefined);
      assert.equal(backendInput.contextBudget?.archiveRetrieval?.maxEstimatedTokens, undefined);
      assert.equal(backendInput.contextBudget?.archiveRetrieval?.maxBytes, undefined);
    });
  });

  test('Harbor context budget env rejects explicit malformed booleans', () => {
    assert.throws(
      () => buildHarborCellContextBudgetBackendOptions({ MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE: 'treu' }),
      /MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE must be a boolean/,
    );
    assert.throws(
      () => buildHarborCellContextBudgetBackendOptions({ MAKA_CONTEXT_ARCHIVE_RETRIEVAL: 'onn' }),
      /MAKA_CONTEXT_ARCHIVE_RETRIEVAL must be a boolean/,
    );
  });

  test('Harbor context budget env treats explicit false-like booleans as disabled', () => {
    // archive retrieval defaults off; stale and active prune default on, so disabling
    // stale/archive alone still leaves an enabled activeToolResultPrune policy.
    assert.deepEqual(
      buildHarborCellContextBudgetBackendOptions({ MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE: 'false' }).contextBudget?.activeToolResultPrune,
      { enabled: true },
    );
    assert.deepEqual(
      buildHarborCellContextBudgetBackendOptions({ MAKA_CONTEXT_ARCHIVE_RETRIEVAL: 'off' }).contextBudget?.activeToolResultPrune,
      { enabled: true },
    );
    assert.deepEqual(
      buildHarborCellContextBudgetBackendOptions({
        MAKA_CONTEXT_ACTIVE_TOOL_RESULT_PRUNE: 'enabled',
      }).contextBudget?.activeToolResultPrune,
      { enabled: true },
    );
  });

  test('Harbor active tool result prune defaults to the measured 2048-token threshold in policy snapshots', () => {
    const snapshot = buildHarborCellContextBudgetPolicySnapshot({
      MAKA_CONTEXT_ACTIVE_TOOL_RESULT_PRUNE: 'on',
    });

    assert.equal(snapshot?.enabled, true);
    if (!snapshot?.enabled) throw new Error('expected context budget snapshot to be enabled');
    assert.equal(snapshot.activeToolResultPrune?.maxCurrentResultEstimatedTokens, 2048);
  });

  test('Harbor active tool result prune is enabled by default without any env', () => {
    const backend = buildHarborCellContextBudgetBackendOptions({});
    assert.equal(backend.contextBudget?.activeToolResultPrune?.enabled, true);
    assert.deepEqual(backend.contextBudget?.activeToolResultPrune, { enabled: true });

    const snapshot = buildHarborCellContextBudgetPolicySnapshot({});
    assert.equal(snapshot?.enabled, true);
    assert.equal(snapshot?.activeToolResultPrune?.enabled, true);
    assert.equal(snapshot?.activeToolResultPrune?.maxCurrentResultEstimatedTokens, 2048);
    assert.equal(snapshot?.activeToolResultPrune?.minStepNumber, 1);
  });

  test('Harbor active tool result prune can be disabled with explicit off', () => {
    const options = buildHarborCellContextBudgetBackendOptions({ MAKA_CONTEXT_ACTIVE_TOOL_RESULT_PRUNE: 'off' });
    assert.equal(options.contextBudget?.activeToolResultPrune, undefined);
    assert.deepEqual(options.contextBudget?.staleToolResultPrune, { enabled: true, minRecentTurnsFull: 2 });
  });

  test('Harbor stale tool result prune is enabled by default without any env', () => {
    const backend = buildHarborCellContextBudgetBackendOptions({});
    // minRecentTurnsFull is set explicitly so the runtime protection window
    // matches the policy snapshot and desktop default instead of the runtime's
    // internal ?? 1 fallback.
    assert.deepEqual(backend.contextBudget?.staleToolResultPrune, { enabled: true, minRecentTurnsFull: 2 });

    const snapshot = buildHarborCellContextBudgetPolicySnapshot({});
    assert.equal(snapshot?.enabled, true);
    assert.equal(snapshot?.staleToolResultPrune?.enabled, true);
    assert.equal(snapshot?.staleToolResultPrune?.maxResultEstimatedTokens, 2048);
    assert.equal(snapshot?.staleToolResultPrune?.minRecentTurnsFull, 2);
  });

  test('Harbor stale tool result prune can be disabled with explicit off', () => {
    const options = buildHarborCellContextBudgetBackendOptions({ MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE: 'off' });
    assert.equal(options.contextBudget?.staleToolResultPrune, undefined);
    assert.deepEqual(options.contextBudget?.activeToolResultPrune, { enabled: true });
  });

  test('Harbor stale tool result prune min recent turns falls back to MAKA_CONTEXT_MIN_RECENT_TURNS', () => {
    const fallback = buildHarborCellContextBudgetBackendOptions({ MAKA_CONTEXT_MIN_RECENT_TURNS: '3' });
    assert.equal(fallback.contextBudget?.staleToolResultPrune?.minRecentTurnsFull, 3);

    const explicit = buildHarborCellContextBudgetBackendOptions({
      MAKA_CONTEXT_MIN_RECENT_TURNS: '3',
      MAKA_CONTEXT_STALE_TOOL_RESULT_MIN_RECENT_TURNS: '5',
    });
    assert.equal(explicit.contextBudget?.staleToolResultPrune?.minRecentTurnsFull, 5);
  });

  test('Harbor context budget is empty when both default-on prunes are explicitly off', () => {
    const env = {
      MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE: 'off',
      MAKA_CONTEXT_ACTIVE_TOOL_RESULT_PRUNE: 'off',
    };
    assert.equal(buildHarborCellContextBudgetBackendOptions({ ...env }).contextBudget, undefined);
    assert.equal(buildHarborCellContextBudgetPolicySnapshot({ ...env }), undefined);
  });

  test('Harbor parses semantic compact policy for headless runs', () => {
    const options = buildHarborCellContextBudgetBackendOptions({
      MAKA_CONTEXT_SEMANTIC_COMPACT: 'on',
      MAKA_CONTEXT_SEMANTIC_COMPACT_MODE: 'replace',
      MAKA_CONTEXT_SEMANTIC_COMPACT_MIN_STEP_NUMBER: '2',
      MAKA_CONTEXT_SEMANTIC_COMPACT_MAX_ACTIVE_ESTIMATED_TOKENS: '4096',
      MAKA_CONTEXT_SEMANTIC_COMPACT_MIN_RECENT_MESSAGES: '3',
      MAKA_CONTEXT_SEMANTIC_COMPACT_MIN_RECENT_TOOL_PAIRS: '2',
      MAKA_CONTEXT_SEMANTIC_COMPACT_MAX_SUMMARY_ESTIMATED_TOKENS: '512',
      MAKA_CONTEXT_SEMANTIC_COMPACT_MIN_SAVINGS_TOKENS: '128',
      MAKA_CONTEXT_SEMANTIC_COMPACT_MIN_SAVINGS_RATIO: '0.2',
      MAKA_CONTEXT_SEMANTIC_COMPACT_MIN_NET_SAVINGS_TOKENS: '256',
      MAKA_CONTEXT_SEMANTIC_COMPACT_CALL_TOKEN_COST_WEIGHT: '0.5',
      MAKA_CONTEXT_SEMANTIC_COMPACT_MAX_CALL_TOKENS: '768',
      MAKA_CONTEXT_SEMANTIC_COMPACT_MAX_CONSECUTIVE_INVALID_SUMMARIES: '3',
      MAKA_CONTEXT_SEMANTIC_COMPACT_INVALID_SUMMARY_COOLDOWN_STEPS: '11',
      MAKA_CONTEXT_SEMANTIC_COMPACT_TIMEOUT_MS: '30000',
      MAKA_CONTEXT_SEMANTIC_COMPACT_ARCHIVE_REQUIRED: 'true',
      MAKA_CONTEXT_SEMANTIC_COMPACT_BENCHMARK_STATE_CARDS: 'true',
      MAKA_CONTEXT_SEMANTIC_COMPACT_MODEL: 'compact-model',
      MAKA_CONTEXT_SEMANTIC_COMPACT_PROMPT_VERSION: 'prompt-v-test',
    });

    assert.equal(options.contextBudget?.semanticCompact?.enabled, true);
    assert.equal(options.contextBudget?.semanticCompact?.mode, 'replace');
    assert.equal(options.contextBudget?.semanticCompact?.minStepNumber, 2);
    assert.equal(options.contextBudget?.semanticCompact?.maxActiveEstimatedTokens, 4096);
    assert.equal(options.contextBudget?.semanticCompact?.minRecentMessages, 3);
    assert.equal(options.contextBudget?.semanticCompact?.minRecentToolPairs, 2);
    assert.equal(options.contextBudget?.semanticCompact?.maxSummaryEstimatedTokens, 512);
    assert.equal(options.contextBudget?.semanticCompact?.minSavingsTokens, 128);
    assert.equal(options.contextBudget?.semanticCompact?.minSavingsRatio, 0.2);
    assert.equal(options.contextBudget?.semanticCompact?.minNetSavingsTokens, 256);
    assert.equal(options.contextBudget?.semanticCompact?.compactCallTokenCostWeight, 0.5);
    assert.equal(options.contextBudget?.semanticCompact?.maxCompactCallTokens, 768);
    assert.equal(options.contextBudget?.semanticCompact?.maxConsecutiveInvalidSummaries, 3);
    assert.equal(options.contextBudget?.semanticCompact?.invalidSummaryCooldownSteps, 11);
    assert.equal(options.contextBudget?.semanticCompact?.timeoutMs, 30000);
    assert.equal(options.contextBudget?.semanticCompact?.archiveRequired, true);
    assert.equal(options.contextBudget?.semanticCompact?.benchmarkStateCards, true);
    assert.equal(options.contextBudget?.semanticCompact?.summarizerModel, 'compact-model');
    assert.equal(options.contextBudget?.semanticCompact?.promptVersion, 'prompt-v-test');

    const snapshot = buildHarborCellContextBudgetPolicySnapshot({
      MAKA_CONTEXT_SEMANTIC_COMPACT: 'on',
      MAKA_CONTEXT_SEMANTIC_COMPACT_MODE: 'validate_only',
      MAKA_CONTEXT_SEMANTIC_COMPACT_MIN_RECENT_TOOL_PAIRS: '1',
      MAKA_CONTEXT_SEMANTIC_COMPACT_MIN_SAVINGS_TOKENS: '64',
    });
    assert.equal(snapshot?.enabled, true);
    if (!snapshot?.enabled) throw new Error('expected context budget snapshot to be enabled');
    assert.equal(snapshot.semanticCompact?.mode, 'validate_only');
    assert.equal(snapshot.semanticCompact?.minRecentToolPairs, 1);
    assert.equal(snapshot.semanticCompact?.minSavingsTokens, 64);
  });

  test('Harbor tool builder keeps the six container-native tools non-interactive', () => {
    const tools = buildHarborCellAiSdkTools(fakeToolExecutor());
    const names = tools.map((tool) => tool.name);

    for (const expected of ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep']) {
      assert.ok(names.includes(expected), `expected Harbor tool ${expected}`);
      assert.equal(tools.find((tool) => tool.name === expected)?.permissionRequired, false);
    }
  });

  test('env entrypoint keeps slashful model ids when provider is explicit', async () => {
    await withDirs(async ({ workspaceDir, outputDir, storageRoot }) => {
      const seenContexts: HeadlessBackendContext[] = [];
      const registerAiSdkBackend = (registry: BackendRegistry, context: HeadlessBackendContext): void => {
        seenContexts.push(context);
        registry.register('ai-sdk', (ctx) =>
          new CellReportingBackend({ sessionId: ctx.sessionId, header: ctx.header, store: ctx.store }, 'ai-sdk'),
        );
      };

      await runHarborCellFromEnv({
        MAKA_INSTRUCTION: 'solve through an OpenAI-compatible gateway',
        MAKA_PROVIDER: 'openai-compatible',
        MAKA_MODEL: 'anthropic/claude-sonnet-4-5',
        MAKA_WORKDIR: workspaceDir,
        MAKA_OUTPUT_DIR: outputDir,
        MAKA_STORAGE_ROOT: storageRoot,
      }, {
        registerBackends: registerAiSdkBackend,
      });

      assert.equal(seenContexts[0].config.llmConnectionSlug, 'openai-compatible');
      assert.equal(seenContexts[0].config.model, 'anthropic/claude-sonnet-4-5');
    });
  });

  test('env entrypoint accepts pi-agent when a Pi backend registration is supplied', async () => {
    await withDirs(async ({ workspaceDir, outputDir, storageRoot }) => {
      const seenContexts: HeadlessBackendContext[] = [];

      const result = await runHarborCellFromEnv({
        MAKA_BACKEND: 'pi-agent',
        MAKA_INSTRUCTION: 'solve through pi',
        MAKA_MODEL: 'pi-test',
        MAKA_WORKDIR: workspaceDir,
        MAKA_OUTPUT_DIR: outputDir,
        MAKA_STORAGE_ROOT: storageRoot,
      }, {
        registerBackends: (registry, context) => {
          seenContexts.push(context);
          registerTestPiAgentBackend(registry, ({ header }) => ({
            async *send(input) {
              assert.equal(input.cwd, workspaceDir);
              assert.equal(input.text, 'solve through pi');
              await writeFile(join(header.cwd, 'pi-cell-proof.txt'), 'ran via pi\n', 'utf8');
              yield { type: 'text_complete', text: 'pi done' };
              yield { type: 'complete' };
            },
          }));
        },
      });

      assert.equal(result.output.status, 'completed');
      assert.equal(await readFile(join(workspaceDir, 'pi-cell-proof.txt'), 'utf8'), 'ran via pi\n');
      assert.equal(seenContexts[0]?.config.backend, 'pi-agent');
      assert.equal(seenContexts[0]?.realBackendIsolation?.kind, 'external');
      assert.equal(seenContexts[0]?.realBackendIsolation?.label, 'Harbor task container');
      assert.equal(typeof seenContexts[0]?.realBackendIsolation?.toolExecutor?.exec, 'function');
    });
  });

  test('env entrypoint keeps Pi-only model ids out of the Maka provider parser', async () => {
    await withDirs(async ({ workspaceDir, outputDir, storageRoot }) => {
      const seenContexts: HeadlessBackendContext[] = [];

      const result = await runHarborCellFromEnv({
        MAKA_BACKEND: 'pi-agent',
        MAKA_INSTRUCTION: 'solve through pi',
        MAKA_MODEL: 'volcengine/glm-5.2',
        MAKA_PI_PROVIDER: 'volcengine-plan',
        MAKA_WORKDIR: workspaceDir,
        MAKA_OUTPUT_DIR: outputDir,
        MAKA_STORAGE_ROOT: storageRoot,
      }, {
        registerBackends: (registry, context) => {
          seenContexts.push(context);
          registerTestPiAgentBackend(registry, () => ({
            async *send() {
              yield { type: 'text_complete', text: 'pi done' };
              yield { type: 'complete' };
            },
          }));
        },
      });

      assert.equal(result.output.status, 'completed');
      assert.equal(seenContexts[0]?.config.backend, 'pi-agent');
      assert.equal(seenContexts[0]?.config.llmConnectionSlug, 'volcengine-plan');
      assert.equal(seenContexts[0]?.config.model, 'volcengine/glm-5.2');
    });
  });

  test('env entrypoint defaults the Pi connection slug when provider is omitted', async () => {
    await withDirs(async ({ workspaceDir, outputDir, storageRoot }) => {
      const seenContexts: HeadlessBackendContext[] = [];

      const result = await runHarborCellFromEnv({
        MAKA_BACKEND: 'pi-agent',
        MAKA_INSTRUCTION: 'solve through pi',
        MAKA_MODEL: 'glm-5.2',
        MAKA_WORKDIR: workspaceDir,
        MAKA_OUTPUT_DIR: outputDir,
        MAKA_STORAGE_ROOT: storageRoot,
      }, {
        registerBackends: (registry, context) => {
          seenContexts.push(context);
          registerTestPiAgentBackend(registry, () => ({
            async *send() {
              yield { type: 'text_complete', text: 'pi done' };
              yield { type: 'complete' };
            },
          }));
        },
      });

      assert.equal(result.output.status, 'completed');
      assert.equal(seenContexts[0]?.config.llmConnectionSlug, 'pi-agent');
      assert.equal(seenContexts[0]?.config.model, 'glm-5.2');
    });
  });

  test('env entrypoint keeps fake backend config explicit', async () => {
    await withDirs(async ({ workspaceDir, outputDir, storageRoot }) => {
      const seenContexts: HeadlessBackendContext[] = [];

      const result = await runHarborCellFromEnv({
        MAKA_BACKEND: 'fake',
        MAKA_INSTRUCTION: 'solve with fake',
        MAKA_WORKDIR: workspaceDir,
        MAKA_OUTPUT_DIR: outputDir,
        MAKA_STORAGE_ROOT: storageRoot,
      }, {
        registerBackends: (registry, context) => {
          seenContexts.push(context);
          registry.register('fake', (ctx) => new CellReportingBackend({
            sessionId: ctx.sessionId,
            header: ctx.header,
            store: ctx.store,
          }));
        },
      });

      assert.equal(result.output.status, 'completed');
      assert.equal(seenContexts[0]?.config.backend, 'fake');
      assert.equal(seenContexts[0]?.config.llmConnectionSlug, 'fake');
      assert.equal(seenContexts[0]?.config.model, 'fake');
    });
  });

  test('env entrypoint registers the Pi CLI transport by default for pi-agent', async () => {
    await withDirs(async ({ workspaceDir, outputDir, storageRoot }) => {
      const piCommand = join(outputDir, 'fake-pi.mjs');
      await writeFile(
        piCommand,
        `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
writeFileSync('pi-default-argv.json', JSON.stringify(process.argv.slice(2)));
writeFileSync('pi-default-stdin.txt', readFileSync(0, 'utf8'));
writeFileSync('pi-default-proof.txt', 'ran via default pi cli\\n');
console.log(JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'pi ok' } }));
console.log(JSON.stringify({ type: 'agent_end', messages: [{ role: 'assistant', usage: { input: 5, output: 2, totalTokens: 7, cost: { total: 0.0003 } } }] }));
`,
        'utf8',
      );
      await chmod(piCommand, 0o755);

      const result = await runHarborCellFromEnv({
        MAKA_BACKEND: 'pi-agent',
        MAKA_INSTRUCTION: 'solve through default pi transport',
        MAKA_MODEL: 'pi-test',
        MAKA_PI_COMMAND: piCommand,
        MAKA_PI_PROVIDER: 'deepseek',
        MAKA_WORKDIR: workspaceDir,
        MAKA_OUTPUT_DIR: outputDir,
        MAKA_STORAGE_ROOT: storageRoot,
      });

      assert.equal(result.output.status, 'completed');
      assert.equal(await readFile(join(workspaceDir, 'pi-default-proof.txt'), 'utf8'), 'ran via default pi cli\n');
      const argv = JSON.parse(await readFile(join(workspaceDir, 'pi-default-argv.json'), 'utf8')) as string[];
      assert.deepEqual(argv.slice(argv.indexOf('--provider'), argv.indexOf('--provider') + 2), ['--provider', 'deepseek']);
      assert.equal(argv.includes('pi-agent'), false);
      assert.deepEqual(argv.slice(argv.indexOf('--model'), argv.indexOf('--model') + 2), ['--model', 'pi-test']);
      assert.equal(argv.at(-1), '-p');
      assert.equal(argv.includes('solve through default pi transport'), false);
      assert.equal(await readFile(join(workspaceDir, 'pi-default-stdin.txt'), 'utf8'), 'solve through default pi transport');
      assert.equal(result.output.tokenSummary.input, 5);
      assert.equal(result.output.tokenSummary.output, 2);
      assert.equal(result.output.tokenSummary.costUsd, 0.0003);
    });
  });

  test('env entrypoint fails fast when default Pi CLI provider is omitted', async () => {
    await withDirs(async ({ workspaceDir, outputDir, storageRoot }) => {
      const keyPath = join(outputDir, 'deepseek-key');
      await writeFile(keyPath, 'deepseek-key\n', 'utf8');

      await assert.rejects(
        runHarborCellFromEnv({
          MAKA_BACKEND: 'pi-agent',
          MAKA_INSTRUCTION: 'solve through default pi transport',
          MAKA_MODEL: 'pi-test',
          MAKA_PI_COMMAND: join(outputDir, 'pi'),
          DEEPSEEK_API_KEY_FILE: keyPath,
          MAKA_WORKDIR: workspaceDir,
          MAKA_OUTPUT_DIR: outputDir,
          MAKA_STORAGE_ROOT: storageRoot,
        }),
        /MAKA_PI_PROVIDER is required when using the default Pi CLI transport/,
      );
    });
  });

  test('env entrypoint passes only Pi provider env to the Pi CLI child', async () => {
    await withDirs(async ({ workspaceDir, outputDir, storageRoot }) => {
      const piCommand = join(outputDir, 'fake-pi-env.mjs');
      await writeFile(
        piCommand,
        `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync('pi-env.json', JSON.stringify({
  openai: process.env.OPENAI_API_KEY,
  anthropic: process.env.ANTHROPIC_API_KEY,
  google: process.env.GOOGLE_API_KEY,
  xiaomi: process.env.XIAOMI_TOKEN_PLAN_CN_API_KEY,
}));
console.log(JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'pi ok' } }));
console.log(JSON.stringify({ type: 'agent_end', messages: [{ role: 'assistant', usage: { input: 5, output: 2, totalTokens: 7 } }] }));
`,
        'utf8',
      );
      await chmod(piCommand, 0o755);

      const result = await runHarborCellFromEnv({
        MAKA_BACKEND: 'pi-agent',
        MAKA_INSTRUCTION: 'solve through scoped pi env',
        MAKA_MODEL: 'pi-test',
        MAKA_PI_COMMAND: piCommand,
        MAKA_PI_PROVIDER: 'volcengine-plan',
        OPENAI_API_KEY: 'openai-key',
        ANTHROPIC_API_KEY: 'anthropic-key',
        GOOGLE_API_KEY: 'google-key',
        XIAOMI_TOKEN_PLAN_CN_API_KEY: 'xiaomi-key',
        MAKA_WORKDIR: workspaceDir,
        MAKA_OUTPUT_DIR: outputDir,
        MAKA_STORAGE_ROOT: storageRoot,
      });

      assert.equal(result.output.status, 'completed');
      assert.deepEqual(JSON.parse(await readFile(join(workspaceDir, 'pi-env.json'), 'utf8')), {
        xiaomi: 'xiaomi-key',
      });
    });
  });

  test('env entrypoint fails the Pi CLI cell on non-JSON stdout', async () => {
    await withDirs(async ({ workspaceDir, outputDir, storageRoot }) => {
      const piCommand = join(outputDir, 'fake-pi-noisy.mjs');
      await writeFile(
        piCommand,
        `#!/usr/bin/env node
console.log('not json');
`,
        'utf8',
      );
      await chmod(piCommand, 0o755);

      const result = await runHarborCellFromEnv({
        MAKA_BACKEND: 'pi-agent',
        MAKA_INSTRUCTION: 'solve through noisy pi transport',
        MAKA_MODEL: 'pi-test',
        MAKA_PI_COMMAND: piCommand,
        MAKA_PI_PROVIDER: 'deepseek',
        MAKA_WORKDIR: workspaceDir,
        MAKA_OUTPUT_DIR: outputDir,
        MAKA_STORAGE_ROOT: storageRoot,
      });

      assert.equal(result.output.status, 'failed');
      assert.equal(result.output.errorClass, 'pi_agent_transport_error');
      assert.match(
        await readFile(join(outputDir, HARBOR_CELL_RUNTIME_EVENTS_FILENAME), 'utf8'),
        /pi emitted non-JSON stdout: not json/,
      );
    });
  });

  test('env entrypoint fails the Pi CLI cell when stdout ends before agent_end', async () => {
    const cases = [
      { name: 'empty', body: '' },
      {
        name: 'wrapper-only',
        body: `
console.log(JSON.stringify({ type: 'session', id: 'session-1' }));
console.log(JSON.stringify({ type: 'turn_start' }));
`,
      },
      {
        name: 'text-without-terminal',
        body: `
console.log(JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'partial' } }));
`,
      },
    ];

    for (const scenario of cases) {
      await withDirs(async ({ workspaceDir, outputDir, storageRoot }) => {
        const piCommand = join(outputDir, `fake-pi-${scenario.name}.mjs`);
        await writeFile(piCommand, `#!/usr/bin/env node\n${scenario.body}`, 'utf8');
        await chmod(piCommand, 0o755);

        const result = await runHarborCellFromEnv({
          MAKA_BACKEND: 'pi-agent',
          MAKA_INSTRUCTION: `solve through incomplete pi transport: ${scenario.name}`,
          MAKA_MODEL: 'pi-test',
          MAKA_PI_COMMAND: piCommand,
          MAKA_PI_PROVIDER: 'deepseek',
          MAKA_WORKDIR: workspaceDir,
          MAKA_OUTPUT_DIR: outputDir,
          MAKA_STORAGE_ROOT: storageRoot,
        });

        assert.equal(result.output.status, 'failed', scenario.name);
        assert.equal(result.output.errorClass, 'pi_agent_transport_error', scenario.name);
        assert.match(
          await readFile(join(outputDir, HARBOR_CELL_RUNTIME_EVENTS_FILENAME), 'utf8'),
          /pi exited before agent_end/,
          scenario.name,
        );
      });
    }
  });

  test('env entrypoint passes long Pi instructions through stdin instead of argv', async () => {
    await withDirs(async ({ workspaceDir, outputDir, storageRoot }) => {
      const piCommand = join(outputDir, 'fake-pi-long-prompt.mjs');
      await writeFile(
        piCommand,
        `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
const argv = process.argv.slice(2);
const prompt = await new Promise((resolve) => {
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { data += chunk; });
  process.stdin.on('end', () => resolve(data));
});
writeFileSync('pi-long-argv.json', JSON.stringify(argv));
writeFileSync('pi-long-prompt-length.txt', String(prompt.length));
console.log(JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'pi ok' } }));
console.log(JSON.stringify({ type: 'agent_end', messages: [{ role: 'assistant', usage: { input: 5, output: 2, totalTokens: 7 } }] }));
`,
        'utf8',
      );
      await chmod(piCommand, 0o755);
      const instruction = `solve long prompt\n${'x'.repeat(128 * 1024)}`;

      const result = await runHarborCellFromEnv({
        MAKA_BACKEND: 'pi-agent',
        MAKA_INSTRUCTION: instruction,
        MAKA_MODEL: 'pi-test',
        MAKA_PI_COMMAND: piCommand,
        MAKA_PI_PROVIDER: 'deepseek',
        MAKA_WORKDIR: workspaceDir,
        MAKA_OUTPUT_DIR: outputDir,
        MAKA_STORAGE_ROOT: storageRoot,
      });

      assert.equal(result.output.status, 'completed');
      const argv = JSON.parse(await readFile(join(workspaceDir, 'pi-long-argv.json'), 'utf8')) as string[];
      assert.equal(argv.at(-1), '-p');
      assert.equal(argv.includes(instruction), false);
      assert.equal(await readFile(join(workspaceDir, 'pi-long-prompt-length.txt'), 'utf8'), String(instruction.length));
    });
  });

  test('env entrypoint fails the Pi CLI cell when the process exits non-zero after agent_end', async () => {
    await withDirs(async ({ workspaceDir, outputDir, storageRoot }) => {
      const piCommand = join(outputDir, 'fake-pi-fails-late.mjs');
      await writeFile(
        piCommand,
        `#!/usr/bin/env node
console.log(JSON.stringify({ type: 'agent_end', messages: [{ role: 'assistant', usage: { input: 5, output: 2, totalTokens: 7 } }] }));
setTimeout(() => {
  console.error('late pi failure');
  process.exit(1);
}, 25);
`,
        'utf8',
      );
      await chmod(piCommand, 0o755);

      const result = await runHarborCellFromEnv({
        MAKA_BACKEND: 'pi-agent',
        MAKA_INSTRUCTION: 'solve through default pi transport',
        MAKA_MODEL: 'pi-test',
        MAKA_PI_COMMAND: piCommand,
        MAKA_PI_PROVIDER: 'deepseek',
        MAKA_WORKDIR: workspaceDir,
        MAKA_OUTPUT_DIR: outputDir,
        MAKA_STORAGE_ROOT: storageRoot,
      });

      assert.equal(result.output.status, 'failed');
      assert.equal(result.output.errorClass, 'pi_agent_transport_error');
      assert.match(
        await readFile(join(outputDir, HARBOR_CELL_RUNTIME_EVENTS_FILENAME), 'utf8'),
        /pi exited with code 1: late pi failure/,
      );
    });
  });

  test('resolves ai-sdk connection env without constructing a network backend', () => {
    const gateway = resolveHarborCellAiSdkEnv({
      provider: 'openai-compatible',
      model: 'anthropic/claude-sonnet-4-5',
      env: {
        OPENAI_API_KEY: 'gateway-key',
        OPENAI_BASE_URL: 'https://gateway.example/v1',
      },
      ts: 123,
    });
    assert.equal(gateway.apiKey, 'gateway-key');
    assert.equal(gateway.connection.providerType, 'openai-compatible');
    assert.equal(gateway.connection.baseUrl, 'https://gateway.example/v1');
    assert.equal(gateway.connection.defaultModel, 'anthropic/claude-sonnet-4-5');

    const deepseek = resolveHarborCellAiSdkEnv({
      provider: 'deepseek',
      model: 'deepseek-chat',
      env: {
        OPENAI_API_KEY: 'fallback-key',
        OPENAI_BASE_URL: 'https://fallback.example/v1',
      },
      ts: 456,
    });
    assert.equal(deepseek.apiKey, 'fallback-key');
    assert.equal(deepseek.connection.baseUrl, 'https://fallback.example/v1');
  });

  test('resolves ai-sdk api key from a *_API_KEY_FILE without exposing the secret on argv', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-cell-key-'));
    try {
      const keyFile = join(dir, 'deepseek-key');
      await writeFile(keyFile, 'sk-secret-from-file\n', 'utf8');
      const resolved = resolveHarborCellAiSdkEnv({
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        env: { DEEPSEEK_API_KEY_FILE: keyFile },
        ts: 1,
      });
      assert.equal(resolved.apiKey, 'sk-secret-from-file');

      // A raw key still wins over the file companion.
      const rawWins = resolveHarborCellAiSdkEnv({
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        env: { DEEPSEEK_API_KEY: 'sk-raw', DEEPSEEK_API_KEY_FILE: keyFile },
        ts: 1,
      });
      assert.equal(rawWins.apiKey, 'sk-raw');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('falls back to stored Maka credentials for secret-free Harbor configs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-cell-credentials-'));
    try {
      const credentialsPath = join(dir, 'credentials.json');
      await writeFile(
        credentialsPath,
        `${JSON.stringify({
          version: 1,
          values: {
            'zai-coding-plan:apiKey': 'stored-zai-secret',
          },
        })}\n`,
        'utf8',
      );

      const stored = resolveHarborCellAiSdkEnv({
        provider: 'zai-coding-plan',
        model: 'glm-5.2',
        env: { MAKA_CREDENTIALS_PATH: credentialsPath },
        ts: 1,
      });
      assert.equal(stored.apiKey, 'stored-zai-secret');

      const rawWins = resolveHarborCellAiSdkEnv({
        provider: 'zai-coding-plan',
        model: 'glm-5.2',
        env: { MAKA_CREDENTIALS_PATH: credentialsPath, ZAI_API_KEY: 'raw-zai-secret' },
        ts: 1,
      });
      assert.equal(rawWins.apiKey, 'raw-zai-secret');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

});

describe('createHarborCellLocalToolExecutor', () => {
  test('lets MAKA_CELL_COMMAND_TIMEOUT_MS lower the default per-command timeout', async () => {
    const executor = createHarborCellLocalToolExecutor({ MAKA_CELL_COMMAND_TIMEOUT_MS: '50' });
    const result = await executor.exec({ command: 'sleep 1', cwd: process.cwd() });
    assert.notEqual(result.exitCode, 0);
  });

  test('lets MAKA_CELL_COMMAND_TIMEOUT_MS lower the bounded-tail Bash default timeout', async () => {
    const executor = createHarborCellLocalToolExecutor({ MAKA_CELL_COMMAND_TIMEOUT_MS: '50' });
    const result = await executor.exec({ command: 'sleep 1', cwd: process.cwd(), boundedTail: true });
    assert.notEqual(result.exitCode, 0);
  });

  test('honors an explicit per-command timeout over the configured default', async () => {
    const executor = createHarborCellLocalToolExecutor({ MAKA_CELL_COMMAND_TIMEOUT_MS: '60000' });
    const result = await executor.exec({ command: 'sleep 1', cwd: process.cwd(), timeoutMs: 50 });
    assert.notEqual(result.exitCode, 0);
  });

  test('runs a quick command to completion under the default timeout', async () => {
    const executor = createHarborCellLocalToolExecutor({});
    const result = await executor.exec({ command: 'printf ok', cwd: process.cwd() });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, 'ok');
  });

  test('scrubs provider API-key env so task commands cannot read the secret', async () => {
    const executor = createHarborCellLocalToolExecutor({
      DEEPSEEK_API_KEY_FILE: '/run/secrets/deepseek-key',
      DEEPSEEK_API_KEY: 'sk-should-not-leak',
    });
    const result = await executor.exec({
      command: 'printf "[%s][%s]" "${DEEPSEEK_API_KEY_FILE:-}" "${DEEPSEEK_API_KEY:-}"',
      cwd: process.cwd(),
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, '[][]');
  });
});

function fakeToolExecutor(): IsolatedToolExecutor {
  return {
    async exec() {
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  };
}

function testIdFactory(): () => string {
  let i = 0;
  return () => `id-${++i}`;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function backendContext(workspaceDir: string): BackendFactoryContext {
  return {
    sessionId: 'session-1',
    workspaceRoot: workspaceDir,
    header: {
      id: 'session-1',
      cwd: workspaceDir,
      workspaceRoot: workspaceDir,
      createdAt: 123,
      lastUsedAt: 123,
      name: 'harbor cell test',
      isFlagged: false,
      labels: [],
      isArchived: false,
      status: 'active',
      hasUnread: false,
      backend: 'ai-sdk',
      llmConnectionSlug: 'openai',
      connectionLocked: true,
      model: 'gpt-4o-mini',
      permissionMode: 'execute',
      schemaVersion: 1,
    },
    store: {
      appendMessage: async () => {},
    } as unknown as SessionStore,
  };
}

async function withDirs<T>(
  fn: (dirs: { workspaceDir: string; outputDir: string; storageRoot: string }) => Promise<T>,
): Promise<T> {
  const workspaceDir = await mkdtemp(join(tmpdir(), 'maka-cell-ws-'));
  const outputDir = await mkdtemp(join(tmpdir(), 'maka-cell-out-'));
  const storageRoot = await mkdtemp(join(tmpdir(), 'maka-cell-store-'));
  try {
    return await fn({ workspaceDir, outputDir, storageRoot });
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
    await rm(outputDir, { recursive: true, force: true });
    await rm(storageRoot, { recursive: true, force: true });
  }
}

describe('Harbor pi CLI env passthrough for MiniMax', () => {
  test('MINIMAX_* rule matches the lowercased provider name', async () => {
    const src = await readFile(new URL('../../src/harbor-cell.ts', import.meta.url), 'utf8');

    // buildPiCliEnv lowercases the provider before matching against the rule's
    // `includes` values, so any rule value with uppercase letters can never
    // match. Guard the MiniMax rule specifically against that regression.
    const ruleMatch = src.match(/\{\s*includes:\s*\[([^\]]*)\][^}]*MINIMAX_API_KEY[^}]*\}/);
    assert.notEqual(ruleMatch, null, 'MiniMax MINIMAX_* env rule must exist');
    const includeValues = ruleMatch![1]
      .split(',')
      .map((raw) => raw.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
    assert.ok(includeValues.length > 0, 'MiniMax env rule must list at least one include token');
    for (const value of includeValues) {
      assert.equal(value, value.toLowerCase(), `env rule include "${value}" must be lowercase to match normalized provider`);
    }
    // The normalized provider names ('minimax' / 'minimax-cn') must actually hit the rule.
    const normalized = ['minimax', 'minimax-cn'];
    for (const provider of normalized) {
      assert.ok(
        includeValues.some((value) => provider.includes(value)),
        `normalized provider "${provider}" must match the MiniMax env rule`,
      );
    }
  });

  test('buildPiCliEnv lowercases the provider before matching', async () => {
    const src = await readFile(new URL('../../src/harbor-cell.ts', import.meta.url), 'utf8');
    const fnIdx = src.indexOf('function buildPiCliEnv');
    assert.notEqual(fnIdx, -1, 'buildPiCliEnv must exist');
    const fnRegion = src.slice(fnIdx, src.indexOf('\n}', fnIdx));
    assert.match(fnRegion, /provider\?\.toLowerCase\(\)/, 'buildPiCliEnv must normalize provider to lowercase');
    assert.match(fnRegion, /normalizedProvider\.includes\(value\)/, 'buildPiCliEnv must match rule values against the normalized provider');
  });
});
