import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { createConnectionStore, createFileCredentialStore, createShellRunStore } from '@maka/storage';
import { BackendRegistry, type AiSdkBackendInput, type SessionStore } from '@maka/runtime';
import {
  createMakaCliRuntimeContext,
  getOrCreateCliClaudeDeviceId,
  isMakaClaudeSubscriptionCloakEnabled,
} from '../runtime-bootstrap.js';

describe('Maka CLI runtime bootstrap', () => {
  test('loads the default connection and can create an ai-sdk session', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const connectionStore = createConnectionStore(workspaceRoot);
      await connectionStore.create({
        slug: 'local',
        name: 'Local Ollama',
        providerType: 'ollama',
        defaultModel: 'llama3.2',
      });

      const context = await createMakaCliRuntimeContext({
        workspaceRoot,
        cwd: '/repo',
      });
      const session = await context.runtime.createSession({
        cwd: context.cwd,
        backend: 'ai-sdk',
        llmConnectionSlug: context.target.connection.slug,
        model: context.target.model,
        permissionMode: 'bypass',
        name: 'hello',
      });

      assert.equal(context.target.connection.slug, 'local');
      assert.equal(context.target.model, 'llama3.2');
      assert.equal(session.backend, 'ai-sdk');
      assert.equal(session.llmConnectionSlug, 'local');
      assert.equal(session.permissionMode, 'bypass');
    });
  });

  test('registers Edit in the TUI runtime toolset and still requires permission', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const connectionStore = createConnectionStore(workspaceRoot);
      await connectionStore.create({
        slug: 'local',
        name: 'Local Ollama',
        providerType: 'ollama',
        defaultModel: 'llama3.2',
      });

      const context = await createMakaCliRuntimeContext({
        workspaceRoot,
        cwd: '/repo',
      });

      const edit = context.tools.find((tool) => tool.name === 'Edit');
      assert.ok(
        edit,
        'Edit must be registered (regression: it was once filtered out of the TUI runtime)',
      );
      assert.equal(edit?.permissionRequired, true);
    });
  });

  test('enables background ShellRuns for the TUI runtime and cleans them up on close', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const connectionStore = createConnectionStore(workspaceRoot);
      await connectionStore.create({
        slug: 'local',
        name: 'Local Ollama',
        providerType: 'ollama',
        defaultModel: 'llama3.2',
      });

      const context = await createMakaCliRuntimeContext({
        workspaceRoot,
        cwd: workspaceRoot,
      });
      try {
        const names = context.tools.map((tool) => tool.name);
        assert.ok(names.includes('StopBackgroundTask'));

        const bash = context.tools.find((tool) => tool.name === 'Bash');
        assert.ok(bash);
        const read = context.tools.find((tool) => tool.name === 'Read');
        assert.ok(read);
        const command = `${JSON.stringify(process.execPath)} -e "process.stdout.write('start'); setTimeout(() => {}, 5000)"`;
        const result = await bash.impl(
          { command, yield_time_ms: 250 },
          {
            sessionId: 'session-1',
            runId: 'run-1',
            turnId: 'turn-1',
            cwd: workspaceRoot,
            toolCallId: 'tool-1',
            abortSignal: new AbortController().signal,
            emitOutput: () => {},
          },
        ) as { kind: string; ref?: string; status?: string; stdout?: string };

        assert.equal(result.kind, 'shell_run');
        assert.equal(result.status, 'running');
        assert.equal(result.stdout, '');
        assert.ok(result.ref);
        if (!result.ref) throw new Error('expected background task resource ref');

        const detail = await read.impl(
          { path: result.ref },
          {
            sessionId: 'session-1',
            runId: 'run-1',
            turnId: 'turn-1',
            cwd: workspaceRoot,
            toolCallId: 'tool-2',
            abortSignal: new AbortController().signal,
            emitOutput: () => {},
          },
        ) as { content?: string };
        assert.match(detail.content ?? '', /stdout:\nstart/);

        await context.close();
        const record = await createShellRunStore(workspaceRoot).readShellRun('session-1', backgroundTaskId(result.ref));
        assert.equal(record.status, 'cancelled');
        assert.equal(record.exitCode, 130);
      } finally {
        await context.close();
      }
    });
  });

  test('passes the default context budget policy to ai-sdk backends', async () => {
    await withCleanContextBudgetEnv(async () => {
      await withWorkspace(async (workspaceRoot) => {
        const connectionStore = createConnectionStore(workspaceRoot);
        await connectionStore.create({
          slug: 'local',
          name: 'Local Ollama',
          providerType: 'ollama',
          defaultModel: 'llama3.2',
        });

        const context = await createMakaCliRuntimeContext({
          workspaceRoot,
          cwd: '/repo',
        });
        const session = await context.runtime.createSession({
          cwd: context.cwd,
          backend: 'ai-sdk',
          llmConnectionSlug: context.target.connection.slug,
          model: context.target.model,
          permissionMode: 'bypass',
          name: 'budgeted',
        });
        const runtimeDeps = (context.runtime as unknown as RuntimeWithPrivateDeps).deps;
        const header = await runtimeDeps.store.readHeader(session.id);
        const backend = await runtimeDeps.backends.build('ai-sdk', {
          sessionId: session.id,
          workspaceRoot,
          header,
          store: runtimeDeps.store,
        });
        const backendInput = (backend as unknown as { input: AiSdkBackendInput }).input;

        assert.equal(backendInput.contextBudget?.name, 'cli-default-history-budget');
        assert.equal(backendInput.contextBudget?.maxHistoryEstimatedTokens, 32_000);
        assert.equal(backendInput.contextBudget?.activeToolResultPrune?.enabled, true);
        assert.equal(backendInput.contextBudget?.semanticCompact?.enabled, true);
        assert.equal(backendInput.contextBudget?.historyCompact?.enabled, true);
        assert.equal(backendInput.contextBudget?.historyCompact?.mode, 'lookup');
        assert.equal(backendInput.contextBudget?.historyCompact?.tailEstimatedTokens, 1);
      });
    });
  });

  test('adds a bounded lookup budget for providers without a default token budget', async () => {
    await withCleanContextBudgetEnv(async () => {
      process.env.MAKA_CONTEXT_HISTORY_COMPACT = 'on';
      await withWorkspace(async (workspaceRoot) => {
        const connectionStore = createConnectionStore(workspaceRoot);
        await connectionStore.create({
          slug: 'deepseek',
          name: 'DeepSeek',
          providerType: 'deepseek',
          defaultModel: 'deepseek-chat',
        });
        const credentialStore = createFileCredentialStore(workspaceRoot);
        await credentialStore.setSecret('deepseek', 'api_key', 'test-key');

        const context = await createMakaCliRuntimeContext({
          workspaceRoot,
          cwd: '/repo',
        });
        const session = await context.runtime.createSession({
          cwd: context.cwd,
          backend: 'ai-sdk',
          llmConnectionSlug: context.target.connection.slug,
          model: context.target.model,
          permissionMode: 'bypass',
          name: 'budgeted',
        });
        const runtimeDeps = (context.runtime as unknown as RuntimeWithPrivateDeps).deps;
        const header = await runtimeDeps.store.readHeader(session.id);
        const backend = await runtimeDeps.backends.build('ai-sdk', {
          sessionId: session.id,
          workspaceRoot,
          header,
          store: runtimeDeps.store,
        });
        const backendInput = (backend as unknown as { input: AiSdkBackendInput }).input;

        assert.equal(backendInput.contextBudget?.maxHistoryEstimatedTokens, 32_000);
        assert.equal(backendInput.contextBudget?.historyCompact?.mode, 'lookup');
        assert.equal(backendInput.contextBudget?.historyCompact?.highWaterRatio, 0.000001);
        assert.equal(backendInput.contextBudget?.historyCompact?.tailEstimatedTokens, 1);
      });
    });
  });

  test('keeps Claude subscription cloaking enabled unless the emergency opt-out is set', () => {
    assert.equal(isMakaClaudeSubscriptionCloakEnabled({}), true);
    assert.equal(isMakaClaudeSubscriptionCloakEnabled({ MAKA_CLAUDE_SUBSCRIPTION_CLOAK: '1' }), true);
    assert.equal(isMakaClaudeSubscriptionCloakEnabled({ MAKA_CLAUDE_SUBSCRIPTION_CLOAK: '0' }), false);
  });

  test('persists a random Claude device id instead of deriving it from the workspace path', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const pathHash = createHash('sha256').update(workspaceRoot, 'utf8').digest('hex');
      const first = await getOrCreateCliClaudeDeviceId(workspaceRoot, {
        newId: () => '1'.repeat(64),
      });
      const second = await getOrCreateCliClaudeDeviceId(workspaceRoot, {
        newId: () => '2'.repeat(64),
      });

      assert.equal(first, '1'.repeat(64));
      assert.equal(second, first);
      assert.notEqual(first, pathHash);
    });
  });
});

interface RuntimeWithPrivateDeps {
  deps: {
    backends: BackendRegistry;
    store: SessionStore;
  };
}

async function withWorkspace(fn: (workspaceRoot: string) => Promise<void>): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-cli-runtime-'));
  try {
    await fn(workspaceRoot);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

function backgroundTaskId(ref: string): string {
  const id = new URL(ref).pathname.split('/').pop();
  if (!id) throw new Error(`Invalid background task ref: ${ref}`);
  return decodeURIComponent(id);
}

async function withCleanContextBudgetEnv(fn: () => Promise<void>): Promise<void> {
  const saved = new Map<string, string | undefined>();
  for (const key of Object.keys(process.env).filter((key) => key.startsWith('MAKA_CONTEXT_'))) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
