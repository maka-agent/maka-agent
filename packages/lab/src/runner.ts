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
  now?: () => number;
  newId?: () => string;
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
    // auto-approve every request as it streams by. The lab IS the
    // autonomy boundary: isolation (throwaway workspace) is the safety
    // net here, not interactive confirmation.
    for await (const event of manager.sendMessage(session.id, { turnId, text: task.instruction })) {
      if ((event as { type?: string }).type === 'permission_request') {
        const { requestId } = event as { requestId: string };
        await manager.respondToPermission(session.id, { requestId, decision: 'allow', rememberForTurn: true });
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
      passed: evaluation.passed,
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
