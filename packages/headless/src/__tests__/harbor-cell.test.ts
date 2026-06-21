import assert from 'node:assert/strict';
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
  type PiAgentTransport,
  type SessionStore,
} from '@maka/runtime';
import type { Config } from '../contracts.js';
import type { HeadlessBackendContext } from '../isolation.js';
import {
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

describe('runHarborCell', () => {
  test('runs in the provided workspace and writes the shared cell artifacts', async () => {
    await withDirs(async ({ workspaceDir, outputDir, storageRoot }) => {
      const result = await runHarborCell({
        config,
        instruction: 'write the answer in-place',
        cwd: workspaceDir,
        outputDir,
        storageRoot,
        registerBackends: registerCellBackend,
      });

      assert.equal(await readFile(join(workspaceDir, 'cell-proof.txt'), 'utf8'), 'ran in place\n');
      assert.equal(result.output.status, 'completed');
      assert.equal(result.output.promptHash, 'sha256:cell-prompt');
      assert.equal(result.output.runtimeEventsPath, join(outputDir, HARBOR_CELL_RUNTIME_EVENTS_FILENAME));
      assert.equal(result.output.tokenSummary.costUsd, 0.0042);

      const outputJson = JSON.parse(await readFile(join(outputDir, HARBOR_CELL_OUTPUT_FILENAME), 'utf8'));
      assert.deepEqual(outputJson, result.output);
      const runtimeEvents = await readFile(join(outputDir, HARBOR_CELL_RUNTIME_EVENTS_FILENAME), 'utf8');
      assert.match(runtimeEvents, /"id":"cell-usage"/);
      assert.match(runtimeEvents, /"systemPromptHash":"sha256:cell-prompt"/);
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
      assert.deepEqual(seenContexts[0].realBackendIsolation, {
        kind: 'external',
        label: 'Harbor task container',
      });
    });
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
      assert.deepEqual(seenContexts[0]?.realBackendIsolation, {
        kind: 'external',
        label: 'Harbor task container',
      });
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
        MAKA_WORKDIR: workspaceDir,
        MAKA_OUTPUT_DIR: outputDir,
        MAKA_STORAGE_ROOT: storageRoot,
      });

      assert.equal(result.output.status, 'completed');
      assert.equal(await readFile(join(workspaceDir, 'pi-default-proof.txt'), 'utf8'), 'ran via default pi cli\n');
      const argv = JSON.parse(await readFile(join(workspaceDir, 'pi-default-argv.json'), 'utf8')) as string[];
      assert.equal(argv.includes('--provider'), false);
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

  test('resolves ai-sdk API keys from secret files without embedding the key in job env', async () => {
    await withDirs(async ({ outputDir }) => {
      const keyPath = join(outputDir, 'api-key');
      await writeFile(keyPath, 'file-key\n', 'utf8');

      const resolved = resolveHarborCellAiSdkEnv({
        provider: 'openai-compatible',
        model: 'glm-5.2',
        env: {
          OPENAI_API_KEY_FILE: keyPath,
          OPENAI_BASE_URL: 'https://ark.example/api/coding/v3',
        },
        ts: 789,
      });

      assert.equal(resolved.apiKey, 'file-key');
      assert.equal(resolved.connection.baseUrl, 'https://ark.example/api/coding/v3');
    });
  });
});

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
