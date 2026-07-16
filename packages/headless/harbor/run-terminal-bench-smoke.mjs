#!/usr/bin/env node

/**
 * Run a structured Terminal-Bench sample job through the local Harbor smoke
 * harness. Replaces the retired terminal-bench-smoke/run-terminal-bench-sample.sh
 * and run-terminal-bench-sample-heavy.sh shell scripts with a single pure-Node
 * entrypoint. Maka profiles drive the authoritative maka_agent:MakaAgent adapter
 * in task-run host-bridge mode; heavy-task and autonomous experiments run through
 * `--profile maka-heavy` and `--profile maka-heavy-prune`.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSmokeJobConfig, resolveSmokeRunTargets } from '#harbor-smoke-config';

const HARBOR_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HARBOR_DIR, '..', '..', '..');
const MANIFEST_PATH = join(HARBOR_DIR, 'terminal-bench-smoke-profiles.json');

const USAGE = `Run a structured Terminal-Bench sample job through the local Harbor smoke harness.

Usage:
  node packages/headless/harbor/run-terminal-bench-smoke.mjs [options]

Profiles:
  maka-basic         Maka task-run host bridge, non-autonomous, DeepSeek V4 Pro (default)
  maka-heavy         Maka task-run heavy-task bridge for trace/evidence experiments
  maka-heavy-prune   Maka heavy-task bridge with autonomous prior-attempt runtime replay
                     and stale tool-result archive pruning enabled
  maka-prune-default Post-#621 default prune pipeline with continuation (stale A/B B arm)
  maka-stale-off     maka-prune-default with stale prune explicitly off (stale A/B A arm)
  maka-retrieval-on  maka-prune-default plus eager archive retrieval (retrieval A/B B arm)
  opencode           OpenCode Harbor wrapper
  oracle             Harbor oracle agent for cheap wrapper/dataset smoke tests

Options:
  --profile NAME              Run profile (default: maka-basic)
  --compare                   Run comparison profiles sequentially (default: maka-basic,opencode)
  --compare-profiles LIST     Comma-separated profiles for --compare
  --task PATTERN              Harbor task pattern (default: *sqlite-with-gcov)
  --n-tasks N                 Pick N tasks instead of using --task
  --job-name NAME             Harbor job name (default: generated with timestamp)
  --model MODEL               Override model. For Maka this sets MAKA_MODEL; for OpenCode it sets model_name.
  --steps N                   Override MAKA_MAX_STEPS for Maka profiles
  --agent-timeout-sec N       Override MAKA_HARBOR_AGENT_TIMEOUT_SEC for Maka profiles
  --dataset NAME              Override dataset name (default: terminal-bench-sample)
  --dataset-version VERSION   Override dataset version (default: 2.0)
  --dry-run                   Generate and print config path/command without running Harbor
  -h, --help                  Show this help

Environment:
  HARBOR_BIN                  Harbor executable (default: harbor on PATH)

Examples:
  node packages/headless/harbor/run-terminal-bench-smoke.mjs --profile oracle --n-tasks 1
  node packages/headless/harbor/run-terminal-bench-smoke.mjs --profile maka-basic --task '*sqlite-with-gcov'
  node packages/headless/harbor/run-terminal-bench-smoke.mjs --compare --task '*sqlite-with-gcov'
  node packages/headless/harbor/run-terminal-bench-smoke.mjs --profile maka-heavy --compare-profiles maka-heavy,opencode --compare
`;

function parseArgs(argv) {
  const opts = {
    profile: 'maka-basic',
    compare: false,
    compareProfiles: 'maka-basic,opencode',
    taskPattern: undefined,
    nTasks: undefined,
    jobName: undefined,
    model: undefined,
    maxSteps: undefined,
    agentTimeoutSec: undefined,
    datasetName: undefined,
    datasetVersion: undefined,
    dryRun: false,
    help: false,
  };
  const takeValue = (i, flag) => {
    const value = argv[i + 1];
    if (value === undefined) {
      throw new Error(`missing value for ${flag}`);
    }
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--profile': opts.profile = takeValue(i, arg); i++; break;
      case '--compare': opts.compare = true; break;
      case '--compare-profiles': opts.compare = true; opts.compareProfiles = takeValue(i, arg); i++; break;
      case '--task': opts.taskPattern = takeValue(i, arg); i++; break;
      case '--n-tasks': opts.nTasks = Number(takeValue(i, arg)); i++; break;
      case '--job-name': opts.jobName = takeValue(i, arg); i++; break;
      case '--model': opts.model = takeValue(i, arg); i++; break;
      case '--steps': opts.maxSteps = takeValue(i, arg); i++; break;
      case '--agent-timeout-sec': opts.agentTimeoutSec = takeValue(i, arg); i++; break;
      case '--dataset': opts.datasetName = takeValue(i, arg); i++; break;
      case '--dataset-version': opts.datasetVersion = takeValue(i, arg); i++; break;
      case '--dry-run': opts.dryRun = true; break;
      case '-h':
      case '--help': opts.help = true; break;
      default:
        throw new Error(`unknown option: ${arg}`);
    }
  }
  return opts;
}

function overridesFor(opts) {
  return {
    ...(opts.taskPattern !== undefined ? { taskPattern: opts.taskPattern } : {}),
    ...(opts.nTasks !== undefined ? { nTasks: opts.nTasks } : {}),
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.maxSteps !== undefined ? { maxSteps: opts.maxSteps } : {}),
    ...(opts.agentTimeoutSec !== undefined ? { agentTimeoutSec: opts.agentTimeoutSec } : {}),
    ...(opts.datasetName !== undefined ? { datasetName: opts.datasetName } : {}),
    ...(opts.datasetVersion !== undefined ? { datasetVersion: opts.datasetVersion } : {}),
    // Match the retired shell runner: MAKA_BENCHMARK_DATASET in the environment
    // overrides the dataset-name default that maka-* profiles forward to the
    // adapter (an explicit value wins over the datasetName default).
    ...(process.env.MAKA_BENCHMARK_DATASET ? { benchmarkDataset: process.env.MAKA_BENCHMARK_DATASET } : {}),
  };
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (opts.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (opts.nTasks !== undefined && (!Number.isInteger(opts.nTasks) || opts.nTasks <= 0)) {
    process.stderr.write(`--n-tasks must be a positive integer\n`);
    process.exit(2);
  }

  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  const generatedConfigDir = resolve(
    REPO_ROOT,
    manifest.defaults?.generatedConfigDir ?? 'packages/headless/harbor/smoke-generated-configs',
  );
  mkdirSync(generatedConfigDir, { recursive: true });

  const harborBin = process.env.HARBOR_BIN || 'harbor';
  const pythonPath = [HARBOR_DIR, process.env.PYTHONPATH].filter(Boolean).join(delimiter);

  const targets = resolveSmokeRunTargets({
    compare: opts.compare,
    compareProfiles: opts.compareProfiles,
    profile: opts.profile,
    jobName: opts.jobName,
  });

  for (const target of targets) {
    const { jobName, config } = buildSmokeJobConfig({
      manifest,
      profileName: target.profileName,
      overrides: {
        ...overridesFor(opts),
        ...(target.jobName ? { jobName: target.jobName } : {}),
      },
    });
    const configPath = join(generatedConfigDir, `${jobName}.json`);
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

    process.stdout.write(`Generated Harbor config: ${configPath}\n`);
    process.stdout.write(`Profile: ${target.profileName}\n`);
    process.stdout.write(`Run command:\n`);
    process.stdout.write(`  PYTHONPATH=${HARBOR_DIR} ${harborBin} run --config ${configPath} --yes\n`);

    if (opts.dryRun) continue;

    const result = spawnSync(harborBin, ['run', '--config', configPath, '--yes'], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      env: { ...process.env, PYTHONPATH: pythonPath },
    });
    if (result.error) {
      process.stderr.write(`failed to launch harbor: ${result.error.message}\n`);
      process.exit(1);
    }
    if (result.status !== 0) {
      process.exit(result.status ?? 1);
    }
  }
}

main();
