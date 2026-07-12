import type { SessionEvent } from '@maka/core/events';
import type { SessionSummary } from '@maka/core/session';
import type { InvocationResult } from '@maka/runtime';
import {
  runMakaTextCli,
  type MakaRunContext,
  type MakaRunRuntime,
} from '../run-command.js';
import type { CreateMakaCliRuntimeContextInput } from '../runtime-bootstrap.js';
import type { ReadySessionTarget } from '../connection-target.js';

const scenario = process.env.MAKA_RUN_FIXTURE_SCENARIO ?? 'completed';
let observer: CreateMakaCliRuntimeContextInput['runtimeInvocationObserver'];
let permissionDenied = false;
let releaseStop: (() => void) | undefined;

const target = {
  connection: {
    slug: 'fixture',
    name: 'Fixture',
    providerType: 'ollama',
    enabled: true,
    defaultModel: 'fixture-model',
  },
  apiKey: '',
  model: 'fixture-model',
} as ReadySessionTarget;

const summary = {
  id: 'session-fixture',
  cwd: process.cwd(),
  name: 'fixture',
  isFlagged: false,
  isArchived: false,
  labels: [],
  hasUnread: false,
  status: 'active',
  backend: 'ai-sdk',
  llmConnectionSlug: 'fixture',
  model: 'fixture-model',
  permissionMode: 'explore',
} satisfies SessionSummary;

const runtime: MakaRunRuntime = {
  async createSession() {
    return summary;
  },
  async *sendMessage(_sessionId, input): AsyncIterable<SessionEvent> {
    if (scenario === 'runtime-error') throw new Error('provider failed after startup');
    if (scenario === 'permission') {
      yield {
        type: 'permission_request',
        id: 'event-permission',
        turnId: input.turnId,
        ts: 1,
        requestId: 'permission-1',
        toolUseId: 'tool-1',
        toolName: 'WebSearch',
        category: 'web_read',
        reason: 'network',
        args: { query: 'example' },
      };
      if (!permissionDenied) throw new Error('permission prompt was not denied');
      await notify(failedResult('permission_denied', 'permission request permission-1 was denied'));
      return;
    }
    if (scenario === 'slow') {
      process.stderr.write('fixture-ready\n');
      const keepAlive = setInterval(() => {}, 1_000);
      await new Promise<void>((resolve) => { releaseStop = resolve; });
      clearInterval(keepAlive);
      await notify(failedResult('aborted', 'fixture stopped'));
      return;
    }
    if (scenario === 'missing-output') {
      await notify(failedResult('missing_final_output', 'completed invocation produced no final output'));
      return;
    }
    const maxSteps = process.env.MAKA_RUN_EXPECT_MAX_STEPS;
    const output = maxSteps
      ? `maxSteps=${maxSteps};prompt=${input.text}`
      : `prompt=${input.text}`;
    await notify(completedResult(output));
  },
  async respondToPermission(_sessionId, response) {
    permissionDenied = response.decision === 'deny' && response.requestId === 'permission-1';
  },
  async stopSession() {
    releaseStop?.();
  },
};

async function createContext(input: CreateMakaCliRuntimeContextInput): Promise<MakaRunContext> {
  if (scenario === 'config-error') throw new Error('unknown connection fixture-missing');
  if (
    process.env.MAKA_RUN_EXPECT_MAX_STEPS
    && input.maxSteps !== Number(process.env.MAKA_RUN_EXPECT_MAX_STEPS)
  ) {
    throw new Error(`unexpected maxSteps ${String(input.maxSteps)}`);
  }
  observer = input.runtimeInvocationObserver;
  return { runtime, target, close: async () => {} };
}

function completedResult(finalOutput: string): InvocationResult {
  return {
    invocationId: 'invocation-fixture',
    runId: 'run-fixture',
    sessionId: summary.id,
    turnId: 'turn-fixture',
    status: 'completed',
    finalOutput,
    events: [],
    startedAt: 1,
    finishedAt: 2,
  };
}

function failedResult(failureClass: string, message: string): InvocationResult {
  return {
    invocationId: 'invocation-fixture',
    runId: 'run-fixture',
    sessionId: summary.id,
    turnId: 'turn-fixture',
    status: 'failed',
    events: [],
    failure: { class: failureClass, message },
    startedAt: 1,
    finishedAt: 2,
  };
}

async function notify(result: InvocationResult): Promise<void> {
  await observer?.(result);
}

runMakaTextCli(process.argv.slice(2), { createContext }).then(
  (code) => { process.exitCode = code; },
  (error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  },
);
