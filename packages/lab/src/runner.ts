import { randomUUID } from 'node:crypto';
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
import { prepareWorkspace } from './sandbox.js';
import { runVerification } from './evaluator.js';

export interface RunExperimentDeps {
  /**
   * Where the lab writes session / run / trajectory JSONL. This is the
   * STORAGE root, distinct from the agent's cwd (the throwaway fixture
   * copy) — the agent never sees the lab's own bookkeeping.
   */
  storageRoot: string;
  /**
   * Registers the backend(s) a Config may select. Injected so the lab
   * core stays free of model/credential wiring: the skeleton registers a
   * FakeBackend; real runs register an AiSdkBackend (which reads keys via
   * the pure-Node CredentialStore). The registry is keyed by BackendKind.
   */
  registerBackends: (registry: BackendRegistry) => void;
  /**
   * Allow irreversible/host-reaching tool categories (delete, destructive
   * git, privileged, browser). Default false: the workspace is a copy, not
   * a jail, so these are denied unless you run inside a real OS/container
   * sandbox. Read/edit/shell still run — enough for ordinary coding tasks.
   */
  allowDangerousTools?: boolean;
  now?: () => number;
  newId?: () => string;
}

/** Categories `execute` mode still raises a prompt for — denied by default
 *  because the throwaway workspace does not contain their blast radius. */
const DANGEROUS_CATEGORIES = new Set(['fs_destructive', 'git_destructive', 'privileged', 'browser']);

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
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? randomUUID;
  const startedAt = now();

  const workspace = await prepareWorkspace(task.workspaceDir);
  try {
    const backends = new BackendRegistry();
    deps.registerBackends(backends);

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
    // captured InvocationResult, not the streamed SessionEvents — but a
    // headless benchmark has no human to answer permission prompts, so we
    // resolve each one as it streams by: allow ordinary tool use, deny the
    // dangerous categories whose blast radius escapes the workspace copy
    // (unless the caller opted in via allowDangerousTools).
    const allowDangerous = deps.allowDangerousTools === true;
    for await (const event of manager.sendMessage(session.id, { turnId, text: task.instruction })) {
      if ((event as { type?: string }).type === 'permission_request') {
        const { requestId, category } = event as { requestId: string; category: string };
        const decision = allowDangerous || !DANGEROUS_CATEGORIES.has(category) ? 'allow' : 'deny';
        await manager.respondToPermission(session.id, { requestId, decision, rememberForTurn: true });
      }
    }

    const evaluation = await runVerification(
      task.verification.command,
      workspace.dir,
      task.verification.timeoutMs,
    );
    const finishedAt = now();

    return {
      taskId: task.id,
      configId: config.id,
      sessionId: session.id,
      runId: invocation?.runId ?? turnId,
      status: invocation?.status ?? 'failed',
      // Only a completed run can "pass" — a crashed/errored run that happens
      // to leave a green fixture must not read as a pass.
      passed: invocation?.status === 'completed' && evaluation.passed,
      exitCode: evaluation.exitCode,
      steps: invocation?.events.length ?? 0,
      durationMs: finishedAt - startedAt,
      startedAt,
      finishedAt,
    };
  } finally {
    await workspace.cleanup();
  }
}
