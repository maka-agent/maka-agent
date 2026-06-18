import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { BackendRegistry, FakeBackend, SessionManager, type SessionStore, type AgentBackend } from '@maka/runtime';
import type { BackendKind, SessionEvent, SessionHeader } from '@maka/core';
import type { BackendSendInput, PermissionDecision } from '@maka/core/backend-types';
import type { Config, Task } from '../contracts.js';
import { runAutonomousTask } from '../autonomous-agent-loop.js';

const fakeConfig: Config = {
  id: 'fake-cfg',
  backend: 'fake',
  llmConnectionSlug: 'fake',
  model: 'fake-model',
};

const registerFakeBackend = (registry: BackendRegistry): void => {
  registry.register('fake', (ctx) =>
    new FakeBackend({ sessionId: ctx.sessionId, header: ctx.header, store: ctx.store }),
  );
};

class PermissionRequestBackend implements AgentBackend {
  readonly kind: BackendKind = 'fake';
  readonly sessionId: string;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    const ts = Date.now();
    yield {
      type: 'permission_request',
      id: 'permission-request-event',
      turnId: input.turnId,
      ts,
      requestId: 'permission-request-1',
      toolUseId: 'tool-1',
      toolName: 'Bash',
      category: 'shell_unsafe',
      reason: 'shell_dangerous',
      args: { command: 'rm -rf /tmp/example' },
    };
    yield { type: 'complete', id: 'permission-complete', turnId: input.turnId, ts, stopReason: 'permission_handoff' };
  }

  async stop(): Promise<void> {}
  async respondToPermission(_decision: PermissionDecision): Promise<void> {}
  async dispose(): Promise<void> {}
}

const registerPermissionRequestBackend = (registry: BackendRegistry): void => {
  registry.register('fake', (ctx) => new PermissionRequestBackend(ctx.sessionId));
};

async function withDirs<T>(fn: (fixtureDir: string, storageRoot: string) => Promise<T>): Promise<T> {
  const fixtureDir = await mkdtemp(join(tmpdir(), 'maka-autonomous-loop-fx-'));
  const storageRoot = await mkdtemp(join(tmpdir(), 'maka-autonomous-loop-store-'));
  try {
    return await fn(fixtureDir, storageRoot);
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
    await rm(storageRoot, { recursive: true, force: true });
  }
}

function idFactory(): () => string {
  let i = 0;
  return () => `id-${++i}`;
}

describe('runAutonomousTask', () => {
  test('uses RuntimeRunner path without SessionManager.sendMessage', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      await writeFile(join(fixtureDir, 'marker.txt'), 'present', 'utf8');
      const original = SessionManager.prototype.sendMessage;
      SessionManager.prototype.sendMessage = async function* () {
        throw new Error('autonomous loop must not use interactive sendMessage');
      } as typeof original;
      try {
        const task: Task = {
          id: 'no-send-message',
          instruction: 'do the thing',
          workspaceDir: fixtureDir,
          verification: { command: 'test -f marker.txt', protectedPaths: [] },
        };

        const result = await runAutonomousTask(fakeConfig, task, {
          storageRoot,
          registerBackends: registerFakeBackend,
          budget: { maxAttempts: 2 },
          newId: idFactory(),
        });

        assert.equal(result.attempts.length, 1);
        assert.equal(result.resultRecord.passed, true);
        assert.equal(result.projection.status, 'completed');
      } finally {
        SessionManager.prototype.sendMessage = original;
      }
    });
  });

  test('runs one passing attempt and records stop decision', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      await writeFile(join(fixtureDir, 'marker.txt'), 'present', 'utf8');
      const task: Task = {
        id: 'pass-task',
        instruction: 'do the thing',
        workspaceDir: fixtureDir,
        verification: { command: 'test -f marker.txt', protectedPaths: [] },
      };

      const result = await runAutonomousTask(fakeConfig, task, {
        storageRoot,
        registerBackends: registerFakeBackend,
        budget: { maxAttempts: 3 },
        newId: idFactory(),
      });

      assert.equal(result.attempts.length, 1);
      assert.equal(result.resultRecord.passed, true);
      assert.equal(result.projection.status, 'completed');
      assert.equal(result.projection.latestScoreResult?.taxonomy, 'passed');
      assert.equal(result.projection.decisions[0]?.decision, 'stop');
      assert.equal(result.projection.decisions[0]?.reason, 'authoritative verification passed');
      assert.equal(result.projection.feedback.some((entry) => entry.source === 'verifier'), true);
      assert.deepEqual(
        result.projection.events
          .filter((event) => event.type.startsWith('task_run_'))
          .map((event) => event.type),
        [
          'task_run_created',
          'task_run_queued',
          'task_run_started',
          'task_run_verifying',
          'task_run_completed',
        ],
      );
    });
  });

  test('continues after verifier failure until maxAttempts records budget terminal', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      const task: Task = {
        id: 'verify-fails',
        instruction: 'do the thing',
        workspaceDir: fixtureDir,
        verification: { command: 'test -f missing.txt', protectedPaths: [] },
      };

      const result = await runAutonomousTask(fakeConfig, task, {
        storageRoot,
        registerBackends: registerFakeBackend,
        budget: { maxAttempts: 2 },
        newId: idFactory(),
      });

      assert.equal(result.attempts.length, 2);
      assert.equal(result.resultRecord.passed, false);
      assert.equal(result.projection.status, 'budget_exhausted');
      assert.equal(result.projection.latestScoreResult?.taxonomy, 'verification_failed');
      assert.deepEqual(result.projection.decisions.map((decision) => decision.decision), ['continue', 'stop']);
      assert.equal(result.projection.error?.class, 'budget_exhausted');
      assert.equal(
        result.projection.events.filter((event) => event.type === 'task_run_budget_exhausted').length,
        1,
      );
    });
  });

  test('self-check pass-like language is non-authoritative when verifier fails', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      const task: Task = {
        id: 'self-check-does-not-score',
        instruction: 'do the thing',
        workspaceDir: fixtureDir,
        verification: { command: 'test -f missing.txt', protectedPaths: [] },
      };

      const result = await runAutonomousTask(fakeConfig, task, {
        storageRoot,
        registerBackends: registerFakeBackend,
        budget: { maxAttempts: 1 },
        selfCheck: {
          observe: () => ({ summary: 'self-check passed: looks solved', details: { passed: true } }),
        },
        newId: idFactory(),
      });

      assert.equal(result.projection.selfChecks[0]?.summary, 'self-check passed: looks solved');
      assert.equal(result.resultRecord.passed, false);
      assert.equal(result.projection.result?.passed, false);
      assert.equal(result.projection.latestScoreResult?.taxonomy, 'verification_failed');
      assert.notEqual(result.projection.latestScoreResult?.taxonomy, 'passed');
      assert.equal(result.projection.status, 'budget_exhausted');
    });
  });

  test('maxRuntimeSteps fails closed after an over-cap attempt', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      const task: Task = {
        id: 'runtime-step-cap',
        instruction: 'do the thing',
        workspaceDir: fixtureDir,
        verification: { command: 'test -f missing.txt', protectedPaths: [] },
      };

      const result = await runAutonomousTask(fakeConfig, task, {
        storageRoot,
        registerBackends: registerFakeBackend,
        budget: { maxAttempts: 3, maxRuntimeSteps: 1 },
        newId: idFactory(),
      });

      assert.equal(result.attempts.length, 1);
      assert.equal(result.projection.status, 'budget_exhausted');
      assert.equal(result.projection.decisions[0]?.reason, 'runtime step cap reached');
      assert.equal(result.projection.error?.class, 'budget_exhausted');
    });
  });

  test('maxWallTimeMs fails closed before starting another attempt', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      const task: Task = {
        id: 'wall-cap',
        instruction: 'do the thing',
        workspaceDir: fixtureDir,
        verification: { command: 'test -f missing.txt', protectedPaths: [] },
      };
      let t = 0;

      const result = await runAutonomousTask(fakeConfig, task, {
        storageRoot,
        registerBackends: registerFakeBackend,
        budget: { maxAttempts: 3, maxWallTimeMs: 1 },
        now: () => {
          t += 10;
          return t;
        },
        newId: idFactory(),
      });

      assert.equal(result.attempts.length, 0);
      assert.equal(result.projection.status, 'budget_exhausted');
      assert.equal(result.projection.feedback[0]?.source, 'system');
      assert.equal(result.projection.error?.class, 'budget_exhausted');
    });
  });

  test('non-retryable policy-denied taxonomy stops without continuation', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      const task: Task = {
        id: 'policy-denied',
        instruction: 'run a dangerous command',
        workspaceDir: fixtureDir,
        verification: { command: 'true', protectedPaths: [] },
      };

      const result = await runAutonomousTask(fakeConfig, task, {
        storageRoot,
        registerBackends: registerPermissionRequestBackend,
        budget: { maxAttempts: 3 },
        newId: idFactory(),
      });

      assert.equal(result.attempts.length, 1);
      assert.equal(result.projection.status, 'policy_denied');
      assert.equal(result.projection.decisions[0]?.decision, 'stop');
      assert.equal(result.projection.latestScoreResult?.taxonomy, 'policy_denied');
    });
  });
});
