import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  BackendRegistry,
  FakeBackend,
  SessionManager,
  type AgentBackend,
  type SessionStore,
} from '@maka/runtime';
import {
  isTerminalRuntimeEvent,
  type AgentRunHeader,
  type BackendKind,
  type RuntimeEvent,
  type RuntimeEventStore,
  type SessionEvent,
  type SessionHeader,
} from '@maka/core';
import type { BackendSendInput, PermissionDecision } from '@maka/core/backend-types';
import { createRuntimeEventStore } from '@maka/storage';
import type { Config, Task } from '../contracts.js';
import type { HeadlessBackendContext } from '../isolation.js';
import { commandResourceScope, hashNormalizedArgs } from '../permission-grants.js';
import { runTaskOnce } from '../task-agent-controller.js';
import type { TaskPermissionGrant } from '../task-contracts.js';
import { buildIsolatedHeadlessTools } from '../tools.js';

const fakeConfig: Config = {
  id: 'fake-cfg',
  backend: 'fake',
  llmConnectionSlug: 'fake',
  model: 'fake-model',
};

const registerFakeBackend = (registry: BackendRegistry): void => {
  registry.register(
    'fake',
    (ctx) => new FakeBackend({ sessionId: ctx.sessionId, header: ctx.header, store: ctx.store }),
  );
};

class ReportingBackend implements AgentBackend {
  readonly kind: BackendKind = 'ai-sdk';
  readonly sessionId: string;

  constructor(
    private readonly ctx: { sessionId: string; header: SessionHeader; store: SessionStore },
  ) {
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
      contextBudget: {
        enabled: true,
        policyName: 'unit-budget',
        estimatedTokensBefore: 20,
        estimatedTokensAfter: 10,
        keptTurns: 1,
        droppedTurns: 1,
        keptEvents: 2,
        droppedEvents: 1,
      },
    };
    yield { type: 'complete', id: 'report-complete', turnId, ts, stopReason: 'end_turn' };
  }

  async stop(): Promise<void> {}
  async respondToPermission(_decision: PermissionDecision): Promise<void> {}
  async dispose(): Promise<void> {}
}

const registerReportingBackend = (registry: BackendRegistry): void => {
  registry.register(
    'ai-sdk',
    (ctx) =>
      new ReportingBackend({ sessionId: ctx.sessionId, header: ctx.header, store: ctx.store }),
  );
};

class ProtectedTamperBackend implements AgentBackend {
  readonly kind: BackendKind = 'fake';
  readonly sessionId: string;

  constructor(
    private readonly ctx: { sessionId: string; header: SessionHeader; store: SessionStore },
  ) {
    this.sessionId = ctx.sessionId;
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    const { turnId } = input;
    const ts = Date.now();
    const messageId = 'tamper-message';
    await writeFile(join(this.ctx.header.cwd, 'check.mjs'), 'process.exit(0);\n', 'utf8');
    await this.ctx.store.appendMessage(this.sessionId, {
      type: 'assistant',
      id: messageId,
      turnId,
      ts,
      text: 'tampered with verifier asset',
      modelId: this.ctx.header.model,
    });
    yield {
      type: 'text_complete',
      id: 'tamper-text',
      turnId,
      ts,
      messageId,
      text: 'tampered with verifier asset',
    };
    yield { type: 'complete', id: 'tamper-complete', turnId, ts, stopReason: 'end_turn' };
  }

  async stop(): Promise<void> {}
  async respondToPermission(_decision: PermissionDecision): Promise<void> {}
  async dispose(): Promise<void> {}
}

const registerProtectedTamperBackend = (registry: BackendRegistry): void => {
  registry.register(
    'fake',
    (ctx) =>
      new ProtectedTamperBackend({
        sessionId: ctx.sessionId,
        header: ctx.header,
        store: ctx.store,
      }),
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
    yield {
      type: 'complete',
      id: 'incomplete-complete',
      turnId: input.turnId,
      ts,
      stopReason: 'end_turn',
    };
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

  constructor(
    sessionId: string,
    private readonly onRespond: () => void,
    private readonly command: string,
  ) {
    this.sessionId = sessionId;
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    const ts = Date.now();
    yield {
      type: 'permission_request',
      kind: 'tool_permission',
      id: 'permission-request-event',
      turnId: input.turnId,
      ts,
      requestId: 'permission-request-1',
      toolUseId: 'tool-1',
      toolName: 'Bash',
      category: 'shell_unsafe',
      reason: 'shell_dangerous',
      args: { command: this.command },
      rememberForTurnAllowed: true,
    };
    yield {
      type: 'complete',
      id: 'permission-complete',
      turnId: input.turnId,
      ts,
      stopReason: 'permission_handoff',
    };
  }

  async stop(): Promise<void> {}
  async respondToPermission(_decision: PermissionDecision): Promise<void> {
    this.onRespond();
    throw new Error('headless task facade must not answer interactive permission requests');
  }
  async dispose(): Promise<void> {}
}

const registerPermissionRequestBackend =
  (onRespond: () => void, command = 'rm -rf /tmp/example') =>
  (registry: BackendRegistry): void => {
    registry.register(
      'fake',
      (ctx) => new PermissionRequestBackend(ctx.sessionId, onRespond, command),
    );
  };

class ProgressToolBackend implements AgentBackend {
  readonly kind: BackendKind = 'ai-sdk';
  readonly sessionId: string;

  constructor(
    private readonly ctx: {
      sessionId: string;
      header: SessionHeader;
      tools: ReturnType<typeof buildIsolatedHeadlessTools>;
    },
  ) {
    this.sessionId = ctx.sessionId;
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    const bash = this.ctx.tools.find((tool) => tool.name === 'Bash');
    const inventorySubmit = this.ctx.tools.find((tool) => tool.name === 'inventory_submit');
    const todoUpdate = this.ctx.tools.find((tool) => tool.name === 'todo_update');
    const selfCheckPlanSubmit = this.ctx.tools.find(
      (tool) => tool.name === 'self_check_plan_submit',
    );
    const selfCheckSubmit = this.ctx.tools.find((tool) => tool.name === 'self_check_submit');
    assert.ok(bash);
    assert.ok(inventorySubmit);
    assert.ok(todoUpdate);
    assert.ok(selfCheckPlanSubmit);
    assert.ok(selfCheckSubmit);
    const toolCtx = {
      sessionId: this.sessionId,
      turnId: input.turnId,
      cwd: this.ctx.header.cwd,
      toolCallId: 'progress-tool-call',
      abortSignal: new AbortController().signal,
      emitOutput: () => {},
    };
    await bash.impl({ command: 'npm test' }, { ...toolCtx, toolCallId: 'bash-tool-call' });
    await inventorySubmit.impl(
      {
        summary: 'Inspected public files.',
        items: [{ path: 'README.md', kind: 'file', status: 'observed' }],
      },
      toolCtx,
    );
    await todoUpdate.impl(
      {
        items: [
          {
            id: 'artifact',
            kind: 'runnable_artifact',
            content: 'Patch first runnable artifact',
            status: 'in_progress',
            priority: 'high',
          },
          {
            id: 'check',
            kind: 'public_check',
            content: 'Run public check after artifact exists',
            status: 'pending',
            priority: 'high',
          },
        ],
      },
      toolCtx,
    );
    await selfCheckPlanSubmit.impl(
      {
        finalArtifacts: [
          {
            path: '/app/README.md',
            purpose: 'visible public artifact inspected by the check',
            publicReason: 'visible task notes are public',
          },
        ],
        selfCheckScratch: {
          root: '/tmp/maka-self-check/progress',
          expectedGeneratedPaths: ['/tmp/maka-self-check/progress/check.log'],
          publicReason: 'public check outputs stay under scratch',
        },
        workspaceGuardPlan: {
          checkedPaths: ['/app/README.md'],
          expectedAddedPaths: [],
          expectedGeneratedPathsOutsideScratch: [],
          publicReason: 'public guard checks visible artifact paths',
        },
        publicReason: 'plan is derived from visible public task files',
      },
      toolCtx,
    );
    await selfCheckSubmit.impl(
      {
        status: 'pass',
        publicReason: 'npm test passed using public README.md-backed fixture state.',
        commandEvidence: [
          { command: 'npm test', exitCode: 0, outputExcerpt: 'public tests passed' },
        ],
        artifactEvidence: [{ path: '/app/README.md', kind: 'file', exists: true }],
      },
      toolCtx,
    );
    const ts = Date.now();
    yield {
      type: 'tool_start',
      id: 'progress-bash-start',
      turnId: input.turnId,
      ts,
      toolUseId: 'bash-tool-call',
      toolName: 'Bash',
      args: { command: 'npm test' },
    };
    yield {
      type: 'tool_result',
      id: 'progress-bash-result',
      turnId: input.turnId,
      ts,
      toolUseId: 'bash-tool-call',
      isError: false,
      content: { kind: 'text', text: 'tests passed' },
    };
    yield {
      type: 'tool_start',
      id: 'progress-self-check-start',
      turnId: input.turnId,
      ts,
      toolUseId: 'progress-tool-call',
      toolName: 'self_check_submit',
      args: { status: 'pass' },
    };
    yield {
      type: 'tool_result',
      id: 'progress-self-check-result',
      turnId: input.turnId,
      ts,
      toolUseId: 'progress-tool-call',
      isError: false,
      content: { kind: 'text', text: 'self-check accepted' },
    };
    yield {
      type: 'complete',
      id: 'progress-complete',
      turnId: input.turnId,
      ts,
      stopReason: 'end_turn',
    };
  }

  async stop(): Promise<void> {}
  async respondToPermission(_decision: PermissionDecision): Promise<void> {}
  async dispose(): Promise<void> {}
}

const registerProgressToolBackend =
  (seen: HeadlessBackendContext[]) =>
  (registry: BackendRegistry, context: HeadlessBackendContext): void => {
    seen.push(context);
    assert.ok(context.toolExecutor);
    registry.register(
      'ai-sdk',
      (ctx) =>
        new ProgressToolBackend({
          sessionId: ctx.sessionId,
          header: ctx.header,
          tools: buildIsolatedHeadlessTools(context.toolExecutor!, {
            ...(context.heavyTaskEvidence ? { heavyTaskEvidence: context.heavyTaskEvidence } : {}),
            ...(context.heavyTaskProgress ? { heavyTaskProgress: context.heavyTaskProgress } : {}),
            ...(context.heavyTaskSelfCheck
              ? { heavyTaskSelfCheck: context.heavyTaskSelfCheck }
              : {}),
          }),
        }),
    );
  };

class GateRepairBackend implements AgentBackend {
  readonly kind: BackendKind = 'ai-sdk';
  readonly sessionId: string;

  constructor(
    private readonly ctx: {
      sessionId: string;
      header: SessionHeader;
      tools: ReturnType<typeof buildIsolatedHeadlessTools>;
      prompts: string[];
      repairSubmitsSelfCheck: boolean;
    },
  ) {
    this.sessionId = ctx.sessionId;
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    this.ctx.prompts.push(input.text);
    const ts = Date.now();
    const turnNumber = this.ctx.prompts.length;
    if (turnNumber === 2 && this.ctx.repairSubmitsSelfCheck) {
      const todoUpdate = this.ctx.tools.find((tool) => tool.name === 'todo_update');
      const selfCheckPlanSubmit = this.ctx.tools.find(
        (tool) => tool.name === 'self_check_plan_submit',
      );
      const selfCheckSubmit = this.ctx.tools.find((tool) => tool.name === 'self_check_submit');
      assert.ok(todoUpdate);
      assert.ok(selfCheckPlanSubmit);
      assert.ok(selfCheckSubmit);
      const toolCtx = {
        sessionId: this.sessionId,
        turnId: input.turnId,
        cwd: this.ctx.header.cwd,
        toolCallId: 'gate-repair-tool-call',
        abortSignal: new AbortController().signal,
        emitOutput: () => {},
      };
      await todoUpdate.impl(
        {
          items: [
            {
              id: 'artifact',
              kind: 'runnable_artifact',
              content: 'Keep marker.txt as the runnable artifact',
              status: 'completed',
              priority: 'high',
              evidence: 'test -f marker.txt passed.',
            },
            {
              id: 'check',
              kind: 'public_check',
              content: 'Run public marker check',
              status: 'completed',
              priority: 'high',
              evidence: 'test -f marker.txt passed.',
            },
          ],
        },
        toolCtx,
      );
      await selfCheckPlanSubmit.impl(
        {
          finalArtifacts: [
            {
              path: 'marker.txt',
              purpose: 'visible runnable artifact',
              publicReason: 'visible task asks for marker.txt to exist',
            },
          ],
          selfCheckScratch: {
            root: '/tmp/maka-self-check/gate-repair',
            expectedGeneratedPaths: ['/tmp/maka-self-check/gate-repair/check.log'],
            publicReason: 'public check outputs stay under scratch',
          },
          workspaceGuardPlan: {
            checkedPaths: ['marker.txt'],
            expectedAddedPaths: [],
            expectedGeneratedPathsOutsideScratch: [],
            publicReason: 'public guard checks marker.txt',
          },
          publicReason: 'plan is derived from visible public task evidence',
        },
        toolCtx,
      );
      await selfCheckSubmit.impl(
        {
          status: 'pass',
          publicReason: 'test -f marker.txt passed from public workspace evidence.',
          commandEvidence: [
            {
              command: 'test -f marker.txt',
              exitCode: 0,
              outputExcerpt: 'marker present',
              artifactRefs: ['marker.txt'],
            },
          ],
          artifactEvidence: [{ path: 'marker.txt', kind: 'file', exists: true }],
          executionHygiene: {
            sandbox: {
              root: '/tmp/maka-self-check/gate-repair',
              strategy: 'read_only_deliverable_refs',
              commandCwd: '/tmp/maka-self-check/gate-repair',
              outputPolicy: 'scratch_only',
            },
            scratchUsed: true,
            scratchPath: '/tmp/maka-self-check/gate-repair',
            cleanupPerformed: true,
            workspaceSideEffects: 'none',
            workspaceGuard: {
              checked: true,
              checkedPaths: ['marker.txt'],
              beforeListingCommand: 'find . -maxdepth 1 -type f | sort',
              afterListingCommand: 'find . -maxdepth 1 -type f | sort',
              addedPaths: [],
              modifiedPaths: [],
              removedPaths: [],
            },
          },
        },
        toolCtx,
      );
    }
    yield {
      type: 'text_complete',
      id: `gate-text-${turnNumber}`,
      turnId: input.turnId,
      ts,
      messageId: `gate-message-${turnNumber}`,
      text: 'done',
    };
    yield {
      type: 'complete',
      id: `gate-complete-${turnNumber}`,
      turnId: input.turnId,
      ts,
      stopReason: 'end_turn',
    };
  }

  async stop(): Promise<void> {}
  async respondToPermission(_decision: PermissionDecision): Promise<void> {}
  async dispose(): Promise<void> {}
}

const registerGateRepairBackend =
  (prompts: string[], repairSubmitsSelfCheck: boolean) =>
  (registry: BackendRegistry, context: HeadlessBackendContext): void => {
    assert.ok(context.toolExecutor);
    registry.register(
      'ai-sdk',
      (ctx) =>
        new GateRepairBackend({
          sessionId: ctx.sessionId,
          header: ctx.header,
          tools: buildIsolatedHeadlessTools(context.toolExecutor!, {
            ...(context.heavyTaskEvidence ? { heavyTaskEvidence: context.heavyTaskEvidence } : {}),
            ...(context.heavyTaskProgress ? { heavyTaskProgress: context.heavyTaskProgress } : {}),
            ...(context.heavyTaskSelfCheck
              ? { heavyTaskSelfCheck: context.heavyTaskSelfCheck }
              : {}),
          }),
          prompts,
          repairSubmitsSelfCheck,
        }),
    );
  };

class GateLaunderBackend implements AgentBackend {
  readonly kind: BackendKind = 'ai-sdk';
  readonly sessionId: string;

  constructor(
    private readonly ctx: {
      sessionId: string;
      header: SessionHeader;
      tools: ReturnType<typeof buildIsolatedHeadlessTools>;
      prompts: string[];
    },
  ) {
    this.sessionId = ctx.sessionId;
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    this.ctx.prompts.push(input.text);
    const ts = Date.now();
    const turnNumber = this.ctx.prompts.length;
    const selfCheckPlanSubmit = this.ctx.tools.find(
      (tool) => tool.name === 'self_check_plan_submit',
    );
    const selfCheckSubmit = this.ctx.tools.find((tool) => tool.name === 'self_check_submit');
    assert.ok(selfCheckPlanSubmit);
    assert.ok(selfCheckSubmit);
    const toolCtx = {
      sessionId: this.sessionId,
      turnId: input.turnId,
      cwd: this.ctx.header.cwd,
      toolCallId: `launder-tool-call-${turnNumber}`,
      abortSignal: new AbortController().signal,
      emitOutput: () => {},
    };
    await selfCheckPlanSubmit.impl(
      {
        finalArtifacts: [
          {
            path: '/app/polyglot/main.py.c',
            purpose: 'single-file polyglot source',
            publicReason: 'visible task asks for this final file',
          },
        ],
        selfCheckScratch: {
          root: '/tmp/maka-self-check/polyglot',
          expectedGeneratedPaths: ['/tmp/maka-self-check/polyglot/cmain'],
          publicReason: 'compile checks should stay under scratch',
        },
        workspaceGuardPlan: {
          checkedPaths: ['/app/polyglot'],
          expectedAddedPaths: [],
          expectedGeneratedPathsOutsideScratch: turnNumber === 1 ? [] : ['/app/polyglot/cmain'],
          publicReason:
            turnNumber === 1
              ? 'first plan only declares the final source file'
              : 'repair attempt tries to launder the observed cmain path',
        },
        publicReason: 'public polyglot self-check plan',
      },
      toolCtx,
    );
    await selfCheckSubmit.impl(
      {
        status: 'pass',
        publicReason: 'python and gcc checks passed, but cmain remains in /app/polyglot',
        commandEvidence: [
          {
            command: 'gcc /app/polyglot/main.py.c -o /app/polyglot/cmain && /app/polyglot/cmain 10',
            exitCode: 0,
            outputExcerpt: '55',
            artifactRefs: ['/app/polyglot/main.py.c', '/app/polyglot/cmain'],
          },
        ],
        artifactEvidence: [
          { path: '/app/polyglot/main.py.c', kind: 'file', exists: true },
          { path: '/app/polyglot/cmain', kind: 'file', exists: true },
        ],
        executionHygiene: {
          sandbox: {
            root: '/tmp/maka-self-check/polyglot',
            strategy: 'copied_inputs',
            commandCwd: '/tmp/maka-self-check/polyglot',
            outputPolicy: 'scratch_only',
          },
          scratchUsed: true,
          scratchPath: '/tmp/maka-self-check/polyglot',
          cleanupPerformed: true,
          workspaceSideEffects: 'present',
          workspaceGuard: {
            checked: true,
            checkedPaths: ['/app/polyglot'],
            beforeListingCommand: 'find /app/polyglot -maxdepth 1',
            afterListingCommand: 'find /app/polyglot -maxdepth 1',
            addedPaths: ['/app/polyglot/cmain'],
            modifiedPaths: [],
            removedPaths: [],
          },
        },
      },
      toolCtx,
    );
    yield {
      type: 'text_complete',
      id: `launder-text-${turnNumber}`,
      turnId: input.turnId,
      ts,
      messageId: `launder-message-${turnNumber}`,
      text: 'done',
    };
    yield {
      type: 'complete',
      id: `launder-complete-${turnNumber}`,
      turnId: input.turnId,
      ts,
      stopReason: 'end_turn',
    };
  }

  async stop(): Promise<void> {}
  async respondToPermission(_decision: PermissionDecision): Promise<void> {}
  async dispose(): Promise<void> {}
}

const registerGateLaunderBackend =
  (prompts: string[]) =>
  (registry: BackendRegistry, context: HeadlessBackendContext): void => {
    assert.ok(context.toolExecutor);
    registry.register(
      'ai-sdk',
      (ctx) =>
        new GateLaunderBackend({
          sessionId: ctx.sessionId,
          header: ctx.header,
          tools: buildIsolatedHeadlessTools(context.toolExecutor!, {
            ...(context.heavyTaskEvidence ? { heavyTaskEvidence: context.heavyTaskEvidence } : {}),
            ...(context.heavyTaskProgress ? { heavyTaskProgress: context.heavyTaskProgress } : {}),
            ...(context.heavyTaskSelfCheck
              ? { heavyTaskSelfCheck: context.heavyTaskSelfCheck }
              : {}),
          }),
          prompts,
        }),
    );
  };

async function withDirs<T>(
  fn: (fixtureDir: string, storageRoot: string) => Promise<T>,
): Promise<T> {
  const fixtureDir = await mkdtemp(join(tmpdir(), 'maka-task-controller-fx-'));
  const storageRoot = await mkdtemp(join(tmpdir(), 'maka-task-controller-store-'));
  try {
    return await fn(fixtureDir, storageRoot);
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
    await rm(storageRoot, { recursive: true, force: true });
  }
}

async function readRuntimeEventLedger(
  storageRoot: string,
  sessionId: string,
  runId: string,
): Promise<RuntimeEvent[]> {
  const runtimeEventsPath = join(
    storageRoot,
    'sessions',
    sessionId,
    'runs',
    runId,
    'runtime-events.jsonl',
  );
  const content = await readFile(runtimeEventsPath, 'utf8');
  return content
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RuntimeEvent);
}

async function readAgentRunHeader(
  storageRoot: string,
  sessionId: string,
  runId: string,
): Promise<AgentRunHeader> {
  const runPath = join(storageRoot, 'sessions', sessionId, 'runs', runId, 'run.json');
  return JSON.parse(await readFile(runPath, 'utf8')) as AgentRunHeader;
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
            'heavy_task_mode_recorded',
            'economy_task_mode_recorded',
            'isolation_policy_recorded',
            'workspace_lease_recorded',
            'tool_executor_identity_recorded',
            'task_run_started',
            'task_attempt_started',
            'task_attempt_execution_linked',
            'feedback_observed',
            'task_run_verifying',
            'verifier_result_recorded',
            'score_result_recorded',
            'task_attempt_completed',
            'task_run_completed',
          ],
        );
        assert.equal(result.projection.heavyTaskMode?.enabled, false);
        assert.equal(result.projection.isolation?.mode, 'inert_fake_backend');
        assert.equal(result.projection.workspaceLease?.taskRunId, result.taskRunId);
        assert.equal(result.projection.toolExecutors[0]?.isolationMode, 'inert_fake_backend');
        const tools = result.projection.latestScoreResult?.details?.tools as
          | Record<string, unknown>
          | undefined;
        assert.ok(tools, 'score details should include tool economy summary');
        assert.equal(tools.actualToolCalls, 0);
        assert.deepEqual(tools.actualToolNames, []);
        assert.deepEqual(tools.actualToolCallCounts, {});
        const runtimeLedger = await readRuntimeEventLedger(
          storageRoot,
          result.invocation.sessionId,
          result.invocation.runId,
        );
        const lineage = result.projection.attempts[0]?.executionLineage[0];
        assert.equal(lineage?.execution?.invocationId, result.invocation.invocationId);
        assert.equal(lineage?.execution?.agentRunId, result.invocation.runId);
        assert.equal(lineage?.runtimeCoverage?.lowWater?.sequence, 0);
        assert.equal(lineage?.runtimeCoverage?.lowWater?.eventId, runtimeLedger[0]?.id);
        assert.equal(lineage?.runtimeCoverage?.highWater.sequence, runtimeLedger.length - 1);
        assert.equal(lineage?.runtimeCoverage?.highWater.eventId, runtimeLedger.at(-1)?.id);
        assert.equal(lineage?.runtimeCoverage?.eventCount, runtimeLedger.length);
        const runHeader = await readAgentRunHeader(
          storageRoot,
          result.invocation.sessionId,
          result.invocation.runId,
        );
        assert.equal(runHeader.invocationId, result.invocation.invocationId);
      } finally {
        SessionManager.prototype.sendMessage = original;
      }
    });
  });

  test('records task-metadata heavy-task mode selection without changing scoring authority', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      await writeFile(join(fixtureDir, 'marker.txt'), 'present', 'utf8');
      const task: Task = {
        id: 'heavy-task',
        instruction: 'do the thing',
        workspaceDir: fixtureDir,
        verification: { command: 'test -f marker.txt', protectedPaths: [] },
        benchmark: { metadata: { heavyTaskMode: { enabled: true, reason: 'declared long task' } } },
      };

      const result = await runTaskOnce(fakeConfig, task, {
        storageRoot,
        registerBackends: registerFakeBackend,
      });

      assert.equal(result.projection.heavyTaskMode?.enabled, true);
      assert.equal(result.projection.heavyTaskMode?.triggerSource, 'task_metadata');
      assert.equal(result.projection.heavyTaskMode?.triggerReason, 'declared long task');
      assert.equal(result.projection.latestVerifierResult?.authority, undefined);
      assert.equal(result.projection.latestScoreResult?.taxonomy, 'passed');
      assert.equal(result.resultRecord.passed, true);
      assert.ok(!result.projection.toolExecutors[0]?.toolNames.includes('inventory_submit'));
      assert.ok(!result.projection.toolExecutors[0]?.toolNames.includes('todo_update'));
      assert.ok(!result.projection.toolExecutors[0]?.toolNames.includes('self_check_plan_submit'));
      assert.ok(!result.projection.toolExecutors[0]?.toolNames.includes('self_check_submit'));
    });
  });

  test('records config economy-task mode selection without changing scoring authority', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      await writeFile(join(fixtureDir, 'marker.txt'), 'present', 'utf8');
      const task: Task = {
        id: 'economy-task',
        instruction: 'write a csv summary',
        workspaceDir: fixtureDir,
        verification: { command: 'test -f marker.txt', protectedPaths: [] },
      };

      const result = await runTaskOnce(
        {
          ...fakeConfig,
          economyTaskMode: { enabled: true, reason: 'declared simple task' },
        },
        task,
        {
          storageRoot,
          registerBackends: registerFakeBackend,
        },
      );

      assert.equal(result.projection.economyTaskMode?.enabled, true);
      assert.equal(result.projection.economyTaskMode?.triggerSource, 'config');
      assert.equal(result.projection.economyTaskMode?.triggerReason, 'declared simple task');
      assert.equal(result.projection.latestScoreResult?.taxonomy, 'passed');
      assert.equal(result.resultRecord.passed, true);
    });
  });

  test('enabled heavy-task run exposes progress tools and records submitted snapshots', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      await writeFile(join(fixtureDir, 'README.md'), 'public task notes\n', 'utf8');
      const seenContexts: HeadlessBackendContext[] = [];
      const config: Config = {
        ...fakeConfig,
        backend: 'ai-sdk',
        heavyTaskMode: true,
      };
      const task: Task = {
        id: 'progress-task',
        instruction: 'do the thing',
        workspaceDir: fixtureDir,
        verification: { command: 'test -f README.md', protectedPaths: [] },
      };

      const result = await runTaskOnce(config, task, {
        storageRoot,
        registerBackends: registerProgressToolBackend(seenContexts),
        realBackendIsolation: {
          kind: 'external',
          label: 'unit isolated executor',
          toolExecutor: {
            async exec() {
              return { exitCode: 0, stdout: '', stderr: '' };
            },
          },
        },
      });

      assert.equal(seenContexts[0]?.heavyTaskMode?.enabled, true);
      assert.ok(seenContexts[0]?.heavyTaskEvidence);
      assert.ok(seenContexts[0]?.heavyTaskProgress);
      assert.ok(seenContexts[0]?.heavyTaskSelfCheck);
      assert.ok(result.projection.toolExecutors[0]?.toolNames.includes('inventory_submit'));
      assert.ok(result.projection.toolExecutors[0]?.toolNames.includes('todo_update'));
      assert.ok(result.projection.toolExecutors[0]?.toolNames.includes('self_check_plan_submit'));
      assert.ok(result.projection.toolExecutors[0]?.toolNames.includes('self_check_submit'));
      assert.equal(result.projection.latestHeavyTaskInventory?.summary, 'Inspected public files.');
      assert.equal(result.projection.latestHeavyTaskInventory?.items[0]?.path, 'README.md');
      assert.equal(result.projection.latestHeavyTaskTodos?.items[0]?.status, 'in_progress');
      assert.equal(result.projection.latestHeavyTaskTodos?.items[0]?.kind, 'runnable_artifact');
      assert.equal(result.projection.latestHeavyTaskTodos?.items[1]?.kind, 'public_check');
      assert.equal(result.projection.latestHeavyTaskSelfCheck?.status, 'pass');
      assert.equal(result.projection.latestHeavyTaskSelfCheckPlan?.guard.status, 'accepted');
      assert.equal(result.projection.latestHeavyTaskSelfCheck?.guard.status, 'accepted');
      assert.equal(
        result.projection.latestHeavyTaskSelfCheck?.freshness,
        'current',
        JSON.stringify({
          warnings: result.projection.warnings,
          selfCheck: result.projection.latestHeavyTaskSelfCheck,
          evidenceLinks: result.projection.events.filter(
            (event) => event.type === 'heavy_task_self_check_evidence_linked',
          ),
          observations: result.projection.heavyTaskWorkspaceObservations,
        }),
      );
      assert.ok(result.projection.latestHeavyTaskSelfCheck?.provenance?.runtimeCoverage);
      assert.ok(result.projection.latestHeavyTaskSelfCheck?.provenance?.taskCoverage);
      assert.equal(
        result.projection.latestHeavyTaskSelfCheck?.provenance?.workspace?.kind,
        'manifest',
      );
      assert.equal(
        result.projection.events.filter(
          (event) => event.type === 'heavy_task_self_check_evidence_linked',
        ).length,
        result.projection.heavyTaskSelfChecks.length,
      );
      assert.equal(
        result.projection.events.filter((event) => event.type === 'heavy_task_inventory_recorded')
          .length,
        2,
      );
      assert.equal(
        result.projection.events.filter((event) => event.type === 'heavy_task_todos_recorded')
          .length,
        2,
      );
      assert.equal(
        result.projection.events.filter(
          (event) => event.type === 'heavy_task_self_check_plan_recorded',
        ).length,
        2,
      );
      assert.equal(
        result.projection.events.filter((event) => event.type === 'heavy_task_self_check_recorded')
          .length,
        2,
      );
      assert.equal(
        result.projection.events.filter(
          (event) => event.type === 'heavy_task_self_check_gate_recorded',
        ).length,
        2,
      );
      const linkedEvidence = result.projection.heavyTaskEvidence.filter((item) => item.provenance);
      const linkedAgentRuns = new Set(
        result.projection.executionLineage.map((item) => item.execution?.agentRunId),
      );
      assert.ok(linkedEvidence.length > 0);
      assert.ok(
        linkedEvidence.every((item) => {
          const provenance = item.provenance;
          return (
            provenance !== undefined &&
            linkedAgentRuns.has(provenance.execution?.agentRunId) &&
            provenance.execution?.turnId === item.source.turnId &&
            Boolean(provenance.runtimeCoverage?.highWater.eventId)
          );
        }),
      );
      assert.equal(
        result.projection.events.filter(
          (event) => event.type === 'heavy_task_evidence_provenance_linked',
        ).length,
        linkedEvidence.length,
      );
      const replayDerivedSelfCheckEvidence = result.projection.heavyTaskEvidence.filter((item) =>
        item.evidenceId.includes(':compact-'),
      );
      assert.ok(replayDerivedSelfCheckEvidence.length > 0);
      assert.ok(replayDerivedSelfCheckEvidence.every((item) => item.provenance === undefined));
    });
  });

  test('enabled heavy-task run performs one bounded self-check repair turn before verifying', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      await writeFile(join(fixtureDir, 'marker.txt'), 'present', 'utf8');
      const prompts: string[] = [];
      const config: Config = {
        ...fakeConfig,
        backend: 'ai-sdk',
        heavyTaskMode: true,
      };
      const task: Task = {
        id: 'gate-repair-task',
        instruction: 'Ensure marker.txt exists and verify it publicly.',
        workspaceDir: fixtureDir,
        verification: { command: 'test -f marker.txt', protectedPaths: [] },
      };

      const result = await runTaskOnce(config, task, {
        storageRoot,
        registerBackends: registerGateRepairBackend(prompts, true),
        realBackendIsolation: {
          kind: 'external',
          label: 'unit isolated executor',
          toolExecutor: {
            async exec() {
              return { exitCode: 0, stdout: '', stderr: '' };
            },
          },
        },
      });

      assert.equal(prompts.length, 2);
      assert.match(prompts[1] ?? '', /not accepted for heavy-task finalization/);
      assert.equal(result.projection.latestHeavyTaskSelfCheckPlan?.guard.status, 'accepted');
      assert.equal(result.projection.latestHeavyTaskSelfCheck?.status, 'pass');
      assert.equal(result.projection.latestHeavyTaskSelfCheckGate?.action, 'allow_finalize');
      assert.equal(result.projection.latestVerifierResult?.passed, true);
      assert.equal(result.resultRecord.passed, true);
      assert.equal(result.projection.attempts[0]?.executionLineage.length, 2);
      assert.equal(
        new Set(
          result.projection.attempts[0]?.executionLineage.map((ref) => ref.execution?.agentRunId),
        ).size,
        2,
      );
      const gateIndexes = result.projection.events
        .map((event, index) => (event.type === 'heavy_task_self_check_gate_recorded' ? index : -1))
        .filter((index) => index >= 0);
      const verifyingIndex = result.projection.events.findIndex(
        (event) => event.type === 'task_run_verifying',
      );
      assert.equal(gateIndexes.length, 2);
      assert.ok(gateIndexes.every((index) => index < verifyingIndex));
    });
  });

  test('bounded self-check gate does not loop and official verifier remains authoritative', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      await writeFile(join(fixtureDir, 'marker.txt'), 'present', 'utf8');
      const prompts: string[] = [];
      const config: Config = {
        ...fakeConfig,
        backend: 'ai-sdk',
        heavyTaskMode: true,
      };
      const task: Task = {
        id: 'gate-still-missing-task',
        instruction: 'Ensure marker.txt exists and verify it publicly.',
        workspaceDir: fixtureDir,
        verification: { command: 'test -f marker.txt', protectedPaths: [] },
      };

      const result = await runTaskOnce(config, task, {
        storageRoot,
        registerBackends: registerGateRepairBackend(prompts, false),
        realBackendIsolation: {
          kind: 'external',
          label: 'unit isolated executor',
          toolExecutor: {
            async exec() {
              return { exitCode: 0, stdout: '', stderr: '' };
            },
          },
        },
      });

      assert.equal(prompts.length, 2);
      assert.equal(result.projection.latestHeavyTaskSelfCheck, undefined);
      assert.equal(
        result.projection.latestHeavyTaskSelfCheckGate?.action,
        'allow_official_verifier_after_bounded_attempt',
      );
      assert.match(
        result.projection.latestHeavyTaskSelfCheckGate?.reason ?? '',
        /missing accepted public self-check/,
      );
      assert.equal(result.projection.latestVerifierResult?.passed, true);
      assert.equal(result.projection.latestScoreResult?.taxonomy, 'passed');
      assert.equal(result.resultRecord.passed, true);
      assert.equal(
        result.projection.events.filter(
          (event) => event.type === 'heavy_task_self_check_gate_recorded',
        ).length,
        2,
      );
    });
  });

  test('bounded repair records model-reported workspace side-effect diagnostic before official verifier', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      const prompts: string[] = [];
      const config: Config = {
        ...fakeConfig,
        backend: 'ai-sdk',
        heavyTaskMode: true,
      };
      const task: Task = {
        id: 'polyglot-launder-task',
        instruction: 'Write a single file in /app/polyglot/main.py.c.',
        workspaceDir: fixtureDir,
        verification: { command: 'true', protectedPaths: [] },
      };

      const result = await runTaskOnce(config, task, {
        storageRoot,
        registerBackends: registerGateLaunderBackend(prompts),
        realBackendIsolation: {
          kind: 'external',
          label: 'unit isolated executor',
          toolExecutor: {
            async exec() {
              return {
                exitCode: 0,
                stdout: 'file\t/app/polyglot/main.py.c\t\nfile\t/app/polyglot/cmain\t\n',
                stderr: '',
              };
            },
          },
        },
      });

      assert.equal(prompts.length, 2);
      assert.equal(
        result.projection.latestHeavyTaskSelfCheckGate?.action,
        'allow_official_verifier_after_bounded_attempt',
      );
      assert.match(
        result.projection.latestHeavyTaskSelfCheckGate?.reason ?? '',
        /\/app\/polyglot\/cmain/,
      );
      assert.match(
        result.projection.latestHeavyTaskSelfCheckGate?.reason ?? '',
        /unplanned_added_path/,
      );
      assert.equal(result.projection.latestVerifierResult?.passed, true);
      assert.equal(result.projection.latestScoreResult?.taxonomy, 'passed');
      assert.equal(result.resultRecord.status, 'completed');
      assert.equal(result.resultRecord.passed, true);
      assert.equal(
        result.projection.events.some((event) => event.type === 'task_run_verifying'),
        true,
      );
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
      assert.equal(result.resultRecord.runnerCompleted, true);
      assert.equal(result.resultRecord.scored, true);
      assert.equal(result.resultRecord.eligible, true);
      assert.equal(result.projection.status, 'completed');
      assert.equal(result.projection.result?.passed, false);
      assert.equal(result.projection.latestScoreResult?.taxonomy, 'verification_failed');
    });
  });

  test('records benchmark adapter hooks as unsupported instead of silently scoring', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      const task: Task = {
        id: 'terminal-bench-hook',
        instruction: 'do the thing',
        workspaceDir: fixtureDir,
        verifier: {
          kind: 'terminal_bench',
          adapter: 'terminal-bench',
          instanceId: 'terminal-bench/example',
          protectedPaths: [],
        },
      };

      const result = await runTaskOnce(fakeConfig, task, {
        storageRoot,
        registerBackends: registerFakeBackend,
      });

      assert.equal(result.resultRecord.status, 'completed');
      assert.equal(result.resultRecord.runnerCompleted, true);
      assert.equal(result.resultRecord.passed, false);
      assert.equal(result.resultRecord.scored, false);
      assert.equal(result.resultRecord.eligible, false);
      assert.equal(result.resultRecord.errorClass, 'unsupported_adapter');
      assert.equal(result.projection.status, 'completed');
      assert.equal(result.projection.latestVerifierResult?.kind, 'terminal_bench');
      assert.equal(result.projection.latestVerifierResult?.errorClass, 'unsupported_adapter');
      assert.equal(result.projection.latestScoreResult?.taxonomy, 'unsupported_adapter');
    });
  });

  test('records official Harbor verifier result and container artifacts from benchmark adapter', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      const task: Task = {
        id: 'terminal-bench-official',
        instruction: 'do the thing',
        workspaceDir: fixtureDir,
        verifier: {
          kind: 'terminal_bench',
          adapter: 'terminal-bench',
          instanceId: 'terminal-bench/example',
          protectedPaths: [],
        },
      };

      const result = await runTaskOnce(fakeConfig, task, {
        storageRoot,
        registerBackends: registerFakeBackend,
        benchmarkAdapters: {
          'terminal-bench': {
            name: 'terminal-bench',
            runVerifier: () => ({
              kind: 'terminal_bench',
              passed: true,
              exitCode: 0,
              score: 1,
              maxScore: 1,
              authority: { source: 'official_harbor_verifier', authoritative: true },
              details: { source: 'harbor', official: true, instanceId: 'terminal-bench/example' },
              artifacts: [
                {
                  kind: 'container_workspace',
                  workspacePath: '/app',
                  authority: { source: 'container_capture', authoritative: true },
                },
                {
                  kind: 'workspace_diff',
                  path: '/logs/artifacts/submission.diff',
                  workspacePath: '/app',
                  authority: { source: 'container_capture', authoritative: true },
                },
                {
                  kind: 'source_code',
                  path: '/logs/artifacts/app/vm.js',
                  workspacePath: '/app/vm.js',
                  authority: { source: 'container_capture', authoritative: true },
                },
                {
                  kind: 'generated_output',
                  path: '/logs/artifacts/frame.bmp',
                  workspacePath: '/app/frame.bmp',
                  authority: { source: 'container_capture', authoritative: true },
                },
                {
                  kind: 'benchmark_manifest',
                  path: '/logs/artifacts/manifest.json',
                  authority: { source: 'official_harbor_verifier', authoritative: true },
                },
              ],
            }),
          },
        },
      });

      assert.equal(result.resultRecord.passed, true);
      assert.equal(result.resultRecord.scored, true);
      assert.equal(
        result.projection.latestVerifierResult?.authority?.source,
        'official_harbor_verifier',
      );
      assert.equal(result.projection.latestScoreResult?.taxonomy, 'passed');
      assert.equal(result.projection.artifacts.length, 5);
      assert.equal(result.projection.artifacts[0]?.workspacePath, '/app');
      assert.equal(result.projection.artifacts[2]?.workspacePath, '/app/vm.js');
      assert.equal(result.projection.artifacts[3]?.path, '/logs/artifacts/frame.bmp');
      assert.equal(result.projection.artifacts[4]?.kind, 'benchmark_manifest');
    });
  });

  test('freezes submitted workspace before restoring protected paths for verifier', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      await writeFile(join(fixtureDir, 'src.mjs'), 'export const add = (a, b) => a - b;\n', 'utf8');
      await writeFile(
        join(fixtureDir, 'check.mjs'),
        "import { add } from './src.mjs';\nprocess.exit(add(2, 3) === 5 ? 0 : 1);\n",
        'utf8',
      );
      const task: Task = {
        id: 'freeze-before-restore',
        instruction: 'fix the bug',
        workspaceDir: fixtureDir,
        verification: { command: 'node check.mjs', protectedPaths: ['check.mjs'] },
      };

      const result = await runTaskOnce(fakeConfig, task, {
        storageRoot,
        registerBackends: registerProtectedTamperBackend,
      });

      assert.equal(result.resultRecord.status, 'completed');
      assert.equal(result.resultRecord.passed, false);
      assert.equal(result.resultRecord.scored, true);
      assert.equal(result.projection.latestVerifierResult?.exitCode, 1);
      const snapshot = result.projection.latestScoreResult?.details?.submittedSnapshot as
        | { snapshotPath?: string }
        | undefined;
      assert.ok(snapshot?.snapshotPath, 'expected submitted snapshot metadata in score details');
      assert.equal(
        await readFile(join(snapshot.snapshotPath, 'check.mjs'), 'utf8'),
        'process.exit(0);\n',
      );
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
      const failedRuntimeEvents = await readRuntimeEventLedger(
        storageRoot,
        failed.invocation.sessionId,
        failed.invocation.runId,
      );
      assert.deepEqual(
        failedRuntimeEvents
          .filter((event) => event.content?.kind === 'error' && !isTerminalRuntimeEvent(event))
          .map((event) => event.id),
        [],
      );
      const failedTerminalEvents = failedRuntimeEvents.filter(isTerminalRuntimeEvent);
      assert.equal(failedTerminalEvents.length, 1);
      assert.equal(failedTerminalEvents[0]?.status, 'failed');

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

  test('does not persist terminal headless run headers when terminal runtime event append fails', async () => {
    await withDirs(async (fixtureDir, storageRoot) => {
      await writeFile(join(fixtureDir, 'marker.txt'), 'present', 'utf8');
      const task: Task = {
        id: 'terminal-append-fails',
        instruction: 'do the thing',
        workspaceDir: fixtureDir,
        verification: { command: 'test -f marker.txt', protectedPaths: [] },
      };
      const backingRuntimeEventStore = createRuntimeEventStore(storageRoot);
      const runtimeEventStore: RuntimeEventStore = {
        appendRuntimeEvent(sessionId, runId, event) {
          if (isTerminalRuntimeEvent(event)) {
            throw new Error('terminal append failed');
          }
          return backingRuntimeEventStore.appendRuntimeEvent(sessionId, runId, event);
        },
        ensureTerminalRuntimeEventDurable() {
          throw new Error('terminal append failed');
        },
        readRuntimeEvents: (sessionId, runId) =>
          backingRuntimeEventStore.readRuntimeEvents(sessionId, runId),
        readSessionRuntimeEvents: (sessionId) =>
          backingRuntimeEventStore.readSessionRuntimeEvents(sessionId),
      };

      const result = await runTaskOnce(fakeConfig, task, {
        storageRoot,
        registerBackends: registerFakeBackend,
        runtimeEventStore,
      });

      assert.equal(result.invocation.status, 'failed');
      assert.equal(result.invocation.failure?.message, 'terminal append failed');
      const runtimeEvents = await runtimeEventStore.readRuntimeEvents(
        result.invocation.sessionId,
        result.invocation.runId,
      );
      assert.equal(runtimeEvents.some(isTerminalRuntimeEvent), false);
      const runHeader = await readAgentRunHeader(
        storageRoot,
        result.invocation.sessionId,
        result.invocation.runId,
      );
      assert.notEqual(runHeader.status, 'completed');
      assert.notEqual(runHeader.status, 'failed');
      assert.notEqual(runHeader.status, 'cancelled');
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
      assert.equal(result.projection.permissionRequests.length, 1);
      assert.equal(result.projection.permissionRequests[0]?.toolName, 'Bash');
      assert.equal(result.projection.permissionRequests[0]?.resourceScope.kind, 'command');
      const runtimeEvents = await readRuntimeEventLedger(
        storageRoot,
        result.invocation.sessionId,
        result.invocation.runId,
      );
      assert.equal(runtimeEvents.some(isTerminalRuntimeEvent), false);
      assert.ok(
        runtimeEvents.some(
          (event) => event.actions?.permissionRequest?.requestId === 'permission-request-1',
        ),
        'expected the permission request fact to stay in the runtime ledger',
      );
      assert.equal(result.projection.inboxItems[0]?.kind, 'approval_request');
      assert.equal(result.projection.inboxItems[0]?.status, 'resolved');
      assert.ok(
        result.projection.events.some(
          (event) => event.type === 'permission_decision_recorded' && event.decision === 'deny',
        ),
        'expected a fail-closed permission denial event',
      );
    });
  });

  test('does not treat post-hoc matching permission grants as runtime authorization', async () => {
    await withDirs(async (_fixtureDir, storageRoot) => {
      let respondCalls = 0;
      const taskRunId = 'grant-run';
      const command = 'rm -rf /tmp/example';
      const grant: TaskPermissionGrant = {
        schemaVersion: 1,
        grantId: 'grant-posthoc',
        requestId: 'permission-request-1',
        taskRunId,
        attemptId: `${taskRunId}-attempt-1`,
        toolCallId: 'tool-1',
        toolName: 'Bash',
        normalizedArgsHash: hashNormalizedArgs({ command }),
        resourceScope: commandResourceScope(command),
        decision: 'allow',
        actor: { kind: 'test', id: 'unit' },
        source: 'test_fixture',
        decidedAt: 10,
        expiresAt: Number.MAX_SAFE_INTEGER,
      };
      const task: Task = {
        id: 'permission-grant-posthoc',
        instruction: 'run a dangerous command',
        workspaceDir: _fixtureDir,
        verification: { command: 'true', protectedPaths: [] },
      };

      const result = await runTaskOnce(fakeConfig, task, {
        storageRoot,
        taskRunId,
        registerBackends: registerPermissionRequestBackend(() => {
          respondCalls += 1;
        }, command),
        permissionGrants: [grant],
      });

      assert.equal(respondCalls, 0);
      assert.equal(result.resultRecord.status, 'failed');
      assert.equal(result.resultRecord.errorClass, 'policy_denied');
      assert.equal(result.projection.status, 'policy_denied');
      assert.equal(result.projection.permissionGrants.length, 1);
      assert.equal(result.projection.permissionGrants[0]?.grantId, 'grant-posthoc');
      assert.equal(
        result.projection.events.some(
          (event) => event.type === 'permission_decision_recorded' && event.decision === 'allow',
        ),
        false,
      );
      const denyDecision = result.projection.events.find(
        (event) => event.type === 'permission_decision_recorded',
      );
      assert.ok(denyDecision);
      if (denyDecision.type !== 'permission_decision_recorded') {
        throw new Error('expected permission_decision_recorded event');
      }
      assert.equal(denyDecision.decision, 'deny');
      assert.match(denyDecision.reason ?? '', /post-hoc permission requests/);
    });
  });

  test('redacts bash permission scopes and inbox previews while preserving args hash', async () => {
    await withDirs(async (_fixtureDir, storageRoot) => {
      const secret = 'SECRET_TOKEN_123456';
      const command = `printf ${secret} > /tmp/secret-output`;
      const task: Task = {
        id: 'permission-redaction',
        instruction: 'request permission',
        workspaceDir: _fixtureDir,
        verification: { command: 'true', protectedPaths: [] },
      };

      const result = await runTaskOnce(fakeConfig, task, {
        storageRoot,
        registerBackends: registerPermissionRequestBackend(() => {}, command),
      });

      const request = result.projection.permissionRequests[0];
      assert.ok(request);
      assert.equal(request.normalizedArgsHash, hashNormalizedArgs({ command }));
      assert.deepEqual(request.resourceScope, commandResourceScope(command));
      const serializedPermissionFacts = JSON.stringify({
        permissionRequests: result.projection.permissionRequests,
        inboxItems: result.projection.inboxItems,
        permissionEvents: result.projection.events.filter(
          (event) =>
            event.type === 'permission_request_recorded' ||
            event.type === 'task_inbox_item_recorded' ||
            event.type === 'task_inbox_item_resolved',
        ),
      });
      assert.equal(serializedPermissionFacts.includes(secret), false);
      assert.equal(serializedPermissionFacts.includes(command), false);
      assert.match(serializedPermissionFacts, new RegExp(request.normalizedArgsHash));
    });
  });

  test('parks permission requests in desktop intervention mode without verifying', async () => {
    await withDirs(async (_fixtureDir, storageRoot) => {
      const task: Task = {
        id: 'permission-park',
        instruction: 'run a dangerous command',
        workspaceDir: _fixtureDir,
        verification: { command: 'false', protectedPaths: [] },
      };

      const result = await runTaskOnce(fakeConfig, task, {
        storageRoot,
        registerBackends: registerPermissionRequestBackend(() => {}),
        interventionPolicy: { mode: 'park' },
      });

      assert.equal(result.resultRecord.status, 'failed');
      assert.equal(result.resultRecord.errorClass, 'needs_approval');
      assert.equal(result.projection.status, 'needs_approval');
      assert.equal(result.projection.parked?.reason, 'approval');
      assert.equal(result.projection.latestVerifierResult, undefined);
      assert.equal(result.projection.latestScoreResult, undefined);
      assert.equal(result.projection.attempts[0]?.status, 'needs_approval');
      assert.equal(result.projection.inboxItems[0]?.kind, 'approval_request');
      assert.equal(result.projection.inboxItems[0]?.status, 'open');
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
      assert.equal(
        (feedback.details.runtimeRefs as { runId?: string }).runId,
        result.invocation.runId,
      );
      assert.ok(
        (feedback.details.runtimeRefs as { runtimeEventIds?: string[] }).runtimeEventIds?.includes(
          'report-usage',
        ),
      );
      assert.deepEqual(feedback.details.artifactRefs, [
        { runtimeEventId: 'report-artifact', artifactId: 'artifact-1', toolCallId: 'tool-1' },
      ]);
      assert.equal((feedback.details.budget as { totals: { input: number } }).totals.input, 10);
      assert.deepEqual(
        result.projection.latestScoreResult?.details?.artifactRefs,
        feedback.details.artifactRefs,
      );

      const runtimeEventsPath = join(
        storageRoot,
        'sessions',
        result.invocation.sessionId,
        'runs',
        result.invocation.runId,
        'runtime-events.jsonl',
      );
      const runtimeEvents = await readFile(runtimeEventsPath, 'utf8');
      assert.match(runtimeEvents, /report-usage/);
      assert.match(runtimeEvents, /report-artifact/);
    });
  });
});
