#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
MANIFEST_PATH="${SCRIPT_DIR}/terminal-bench-sample-runs.json"
HARBOR_BIN="${HARBOR_BIN:-${SCRIPT_DIR}/harbor-venv/bin/harbor}"

PROFILE="maka-basic"
COMPARE=0
COMPARE_PROFILES="maka-basic,opencode"
TASK_PATTERN=""
JOB_NAME=""
MODEL=""
MAX_STEPS=""
AGENT_TIMEOUT_SEC=""
N_TASKS=""
DATASET_NAME=""
DATASET_VERSION=""
DRY_RUN=0

usage() {
  cat <<'USAGE'
Run a structured Terminal-Bench sample job through the local Harbor smoke harness.

Usage:
  terminal-bench-smoke/run-terminal-bench-sample.sh [options]

Profiles:
  maka-basic   Maka Harbor bridge, non-autonomous, DeepSeek V4 Pro (default)
  maka-heavy   Maka task-run heavy-task bridge for trace/evidence experiments
  maka-heavy-prune
               Maka heavy-task bridge with autonomous prior-attempt runtime replay
               and stale tool-result archive pruning enabled
  opencode     OpenCode Harbor wrapper
  oracle       Harbor oracle agent for cheap wrapper/dataset smoke tests

Options:
  --profile NAME              Run profile: maka-basic, maka-heavy, maka-heavy-prune, opencode, oracle
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

Examples:
  terminal-bench-smoke/run-terminal-bench-sample.sh --profile oracle --n-tasks 1
  terminal-bench-smoke/run-terminal-bench-sample.sh --profile maka-basic --task '*sqlite-with-gcov'
  terminal-bench-smoke/run-terminal-bench-sample.sh --compare --task '*sqlite-with-gcov'
  terminal-bench-smoke/run-terminal-bench-sample.sh --profile maka-heavy --job-name maka-sample-heavy-$(date +%Y%m%d%H%M%S)
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --profile)
      PROFILE="${2:?missing value for --profile}"
      shift 2
      ;;
    --compare)
      COMPARE=1
      shift
      ;;
    --compare-profiles)
      COMPARE=1
      COMPARE_PROFILES="${2:?missing value for --compare-profiles}"
      shift 2
      ;;
    --task)
      TASK_PATTERN="${2:?missing value for --task}"
      shift 2
      ;;
    --n-tasks)
      N_TASKS="${2:?missing value for --n-tasks}"
      shift 2
      ;;
    --job-name)
      JOB_NAME="${2:?missing value for --job-name}"
      shift 2
      ;;
    --model)
      MODEL="${2:?missing value for --model}"
      shift 2
      ;;
    --steps)
      MAX_STEPS="${2:?missing value for --steps}"
      shift 2
      ;;
    --agent-timeout-sec)
      AGENT_TIMEOUT_SEC="${2:?missing value for --agent-timeout-sec}"
      shift 2
      ;;
    --dataset)
      DATASET_NAME="${2:?missing value for --dataset}"
      shift 2
      ;;
    --dataset-version)
      DATASET_VERSION="${2:?missing value for --dataset-version}"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [ ! -x "$HARBOR_BIN" ]; then
  echo "Harbor binary not found or not executable: $HARBOR_BIN" >&2
  exit 1
fi

mkdir -p "${SCRIPT_DIR}/generated-configs"

generate_config() {
  local profile_name="$1"
  local job_name="$2"

  MANIFEST_PATH="$MANIFEST_PATH" \
  PROFILE="$profile_name" \
  TASK_PATTERN="$TASK_PATTERN" \
  JOB_NAME="$job_name" \
  MODEL="$MODEL" \
  MAX_STEPS="$MAX_STEPS" \
  AGENT_TIMEOUT_SEC="$AGENT_TIMEOUT_SEC" \
  N_TASKS="$N_TASKS" \
  DATASET_NAME="$DATASET_NAME" \
  DATASET_VERSION="$DATASET_VERSION" \
  node <<'NODE'
const fs = require('fs');
const path = require('path');

const manifestPath = process.env.MANIFEST_PATH;
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const defaults = manifest.defaults || {};
const profileName = process.env.PROFILE || 'maka-basic';
const profile = manifest.profiles && manifest.profiles[profileName];
if (!profile) {
  const names = Object.keys(manifest.profiles || {}).join(', ');
  throw new Error(`unknown profile "${profileName}". Available profiles: ${names}`);
}

function env(name) {
  const value = process.env[name];
  return value && value.length ? value : null;
}

function slug(value) {
  return String(value)
    .replace(/^\*/, '')
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'sample';
}

function retryConfig() {
  return {
    max_retries: Number(defaults.retryMaxRetries || 0),
    include_exceptions: null,
    exclude_exceptions: [
      'AgentTimeoutError',
      'VerifierOutputParseError',
      'VerifierTimeoutError',
      'RewardFileNotFoundError',
      'RewardFileEmptyError',
    ],
    wait_multiplier: 1.0,
    min_wait_sec: 1.0,
    max_wait_sec: 60.0,
  };
}

const taskPattern = env('TASK_PATTERN') || defaults.taskPattern || '*sqlite-with-gcov';
const datasetName = env('DATASET_NAME') || (defaults.dataset && defaults.dataset.name) || 'terminal-bench-sample';
const datasetVersion = env('DATASET_VERSION') || (defaults.dataset && defaults.dataset.version) || '2.0';
const nTasksRaw = env('N_TASKS');
const nTasks = nTasksRaw ? Number(nTasksRaw) : null;
if (nTasksRaw && (!Number.isInteger(nTasks) || nTasks <= 0)) {
  throw new Error(`--n-tasks must be a positive integer, got ${nTasksRaw}`);
}

const explicitJobName = env('JOB_NAME');
const jobName = explicitJobName || [
  profileName,
  'terminal-bench-sample',
  nTasks ? `n${nTasks}` : slug(taskPattern),
  new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, 'Z'),
].join('-');

const agent = profile.agent || {};
const agentEnv = { ...(agent.env || {}) };
let agentModelName = agent.modelName || null;
const modelOverride = env('MODEL');
if (modelOverride) {
  if (profileName.startsWith('maka-')) {
    agentEnv.MAKA_MODEL = modelOverride;
  } else {
    agentModelName = modelOverride;
  }
}

const maxSteps = env('MAX_STEPS');
if (maxSteps) agentEnv.MAKA_MAX_STEPS = maxSteps;
const agentTimeoutSec = env('AGENT_TIMEOUT_SEC');
if (agentTimeoutSec) agentEnv.MAKA_HARBOR_AGENT_TIMEOUT_SEC = agentTimeoutSec;
if (profileName.startsWith('maka-') && !agentEnv.MAKA_BENCHMARK_DATASET) {
  agentEnv.MAKA_BENCHMARK_DATASET = env('MAKA_BENCHMARK_DATASET') || datasetName;
}

const extraInstructionPaths = Object.prototype.hasOwnProperty.call(profile, 'extraInstructionPaths')
  ? profile.extraInstructionPaths
  : (defaults.modelExtraInstructionPaths || []);

const config = {
  job_name: jobName,
  jobs_dir: defaults.jobsDir || 'terminal-bench-smoke/jobs',
  n_attempts: Number(defaults.nAttempts || 1),
  timeout_multiplier: Number(defaults.timeoutMultiplier || 1.0),
  agent_timeout_multiplier: profile.agentTimeoutMultiplier === undefined ? null : profile.agentTimeoutMultiplier,
  verifier_timeout_multiplier: null,
  agent_setup_timeout_multiplier: null,
  environment_build_timeout_multiplier: null,
  debug: false,
  n_concurrent_trials: Number(defaults.nConcurrentTrials || 1),
  quiet: false,
  retry: retryConfig(),
  environment: {
    type: 'docker',
    import_path: null,
    force_build: false,
    delete: true,
    cpu_enforcement_policy: 'auto',
    memory_enforcement_policy: 'auto',
    override_cpus: null,
    override_memory_mb: null,
    override_storage_mb: null,
    override_gpus: null,
    override_tpu: null,
    mounts: null,
    extra_docker_compose: [],
    env: {},
    kwargs: {},
    extra_allowed_hosts: [],
  },
  verifier: {
    override_timeout_sec: null,
    max_timeout_sec: null,
    env: {},
    disable: false,
  },
  metrics: [],
  agents: [
    {
      name: agent.name || null,
      import_path: agent.importPath || null,
      model_name: agentModelName,
      skills: [],
      override_timeout_sec: null,
      override_setup_timeout_sec: null,
      max_timeout_sec: null,
      extra_allowed_hosts: [],
      kwargs: agent.kwargs || {},
      env: agentEnv,
      mcp_servers: [],
    },
  ],
  datasets: [
    {
      path: null,
      name: datasetName,
      version: datasetVersion,
      ref: null,
      registry_url: null,
      registry_path: null,
      overwrite: false,
      download_dir: null,
      task_names: nTasks ? null : [taskPattern],
      exclude_task_names: null,
      n_tasks: nTasks,
    },
  ],
  tasks: [],
  artifacts: [],
  extra_instruction_paths: extraInstructionPaths,
  plugins: [],
};

const generatedDir = path.resolve(path.dirname(manifestPath), 'generated-configs');
fs.mkdirSync(generatedDir, { recursive: true });
const configPath = path.join(generatedDir, `${jobName}.json`);
fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
process.stdout.write(configPath);
NODE
}

run_one() {
  local profile_name="$1"
  local job_name="$2"
  local config_path
  config_path="$(generate_config "$profile_name" "$job_name")"

  echo "Generated Harbor config: $config_path"
  echo "Profile: $profile_name"
  echo "Run command:"
  echo "  PYTHONPATH=terminal-bench-smoke $HARBOR_BIN run --config $config_path --yes"

  if [ "$DRY_RUN" -eq 1 ]; then
    return 0
  fi

  PYTHONPATH="${SCRIPT_DIR}${PYTHONPATH:+:${PYTHONPATH}}" "$HARBOR_BIN" run --config "$config_path" --yes
}

cd "$WORKSPACE_DIR"

if [ "$COMPARE" -eq 1 ]; then
  IFS=',' read -r -a profiles <<< "$COMPARE_PROFILES"
  for profile_name in "${profiles[@]}"; do
    profile_name="${profile_name#"${profile_name%%[![:space:]]*}"}"
    profile_name="${profile_name%"${profile_name##*[![:space:]]}"}"
    if [ -z "$profile_name" ]; then
      continue
    fi
    compare_job_name=""
    if [ -n "$JOB_NAME" ]; then
      compare_job_name="${JOB_NAME}-${profile_name}"
    fi
    run_one "$profile_name" "$compare_job_name"
  done
else
  run_one "$PROFILE" "$JOB_NAME"
fi
