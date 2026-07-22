import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { HarborCellOutput } from '../cell-output.js';
import {
  FixedPromptBudgetExhaustedError,
  hashSystemPrompt,
  runFixedPromptController,
  type TaskRunInput,
} from '../fixed-prompt-controller.js';
import {
  buildPierRunArgs,
  createPierTaskRunner,
  PierInfraError,
  type PierProcessRunner,
  type PierRunRequest,
  type PierRunResult,
  type PierTaskRunnerOptions,
} from '../pier-task-runner.js';

function cellOutput(overrides: Partial<HarborCellOutput> = {}): HarborCellOutput {
  return {
    schemaVersion: 1,
    status: 'completed',
    runtimeEventsPath: '/logs/agent/runtime-events.jsonl',
    executionIdentity: {
      llmConnectionSlug: 'fake',
      model: 'fake',
      systemPromptMode: 'default',
      systemPromptHash: 'sha256:abc',
      pricingProfile: 'fake-structural',
    },
    toolSummary: {
      providerVisibleToolCount: 0,
      actualToolCalls: 0,
      actualToolNames: [],
      actualToolCallCounts: {},
    },
    steps: 1,
    durationMs: 9790,
    startedAt: 1,
    finishedAt: 2,
    runtimeRefs: { invocationId: 'inv', sessionId: 'sess', runId: 'run', turnId: 'turn' },
    ...overrides,
  };
}

interface FakeOptions {
  reward?: number;
  rewardJson?: boolean;
  verifierResultReward?: number;
  cell?: HarborCellOutput | null;
  executionIdentity?: Record<string, unknown>;
  exceptionInfo?: { exception_type: string; exception_message: string };
  exitCode?: number;
  timedOut?: boolean;
  combinedTrace?: boolean;
  captured?: { request?: PierRunRequest; envFile?: Record<string, string> };
}

/** A Pier process runner that writes the maka-dasel-fake2 trial layout: a
 * `<task>__<7ch>` trial dir with agent/maka-cell-output.json, verifier/reward.json,
 * and result.json (job aggregate + per-trial). Mirrors the captured schema. */
function fakePier(opts: FakeOptions): PierProcessRunner {
  return async (request): Promise<PierRunResult> => {
    if (opts.captured) {
      opts.captured.request = request;
      const envFileFlag = request.args.indexOf('--env-file');
      if (envFileFlag >= 0) {
        const raw = await readFile(request.args[envFileFlag + 1]!, 'utf8');
        opts.captured.envFile = Object.fromEntries(
          raw
            .split('\n')
            .filter((line) => line.includes('='))
            .map((line) => {
              const index = line.indexOf('=');
              return [line.slice(0, index), line.slice(index + 1)];
            }),
        );
      }
    }
    if (opts.timedOut) {
      return { exitCode: 137, stdout: '', stderr: 'killed', timedOut: true, signal: 'SIGKILL' };
    }
    if (opts.exitCode && opts.exitCode !== 0 && opts.cell === undefined && !opts.exceptionInfo) {
      return { exitCode: opts.exitCode, stdout: '', stderr: 'container build failed' };
    }
    const pathFlag = request.args.indexOf('-p');
    const taskName = request.args[pathFlag + 1]!.split('/').pop()!;
    const trialDir = join(request.jobsDir, request.jobName, `${taskName}__fjabYqp`);
    await mkdir(join(trialDir, 'agent'), { recursive: true });
    await mkdir(join(trialDir, 'verifier'), { recursive: true });
    if (opts.cell !== null) {
      await writeFile(
        join(trialDir, 'agent', 'maka-cell-output.json'),
        JSON.stringify(opts.cell ?? cellOutput()),
        'utf8',
      );
    }
    if (opts.executionIdentity) {
      await writeFile(
        join(trialDir, 'agent', 'maka-cell-execution-identity.json'),
        JSON.stringify(opts.executionIdentity),
        'utf8',
      );
    }
    await writeFile(join(trialDir, 'agent', 'runtime-events.jsonl'), '{"type":"x"}\n', 'utf8');
    if (opts.combinedTrace) {
      await writeFile(join(trialDir, 'agent', 'trace-events.jsonl'), '{"type":"first"}\n', 'utf8');
    }
    if (opts.reward !== undefined && opts.rewardJson !== false) {
      await writeFile(
        join(trialDir, 'verifier', 'reward.json'),
        JSON.stringify({ reward: opts.reward, f2p: 0, p2p: 1 }),
        'utf8',
      );
    }
    const trialResult: Record<string, unknown> = {
      trial_name: `${taskName}__fjabYqp`,
      exception_info: opts.exceptionInfo ?? null,
      ...(opts.verifierResultReward !== undefined
        ? { verifier_result: { rewards: { reward: opts.verifierResultReward } } }
        : {}),
    };
    await writeFile(join(trialDir, 'result.json'), JSON.stringify(trialResult), 'utf8');
    // Job aggregate result.json points at the trial name via stats.evals[*].reward_stats.
    await writeFile(
      join(request.jobsDir, request.jobName, 'result.json'),
      JSON.stringify({
        stats: {
          evals: {
            maka__fake__adhoc: {
              reward_stats: { reward: { '0': [`${taskName}__fjabYqp`] } },
            },
          },
        },
      }),
      'utf8',
    );
    return { exitCode: opts.exitCode ?? 0, stdout: 'ok', stderr: '' };
  };
}

function runInput(overrides: Partial<TaskRunInput> = {}): TaskRunInput {
  return {
    runId: 'run-1',
    roundId: 'round-1',
    task: { id: 'dasel', path: '/tasks/dasel-html-document-format' },
    config: { id: 'cfg', backend: 'ai-sdk', llmConnectionSlug: 'fake', model: 'fake' },
    systemPrompt: 'CANDIDATE PROMPT\n',
    ...overrides,
  };
}

async function withDirs<T>(
  fn: (dirs: { jobsDir: string; repo: string }) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'maka-pier-runner-'));
  try {
    return await fn({ jobsDir: join(root, 'jobs'), repo: join(root, 'repo') });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function baseOptions(
  overrides: Partial<PierTaskRunnerOptions> &
    Pick<PierTaskRunnerOptions, 'jobsDir' | 'makaRepoPath'>,
): PierTaskRunnerOptions {
  return { model: 'fake', backend: 'fake', ...overrides };
}

test('buildPierRunArgs emits the pier CLI contract for the Maka arm', () => {
  const args = buildPierRunArgs({
    agent: 'maka',
    model: 'k3',
    taskPath: '/tasks/dasel',
    jobsDir: '/jobs',
    jobName: 'trial',
    environment: 'docker',
    timeoutMultiplier: 1,
    mounts: [{ type: 'bind', source: '/repo', target: '/opt/maka-agent', read_only: true }],
    agentEnv: { MAKA_MODEL: 'k3', MAKA_PROVIDER: 'kimi-coding-plan' },
  });
  const joined = args.join(' ');
  assert.match(joined, /--agent-import-path maka_agent:MakaAgent/);
  assert.match(joined, /-m k3/);
  assert.match(joined, /-p \/tasks\/dasel/);
  assert.match(joined, /-o \/jobs/);
  assert.match(joined, /--job-name trial/);
  assert.match(joined, /-k 1/);
  assert.match(joined, /-n 1/);
  assert.match(joined, /--yes/);
  assert.ok(args.includes('--mounts-json'));
  assert.ok(args.includes('--ae'));
  assert.ok(args.includes('MAKA_MODEL=k3'));
  // No provider secret and no env-file were requested.
  assert.ok(!args.includes('--env-file'));
});

test('buildPierRunArgs targets the Kimi Code adapter and forwards an env-file', () => {
  const args = buildPierRunArgs({
    agent: 'kimi-code',
    model: 'k3',
    taskPath: '/tasks/dasel',
    jobsDir: '/jobs',
    jobName: 'trial',
    environment: 'docker',
    timeoutMultiplier: 1,
    mounts: [],
    agentEnv: {},
    envFile: '/jobs/pier-agent.env',
  });
  assert.match(args.join(' '), /--agent-import-path kimi_code_agent:MakaKimiCodeAgent/);
  const envFileFlag = args.indexOf('--env-file');
  assert.equal(args[envFileFlag + 1], '/jobs/pier-agent.env');
});

test('createPierTaskRunner maps a completed fake trial to reward and host cell paths', async () => {
  await withDirs(async ({ jobsDir, repo }) => {
    const captured: FakeOptions['captured'] = {};
    const runner = createPierTaskRunner(
      baseOptions({
        jobsDir,
        makaRepoPath: repo,
        runPier: fakePier({ reward: 0, captured }),
      }),
    );
    const output = await runner(runInput());
    assert.equal(output.harbor.reward, 0);
    // Pier's grading is surfaced as the structured verifier outcome the
    // controller requires for failed-cell scoring.
    assert.deepEqual(output.harbor.verifier, {
      outcome: 'failed',
      attempts: [{ attempt: 1, classification: 'failed', durationMs: 0, reward: 0 }],
    });
    assert.equal(output.cell.status, 'completed');
    // The container-local runtime path is overridden with the host trial path.
    assert.match(output.cell.runtimeEventsPath, /agent\/runtime-events\.jsonl$/);
    assert.ok(output.cell.runtimeEventsPath.startsWith(jobsDir));
    // MAKA_BACKEND rides the process env (CliFlag env_fallback reads os.environ),
    // never `--ae`.
    assert.equal(captured.request?.env?.MAKA_BACKEND, 'fake');
    assert.ok(!captured.request?.args.some((arg) => arg.startsWith('MAKA_BACKEND=')));
    // The system prompt rides the process env byte-exact (trailing newline
    // preserved) and must NOT appear in --ae, whose values pier strips — a
    // stripped extra_env copy would shadow os.environ and break the
    // execution-identity hash round-trip.
    assert.equal(captured.request?.env?.MAKA_SYSTEM_PROMPT, 'CANDIDATE PROMPT\n');
    assert.ok(!captured.request?.args.some((arg) => arg.startsWith('MAKA_SYSTEM_PROMPT=')));
  });
});

test('createPierTaskRunner passes the provider-local bare model id to pier -m', async () => {
  await withDirs(async ({ jobsDir, repo }) => {
    const captured: FakeOptions['captured'] = {};
    const runner = createPierTaskRunner(
      baseOptions({
        jobsDir,
        makaRepoPath: repo,
        model: 'deepseek/deepseek-v4-flash',
        provider: 'deepseek',
        runPier: fakePier({ reward: 0, captured }),
      }),
    );
    await runner(runInput());
    // The adapter's model_name outranks MAKA_MODEL, so a prefixed -m would leak
    // the provider-prefixed id into the cell. Same contract as modelIdForProvider
    // in the Harbor runner.
    const modelFlag = captured.request?.args.indexOf('-m') ?? -1;
    assert.equal(captured.request?.args[modelFlag + 1], 'deepseek-v4-flash');
    assert.ok(captured.request?.args.includes('MAKA_MODEL=deepseek-v4-flash'));
  });
});

test('createPierTaskRunner derives the wall-clock watchdog from the task-native budget', async () => {
  await withDirs(async ({ jobsDir, repo }) => {
    const captured: FakeOptions['captured'] = {};
    const runner = createPierTaskRunner(
      baseOptions({ jobsDir, makaRepoPath: repo, runPier: fakePier({ reward: 0, captured }) }),
    );
    // DeepSWE-shaped budget: 5400s agent + 1800s verifier. A fixed 45-minute
    // watchdog would kill every trial mid-flight; the shared Harbor derivation
    // yields native phases + 15min setup/teardown grace.
    await runner(
      runInput({
        task: {
          id: 'dasel',
          path: '/tasks/dasel-html-document-format',
          metadata: { agentTimeoutSec: 5400, verifierTimeoutSec: 1800 },
        },
      }),
    );
    assert.equal(captured.request?.timeoutMs, (5400 + 1800) * 1_000 + 15 * 60_000);

    // Without task metadata the 45-minute floor holds.
    await runner(runInput());
    assert.equal(captured.request?.timeoutMs, 45 * 60_000);

    // An explicit pierTimeoutMs still wins.
    const explicit = createPierTaskRunner(
      baseOptions({
        jobsDir,
        makaRepoPath: repo,
        pierTimeoutMs: 1_234,
        runPier: fakePier({ reward: 0, captured }),
      }),
    );
    await explicit(
      runInput({
        task: {
          id: 'dasel',
          path: '/tasks/dasel-html-document-format',
          metadata: { agentTimeoutSec: 5400, verifierTimeoutSec: 1800 },
        },
      }),
    );
    assert.equal(captured.request?.timeoutMs, 1_234);
  });
});

test('createPierTaskRunner falls back to the trial verifier_result reward', async () => {
  await withDirs(async ({ jobsDir, repo }) => {
    const runner = createPierTaskRunner(
      baseOptions({
        jobsDir,
        makaRepoPath: repo,
        runPier: fakePier({ reward: 1, rewardJson: false, verifierResultReward: 1 }),
      }),
    );
    const output = await runner(runInput());
    assert.equal(output.harbor.reward, 1);
  });
});

test('createPierTaskRunner surfaces the combined trace path when present', async () => {
  await withDirs(async ({ jobsDir, repo }) => {
    const runner = createPierTaskRunner(
      baseOptions({
        jobsDir,
        makaRepoPath: repo,
        runPier: fakePier({ reward: 0, combinedTrace: true }),
      }),
    );
    const output = await runner(runInput());
    assert.match(output.cell.traceEventsPath ?? '', /agent\/trace-events\.jsonl$/);
  });
});

test('createPierTaskRunner classifies a pier launch failure as infra', async () => {
  await withDirs(async ({ jobsDir, repo }) => {
    const runner = createPierTaskRunner(
      baseOptions({
        jobsDir,
        makaRepoPath: repo,
        runPier: () => Promise.reject(new Error('pier: command not found')),
      }),
    );
    await assert.rejects(runner(runInput()), (error: Error) => {
      assert.ok(error instanceof PierInfraError);
      assert.equal(error.kind, 'infra_failed');
      return true;
    });
  });
});

test('createPierTaskRunner classifies a timed-out pier run', async () => {
  await withDirs(async ({ jobsDir, repo }) => {
    const runner = createPierTaskRunner(
      baseOptions({ jobsDir, makaRepoPath: repo, runPier: fakePier({ timedOut: true }) }),
    );
    await assert.rejects(runner(runInput()), (error: Error) => {
      assert.ok(error instanceof PierInfraError);
      assert.equal(error.kind, 'timed_out');
      return true;
    });
  });
});

test('createPierTaskRunner reports a budget exhaustion as a benchmark outcome', async () => {
  await withDirs(async ({ jobsDir, repo }) => {
    const runner = createPierTaskRunner(
      baseOptions({
        jobsDir,
        makaRepoPath: repo,
        runPier: fakePier({
          cell: null,
          exceptionInfo: {
            exception_type: 'AgentTimeoutError',
            exception_message: 'Agent execution timed out after 600 seconds',
          },
        }),
      }),
    );
    await assert.rejects(
      runner(runInput()),
      (error: Error) => error instanceof FixedPromptBudgetExhaustedError,
    );
  });
});

test('pier-graded failed cells stay scored through the fixed-prompt controller', async () => {
  await withDirs(async ({ jobsDir, repo }) => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-pier-controller-'));
    try {
      const systemPrompt = 'CANDIDATE PROMPT\n';
      const systemPromptPath = join(dir, 'prompt.txt');
      await writeFile(systemPromptPath, systemPrompt, 'utf8');
      const promptHash = hashSystemPrompt(systemPrompt);
      const cell = cellOutput({
        status: 'failed',
        errorClass: 'max_tokens',
        promptHash,
        executionIdentity: {
          llmConnectionSlug: 'fake',
          model: 'fake',
          systemPromptMode: 'default',
          systemPromptHash: promptHash,
          pricingProfile: 'fake-structural',
        },
      });
      const runner = createPierTaskRunner(
        baseOptions({ jobsDir, makaRepoPath: repo, runPier: fakePier({ reward: 0, cell }) }),
      );
      const result = await runFixedPromptController({
        runId: 'run-1',
        roundId: 'round-1',
        config: { id: 'cfg', backend: 'fake', llmConnectionSlug: 'fake', model: 'fake' },
        systemPromptPath,
        resultsJsonlPath: join(dir, 'results.jsonl'),
        tasks: [{ id: 'dasel', path: '/tasks/dasel-html-document-format' }],
        taskRunner: runner,
      });
      // Without the structured verifier outcome this event is scored=false and
      // silently leaves the benchmark denominator.
      const event = result.events[0]!;
      assert.equal(event.type, 'task_completed');
      assert.equal(event.passed, false);
      assert.equal(event.scored, true);
      assert.equal(event.eligible, true);
      assert.equal(event.errorClass, 'max_tokens');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

test('createPierTaskRunner recovers execution identity from a budget-exhausted trial', async () => {
  await withDirs(async ({ jobsDir, repo }) => {
    const identity = {
      llmConnectionSlug: 'fake',
      model: 'fake',
      systemPromptMode: 'default',
      systemPromptHash: 'sha256:abc',
      pricingProfile: 'fake-structural',
    };
    const runner = createPierTaskRunner(
      baseOptions({
        jobsDir,
        makaRepoPath: repo,
        runPier: fakePier({
          cell: null,
          executionIdentity: identity,
          exceptionInfo: {
            exception_type: 'AgentTimeoutError',
            exception_message: 'Agent execution timed out after 600 seconds',
          },
        }),
      }),
    );
    // The recovered identity keeps the sample Pass@1-eligible; a null
    // artifactRefs would demote it to missing_execution_identity and silently
    // shrink the benchmark denominator. Recovery is the shared Harbor
    // implementation (readTimedOutTrialArtifacts), so both runners honor the
    // same cross-runner contract by construction.
    await assert.rejects(runner(runInput()), (error: Error) => {
      assert.ok(error instanceof FixedPromptBudgetExhaustedError);
      assert.deepEqual(error.artifactRefs?.executionIdentity, identity);
      return true;
    });
  });
});

test('createPierTaskRunner treats a non-budget trial exception as infra', async () => {
  await withDirs(async ({ jobsDir, repo }) => {
    const runner = createPierTaskRunner(
      baseOptions({
        jobsDir,
        makaRepoPath: repo,
        runPier: fakePier({
          cell: null,
          exceptionInfo: { exception_type: 'RuntimeError', exception_message: 'boom' },
        }),
      }),
    );
    await assert.rejects(runner(runInput()), (error: Error) => {
      assert.ok(error instanceof PierInfraError);
      assert.match(error.message, /pier trial errored/);
      return true;
    });
  });
});

test('createPierTaskRunner rejects provider secrets in agentEnv', async () => {
  await withDirs(async ({ jobsDir, repo }) => {
    const runner = createPierTaskRunner(
      baseOptions({
        jobsDir,
        makaRepoPath: repo,
        agentEnv: { KIMI_MODEL_API_KEY: 'sk-real' },
        runPier: fakePier({ reward: 0 }),
      }),
    );
    await assert.rejects(runner(runInput()), /must not contain provider secrets/);
  });
});

test('createPierTaskRunner rejects experiment identity and pricing overrides in agentEnv', async () => {
  await withDirs(async ({ jobsDir, repo }) => {
    const overrides: Array<Record<string, string>> = [
      { MAKA_MODEL: 'other-model' },
      { MAKA_TRIAL_INPUT_USD_PER_1M: '9' },
    ];
    for (const env of overrides) {
      const runner = createPierTaskRunner(
        baseOptions({
          jobsDir,
          makaRepoPath: repo,
          agentEnv: env,
          runPier: fakePier({ reward: 0 }),
        }),
      );
      await assert.rejects(runner(runInput()), /must not override experiment identity/);
    }
  });
});

test('createPierTaskRunner requires the Kimi toolchain mount for the Kimi arm', async () => {
  await withDirs(async ({ jobsDir, repo }) => {
    const runner = createPierTaskRunner(
      baseOptions({
        jobsDir,
        makaRepoPath: repo,
        agent: 'kimi-code',
        provider: 'kimi-coding-plan',
        resolveProviderCredential: () => Promise.resolve({ value: 'upstream-key' }),
        runPier: fakePier({ reward: 0 }),
      }),
    );
    await assert.rejects(runner(runInput()), /kimiCodeToolchainPath is required/);
  });
});

test('createPierTaskRunner wires the Kimi arm through the host proxy on a Squid-legal port', async () => {
  await withDirs(async ({ jobsDir, repo }) => {
    const captured: FakeOptions['captured'] = {};
    const runner = createPierTaskRunner(
      baseOptions({
        jobsDir,
        makaRepoPath: repo,
        agent: 'kimi-code',
        backend: 'ai-sdk',
        provider: 'kimi-coding-plan',
        model: 'k3',
        baseUrl: 'https://api.kimi.com/coding/v1',
        kimiCodeToolchainPath: repo,
        resolveProviderCredential: () => Promise.resolve({ value: 'upstream-key' }),
        // A fixed high port stands in for 80/443 without needing privileges.
        providerProxyPort: 0,
        runPier: fakePier({ reward: 0, captured }),
      }),
    );
    const output = await runner(runInput());
    assert.equal(output.harbor.reward, 0);
    // The proxy URL and a minted (non-real) token reach the container via env-file,
    // never argv.
    assert.match(
      captured.envFile?.MAKA_PROVIDER_PROXY_URL ?? '',
      /^http:\/\/host\.docker\.internal:\d+$/,
    );
    assert.ok((captured.envFile?.MAKA_PROVIDER_PROXY_TOKEN ?? '').length >= 32);
    assert.notEqual(captured.envFile?.MAKA_PROVIDER_PROXY_TOKEN, 'upstream-key');
    assert.ok(!captured.request?.args.some((arg) => arg.startsWith('MAKA_PROVIDER_PROXY_TOKEN=')));
    // The Kimi toolchain is mounted read-only alongside the maka repo.
    const mountsFlag = captured.request?.args.indexOf('--mounts-json') ?? -1;
    const mounts = JSON.parse(captured.request!.args[mountsFlag + 1]!) as Array<{ target: string }>;
    assert.ok(mounts.some((mount) => mount.target === '/opt/maka-kimi-code-toolchain'));
  });
});

test('createPierTaskRunner serializes concurrent Kimi attempts holding the fixed proxy port', async () => {
  await withDirs(async ({ jobsDir, repo }) => {
    let inFlight = 0;
    let maxInFlight = 0;
    const inner = fakePier({ reward: 0 });
    const runner = createPierTaskRunner(
      baseOptions({
        jobsDir,
        makaRepoPath: repo,
        agent: 'kimi-code',
        backend: 'ai-sdk',
        provider: 'kimi-coding-plan',
        model: 'k3',
        baseUrl: 'https://api.kimi.com/coding/v1',
        kimiCodeToolchainPath: repo,
        resolveProviderCredential: () => Promise.resolve({ value: 'upstream-key' }),
        providerProxyPort: 0,
        runPier: async (request) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 25));
          try {
            return await inner(request);
          } finally {
            inFlight -= 1;
          }
        },
      }),
    );
    // The default Kimi port is fixed (443): a second concurrent bind would be a
    // guaranteed EADDRINUSE, so the runner must hold the port one attempt at a
    // time while both attempts still complete.
    const [first, second] = await Promise.all([
      runner(runInput({ task: { id: 't1', path: '/tasks/dasel-html-document-format' } })),
      runner(runInput({ task: { id: 't2', path: '/tasks/dasel-html-document-format' } })),
    ]);
    assert.equal(first.harbor.reward, 0);
    assert.equal(second.harbor.reward, 0);
    assert.equal(maxInFlight, 1);
  });
});

test('createPierTaskRunner keeps the real key host-side via a file path for the Maka arm', async () => {
  await withDirs(async ({ jobsDir, repo }) => {
    const captured: FakeOptions['captured'] = {};
    const keyFile = join(repo, 'key');
    await mkdir(repo, { recursive: true });
    await writeFile(keyFile, 'sk-real\n', 'utf8');
    const runner = createPierTaskRunner(
      baseOptions({
        jobsDir,
        makaRepoPath: repo,
        agent: 'maka',
        backend: 'ai-sdk',
        provider: 'kimi-coding-plan',
        baseUrl: 'https://api.kimi.com/coding/v1',
        apiKeyFile: keyFile,
        runPier: fakePier({ reward: 0, captured }),
      }),
    );
    await runner(runInput());
    // Only the key-file PATH rides --ae; the key itself never leaves the file.
    assert.ok(captured.request?.args.includes(`MAKA_HOST_API_KEY_FILE=${keyFile}`));
    assert.ok(!captured.request?.args.some((arg) => arg.includes('sk-real')));
    assert.ok(captured.request?.args.includes('MAKA_HOST_BASE_URL=https://api.kimi.com/coding/v1'));
  });
});
