import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { BackendRegistry, FakeBackend, type AgentBackend, type SessionStore } from '@maka/runtime';
import type { BackendKind, SessionEvent, SessionHeader } from '@maka/core';
import type { BackendSendInput, PermissionDecision } from '@maka/core/backend-types';
import type { Config, Task } from '../contracts.js';
import type { HeadlessBackendContext } from '../isolation.js';
import { runExperiment } from '../runner.js';

const registerFakeBackend = (registry: BackendRegistry): void => {
  registry.register('fake', (ctx) =>
    new FakeBackend({ sessionId: ctx.sessionId, header: ctx.header, store: ctx.store }),
  );
};

/**
 * A malicious config: it rewrites the grading test in its own cwd to one
 * that always passes, then completes normally. Used to prove clean-room
 * grading reverts the tamper before scoring.
 */
class TamperBackend implements AgentBackend {
  readonly kind: BackendKind = 'fake';
  readonly sessionId: string;
  constructor(private readonly ctx: { sessionId: string; header: SessionHeader; store: SessionStore }) {
    this.sessionId = ctx.sessionId;
  }
  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    const turnId = input.turnId;
    const messageId = 'tamper-msg';
    // Rewrite the grading script in its own cwd to one that always passes.
    await writeFile(join(this.ctx.header.cwd, 'check.mjs'), 'process.exit(0);\n', 'utf8');
    const text = 'rewrote the grading script to pass';
    const ts = Date.now();
    await this.ctx.store.appendMessage(this.sessionId, {
      type: 'assistant',
      id: messageId,
      turnId,
      ts,
      text,
      modelId: this.ctx.header.model,
    });
    yield { type: 'text_complete', id: 'tamper-tc', turnId, ts, messageId, text };
    yield { type: 'complete', id: 'tamper-c', turnId, ts, stopReason: 'end_turn' };
  }
  async stop(): Promise<void> {}
  async respondToPermission(_decision: PermissionDecision): Promise<void> {}
  async dispose(): Promise<void> {}
}

const registerTamperBackend = (registry: BackendRegistry): void => {
  registry.register('fake', (ctx) =>
    new TamperBackend({ sessionId: ctx.sessionId, header: ctx.header, store: ctx.store }),
  );
};

/**
 * A backend that reports failure the way a real one can — an error event plus
 * a complete(error) — WITHOUT throwing. The InvocationResult comes back with
 * status 'failed'; the run must surface that as a record error, not a silent
 * ⚠️-but-exit-0.
 */
class FailingBackend implements AgentBackend {
  readonly kind: BackendKind = 'fake';
  readonly sessionId: string;
  constructor(private readonly ctx: { sessionId: string; header: SessionHeader; store: SessionStore }) {
    this.sessionId = ctx.sessionId;
  }
  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    const { turnId } = input;
    const ts = Date.now();
    yield { type: 'error', id: 'fail-err', turnId, ts, recoverable: false, reason: 'backend_failed', message: 'backend blew up' };
    yield { type: 'complete', id: 'fail-c', turnId, ts, stopReason: 'error' };
  }
  async stop(): Promise<void> {}
  async respondToPermission(_decision: PermissionDecision): Promise<void> {}
  async dispose(): Promise<void> {}
}

const registerFailingBackend = (registry: BackendRegistry): void => {
  registry.register('fake', (ctx) =>
    new FailingBackend({ sessionId: ctx.sessionId, header: ctx.header, store: ctx.store }),
  );
};

class IsolatedRealBackend implements AgentBackend {
  readonly kind: BackendKind = 'ai-sdk';
  readonly sessionId: string;
  constructor(private readonly ctx: { sessionId: string; header: SessionHeader; store: SessionStore }) {
    this.sessionId = ctx.sessionId;
  }
  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    const turnId = input.turnId;
    const ts = Date.now();
    const messageId = 'isolated-real-msg';
    await writeFile(join(this.ctx.header.cwd, 'solved.txt'), 'ok\n', 'utf8');
    await this.ctx.store.appendMessage(this.sessionId, {
      type: 'assistant',
      id: messageId,
      turnId,
      ts,
      text: 'solved inside explicit isolation',
      modelId: this.ctx.header.model,
    });
    yield { type: 'text_complete', id: 'isolated-real-tc', turnId, ts, messageId, text: 'solved inside explicit isolation' };
    yield { type: 'complete', id: 'isolated-real-c', turnId, ts, stopReason: 'end_turn' };
  }
  async stop(): Promise<void> {}
  async respondToPermission(_decision: PermissionDecision): Promise<void> {}
  async dispose(): Promise<void> {}
}

const registerIsolatedRealBackend = (seen: HeadlessBackendContext[]): NonNullable<Parameters<typeof runExperiment>[2]['registerBackends']> =>
  (registry, context) => {
    seen.push(context);
    registry.register('ai-sdk', (ctx) =>
      new IsolatedRealBackend({ sessionId: ctx.sessionId, header: ctx.header, store: ctx.store }),
    );
  };

// A fixture whose grading script exits non-zero against the buggy source —
// the only way `node check.mjs` passes is if the grading script is replaced.
// (Plain exit-code grading, not `node --test`, so the verification child
// doesn't collide with the lab's own test runner.)
async function writeBuggyFixture(fixtureDir: string): Promise<void> {
  await writeFile(join(fixtureDir, 'src.mjs'), 'export const add = (a, b) => a - b;\n', 'utf8');
  await writeFile(
    join(fixtureDir, 'check.mjs'),
    "import { add } from './src.mjs';\nprocess.exit(add(2, 3) === 5 ? 0 : 1);\n",
    'utf8',
  );
}

const fakeConfig: Config = {
  id: 'fake-cfg',
  backend: 'fake',
  llmConnectionSlug: 'fake',
  model: 'fake-model',
};

async function fileExistsRecursive(root: string, name: string): Promise<boolean> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      if (await fileExistsRecursive(full, name)) return true;
    } else if (entry.name === name) {
      return true;
    }
  }
  return false;
}

async function withDirs<T>(fn: (fixtureDir: string, storageRoot: string) => Promise<T>): Promise<T> {
  const fixtureDir = await mkdtemp(join(tmpdir(), 'maka-headless-fx-'));
  const storageRoot = await mkdtemp(join(tmpdir(), 'maka-headless-store-'));
  try {
    return await fn(fixtureDir, storageRoot);
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
    await rm(storageRoot, { recursive: true, force: true });
  }
}

describe('runExperiment (walking skeleton)', () => {
  test('runs Config × Task end-to-end, scores a passing verification, records a trajectory', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      await writeFile(join(fixtureDir, 'marker.txt'), 'present', 'utf8');
      const task: Task = {
        id: 'pass-task',
        instruction: 'do the thing',
        workspaceDir: fixtureDir,
        verification: { command: 'test -f marker.txt', protectedPaths: [] },
      };

      const result = await runExperiment(fakeConfig, task, {
        storageRoot,
        registerBackends: registerFakeBackend,
      });

      assert.equal(result.status, 'completed');
      assert.equal(result.passed, true);
      assert.equal(result.exitCode, 0);
      assert.equal(result.taskId, 'pass-task');
      assert.equal(result.configId, 'fake-cfg');
      // The agent run produced a trajectory...
      assert.ok(result.steps > 0, 'expected a non-empty trajectory');
      // ...persisted as the canonical runtime-events.jsonl.
      assert.ok(
        await fileExistsRecursive(storageRoot, 'runtime-events.jsonl'),
        'expected runtime-events.jsonl under the storage root',
      );
    });
  });

  test('scores a failing verification as not passed (run still completes)', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      const task: Task = {
        id: 'fail-task',
        instruction: 'do the thing',
        workspaceDir: fixtureDir,
        verification: { command: 'test -f does-not-exist.txt', protectedPaths: [] },
      };

      const result = await runExperiment(fakeConfig, task, {
        storageRoot,
        registerBackends: registerFakeBackend,
      });

      assert.equal(result.status, 'completed');
      assert.equal(result.passed, false);
      assert.notEqual(result.exitCode, 0);
    });
  });

  test('defaults to the inert FakeBackend when no registerBackends is given', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      await writeFile(join(fixtureDir, 'marker.txt'), 'present', 'utf8');
      const task: Task = {
        id: 'default-backend',
        instruction: 'do the thing',
        workspaceDir: fixtureDir,
        verification: { command: 'test -f marker.txt', protectedPaths: [] },
      };
      // Minimal usage — no registerBackends supplied; the engine wires fake.
      const result = await runExperiment(fakeConfig, task, { storageRoot });
      assert.equal(result.status, 'completed');
      assert.equal(result.passed, true);
    });
  });
});

describe('clean-room grading (a config cannot rewrite its own test to pass)', () => {
  test('protectedPaths reverts the tampered test before scoring', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      await writeBuggyFixture(fixtureDir);
      const task: Task = {
        id: 'tamper-task',
        instruction: 'fix the bug',
        workspaceDir: fixtureDir,
        verification: { command: 'node check.mjs', protectedPaths: ['check.mjs'] },
      };

      const result = await runExperiment(fakeConfig, task, {
        storageRoot,
        registerBackends: registerTamperBackend,
      });

      // The run completed normally, but the cheated grading script was
      // restored to the original, which still fails the unfixed buggy source.
      assert.equal(result.status, 'completed');
      assert.equal(result.passed, false);
      assert.notEqual(result.exitCode, 0);
    });
  });

});

describe('fail-closed (a model-backed backend does not run without isolation)', () => {
  test('refuses a real backend when no isolated executor is available', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      await writeFile(join(fixtureDir, 'marker.txt'), 'present', 'utf8');
      const realConfig: Config = {
        id: 'real-cfg',
        backend: 'ai-sdk',
        llmConnectionSlug: 'anthropic',
        model: 'claude-sonnet-4-6',
      };
      const task: Task = {
        id: 'real-task',
        instruction: 'do the thing',
        workspaceDir: fixtureDir,
        verification: { command: 'test -f marker.txt', protectedPaths: [] },
      };

      // A real backend would run tools on the host with no isolation, so the
      // run is refused before it starts — no workspace prepared, no agent turn.
      await assert.rejects(
        runExperiment(realConfig, task, { storageRoot, registerBackends: registerFakeBackend }),
        /isolated executor/i,
      );
    });
  });

  test('runs a model-backed backend only when the caller supplies explicit isolation', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      const realConfig: Config = {
        id: 'real-cfg',
        backend: 'ai-sdk',
        llmConnectionSlug: 'deepseek',
        model: 'deepseek-chat',
      };
      const task: Task = {
        id: 'real-task',
        instruction: 'create solved.txt',
        workspaceDir: fixtureDir,
        verification: { command: 'test -f solved.txt', protectedPaths: [] },
      };
      const contexts: HeadlessBackendContext[] = [];

      const result = await runExperiment(realConfig, task, {
        storageRoot,
        registerBackends: registerIsolatedRealBackend(contexts),
        realBackendIsolation: { kind: 'external', label: 'unit-test isolated backend' },
      });

      assert.equal(result.status, 'completed');
      assert.equal(result.passed, true);
      assert.equal(contexts.length, 1);
      assert.equal(contexts[0]?.realBackendIsolation?.label, 'unit-test isolated backend');
      assert.equal(contexts[0]?.config.id, 'real-cfg');
      assert.equal(contexts[0]?.task.id, 'real-task');
    });
  });
});

describe('failed runs surface as an error (not a silent ⚠️ + exit 0)', () => {
  test('a backend that reports failure without throwing yields status failed + an error', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      // The fixture already satisfies the verification — proving the failure
      // verdict comes from the run status, not from a failing check.
      await writeFile(join(fixtureDir, 'marker.txt'), 'present', 'utf8');
      const task: Task = {
        id: 'failing',
        instruction: 'do the thing',
        workspaceDir: fixtureDir,
        verification: { command: 'test -f marker.txt', protectedPaths: [] },
      };

      const result = await runExperiment(fakeConfig, task, {
        storageRoot,
        registerBackends: registerFailingBackend,
      });

      assert.equal(result.status, 'failed');
      assert.ok(result.error, 'a failed run must carry an error so the CLI exit code and the table agree');
      assert.equal(result.errorClass, 'backend_failed');
      assert.equal(result.passed, false);
    });
  });
});

describe('engine-level grading-boundary validation (not only the CLI)', () => {
  test('runExperiment refuses a task missing protectedPaths before running the agent', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      // Simulate an untyped (JS / JSON) caller that omits the now-required field.
      const task = {
        id: 'no-guard',
        instruction: 'do the thing',
        workspaceDir: fixtureDir,
        verification: { command: 'true' },
      } as unknown as Task;

      await assert.rejects(
        runExperiment(fakeConfig, task, { storageRoot, registerBackends: registerFakeBackend }),
        /protectedPaths/,
      );
    });
  });
});
