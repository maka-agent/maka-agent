#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER="${SCRIPT_DIR}/run-terminal-bench-sample.sh"

COMPARE_OPENCODE=0
ARGS=()

usage() {
  cat <<'USAGE'
Run Terminal-Bench sample with Maka heavy-task mode.

Usage:
  terminal-bench-smoke/run-terminal-bench-sample-heavy.sh [options]

This is a thin wrapper over run-terminal-bench-sample.sh. By default it runs:
  run-terminal-bench-sample.sh --profile maka-heavy ...

Options:
  --compare-opencode          Run maka-heavy and opencode sequentially for comparison
  --task PATTERN              Harbor task pattern
  --n-tasks N                 Pick N tasks instead of using --task
  --job-name NAME             Harbor job name
  --model MODEL               Override MAKA_MODEL
  --steps N                   Override MAKA_MAX_STEPS
  --agent-timeout-sec N       Override MAKA_HARBOR_AGENT_TIMEOUT_SEC
  --dataset NAME              Override dataset name
  --dataset-version VERSION   Override dataset version
  --dry-run                   Generate config and print command without running Harbor
  -h, --help                  Show this help

Examples:
  terminal-bench-smoke/run-terminal-bench-sample-heavy.sh --n-tasks 10
  terminal-bench-smoke/run-terminal-bench-sample-heavy.sh --task '*qemu-startup'
  terminal-bench-smoke/run-terminal-bench-sample-heavy.sh --compare-opencode --n-tasks 10
USAGE
}

if [ ! -x "$RUNNER" ]; then
  echo "Runner not found or not executable: $RUNNER" >&2
  exit 1
fi

while [ "$#" -gt 0 ]; do
  case "$1" in
    --compare-opencode)
      COMPARE_OPENCODE=1
      shift
      ;;
    --profile|--compare|--compare-profiles)
      echo "run-terminal-bench-sample-heavy.sh fixes the profile to maka-heavy; use the base runner for $1" >&2
      exit 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      ARGS+=("$1")
      shift
      ;;
  esac
done

if [ "$COMPARE_OPENCODE" -eq 1 ]; then
  exec "$RUNNER" --compare --compare-profiles maka-heavy,opencode "${ARGS[@]}"
fi

exec "$RUNNER" --profile maka-heavy "${ARGS[@]}"
