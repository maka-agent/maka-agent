# Terminal-Bench Sample Runner

This directory has a structured one-command entrypoint for local
`terminal-bench-sample@2.0` runs:

```sh
terminal-bench-smoke/run-terminal-bench-sample.sh --profile oracle --n-tasks 1
terminal-bench-smoke/run-terminal-bench-sample.sh --profile maka-basic --task '*sqlite-with-gcov'
terminal-bench-smoke/run-terminal-bench-sample.sh --profile maka-heavy --task '*sqlite-with-gcov'
terminal-bench-smoke/run-terminal-bench-sample.sh --profile opencode --task '*sqlite-with-gcov'
terminal-bench-smoke/run-terminal-bench-sample.sh --compare --task '*sqlite-with-gcov'
terminal-bench-smoke/run-terminal-bench-sample-heavy.sh --n-tasks 10
```

The script reads `terminal-bench-smoke/terminal-bench-sample-runs.json`,
generates a Harbor config under `terminal-bench-smoke/generated-configs/`, then
runs:

```sh
PYTHONPATH=terminal-bench-smoke terminal-bench-smoke/harbor-venv/bin/harbor run --config <generated-config> --yes
```

Set `HARBOR_BIN=/path/to/harbor` if Harbor is not installed in
`terminal-bench-smoke/harbor-venv/bin/harbor`. Maka runs default to the current
repository root; set `MAKA_REPO_DIR=/path/to/maka-agent` only when running the
bridge against a different checkout. Optional local runner secrets can be loaded
from `MAKA_HARBOR_RUNNER_ENV_FILE` (default:
`~/.config/maka/harbor-runner.env`).

Use `--dry-run` to generate the config and print the exact command without
launching a benchmark.

## Profiles

- `maka-basic`: Maka Harbor bridge, non-autonomous, DeepSeek V4 Pro. This
  matches the successful earlier `sqlite-with-gcov` sample run shape.
- `maka-heavy`: Maka task-run heavy-task bridge for public trace/evidence
  experiments.
- `opencode`: OpenCode Harbor wrapper for comparison runs.
- `oracle`: Harbor built-in oracle agent. Use this for cheap wrapper/dataset
  smoke tests before spending model tokens.

## Heavy-Task Entry Point

Use this wrapper when the run must exercise Maka heavy-task/task-run mode:

```sh
terminal-bench-smoke/run-terminal-bench-sample-heavy.sh --task '*qemu-startup'
terminal-bench-smoke/run-terminal-bench-sample-heavy.sh --n-tasks 10
terminal-bench-smoke/run-terminal-bench-sample-heavy.sh --compare-opencode --n-tasks 10
```

The wrapper fixes the Maka profile to `maka-heavy`. `--compare-opencode` runs
the explicit comparison profile list `maka-heavy,opencode`; the base runner's
plain `--compare` default remains `maka-basic,opencode`.

## Useful Options

```sh
--profile NAME
--compare
--compare-profiles maka-basic,opencode
--task PATTERN
--n-tasks N
--job-name NAME
--model MODEL
--steps N
--agent-timeout-sec N
--dry-run
```

Generated results are written under `terminal-bench-smoke/jobs/<job-name>/`.

## Live Observability

For Maka bridge runs, each trial's `agent/` directory is populated as soon as
the agent starts:

- `maka-harbor.status.json`: redacted runner status, PID, timeout, resolved
  task cwd, task-run output directory, and whitelisted Maka mode flags.
- `maka-harbor.stdout.json`: runner stdout, streamed to disk as bytes arrive.
- `maka-harbor.stderr.log`: runner stderr, streamed to disk as bytes arrive.
- `maka-task-run/`: task-run store/export parent directory for heavy-task
  mode.

`maka-harbor.stdout.json` still depends on the Node runner's stdout behavior,
so it may only become meaningful near completion. `maka-harbor.status.json`,
`maka-harbor.stderr.log`, and `maka-task-run/` are the live files to inspect
while a trial is running.

## Self-Check Cleanup Prompt

Maka/OpenCode model profiles automatically inject
`terminal-bench-smoke/prompts/self-check-cleanup.md` through Harbor
`extra_instruction_paths`. The prompt tells the agent to delete self-check
byproducts and restore verifier-clean runtime state after validation, while
keeping final required implementation/output files intact.

The `oracle` profile does not inject this prompt, so it remains a cheap pure
dataset/wrapper smoke path.
