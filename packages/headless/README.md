# @maka/headless

The single headless entry point for driving a Maka agent without a UI. Its
evaluation mode can run a **Config × Task** grid, capture each trajectory,
score it with the task's own command, and compare.

```
Config × Task  →  throwaway workspace  →  headless agent run  →  trajectory
                                                                     ↓
                              ResultRecord (JSONL)  ←  verification command
```

## CLI

```sh
maka eval run <spec.json> [--out <dir>]
maka eval compare <results.jsonl>
maka eval task-run run <spec.json> --task <id> --config <id> [--out <dir>]
maka eval task-run inspect <taskRunId> --store <out>/runs [--json]
maka eval task-run export <taskRunId> --store <out>/runs --out <dir> [--include-events]
maka eval task-run resume <taskRunId> --spec <spec.json> --out <dir> [--grant-file <json>]
maka eval task-run retry-failed <results.jsonl|out-dir> --spec <spec.json> --out <dir>
maka eval ahe export <taskRunId...> --store <out>/runs --repo <repo> --out <dir>
maka eval harbor run --instruction <text> --workdir <dir> --out <dir> --isolation harbor-local
```

Try it with the bundled fake-backend demo (no API key needed):

```sh
maka eval run examples/demo.spec.json --out /tmp/maka-headless-demo
```

## Trust posture

`eval` is **untrusted by construction**: the config under test is something you
are *measuring*, possibly weak or adversarial, so it must not reach the host.
Without OS-level isolation the only safe enforcement is to **fail closed by
default**:

- The CLI still wires only the inert **`fake`** backend. A model-backed backend
  in a JSON spec exits non-zero unless the caller uses the programmatic API to
  provide backend wiring.
- Programmatic real-model eval must pass `realBackendIsolation` to
  `runExperiment` plus a `registerBackends` factory. The isolation record is an
  explicit assertion that tool execution is already outside the host credential
  process (for example Harbor / Terminal-Bench or a Docker workspace executor).
- If the caller wants Maka's standard tool surface, use
  `buildIsolatedHeadlessTools(executor)`: it routes `Bash` plus
  `Read`/`Write`/`Edit`/`Glob`/`Grep` through the supplied isolation boundary.
  Executors can implement native file-operation methods, or rely on the
  command-backed fallback when the isolated workspace has `node` available.
  The headless helper rejects absolute paths, `..` escapes, and absolute glob
  patterns before dispatching file operations.

(An *operational* mode — intentionally running a trusted agent that *may* touch
the host — can slot into this same entry later. That is a different, explicit
trust posture, never the eval default.)

Programmatic sketch:

```ts
import {
  buildIsolatedHeadlessToolAvailability,
  buildIsolatedHeadlessTools,
  runExperiment,
  type IsolatedToolExecutor,
} from '@maka/headless';

const executor: IsolatedToolExecutor = {
  async exec(input) {
    // Route to Harbor/Docker/etc. Do not inherit host env/secrets.
    return { exitCode: 0, stdout: '', stderr: '' };
  },
  async readFile(input) {
    // Optional: implement native external workspace file reads instead of the
    // command-backed fallback.
    return { content: '' };
  },
};

await runExperiment(config, task, {
  storageRoot: '/tmp/maka-headless-runs',
  realBackendIsolation: {
    kind: 'external',
    label: 'Harbor task container',
    toolExecutor: executor,
  },
  registerBackends(registry, context) {
    registry.register('ai-sdk', (ctx) => createAiSdkBackend({
      ...ctx,
      tools: [...(ctx.tools ?? buildIsolatedHeadlessTools(context.toolExecutor!))],
      toolAvailability: buildIsolatedHeadlessToolAvailability(),
    }));
  },
});
```

## Spec

A spec is `configs × tasks`. Task `workspaceDir` paths resolve relative to the
spec file, so a spec travels with its fixtures.

```jsonc
{
  "configs": [
    { "id": "fake", "backend": "fake", "llmConnectionSlug": "fake", "model": "fake-model" }
  ],
  "tasks": [
    { "id": "fix-bug", "instruction": "Make the failing test pass.",
      "workspaceDir": "./fixtures/fix-bug",
      "verification": {
        "command": "npm test",
        "timeoutMs": 120000,
        // REQUIRED grading boundary (see Grading). Use [] when the
        // verification reads nothing the agent could forge.
        "protectedPaths": ["test/"]
      } }
  ]
}
```

## Grading

Verification runs the task's `command` in the workspace; exit code 0 = pass.
A config must not be able to grade itself, so `verification.protectedPaths` is
**required**: list the test/grading files and they are restored from the
pristine fixture *after* the agent finishes and *before* the command runs — a
model that rewrote its own test to pass has that edit reverted. Declare `[]`
only when the verification reads nothing the agent can forge — as the bundled
`examples/demo` does, checking a fixture file the agent has no reason to touch.

Tasks may also use typed benchmark verifiers. Terminal-Bench is the first
carrier, but it is an adapter hook rather than a runtime architecture:

```jsonc
{
  "id": "terminal-bench-local",
  "instruction": "Solve the task.",
  "workspaceDir": "./fixtures/tb-task",
  "verifier": {
    "kind": "terminal_bench",
    "adapter": "terminal-bench",
    "instanceId": "local-task",
    "datasetPath": "./terminal-bench",
    "testCommand": "./run-tests.sh",
    "protectedPaths": ["tests/", "run-tests.sh"]
  }
}
```

`testCommand` mode runs in Maka's disposable scoring workspace and needs no
Docker, Harbor, or `tb` binary; because it is still a local command verifier,
`protectedPaths` is required. Real Terminal-Bench harness execution is wired
programmatically through `benchmarkAdapters` and an explicit external isolation
record.

`maka eval task-run run` writes append-only task-run JSONL under `<out>/runs/task-runs/`,
updates compatibility `results.jsonl`, and writes a canonical export under
`<out>/exports/<taskRunId>/`. Exports are projection-based: they include
trajectory/runtime refs, submitted snapshot metadata, verifier output, score,
budget, isolation, permission/inbox facts, taxonomy, and warnings. They do not
embed environment variables, credentials, or hidden harness configuration.

## Terminal-Bench smoke runner

`harbor/run-terminal-bench-smoke.mjs` is the local structured smoke harness for the
`terminal-bench-sample` registry dataset. It reads the checked-in profile manifest
`harbor/terminal-bench-smoke-profiles.json`, generates a Harbor run config under
`harbor/smoke-generated-configs/`, and (unless `--dry-run`) invokes Harbor with the
adapter directory on `PYTHONPATH`. `HARBOR_BIN` overrides the Harbor executable
(default `harbor` on `PATH`).

The `maka-*` profiles drive the single authoritative adapter `maka_agent:MakaAgent`
in task-run host-bridge mode (`MAKA_HARBOR_MODE=task-run`): Maka runs the full
task-run controller on the host and bridges tool execution into the task container,
while the container installs nothing. `maka-heavy` and `maka-heavy-prune` carry the
heavy-task and autonomous prior-attempt-replay experiments; `opencode` and `oracle`
provide comparison and cheap dataset smoke arms.

```sh
node packages/headless/harbor/run-terminal-bench-smoke.mjs --profile maka-heavy --dry-run
node packages/headless/harbor/run-terminal-bench-smoke.mjs --compare --task '*sqlite-with-gcov'
```

## K3 harness comparison

`harbor/run-harness-ab.mjs` compares Maka with the official Kimi Code 0.26.0 CLI on Kimi K3 Max. Set `MAKA_HARNESS_AB_COMPETITOR=opencode` to select the pinned OpenCode 1.17.18 arm instead. The task root must match the 89 task ids and canonical task-tree fingerprint of the frozen official Terminal-Bench 2.1 revision; a matching export with one task directory per id is accepted directly. The A/B task order is frozen independently of Oracle evidence. Maka keeps active and stale tool-result pruning enabled while semantic compact is explicitly disabled in both the manifest and runtime environment.

Validate the frozen task source and preview the A/B plan without reading a key or starting Harbor:

```sh
MAKA_HARNESS_AB_OUT_DIR=/path/to/out \
MAKA_HARNESS_AB_TASKS_ROOT=/path/to/terminal-bench-2.1-tasks \
MAKA_HARNESS_AB_LIMIT=5 \
MAKA_HARNESS_AB_DRY_RUN=1 \
node packages/headless/harbor/run-harness-ab.mjs
```

For a live run, remove `MAKA_HARNESS_AB_DRY_RUN` and set `MAKA_HARNESS_AB_KEY_FILE` to a credential file outside git. Both arms receive only a short-lived host proxy capability, never the provider key or key-file path. `MAKA_HARNESS_AB_LIMIT=5` runs the operational canary; rerun the same run id with `89` to continue the same WAL through the complete frozen profile. Four task pairs run concurrently, for at most eight active attempts. Only missing cells run, and the immutable manifest rejects configuration changes.

Oracle evidence is advisory. To consume a CI-issued registry snapshot, set both `MAKA_HARNESS_AB_ORACLE_REGISTRY_URL` and `MAKA_HARNESS_AB_ORACLE_REGISTRY_FINGERPRINT`. The runner downloads the lightweight pinned snapshot, validates its content and per-task identities, and records `passed`, `failed`, `timed_out`, `infra_failed`, `stale`, or `missing` annotations in the manifest and report. Missing, stale, failed, unavailable, invalid, or unresolvable evidence emits warnings but never invokes Oracle, changes task selection, blocks new A/B execution, or changes statistical inclusion. A resumed run reuses the advisory snapshot frozen in its existing manifest instead of resolving current registry state again. Legacy manifests retain their historical Oracle-gated `qualification` metadata as read-only history; the current runner does not append new cells to a run created by the old qualification profile.

The manual `.github/workflows/oracle-evidence-audit.yml` workflow is the only CI path that invokes Oracle. Its prepare job resolves task contents, the pinned Harbor verifier/execution policy, the compose override, Docker platform, and current `linux/amd64` base-image manifest digests into per-task qualification keys. Exact runner versions are recorded as execution provenance rather than key material. Each task runs from a temporary copy whose Dockerfile is pinned to the resolved digests. The workflow downloads the newest prior registry release by default, runs only missing or changed tasks in a bounded GitHub-hosted matrix, and publishes a new content-addressed prerelease containing `oracle-registry.json` and immutable per-task `oracle-evidence.jsonl`. Ordinary CI and A/B runs do not trigger this workflow.

For an unattended run, invoke `node packages/headless/harbor/run-harness-ab-detached.mjs` with the same environment. It detaches the worker from the terminal and atomically journals `running`, `completed`, or `failed` in `background-run.json`; stdout and stderr go to `background-run.log`.

Outputs are `harness-ab-report.json`, `.csv`, and `.md`. Report schema v3 records scheduled, attempted, model-scored, unscored (including the infrastructure-failed subset), and missing-final-usage cell coverage while keeping paired Pass@1 and token economy on separate denominators. Account-plan runs record zero cost and use real token totals as the economy measure. Evidence gaps finish as `completed_with_gaps` and fail the completion assertion; an unattempted suffix remains `incomplete`. Reports do not claim fixed-plan spend or publish results.

## Attention semantic-compaction A/B

`harbor/run-runtime-policy-ab.mjs` includes a checked-in attention-first comparison over
`polyglot-rust-c`, `sqlite-db-truncate`, `reshard-c4-data`, `sanitize-git-repo`, and
`build-cython-ext`. The baseline disables semantic compaction; the candidate uses a
16K provider context, 50% high-water mark, 4K completed-middle-span hysteresis, a
4096-token generation budget, and a 768 estimated-token accepted projection budget.
The full phase runs three repetitions per task and arm (30 cells) after a one-repetition
operational pilot. Both arms keep the same model, prompt, tools, task budgets, and code
fingerprint.

Validate the exact executable manifest without reading a credential:

```sh
MAKA_RUNTIME_AB_OUT_DIR=/path/to/out \
MAKA_RUNTIME_AB_TASKS_ROOT=/path/to/frozen-five-task-export \
MAKA_RUNTIME_AB_SPEC_PATH=packages/headless/harbor/runtime-policy-ab-specs/attention-semantic-compact.json \
MAKA_RUNTIME_AB_PROFILE_PATH=packages/headless/harbor/runtime-policy-ab-profiles/glm-5.2.json \
MAKA_RUNTIME_AB_RUN_ID=attention-semantic-compact-glm-5.2 \
MAKA_RUNTIME_AB_DRY_RUN=1 \
node packages/headless/harbor/run-runtime-policy-ab.mjs
```

For a live run, remove `MAKA_RUNTIME_AB_DRY_RUN` and point
`MAKA_RUNTIME_AB_KEY_FILE` at a Z.ai credential file outside git. The lifecycle refuses
to advance past the pilot if either arm has an infrastructure/protocol failure, if the
candidate never activates compaction, or if coverage is incomplete. The final report's
primary decision uses official verifier Pass@1 with the checked-in 10 percentage-point
non-inferiority margin; token, cache, cost, latency, and compaction activation data remain
secondary diagnostics.
Use a frozen exported task root with exactly one version of each selected task; a mixed
Harbor cache containing two versions of a selected task is rejected instead of choosing
one silently.

## Exit code

`maka eval run` exits non-zero on an **infrastructure** failure (invalid
spec, refused backend, a run that crashed before producing a result). A run
that completed and merely **failed its verification** is valid benchmark data
and exits 0.

## Legacy compatibility

`maka-headless` remains a deprecated compatibility binary and prints a warning;
new documentation and automation must use `maka eval`.
