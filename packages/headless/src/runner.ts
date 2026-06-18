import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { BackendKind } from '@maka/core';
import {
  BackendRegistry,
  SessionManager,
  type InvocationResult,
} from '@maka/runtime';
import {
  createAgentRunStore,
  createRuntimeEventStore,
  createSessionStore,
} from '@maka/storage';
import type { Config, ResultRecord, Task } from './contracts.js';
import { registerFakeBackend } from './backends.js';
import type { HeadlessBackendContext, RealBackendIsolation } from './isolation.js';
import { validateRealBackendIsolation } from './isolation.js';
import { prepareWorkspace, restoreProtectedPaths } from './sandbox.js';
import { runVerification } from './evaluator.js';

export interface RunExperimentDeps {
  /**
   * Where the lab writes session / run / trajectory JSONL. This is the
   * STORAGE root, distinct from the agent's cwd (the throwaway fixture
   * copy) — the agent never sees the lab's own bookkeeping.
   */
  storageRoot: string;
  /**
   * Override the backend wiring — a test seam. Defaults to the inert
   * FakeBackend, the only backend this build runs; real backends rejoin with
   * the isolated executor. Minimal usage is just `{ storageRoot }`.
   */
  registerBackends?: (registry: BackendRegistry, context: HeadlessBackendContext) => void | Promise<void>;
  /**
   * Required for every model-backed backend. This is deliberately explicit:
   * a throwaway workspace is not a security boundary, so a real backend may run
   * only when the caller provides an external isolation boundary such as a
   * Harbor/Terminal-Bench environment or Docker workspace executor.
   */
  realBackendIsolation?: RealBackendIsolation;
  now?: () => number;
  newId?: () => string;
}

/**
 * A backend is "inert" when it executes no real tools on the host — only the
 * stub FakeBackend qualifies. Every model-backed backend (`ai-sdk`,
 * `pi-agent`) can drive Bash/network, and the throwaway workspace is a copy,
 * not a jail, so running one in-process would hand the host (files, env incl.
 * API keys, network) to the config under test. Those run ONLY after the caller
 * supplies an explicit external isolation boundary; otherwise the preflight in
 * runExperiment fails closed.
 */
export function backendNeedsIsolation(backend: BackendKind): boolean {
  return backend !== 'fake';
}

/**
 * Validate a Task's grading boundary at the ENGINE boundary — so a public
 * `runExperiment` / `runMatrix` caller that omits or mis-declares
 * `protectedPaths` fails fast, before any workspace / session / backend is
 * created, instead of running the agent and only then tripping over a bad
 * field. The CLI reuses this; there is no second, divergent check.
 */
export function validateTaskVerification(task: Task): void {
  const protectedPaths = task.verification?.protectedPaths;
  if (!Array.isArray(protectedPaths)) {
    throw new Error(
      `task "${task.id}": verification.protectedPaths is required (an array; use [] when the verification reads nothing the agent can forge)`,
    );
  }
  for (const rel of protectedPaths) {
    if (typeof rel !== 'string' || isAbsolute(rel) || rel.split(/[\\/]+/).includes('..')) {
      throw new Error(`task "${task.id}": protectedPaths entry must be a workspace-relative path: ${String(rel)}`);
    }
  }
}

/**
 * Run one `Config × Task` end-to-end: copy the fixture into a throwaway
 * workspace, drive a single headless agent turn through SessionManager,
 * capture the trajectory, score it with the Task's verification command,
 * and return a ResultRecord. The workspace copy is always cleaned up.
 */
export async function runExperiment(
  config: Config,
  task: Task,
  deps: RunExperimentDeps,
): Promise<ResultRecord> {
  if (backendNeedsIsolation(config.backend)) {
    validateRealBackendIsolation(deps.realBackendIsolation);
    if (!deps.registerBackends) {
      throw new Error(
        `@maka/headless: backend "${config.backend}" requires registerBackends to wire an isolated backend factory`,
      );
    }
  }
  validateTaskVerification(task);
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? randomUUID;
  const startedAt = now();

  const workspace = await prepareWorkspace(task.workspaceDir);
  try {
    const backends = new BackendRegistry();
    const registerBackends: NonNullable<RunExperimentDeps['registerBackends']> =
      deps.registerBackends ?? ((registry) => registerFakeBackend(registry));
    await registerBackends(backends, {
      config,
      task,
      workspaceDir: workspace.dir,
      ...(backendNeedsIsolation(config.backend)
        ? { realBackendIsolation: deps.realBackendIsolation, toolExecutor: deps.realBackendIsolation?.toolExecutor }
        : {}),
    });

    let invocation: InvocationResult | undefined;
    const manager = new SessionManager({
      store: createSessionStore(deps.storageRoot),
      runStore: createAgentRunStore(deps.storageRoot),
      runtimeEventStore: createRuntimeEventStore(deps.storageRoot),
      backends,
      newId,
      now,
      runtimeSource: 'test',
      runtimeInvocationObserver: (result) => {
        invocation = result;
      },
    });

    const session = await manager.createSession({
      cwd: workspace.dir,
      backend: config.backend,
      llmConnectionSlug: config.llmConnectionSlug,
      model: config.model,
      permissionMode: 'execute',
      name: `lab:${config.id}:${task.id}`,
    });

    const turnId = newId();
    // Drain the turn to completion. The trajectory + status come from the
    // captured InvocationResult, not the streamed SessionEvents. If a backend
    // still asks this generic runner for an interactive permission decision,
    // fail safe and deny it; isolated eval backends should run with explicit
    // non-interactive policy/tooling.
    for await (const event of manager.sendMessage(session.id, { turnId, text: task.instruction })) {
      if ((event as { type?: string }).type === 'permission_request') {
        const { requestId } = event as { requestId: string };
        await manager.respondToPermission(session.id, { requestId, decision: 'deny', rememberForTurn: true });
      }
    }

    // Clean-room grading: restore the verification assets from the pristine
    // fixture so anything the agent wrote over its own test is reverted
    // before it is graded.
    await restoreProtectedPaths(task.workspaceDir, workspace.dir, task.verification.protectedPaths);

    const evaluation = await runVerification(
      task.verification.command,
      workspace.dir,
      task.verification.timeoutMs,
    );
    const finishedAt = now();
    const status = invocation?.status ?? 'failed';

    return {
      taskId: task.id,
      configId: config.id,
      sessionId: session.id,
      runId: invocation?.runId ?? turnId,
      status,
      // Only a completed run can "pass" — a crashed/errored run that happens
      // to leave a green fixture must not read as a pass.
      passed: status === 'completed' && evaluation.passed,
      exitCode: evaluation.exitCode,
      steps: invocation?.events.length ?? 0,
      durationMs: finishedAt - startedAt,
      startedAt,
      finishedAt,
      // A failed invocation (the backend reported failure without throwing, or
      // no result was captured) must carry an `error` so the comparison table
      // (⚠️) and the CLI exit code agree it was not a trustworthy run — not a
      // silent ⚠️-but-exit-0 that automation reads as success.
      ...(status === 'failed'
        ? {
            error: invocation?.failure?.message ?? invocation?.failure?.class ?? 'run did not complete',
            ...(invocation?.failure?.class ? { errorClass: invocation.failure.class } : {}),
          }
        : {}),
    };
  } finally {
    await workspace.cleanup();
  }
}
