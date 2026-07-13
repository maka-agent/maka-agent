import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  createConnectionStore,
  createFileCredentialStore,
  createSessionStore,
  createShellRunStore,
} from '@maka/storage';
import { BackendRegistry, type AiSdkBackendInput, type SessionStore, type ShellRunUpdate } from '@maka/runtime';
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

  test('uses an explicit connection and forwards one-shot limits and invocation results', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const connectionStore = createConnectionStore(workspaceRoot);
      await connectionStore.create({
        slug: 'default-local',
        name: 'Default local',
        providerType: 'ollama',
        defaultModel: 'default-model',
      });
      await connectionStore.create({
        slug: 'selected-local',
        name: 'Selected local',
        providerType: 'ollama',
        defaultModel: 'selected-model',
      });
      await connectionStore.update('selected-local', {
        models: [{ id: 'requested-model' }],
      });
      const observed: unknown[] = [];
      const observer = (result: unknown): void => { observed.push(result); };
      const permissionRules = [
        { effect: 'deny', kind: 'category', category: 'read' },
      ] as const;

      const context = await createMakaCliRuntimeContext({
        workspaceRoot,
        cwd: '/repo',
        requestedConnectionSlug: 'selected-local',
        requestedModel: 'requested-model',
        maxSteps: 3,
        permissionRules,
        runtimeInvocationObserver: observer,
      });
      try {
        assert.equal(context.target.connection.slug, 'selected-local');
        assert.equal(context.target.model, 'requested-model');
        const session = await context.runtime.createSession({
          cwd: context.cwd,
          backend: 'ai-sdk',
          llmConnectionSlug: context.target.connection.slug,
          model: context.target.model,
          permissionMode: 'explore',
          name: 'one-shot',
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

        assert.equal(backendInput.maxSteps, 3);
        assert.equal(backendInput.permissionRules, permissionRules);
        assert.equal(runtimeDeps.runtimeInvocationObserver, observer);
        assert.deepEqual(observed, []);
      } finally {
        await context.close();
      }
    });
  });

  test('uses a canonical cwd for one resumed backend without rewriting its stored header', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const connectionStore = createConnectionStore(workspaceRoot);
      await connectionStore.create({
        slug: 'local',
        name: 'Local',
        providerType: 'ollama',
        defaultModel: 'model-1',
      });
      const sessionStore = createSessionStore(workspaceRoot);
      const stored = await sessionStore.create({
        cwd: '/stored-link',
        backend: 'ai-sdk',
        llmConnectionSlug: 'local',
        model: 'model-1',
        permissionMode: 'explore',
      });
      const context = await createMakaCliRuntimeContext({
        workspaceRoot,
        cwd: '/canonical-repo',
        requestedConnectionSlug: 'local',
        requestedModel: 'model-1',
        sessionCwdOverride: { sessionId: stored.id, cwd: '/canonical-repo' },
      });
      try {
        const runtimeDeps = (context.runtime as unknown as RuntimeWithPrivateDeps).deps;
        const header = await runtimeDeps.store.readHeader(stored.id);
        const backend = await runtimeDeps.backends.build('ai-sdk', {
          sessionId: stored.id,
          workspaceRoot,
          header,
          store: runtimeDeps.store,
        });
        const backendInput = (backend as unknown as { input: AiSdkBackendInput }).input;

        assert.equal(backendInput.header.cwd, '/canonical-repo');
        assert.equal((await sessionStore.readHeader(stored.id)).cwd, '/stored-link');
      } finally {
        await context.close();
      }
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

  test('registers the Skill tool so the CLI can load workspace skills', async () => {
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
      try {
        const skill = context.tools.find((tool) => tool.name === 'Skill');
        assert.ok(skill, 'Skill tool must be registered on the CLI host');
      } finally {
        await context.close();
      }
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
          { command, run_in_background: true },
          {
            sessionId: 'session-1',
            runId: 'run-1',
            turnId: 'turn-1',
            cwd: workspaceRoot,
            toolCallId: 'tool-1',
            abortSignal: new AbortController().signal,
            emitOutput: () => {},
          },
        ) as {
          kind: string;
          ref?: string;
          status?: string;
          output?: { mode: string; stdout?: string };
        };

        assert.equal(result.kind, 'shell_run');
        assert.equal(result.status, 'running');
        assert.equal(result.output, undefined);
        assert.ok(result.ref);
        if (!result.ref) throw new Error('expected background task resource ref');
        const detail = await waitFor(async () => {
          const snapshot = await read.impl(
            { ref: result.ref },
            {
              sessionId: 'session-1',
              runId: 'run-1',
              turnId: 'turn-1',
              cwd: workspaceRoot,
              toolCallId: 'tool-2',
              abortSignal: new AbortController().signal,
              emitOutput: () => {},
            },
          ) as {
            kind?: string;
            status?: string;
            output?: { mode: string; stdout?: string };
          };
          return snapshot.output?.stdout === 'start' ? snapshot : undefined;
        });
        assert.equal(detail.kind, 'shell_run');
        assert.equal(detail.status, 'running');
        assert.equal(detail.output?.mode, 'pipes');
        assert.equal(detail.output?.stdout, 'start');

        await context.close();
        const record = await createShellRunStore(workspaceRoot).readShellRun('session-1', backgroundTaskId(result.ref));
        assert.equal(record.status, 'cancelled');
        assert.equal(record.exitCode, 130);
      } finally {
        await context.close();
      }
    });
  });

  test('publishes background ShellRun completion without a model resource read', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const connectionStore = createConnectionStore(workspaceRoot);
      await connectionStore.create({
        slug: 'local', name: 'Local Ollama', providerType: 'ollama', defaultModel: 'llama3.2',
      });
      const context = await createMakaCliRuntimeContext({ workspaceRoot, cwd: workspaceRoot });
      const updates: ShellRunUpdate[] = [];
      const unsubscribe = context.subscribeShellRunUpdates((update) => updates.push(update));
      try {
        const bash = context.tools.find((tool) => tool.name === 'Bash');
        assert.ok(bash);
        const command = `${JSON.stringify(process.execPath)} -e "process.stdout.write('start'); setTimeout(() => process.stdout.write('done'), 500)"`;
        const result = await bash.impl(
          { command, run_in_background: true },
          {
            sessionId: 'session-1', runId: 'run-1', turnId: 'turn-1',
            cwd: workspaceRoot, toolCallId: 'tool-1',
            abortSignal: new AbortController().signal, emitOutput: () => {},
          },
        ) as { kind?: string; status?: string };
        assert.equal(result.kind, 'shell_run');
        assert.equal(result.status, 'running');

        const terminal = await waitFor(() => updates.find((update) => update.result.status === 'completed'));
        assert.equal(terminal.sourceToolCallId, 'tool-1');
        assert.equal(
          terminal.result.output?.mode === 'pipes' ? terminal.result.output.stdout : '',
          'startdone',
        );
      } finally {
        unsubscribe();
        await context.close();
      }
    });
  });

  test('exposes canonical ShellRun updates through the runtime context', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const connectionStore = createConnectionStore(workspaceRoot);
      await connectionStore.create({
        slug: 'local', name: 'Local Ollama', providerType: 'ollama', defaultModel: 'llama3.2',
      });
      const context = await createMakaCliRuntimeContext({ workspaceRoot, cwd: workspaceRoot });
      try {
        const parent = await context.runtime.createSession({
          cwd: workspaceRoot, backend: 'ai-sdk', llmConnectionSlug: 'local',
          model: 'llama3.2', permissionMode: 'bypass', name: 'parent',
        });
        const bash = context.tools.find((tool) => tool.name === 'Bash');
        assert.ok(bash);
        const command = `${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 5000)"`;
        const started = await bash.impl(
          { command, run_in_background: true },
          {
            sessionId: parent.id, runId: 'run-1', turnId: 'turn-1',
            cwd: workspaceRoot, toolCallId: 'tool-1',
            abortSignal: new AbortController().signal, emitOutput: () => {},
          },
        ) as { kind?: string; ref?: string; status?: string };
        assert.equal(started.status, 'running');
        assert.ok(started.ref);

        const updates = await context.listShellRunUpdates(parent.id);
        const update = updates.find((candidate) => candidate.result.ref === started.ref);
        assert.deepEqual(update?.ownership, { kind: 'local' });
        assert.equal(update?.result.status, 'running');
      } finally {
        await context.close();
      }
    });
  });

  test('hydrates terminal ShellRun state without marking it observed by the agent', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const connectionStore = createConnectionStore(workspaceRoot);
      await connectionStore.create({
        slug: 'local', name: 'Local Ollama', providerType: 'ollama', defaultModel: 'llama3.2',
      });
      const context = await createMakaCliRuntimeContext({ workspaceRoot, cwd: workspaceRoot });
      try {
        const bash = context.tools.find((tool) => tool.name === 'Bash');
        assert.ok(bash);
        const command = `${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 500)"`;
        const started = await bash.impl(
          { command, run_in_background: true },
          {
            sessionId: 'session-1', runId: 'run-1', turnId: 'turn-1',
            cwd: workspaceRoot, toolCallId: 'tool-1',
            abortSignal: new AbortController().signal, emitOutput: () => {},
          },
        ) as { ref?: string; status?: string };
        assert.equal(started.status, 'running');
        assert.ok(started.ref);

        const hydrated = await waitFor(async () => {
          const updates = await context.listShellRunUpdates('session-1');
          const snapshot = updates.find((candidate) => candidate.result.ref === started.ref);
          return snapshot?.result.status === 'completed' ? snapshot : undefined;
        });
        assert.equal(hydrated.result.status, 'completed');
        const stored = await createShellRunStore(workspaceRoot).readShellRun(
          'session-1',
          backgroundTaskId(started.ref),
        );
        assert.equal(stored.observedAt, undefined);
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
        // In-turn semantic compaction is stripped for the CLI: it interrupts the
        // live reply with a compaction notice for small savings. History/turn
        // compaction stays.
        assert.equal(backendInput.contextBudget?.semanticCompact, undefined);
        assert.equal(backendInput.contextBudget?.historyCompact?.enabled, true);
        assert.equal(backendInput.contextBudget?.historyCompact?.mode, 'read_write');
        assert.equal(backendInput.contextBudget?.historyCompact?.highWaterRatio, 1);
        assert.equal(backendInput.contextBudget?.historyCompact?.tailEstimatedTokens, 16_384);
        assert.equal(backendInput.contextBudget?.historyCompact?.minRecentTurns, 3);
      });
    });
  });

  test('honors an explicit MAKA_CONTEXT_SEMANTIC_COMPACT opt-in', async () => {
    await withCleanContextBudgetEnv(async () => {
      process.env.MAKA_CONTEXT_SEMANTIC_COMPACT = 'on';
      try {
        await withWorkspace(async (workspaceRoot) => {
          const connectionStore = createConnectionStore(workspaceRoot);
          await connectionStore.create({
            slug: 'local',
            name: 'Local Ollama',
            providerType: 'ollama',
            defaultModel: 'llama3.2',
          });

          const context = await createMakaCliRuntimeContext({ workspaceRoot, cwd: '/repo' });
          const session = await context.runtime.createSession({
            cwd: context.cwd,
            backend: 'ai-sdk',
            llmConnectionSlug: context.target.connection.slug,
            model: context.target.model,
            permissionMode: 'bypass',
            name: 'semantic-opt-in',
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

          // The CLI default strips semantic compaction, but an explicit env
          // opt-in must reach the backend so the path stays exercisable.
          assert.equal(backendInput.contextBudget?.semanticCompact?.enabled, true);
        });
      } finally {
        delete process.env.MAKA_CONTEXT_SEMANTIC_COMPACT;
      }
    });
  });

  test('keeps ordinary send policy read-write for providers without a context-window budget', async () => {
    await withCleanContextBudgetEnv(async () => {
      process.env.MAKA_CONTEXT_HISTORY_COMPACT = 'on';
      await withWorkspace(async (workspaceRoot) => {
        const connectionStore = createConnectionStore(workspaceRoot);
        await connectionStore.create({
          slug: 'deepseek',
          name: 'DeepSeek',
          providerType: 'deepseek',
          defaultModel: 'custom-deepseek-model',
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

        assert.equal(backendInput.contextBudget?.maxHistoryEstimatedTokens, undefined);
        assert.equal(backendInput.contextBudget?.historyCompact?.mode, 'read_write');
        assert.equal(backendInput.contextBudget?.historyCompact?.highWaterRatio, 1);
        assert.equal(backendInput.contextBudget?.historyCompact?.tailEstimatedTokens, 16_384);
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
    runtimeInvocationObserver?: (result: unknown) => void | Promise<void>;
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

async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for ShellRun state');
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
