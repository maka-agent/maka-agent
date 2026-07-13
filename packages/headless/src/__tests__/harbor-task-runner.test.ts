import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { tokenSummary } from './helpers/cell-output-fixtures.js';
import type { HarborCellExecutionIdentity, HarborCellOutput } from '../cell-output.js';
import { FixedPromptBudgetExhaustedError, type HarborTaskRunInput } from '../fixed-prompt-controller.js';
import {
  buildHarborJobConfig,
  createHarborTaskRunner,
  HarborInfraError,
  type HarborProcessRunner,
  type HarborRunResult,
} from '../harbor-task-runner.js';

function cellOutput(overrides: Partial<HarborCellOutput> = {}): HarborCellOutput {
  return {
    schemaVersion: 1,
    status: 'completed',
    runtimeEventsPath: '/logs/agent/runtime-events.jsonl',
    promptHash: 'sha256:abc',
    tokenSummary: tokenSummary({ input: 100, output: 50, reasoning: 0, total: 150, costUsd: 0.0001 }),
    toolSummary: {
      providerVisibleToolCount: 6,
      actualToolCalls: 2,
      actualToolNames: ['Bash'],
      actualToolCallCounts: { Bash: 2 },
    },
    steps: 3,
    durationMs: 1000,
    startedAt: 1,
    finishedAt: 2,
    runtimeRefs: { invocationId: 'inv', sessionId: 'sess', runId: 'run', turnId: 'turn' },
    ...overrides,
  };
}

function runInput(overrides: Partial<HarborTaskRunInput> = {}): HarborTaskRunInput {
  return {
    runId: 'run-1',
    roundId: 'round-1',
    task: { id: 'task-1', path: '/tasks/cobol-modernization' },
    config: { id: 'cfg', backend: 'ai-sdk', llmConnectionSlug: 'deepseek', model: 'deepseek-v4-flash' },
    systemPrompt: 'CANDIDATE PROMPT\n',
    ...overrides,
  };
}

interface FakeOptions {
  reward?: string;
  cell?: HarborCellOutput | null;
  executionIdentity?: HarborCellExecutionIdentity;
  exitCode?: number;
  events?: string;
  verifierStdout?: string;
  trialResult?: Record<string, unknown>;
  captured?: { config?: Record<string, unknown> };
}

function fakeRunner(opts: FakeOptions): HarborProcessRunner {
  return async (request): Promise<HarborRunResult> => {
    const config = JSON.parse(await readFile(request.configPath, 'utf8')) as Record<string, unknown>;
    if (opts.captured) opts.captured.config = config;
    if (opts.exitCode && opts.exitCode !== 0) {
      return { exitCode: opts.exitCode, stdout: '', stderr: 'container build failed' };
    }
    const tasks = config.tasks as Array<{ path: string }>;
    const taskName = tasks[0]!.path.split('/').pop()!;
    const trialDir = join(request.jobsDir, request.jobName, `${taskName}__t1`);
    await mkdir(join(trialDir, 'verifier'), { recursive: true });
    await mkdir(join(trialDir, 'agent'), { recursive: true });
    if (opts.reward !== undefined) {
      await writeFile(join(trialDir, 'verifier', 'reward.txt'), opts.reward, 'utf8');
    }
    if (opts.verifierStdout !== undefined) {
      await writeFile(join(trialDir, 'verifier', 'test-stdout.txt'), opts.verifierStdout, 'utf8');
    }
    if (opts.cell !== null) {
      await writeFile(join(trialDir, 'agent', 'maka-cell-output.json'), JSON.stringify(opts.cell ?? cellOutput()), 'utf8');
    }
    if (opts.executionIdentity) {
      await writeFile(
        join(trialDir, 'agent', 'maka-cell-execution-identity.json'),
        JSON.stringify(opts.executionIdentity),
        'utf8',
      );
    }
    if (opts.trialResult) {
      await writeFile(join(trialDir, 'result.json'), JSON.stringify(opts.trialResult), 'utf8');
    }
    await writeFile(join(trialDir, 'agent', 'runtime-events.jsonl'), opts.events ?? '{"type":"x"}\n', 'utf8');
    await mkdir(join(trialDir, 'agent', 'maka-storage', 'sessions', 'sess', 'runs', 'run'), { recursive: true });
    await writeFile(join(trialDir, 'agent', 'maka-storage', 'sessions', 'sess', 'runs', 'run', 'events.jsonl'), '{"type":"tool_failed"}\n', 'utf8');
    return { exitCode: 0, stdout: 'ok', stderr: '' };
  };
}

async function withRun<T>(fn: (dirs: { jobsDir: string; repo: string; keyFile: string }) => Promise<T>): Promise<T> {
  const base = await mkdtemp(join(tmpdir(), 'maka-harbor-runner-'));
  const repo = join(base, 'repo');
  const jobsDir = join(base, 'jobs');
  const keyFile = join(base, 'deepseek-key');
  await mkdir(repo, { recursive: true });
  await writeFile(keyFile, 'sk-secret\n', 'utf8');
  try {
    return await fn({ jobsDir, repo, keyFile });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

describe('createHarborTaskRunner', () => {
  test('parses reward + cell output and rewrites runtime events to the host path', async () => {
    await withRun(async ({ jobsDir, repo, keyFile }) => {
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        model: 'deepseek/deepseek-v4-flash',
        provider: 'deepseek',
        apiKeyFile: keyFile,
        pricing: { inputUsdPer1M: 0.145, outputUsdPer1M: 0.29, cacheReadUsdPer1M: 0.0029, source: 'v4-flash' },
        runHarbor: fakeRunner({ reward: '1\n', cell: cellOutput({ promptHash: 'sha256:candidate' }) }),
      });

      const output = await runner(runInput());
      assert.equal(output.harbor.reward, 1);
      assert.equal(output.cell.status, 'completed');
      assert.equal(output.cell.promptHash, 'sha256:candidate');
      // runtimeEventsPath must be the host trial path, not the container path.
      assert.match(output.cell.runtimeEventsPath, /run-1\/round-1\/task-1\/trial\/cobol-modernization__t1\/agent\/runtime-events\.jsonl$/);
      assert.doesNotMatch(output.cell.runtimeEventsPath, /^\/logs\//);
      assert.match(output.cell.traceEventsPath ?? '', /run-1\/round-1\/task-1\/trial\/cobol-modernization__t1\/agent\/maka-storage\/sessions\/sess\/runs\/run\/events\.jsonl$/);
      assert.doesNotMatch(output.cell.traceEventsPath ?? '', /^\/logs\//);
    });
  });

  test('selects the Harbor result trial instead of a stale matching directory', async () => {
    await withRun(async ({ jobsDir, repo }) => {
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        model: 'deepseek/deepseek-v4-flash',
        runHarbor: async (request) => {
          const staleDir = join(request.jobsDir, request.jobName, 'cobol-modernization__aaa');
          await mkdir(join(staleDir, 'agent'), { recursive: true });
          await writeFile(join(staleDir, 'agent', 'maka-cell-output.json'), JSON.stringify(cellOutput({ promptHash: 'sha256:stale' })), 'utf8');

          const realDir = join(request.jobsDir, request.jobName, 'cobol-modernization__zzz');
          await mkdir(join(realDir, 'verifier'), { recursive: true });
          await mkdir(join(realDir, 'agent'), { recursive: true });
          await writeFile(join(realDir, 'verifier', 'reward.txt'), '1\n', 'utf8');
          await writeFile(join(realDir, 'agent', 'maka-cell-output.json'), JSON.stringify(cellOutput({ promptHash: 'sha256:real' })), 'utf8');
          await writeFile(join(realDir, 'agent', 'runtime-events.jsonl'), '{"type":"x"}\n', 'utf8');
          await mkdir(join(realDir, 'agent', 'maka-storage', 'sessions', 'sess', 'runs', 'run'), { recursive: true });
          await writeFile(join(realDir, 'agent', 'maka-storage', 'sessions', 'sess', 'runs', 'run', 'events.jsonl'), '{"type":"tool_failed"}\n', 'utf8');
          await writeFile(join(request.jobsDir, request.jobName, 'result.json'), JSON.stringify({
            stats: {
              evals: {
                maka: {
                  reward_stats: { reward: { '1.0': ['cobol-modernization__zzz'] } },
                },
              },
            },
          }), 'utf8');
          return { exitCode: 0, stdout: 'ok', stderr: '' };
        },
      });

      const output = await runner(runInput());
      assert.equal(output.cell.promptHash, 'sha256:real');
      assert.equal(output.harbor.reward, 1);
    });
  });

  test('generates a JobConfig with verbatim prompt, host-side provider auth, and trial pricing', async () => {
    await withRun(async ({ jobsDir, repo, keyFile }) => {
      const captured: { config?: Record<string, unknown> } = {};
      let harborEnv: Record<string, string> | undefined;
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        model: 'deepseek/deepseek-v4-flash',
        provider: 'deepseek',
        apiKeyFile: keyFile,
        pricing: { inputUsdPer1M: 0.145, outputUsdPer1M: 0.29, cacheReadUsdPer1M: 0.0029, source: 'v4-flash' },
        agentEnv: { DEEPSEEK_BASE_URL: 'https://api.deepseek.com' },
        runHarbor: async (request) => {
          harborEnv = request.env;
          return fakeRunner({ reward: '0\n', captured })(request);
        },
      });
      await runner(runInput({ systemPrompt: 'PROMPT WITH\nNEWLINES\n' }));

      const config = captured.config!;
      const agent = (config.agents as Array<Record<string, unknown>>)[0]!;
      const env = agent.env as Record<string, string>;
      assert.equal(agent.import_path, 'maka_agent:MakaAgent');
      assert.equal(config.n_attempts, 1);
      assert.equal(config.n_concurrent_trials, 1);
      assert.equal(env.MAKA_BACKEND, 'ai-sdk');
      // The provider-matching prefix is stripped so the native DeepSeek API gets a
      // bare model id (slashful would 400). model_name carries the same value.
      assert.equal(env.MAKA_MODEL, 'deepseek-v4-flash');
      assert.equal(agent.model_name, 'deepseek-v4-flash');
      // Byte-for-byte, including the trailing newline the controller hashes.
      assert.equal(env.MAKA_SYSTEM_PROMPT, 'PROMPT WITH\nNEWLINES\n');
      assert.equal(env.DEEPSEEK_API_KEY_FILE, undefined);
      assert.equal(env.DEEPSEEK_API_KEY, undefined);
      assert.equal(env.DEEPSEEK_BASE_URL, undefined);
      assert.equal(env.MAKA_TRIAL_INPUT_USD_PER_1M, '0.145');
      assert.equal(env.MAKA_TRIAL_OUTPUT_USD_PER_1M, '0.29');
      assert.equal(env.MAKA_TRIAL_CACHE_READ_USD_PER_1M, '0.0029');
      assert.equal(env.MAKA_TRIAL_PRICING_SOURCE, 'v4-flash');
      const mounts = (config.environment as { mounts: Array<Record<string, unknown>> }).mounts;
      assert.ok(mounts.some((m) => m.target === '/opt/maka-agent' && m.read_only === true));
      assert.equal(mounts.some((m) => m.target === '/run/secrets/deepseek-key' || m.source === keyFile), false);
      assert.doesNotMatch(JSON.stringify(config), /\/run\/secrets|deepseek-key|sk-secret|host\.docker\.internal|maka-broker/);
      assert.equal(harborEnv?.MAKA_HOST_REPO_ROOT, repo);
      assert.equal(harborEnv?.MAKA_HOST_API_KEY_FILE, keyFile);
      assert.equal(harborEnv?.MAKA_HOST_API_KEY_ENV_NAME, 'DEEPSEEK_API_KEY');
      assert.equal(harborEnv?.MAKA_HOST_BASE_URL, 'https://api.deepseek.com');
      assert.deepEqual(config.tasks, [{ path: '/tasks/cobol-modernization', overwrite: false }]);
    });
  });

  test('gives OpenCode an ephemeral host proxy without exposing the provider key file', async () => {
    await withRun(async ({ jobsDir, repo, keyFile }) => {
      const captured: { config?: Record<string, unknown> } = {};
      let harborEnv: Record<string, string> | undefined;
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        agent: 'opencode',
        agentVersion: '1.17.18',
        model: 'zai-coding-plan/glm-5.2',
        provider: 'zai-coding-plan',
        reasoningEffort: 'max',
        apiKeyFile: keyFile,
        agentEnv: { ZAI_BASE_URL: 'https://api.z.ai/api/coding/paas/v4' },
        runHarbor: async (request) => {
          harborEnv = request.env;
          return fakeRunner({ reward: '1\n', captured })(request);
        },
      });

      await runner(runInput());

      assert.equal(harborEnv?.ZAI_API_KEY_FILE, undefined);
      assert.match(harborEnv?.MAKA_OPENCODE_PROVIDER_PROXY_URL ?? '', /^http:\/\/host\.docker\.internal:\d+$/);
      assert.match(harborEnv?.MAKA_OPENCODE_PROVIDER_PROXY_TOKEN ?? '', /^[a-f0-9]{64}$/);
      assert.notEqual(harborEnv?.MAKA_OPENCODE_PROVIDER_PROXY_TOKEN, keyFile);
      assert.doesNotMatch(JSON.stringify(harborEnv), /deepseek-key|sk-secret/);
      assert.doesNotMatch(JSON.stringify(captured.config), /ZAI_API_KEY|deepseek-key|sk-secret/);
      const closedProxyUrl = harborEnv?.MAKA_OPENCODE_PROVIDER_PROXY_URL?.replace('host.docker.internal', '127.0.0.1');
      assert.ok(closedProxyUrl);
      await assert.rejects(fetch(closedProxyUrl));
    });
  });

  test('routes SiliconFlow key files and base URLs through the host-side cell', async () => {
    await withRun(async ({ jobsDir, repo, keyFile }) => {
      let harborEnv: Record<string, string> | undefined;
      const captured: { config?: Record<string, unknown> } = {};
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        model: 'siliconflow/moonshotai/Kimi-K2.6',
        provider: 'siliconflow',
        apiKeyFile: keyFile,
        agentEnv: { SILICONFLOW_BASE_URL: 'https://api.siliconflow.cn/v1' },
        runHarbor: async (request) => {
          harborEnv = request.env;
          return fakeRunner({ reward: '1\n', captured })(request);
        },
      });

      await runner(runInput());

      assert.equal(harborEnv?.MAKA_HOST_API_KEY_ENV_NAME, 'SILICONFLOW_API_KEY');
      assert.equal(harborEnv?.MAKA_HOST_BASE_URL, 'https://api.siliconflow.cn/v1');
      const agent = (captured.config?.agents as Array<{ env: Record<string, string> }>)[0]!;
      assert.equal(agent.env.SILICONFLOW_BASE_URL, undefined);
    });
  });

  test('rejects provider secrets in agentEnv even when host-side key file is configured', async () => {
    await withRun(async ({ jobsDir, repo, keyFile }) => {
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        model: 'deepseek/deepseek-v4-flash',
        provider: 'deepseek',
        apiKeyFile: keyFile,
        pricing: { inputUsdPer1M: 0.145, outputUsdPer1M: 0.29 },
        agentEnv: {
          DEEPSEEK_API_KEY: 'raw-should-not-enter-task',
          DEEPSEEK_API_KEY_FILE: '/tmp/should-not-enter-task',
          DEEPSEEK_BASE_URL: 'https://api.deepseek.com',
        },
        runHarbor: async () => {
          throw new Error('harbor must not run with provider secrets in agentEnv');
        },
      });
      await assert.rejects(
        runner(runInput()),
        /agentEnv must not contain provider secrets: DEEPSEEK_API_KEY, DEEPSEEK_API_KEY_FILE/,
      );
    });
  });

  test('rejects provider secrets in agentEnv when no key file is configured', async () => {
    await withRun(async ({ jobsDir, repo }) => {
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        model: 'deepseek/deepseek-v4-flash',
        provider: 'deepseek',
        agentEnv: { OPENAI_API_KEY_FILE: '/tmp/openai-key' },
        runHarbor: async () => {
          throw new Error('harbor must not run with provider secrets in agentEnv');
        },
      });
      await assert.rejects(
        runner(runInput()),
        /agentEnv must not contain provider secrets: OPENAI_API_KEY_FILE/,
      );
    });
  });

  test('throws HarborInfraError when harbor exits non-zero', async () => {
    await withRun(async ({ jobsDir, repo }) => {
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        model: 'deepseek/deepseek-v4-flash',
        runHarbor: fakeRunner({ exitCode: 1 }),
      });
      await assert.rejects(runner(runInput()), HarborInfraError);
    });
  });

  test('throws HarborInfraError when the cell output is missing', async () => {
    await withRun(async ({ jobsDir, repo }) => {
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        model: 'deepseek/deepseek-v4-flash',
        runHarbor: fakeRunner({ reward: '1\n', cell: null }),
      });
      await assert.rejects(runner(runInput()), HarborInfraError);
    });
  });

  test('throws HarborInfraError when the verifier reward is missing', async () => {
    await withRun(async ({ jobsDir, repo }) => {
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        model: 'deepseek/deepseek-v4-flash',
        runHarbor: fakeRunner({ cell: cellOutput() }),
      });
      await assert.rejects(runner(runInput()), HarborInfraError);
    });
  });

  test('reports Harbor trial exception when setup fails before verifier reward exists', async () => {
    await withRun(async ({ jobsDir, repo }) => {
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        model: 'deepseek/deepseek-v4-flash',
        runHarbor: fakeRunner({
          cell: cellOutput(),
          trialResult: {
            exception_info: {
              exception_type: 'NonZeroAgentExitCodeError',
              exception_message: 'Command failed (exit 127): nvm install 22',
            },
          },
        }),
      });
      await assert.rejects(
        runner(runInput()),
        /Harbor trial failed before verifier reward for task task-1: NonZeroAgentExitCodeError: Command failed \(exit 127\): nvm install 22/,
      );
    });
  });

  test('treats host cell timeout before verifier reward as budget exhausted', async () => {
    await withRun(async ({ jobsDir, repo }) => {
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        model: 'deepseek/deepseek-v4-flash',
        runHarbor: fakeRunner({
          cell: cellOutput(),
          trialResult: {
            exception_info: {
              exception_type: 'RuntimeError',
              exception_message: 'Maka host cell exceeded 1800s',
            },
          },
        }),
      });
      await assert.rejects(runner(runInput()), FixedPromptBudgetExhaustedError);
    });
  });

  test('treats Harbor agent timeout with verifier reward as budget exhausted', async () => {
    await withRun(async ({ jobsDir, repo }) => {
      const timedCell = cellOutput({
        executionIdentity: {
          llmConnectionSlug: 'deepseek',
          model: 'deepseek-v4-flash',
          systemPromptHash: 'sha256:abc',
          pricingProfile: 'test-profile',
        },
      });
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        model: 'deepseek/deepseek-v4-flash',
        runHarbor: fakeRunner({
          reward: '0\n',
          cell: timedCell,
          trialResult: {
            exception_info: {
              exception_type: 'AgentTimeoutError',
              exception_message: 'Agent execution timed out after 60.0 seconds',
            },
          },
        }),
      });
      await assert.rejects(runner(runInput()), (error: unknown) => {
        assert.ok(error instanceof FixedPromptBudgetExhaustedError);
        assert.deepEqual(error.artifactRefs?.tokenSummary, timedCell.tokenSummary);
        assert.deepEqual(error.artifactRefs?.cellOutput?.executionIdentity, timedCell.executionIdentity);
        return true;
      });
    });
  });

  test('recovers early identity from an agent-timeout trial without cell output', async () => {
    await withRun(async ({ jobsDir, repo }) => {
      const executionIdentity = {
        llmConnectionSlug: 'deepseek',
        model: 'deepseek-v4-flash',
        systemPromptHash: 'sha256:abc',
        pricingProfile: 'test-profile',
      };
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        model: 'deepseek/deepseek-v4-flash',
        runHarbor: fakeRunner({
          reward: '0\n',
          cell: null,
          executionIdentity,
          trialResult: {
            exception_info: {
              exception_type: 'AgentTimeoutError',
              exception_message: 'Agent execution timed out after 60.0 seconds',
            },
          },
        }),
      });

      await assert.rejects(runner(runInput()), (error: unknown) => {
        assert.ok(error instanceof FixedPromptBudgetExhaustedError);
        assert.deepEqual(
          (error.artifactRefs as { executionIdentity?: HarborCellExecutionIdentity } | undefined)?.executionIdentity,
          executionIdentity,
        );
        return true;
      });
    });
  });

  test('returns an unscored failed cell without throwing (model API failure path)', async () => {
    await withRun(async ({ jobsDir, repo }) => {
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        model: 'deepseek/deepseek-v4-flash',
        runHarbor: fakeRunner({
          reward: '0\n',
          cell: cellOutput({ status: 'failed', errorClass: 'runtime_error' }),
        }),
      });
      const output = await runner(runInput());
      assert.equal(output.harbor.reward, 0);
      assert.equal(output.cell.status, 'failed');
      assert.equal(output.cell.errorClass, 'runtime_error');
    });
  });

  test('marks verifier dependency setup failures as infra on the cell output', async () => {
    await withRun(async ({ jobsDir, repo }) => {
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        model: 'deepseek/deepseek-v4-flash',
        runHarbor: fakeRunner({
          reward: '0\n',
          cell: cellOutput(),
          verifierStdout: [
            'Err:1 http://archive.ubuntu.com/ubuntu noble InRelease',
            '  502  Bad Gateway',
            'E: Failed to fetch http://archive.ubuntu.com/ubuntu/dists/noble/InRelease  502  Bad Gateway',
            '/tests/test.sh: line 8: curl: command not found',
            '/tests/test.sh: line 19: uvx: command not found',
          ].join('\n'),
        }),
      });

      const output = await runner(runInput());

      assert.equal(output.harbor.reward, 0);
      assert.equal(output.cell.status, 'completed');
      assert.equal(output.cell.errorClass, 'infra_failed');
    });
  });

  test('summarizes verifier assertion failures without raw expected output', async () => {
    await withRun(async ({ jobsDir, repo }) => {
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        model: 'deepseek/deepseek-v4-flash',
        runHarbor: fakeRunner({
          reward: '0\n',
          cell: cellOutput(),
          verifierStdout: [
            "E       AssertionError: Expected '79586' to be in answer.txt",
            "E       assert '79586' in '79585'",
          ].join('\n'),
        }),
      });

      const output = await runner(runInput());

      assert.equal(output.harbor.verifierFailureSummary, 'output_assertion_failed integer_output_off_by_one');
      assert.equal(JSON.stringify(output).includes('79586'), false);
      assert.equal(JSON.stringify(output).includes('79585'), false);
    });
  });

  test('summarizes final-state text mismatches without raw expected output', async () => {
    await withRun(async ({ jobsDir, repo }) => {
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        model: 'deepseek/deepseek-v4-flash',
        runHarbor: fakeRunner({
          reward: '0\n',
          cell: cellOutput(),
          verifierStdout: [
            "E       AssertionError: Expected 'hello world'",
            "E       Got: 'hello from final test'",
          ].join('\n'),
        }),
      });

      const output = await runner(runInput());

      assert.equal(output.harbor.verifierFailureSummary, 'output_assertion_failed final_state_expected_text_mismatch');
      assert.equal(JSON.stringify(output).includes('hello world'), false);
      assert.equal(JSON.stringify(output).includes('hello from final test'), false);
    });
  });

  test('summarizes structured output value mismatches without raw verifier details', async () => {
    await withRun(async ({ jobsDir, repo }) => {
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        model: 'deepseek/deepseek-v4-flash',
        runHarbor: fakeRunner({
          reward: '0\n',
          cell: cellOutput(),
          verifierStdout: [
            'E       AssertionError: Only found 0.00% of expected values in the submitted file',
            'E       missing values: 0x401234, 0x401250',
          ].join('\n'),
        }),
      });

      const output = await runner(runInput());

      assert.equal(output.harbor.verifierFailureSummary, 'output_assertion_failed structured_output_values_mismatch');
      assert.equal(JSON.stringify(output).includes('0x401234'), false);
      assert.equal(JSON.stringify(output).includes('0x401250'), false);
    });
  });
});

describe('buildHarborJobConfig', () => {
  test('pins the OpenCode adapter and max model variant without serializing credentials', () => {
    const config = buildHarborJobConfig(runInput(), {
      makaRepoPath: '/repo',
      jobsDir: '/jobs/x',
      jobName: 'trial',
      agent: 'opencode',
      model: 'zai-coding-plan/glm-5.2',
      provider: 'zai-coding-plan',
      reasoningEffort: 'max',
      agentVersion: '1.17.18',
      pricing: { inputUsdPer1M: 1.4, cacheReadUsdPer1M: 0.26, outputUsdPer1M: 4.4 },
    });
    const agent = (config.agents as Array<Record<string, unknown>>)[0]!;
    const env = agent.env as Record<string, string>;

    assert.equal(agent.name, 'opencode');
    assert.equal(agent.import_path, 'opencode_agent:MakaOpenCodeAgent');
    assert.equal(agent.model_name, 'zai-coding-plan/glm-5.2');
    assert.deepEqual(agent.kwargs, { version: '1.17.18' });
    assert.equal(env.MAKA_OPENCODE_VARIANT, 'max');
    assert.equal(env.MAKA_LLM_CONNECTION_SLUG, 'zai-coding-plan');
    assert.equal(env.MAKA_REASONING_EFFORT, 'max');
    assert.equal(env.ZAI_API_KEY, undefined);
    assert.equal(env.ZAI_API_KEY_FILE, undefined);
  });

  test('rejects experiment identity overrides in extra agent env', () => {
    assert.throws(
      () => buildHarborJobConfig(runInput(), {
        makaRepoPath: '/repo',
        jobsDir: '/jobs/x',
        jobName: 'trial',
        model: 'deepseek/deepseek-v4-flash',
        pricing: { inputUsdPer1M: 0.145, outputUsdPer1M: 0.29 },
        agentEnv: {
          MAKA_MODEL: 'deepseek-v4-pro',
          MAKA_SYSTEM_PROMPT: 'wrong prompt',
          MAKA_TRIAL_INPUT_USD_PER_1M: '9',
        },
      }),
      /agentEnv must not override experiment identity: MAKA_MODEL, MAKA_SYSTEM_PROMPT, MAKA_TRIAL_INPUT_USD_PER_1M/,
    );
  });

  test('rejects provider secrets in extra agent env at config-build time', () => {
    assert.throws(
      () => buildHarborJobConfig(runInput(), {
        makaRepoPath: '/repo',
        jobsDir: '/jobs/x',
        jobName: 'trial',
        model: 'deepseek/deepseek-v4-flash',
        agentEnv: { DEEPSEEK_API_KEY: 'raw-secret' },
      }),
      /agentEnv must not contain provider secrets: DEEPSEEK_API_KEY/,
    );
  });

  test('omits pricing env when no pricing is configured', () => {
    const config = buildHarborJobConfig(runInput(), {
      makaRepoPath: '/repo',
      jobsDir: '/jobs/x',
      jobName: 'trial',
      model: 'deepseek/deepseek-v4-flash',
    });
    const env = (config.agents as Array<{ env: Record<string, string> }>)[0]!.env;
    assert.equal(env.MAKA_TRIAL_INPUT_USD_PER_1M, undefined);
    assert.equal(env.MAKA_BACKEND, 'ai-sdk');
  });

  test('mirrors the cell timeout into Harbor agent timeout', () => {
    const config = buildHarborJobConfig(runInput(), {
      makaRepoPath: '/repo',
      jobsDir: '/jobs/x',
      jobName: 'trial',
      model: 'deepseek/deepseek-v4-flash',
      agentEnv: { MAKA_CELL_TIMEOUT_SEC: '1800' },
    });
    const agent = (config.agents as Array<{ max_timeout_sec?: number }>)[0]!;
    assert.equal(agent.max_timeout_sec, 1800);
  });

  test('uses each Terminal-Bench task native agent timeout when no override is set', () => {
    const config = buildHarborJobConfig(runInput({
      task: {
        id: 'task-1',
        path: '/tasks/task-1',
        metadata: { agentTimeoutSec: 1234 },
      },
    }), {
      makaRepoPath: '/repo',
      jobsDir: '/jobs/x',
      jobName: 'trial',
      model: 'zai-coding-plan/glm-5.2',
      provider: 'zai-coding-plan',
    });
    const agent = (config.agents as Array<{ env: Record<string, string>; max_timeout_sec?: number }>)[0]!;
    assert.equal(agent.env.MAKA_CELL_TIMEOUT_SEC, '1234');
    assert.equal(agent.max_timeout_sec, 1234);
  });

  test('merges per-attempt agent env into the Harbor agent config', () => {
    const config = buildHarborJobConfig(runInput({
      agentEnv: {
        MAKA_CONTEXT_BUDGET: 'off',
        MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE: 'on',
      },
    }), {
      makaRepoPath: '/repo',
      jobsDir: '/jobs/x',
      jobName: 'trial',
      model: 'deepseek/deepseek-v4-flash',
      agentEnv: { MAKA_CELL_TIMEOUT_SEC: '1800' },
    });
    const env = (config.agents as Array<{ env: Record<string, string> }>)[0]!.env;
    assert.equal(env.MAKA_CELL_TIMEOUT_SEC, '1800');
    assert.equal(env.MAKA_CONTEXT_BUDGET, 'off');
    assert.equal(env.MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE, 'on');
  });

  test('keeps a gateway-routed slashful model id when the prefix is not the provider', () => {
    const config = buildHarborJobConfig(runInput(), {
      makaRepoPath: '/repo',
      jobsDir: '/jobs/x',
      jobName: 'trial',
      model: 'anthropic/claude-sonnet-4-5',
      provider: 'openai-compatible',
    });
    const agent = (config.agents as Array<{ env: Record<string, string>; model_name: string }>)[0]!;
    assert.equal(agent.env.MAKA_MODEL, 'anthropic/claude-sonnet-4-5');
    assert.equal(agent.model_name, 'anthropic/claude-sonnet-4-5');
  });
});

describe('createHarborTaskRunner timeout', () => {
  test('forwards a default wall-clock timeout to the harbor process', async () => {
    await withRun(async ({ jobsDir, repo }) => {
      let seenTimeout: number | undefined;
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        model: 'deepseek/deepseek-v4-flash',
        runHarbor: async (request) => {
          seenTimeout = request.timeoutMs;
          return fakeRunner({ reward: '1\n' })(request);
        },
      });
      await runner(runInput());
      assert.equal(seenTimeout, 45 * 60_000);
    });
  });

  test('derives the outer Harbor timeout from task-native agent and verifier limits', async () => {
    await withRun(async ({ jobsDir, repo }) => {
      let seenTimeout: number | undefined;
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        model: 'zai-coding-plan/glm-5.2',
        provider: 'zai-coding-plan',
        runHarbor: async (request) => {
          seenTimeout = request.timeoutMs;
          return fakeRunner({ reward: '1\n' })(request);
        },
      });
      await runner(runInput({
        task: {
          id: 'task-1',
          path: '/tasks/task-1',
          metadata: { agentTimeoutSec: 7_200, verifierTimeoutSec: 600 },
        },
      }));
      assert.equal(seenTimeout, (7_200 + 600 + 15 * 60) * 1_000);
    });
  });

  test('puts the adapter dir on PYTHONPATH so harbor can import maka_agent', async () => {
    await withRun(async ({ jobsDir, repo }) => {
      let seenEnv: Record<string, string> | undefined;
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        model: 'deepseek/deepseek-v4-flash',
        runHarbor: async (request) => {
          seenEnv = request.env;
          return fakeRunner({ reward: '1\n' })(request);
        },
      });
      await runner(runInput());
      assert.ok(seenEnv?.PYTHONPATH?.startsWith(join(repo, 'packages', 'headless', 'harbor')));
    });
  });

  test('forwards an explicit harborTimeoutMs override', async () => {
    await withRun(async ({ jobsDir, repo }) => {
      let seenTimeout: number | undefined;
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        model: 'deepseek/deepseek-v4-flash',
        harborTimeoutMs: 1234,
        runHarbor: async (request) => {
          seenTimeout = request.timeoutMs;
          return fakeRunner({ reward: '1\n' })(request);
        },
      });
      await runner(runInput());
      assert.equal(seenTimeout, 1234);
    });
  });

  test('classifies the outer Harbor watchdog as infrastructure failure', async () => {
    await withRun(async ({ jobsDir, repo }) => {
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        model: 'deepseek/deepseek-v4-flash',
        harborTimeoutMs: 600_000,
        runHarbor: async () => ({
          exitCode: 1,
          stdout: '',
          stderr: 'killed after timeout',
          timedOut: true,
          signal: 'SIGKILL',
        }),
      });
      await assert.rejects(runner(runInput()), HarborInfraError);
    });
  });

  test('keeps an outer watchdog timeout infrastructural after cell output exists', async () => {
    await withRun(async ({ jobsDir, repo }) => {
      const writeArtifacts = fakeRunner({ cell: cellOutput({
        executionIdentity: {
          llmConnectionSlug: 'deepseek',
          model: 'deepseek-v4-flash',
          systemPromptHash: 'sha256:abc',
          pricingProfile: 'test-profile',
        },
      }) });
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        model: 'deepseek/deepseek-v4-flash',
        runHarbor: async (request) => {
          await writeArtifacts(request);
          return { exitCode: 1, stdout: '', stderr: 'timed out', timedOut: true, signal: 'SIGKILL' };
        },
      });

      await assert.rejects(runner(runInput()), HarborInfraError);
    });
  });

  test('keeps an outer watchdog timeout infrastructural after early identity exists', async () => {
    await withRun(async ({ jobsDir, repo }) => {
      const executionIdentity = {
        llmConnectionSlug: 'deepseek',
        model: 'deepseek-v4-flash',
        systemPromptHash: 'sha256:abc',
        pricingProfile: 'test-profile',
      };
      const writeArtifacts = fakeRunner({ cell: null, executionIdentity });
      const runner = createHarborTaskRunner({
        makaRepoPath: repo,
        jobsDir,
        model: 'deepseek/deepseek-v4-flash',
        runHarbor: async (request) => {
          await writeArtifacts(request);
          return { exitCode: 1, stdout: '', stderr: 'timed out', timedOut: true, signal: 'SIGKILL' };
        },
      });

      await assert.rejects(runner(runInput()), HarborInfraError);
    });
  });
});
