import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { BackendRegistry, FakeBackend, SessionManager, type AgentBackend, type SessionStore } from '@maka/runtime';
import type { BackendKind, SessionEvent, SessionHeader } from '@maka/core';
import type { BackendSendInput, PermissionDecision } from '@maka/core/backend-types';
import type { Config, Task } from '../contracts.js';
import { runTaskOnce } from '../task-agent-controller.js';

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

class ReportingBackend implements AgentBackend {
  readonly kind: BackendKind = 'ai-sdk';
  readonly sessionId: string;

  constructor(private readonly ctx: { sessionId: string; header: SessionHeader; store: SessionStore }) {
    this.sessionId = ctx.sessionId;
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    const { turnId } = input;
    const ts = Date.now();
    const messageId = 'reporting-message';
    await this.ctx.store.appendMessage(this.sessionId, {
      type: 'assistant',
      id: messageId,
      turnId,
      ts,
      text: 'done',
      modelId: this.ctx.header.model,
    });
    yield { type: 'text_complete', id: 'report-text', turnId, ts, messageId, text: 'done' };
    yield {
      type: 'tool_result',
      id: 'report-artifact',
      turnId,
      ts,
      toolUseId: 'tool-1',
      isError: false,
      content: {
        kind: 'archived_tool_result',
        status: 'not_loaded',
        runtimeEventId: 'runtime-old',
        toolCallId: 'tool-1',
        toolName: 'bash',
        artifactId: 'artifact-1',
        originalEstimatedTokens: 12,
        originalBytes: 34,
        rewriteVersion: 1,
        reason: 'stale_tool_result_pruned_before_compact',
      },
    };
    yield {
      type: 'token_usage',
      id: 'report-usage',
      turnId,
      ts,
      input: 10,
      output: 5,
      reasoning: 2,
      total: 17,
      costUsd: 0.123,
      contextBudget: { policyName: 'unit-budget', droppedTurns: 1 } as never,
    };
    yield { type: 'complete', id: 'report-complete', turnId, ts, stopReason: 'end_turn' };
  }

  async stop(): Promise<void> {}
  async respondToPermission(_decision: PermissionDecision): Promise<void> {}
  async dispose(): Promise<void> {}
}

const registerReportingBackend = (registry: BackendRegistry): void => {
  registry.register('ai-sdk', (ctx) =>
    new ReportingBackend({ sessionId: ctx.sessionId, header: ctx.header, store: ctx.store }),
  );
};

class FailingBackend implements AgentBackend {
  readonly kind: BackendKind = 'fake';
  readonly sessionId: string;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    const ts = Date.now();
    yield {
      type: 'error',
      id: 'fail-error',
      turnId: input.turnId,
      ts,
      recoverable: false,
      reason: 'backend_failed',
      message: 'backend exploded',
    };
    yield { type: 'complete', id: 'fail-complete', turnId: input.turnId, ts, stopReason: 'error' };
  }

  async stop(): Promise<void> {}
  async respondToPermission(_decision: PermissionDecision): Promise<void> {}
  async dispose(): Promise<void> {}
}

const registerFailingBackend = (registry: BackendRegistry): void => {
  registry.register('fake', (ctx) => new FailingBackend(ctx.sessionId));
};

class IncompleteBackend implements AgentBackend {
  readonly kind: BackendKind = 'fake';
  readonly sessionId: string;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    const ts = Date.now();
    yield {
      type: 'token_usage',
      id: 'incomplete-usage',
      turnId: input.turnId,
      ts,
      input: 1,
      output: 2,
      rawFinishReason: 'tool_calls',
    };
    yield { type: 'complete', id: 'incomplete-complete', turnId: input.turnId, ts, stopReason: 'end_turn' };
  }

  async stop(): Promise<void> {}
  async respondToPermission(_decision: PermissionDecision): Promise<void> {}
  async dispose(): Promise<void> {}
}

const registerIncompleteBackend = (registry: BackendRegistry): void => {
  registry.register('fake', (ctx) => new IncompleteBackend(ctx.sessionId));
};

class PermissionRequestBackend implements AgentBackend {
  readonly kind: BackendKind = 'fake';
  readonly sessionId: string;

  constructor(sessionId: string, private readonly onRespond: () => void) {
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
  async respondToPermission(_decision: PermissionDecision): Promise<void> {
    this.onRespond();
    throw new Error('headless task facade must not answer interactive permission requests');
  }
  async dispose(): Promise<void> {}
}

const registerPermissionRequestBackend = (onRespond: () => void) => (registry: BackendRegistry): void => {
  registry.register('fake', (ctx) => new PermissionRequestBackend(ctx.sessionId, onRespond));
};

async function withDirs<T>(fn: (fixtureDir: string, storageRoot: string) => Promise<T>): Promise<T> {
  const fixtureDir = await mkdtemp(join(tmpdir(), 'maka-task-controller-fx-'));
  const storageRoot = await mkdtemp(join(tmpdir(), 'maka-task-controller-store-'));
  try {
    return await fn(fixtureDir, storageRoot);
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
    await rm(storageRoot, { recursive: true, force: true });
  }
}

describe('runTaskOnce', () => {
  test('uses RuntimeRunner path without SessionManager.sendMessage and writes a passing ledger', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      await writeFile(join(fixtureDir, 'marker.txt'), 'present', 'utf8');
      const original = SessionManager.prototype.sendMessage;
      SessionManager.prototype.sendMessage = async function* () {
        throw new Error('interactive sendMessage path must not be used');
      } as typeof original;
      try {
        const task: Task = {
          id: 'pass-task',
          instruction: 'do the thing',
          workspaceDir: fixtureDir,
          verification: { command: 'test -f marker.txt', protectedPaths: [] },
        };

        const result = await runTaskOnce(fakeConfig, task, {
          storageRoot,
          registerBackends: registerFakeBackend,
        });

        assert.equal(result.resultRecord.status, 'completed');
        assert.equal(result.resultRecord.passed, true);
        assert.equal(result.projection.status, 'completed');
        assert.equal(result.projection.latestScoreResult?.passed, true);
        assert.deepEqual(
          result.projection.events.map((event) => event.type),
          [
            'task_run_created',
            'task_run_queued',
            'task_run_started',
            'task_attempt_started',
            'feedback_observed',
            'task_run_verifying',
            'verifier_result_recorded',
            'score_result_recorded',
            'task_attempt_completed',
            'task_run_completed',
          ],
        );
      } finally {
        SessionManager.prototype.sendMessage = original;
      }
    });
  });

  test('records a failing verifier as a completed task run with passed=false', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      const task: Task = {
        id: 'verify-fails',
        instruction: 'do the thing',
        workspaceDir: fixtureDir,
        verification: { command: 'test -f missing.txt', protectedPaths: [] },
      };

      const result = await runTaskOnce(fakeConfig, task, {
        storageRoot,
        registerBackends: registerFakeBackend,
      });

      assert.equal(result.resultRecord.status, 'completed');
      assert.equal(result.resultRecord.passed, false);
      assert.equal(result.projection.status, 'completed');
      assert.equal(result.projection.result?.passed, false);
      assert.equal(result.projection.latestScoreResult?.taxonomy, 'verification_failed');
    });
  });

  test('maps backend failure and incomplete runtime to terminal failure taxonomy', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      await writeFile(join(fixtureDir, 'marker.txt'), 'present', 'utf8');
      const task: Task = {
        id: 'backend-fails',
        instruction: 'do the thing',
        workspaceDir: fixtureDir,
        verification: { command: 'test -f marker.txt', protectedPaths: [] },
      };

      const failed = await runTaskOnce(fakeConfig, task, {
        storageRoot,
        taskRunId: 'backend-failure-run',
        registerBackends: registerFailingBackend,
      });
      assert.equal(failed.resultRecord.status, 'failed');
      assert.equal(failed.projection.status, 'failed');
      assert.equal(failed.projection.latestScoreResult?.taxonomy, 'agent_failed');
      assert.equal(failed.projection.error?.class, 'backend_failed');

      const incomplete = await runTaskOnce(fakeConfig, task, {
        storageRoot,
        taskRunId: 'incomplete-run',
        registerBackends: registerIncompleteBackend,
      });
      assert.equal(incomplete.resultRecord.status, 'failed');
      assert.equal(incomplete.projection.status, 'incomplete');
      assert.equal(incomplete.projection.latestScoreResult?.taxonomy, 'agent_incomplete');
    });
  });

  test('fails closed on permission requests without answering the interactive permission API', async () => {
    await withDirs(async (_fixtureDir, storageRoot) => {
      let respondCalls = 0;
      const task: Task = {
        id: 'permission-handoff',
        instruction: 'run a dangerous command',
        workspaceDir: _fixtureDir,
        verification: { command: 'true', protectedPaths: [] },
      };

      const result = await runTaskOnce(fakeConfig, task, {
        storageRoot,
        registerBackends: registerPermissionRequestBackend(() => {
          respondCalls += 1;
        }),
      });

      assert.equal(respondCalls, 0);
      assert.equal(result.resultRecord.status, 'failed');
      assert.equal(result.resultRecord.passed, false);
      assert.equal(result.resultRecord.errorClass, 'policy_denied');
      assert.equal(result.projection.status, 'policy_denied');
      assert.equal(result.projection.latestVerifierResult?.exitCode, 0);
      assert.equal(result.projection.latestScoreResult?.passed, false);
      assert.equal(result.projection.latestScoreResult?.taxonomy, 'policy_denied');
      assert.ok(
        result.projection.events.some((event) => event.type === 'task_run_policy_denied'),
        'expected a policy-denied terminal task event',
      );
    });
  });

  test('persists runtime refs, isolation, budget, and artifact metadata', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      await writeFile(join(fixtureDir, 'marker.txt'), 'present', 'utf8');
      const task: Task = {
        id: 'metadata-task',
        instruction: 'do the thing',
        workspaceDir: fixtureDir,
        verification: { command: 'test -f marker.txt', protectedPaths: [] },
      };
      const config: Config = {
        id: 'real-cfg',
        backend: 'ai-sdk',
        llmConnectionSlug: 'test',
        model: 'test-model',
      };

      const result = await runTaskOnce(config, task, {
        storageRoot,
        registerBackends: registerReportingBackend,
        realBackendIsolation: { kind: 'external', label: 'unit isolation' },
      });

      const feedback = result.projection.feedback.find((entry) => entry.source === 'runtime');
      assert.ok(feedback?.details);
      assert.equal((feedback.details.isolation as { label?: string }).label, 'unit isolation');
      assert.equal((feedback.details.runtimeRefs as { runId?: string }).runId, result.invocation.runId);
      assert.ok((feedback.details.runtimeRefs as { runtimeEventIds?: string[] }).runtimeEventIds?.includes('report-usage'));
      assert.deepEqual(feedback.details.artifactRefs, [
        { runtimeEventId: 'report-artifact', artifactId: 'artifact-1', toolCallId: 'tool-1' },
      ]);
      assert.equal(((feedback.details.budget as { totals: { input: number } }).totals.input), 10);
      assert.deepEqual(result.projection.latestScoreResult?.details?.artifactRefs, feedback.details.artifactRefs);

      const runtimeEventsPath = join(storageRoot, 'sessions', result.invocation.sessionId, 'runs', result.invocation.runId, 'runtime-events.jsonl');
      const runtimeEvents = await readFile(runtimeEventsPath, 'utf8');
      assert.match(runtimeEvents, /report-usage/);
      assert.match(runtimeEvents, /report-artifact/);
    });
  });
});
