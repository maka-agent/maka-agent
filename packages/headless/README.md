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

`Config.thinkingLevel` is optional and uses the same provider mapping as the
desktop runtime. `thinkingLevelMode: "probe"` is an explicit benchmark opt-in
for uncatalogued custom models. Custom gateways continue to use an existing
`openai-compatible` connection; no benchmark-specific provider adapter is
required. Harbor callers use `MAKA_THINKING_LEVEL` and, for uncatalogued
capability probes, `MAKA_THINKING_LEVEL_MODE=probe`.

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

## Model calibration

Model execution and discovery stay owned by `@maka/runtime`:
`fetchProviderModels`, `getAIModel`, `buildProviderOptions`, `AiSdkBackend`, and
`ModelAdapter`. Headless only defines the provider-neutral 5/5/5/3/2 result
contract and Main/Curator qualification thresholds. Qualification counts unique
model-plus-thinking-level configs, so one selected model can be calibrated at
low, medium, and high without pretending those configs are different models.
Callers run the cases through the normal isolated runtime, then pass normalized evidence to
`qualifyModelCalibrationResults` and `buildModelCalibrationDecision`.

The single-model config identity is `maka.model_calibration.config.v2` and the
environment/decision contract is `maka.model_calibration.v2`. The earlier
pre-release v1 multi-model identity is not silently reinterpreted as v2.

In explicit `probe` mode, a reasoning level for an `openai-compatible`
connection is sent under that connection's AI SDK namespace. Normal runtime
calls still require catalog support. This enables custom-gateway capability
probing without weakening the desktop model picker's conservative behavior.

## Grading

Verification runs the task's `command` in the workspace; exit code 0 = pass.
A config must not be able to grade itself, so `verification.protectedPaths` is
**required**: list the test/grading files and they are restored from the
pristine fixture *after* the agent finishes and *before* the command runs — a
model that rewrote its own test to pass has that edit reverted. Declare `[]`
only when the verification reads nothing the agent can forge — as the bundled
`examples/demo` does, checking a fixture file the agent has no reason to touch.

## Memory benchmark datasets

`@maka/headless` includes two frozen, host-owned deterministic datasets:

- `maka-context-continuity-v1`: 60 cases covering distant facts, exact values,
  large tool results, tool adjacency, compact/resume/fork, and overflow recovery.
- `maka-native-memory-lifecycle-v1`: 80 cases covering remember, evidence
  promotion, one-off rejection, conflict, dedupe, scope, privacy/deletion, and
  freshness.

Use `loadBundledMemoryBenchmarkDataset` to load and verify the pinned dataset
hash, then `gradeMemoryBenchmarkDataset` to classify normalized case outputs.
The grader distinguishes task, infrastructure, privacy/scope/deletion hard-gate,
and artifact failures. It recomputes scores from assertions; model self-checks
and bare pass flags are not inputs to this API.

Hard-gate `not_contains` assertions scan the complete normalized result, so a
forbidden value cannot pass by moving to another field. Grades report hard-gate
state as `passed`, `failed`, or `not_evaluated`; execution and artifact failures
on protected cases are not mislabeled as proven privacy violations.

The checked-in JSON is generated from compact deterministic family definitions.
Run `npm --workspace @maka/headless run check:memory-datasets` to verify that the
frozen artifacts still match their source. Maintainers may use the generator's
`--write` mode only while introducing a new dataset id/version.

Bundled `v1` files are immutable. Any content change requires a new dataset id
and version rather than updating the pinned hash in place.

## Current Maka memory baseline

`buildCurrentMakaMemoryBaseline` combines the existing model calibration,
benchmark manifest, WAL, Harbor importer, and offline scorer contracts. A frozen
baseline retains one selected model with low/medium/high capability probes and
three matching formal calibration reports, clean-subject run manifests,
explicit known gaps, model/effort configuration, dataset hashes, strategy
hashes, and repetitions. Capability evidence includes runtime status, exact
usage, reasoning tokens, latency, fallback state, and provider HTTP status when
the existing adapter exposes it. The three token-sanity runs are also pinned to
the official Harbor task checksum, not only its display name.

`auditCurrentMakaMemoryBaseline` reads the manifest-declared attempts,
transcripts, exact token rows, and Harbor verifier artifacts without contacting
a model. Incomplete, tampered, or non-authoritative evidence produces an
`invalid` snapshot and remains available for audit. Baseline descriptors and
snapshots use the existing create-only redacted artifact writer, so a repeated
run must use a new baseline id/path and cannot overwrite frozen evidence.
Current descriptors use `maka.memory_benchmark.current_baseline.v2`; the
pre-release six-model v1 descriptor remains a separate historical contract.

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

## GLM-5.2 harness comparison

`harbor/run-harness-ab.mjs` compares Maka and OpenCode 1.17.18 on the same Terminal-Bench 2.1 tasks with GLM-5.2 Max. The task root must match the 89 task ids and canonical task-tree fingerprint of the frozen official revision; a matching Harbor export with one task directory per id is accepted directly. The first 40 tasks are a fixed prefix of the full seeded order.

Validate the manifest without reading a key or starting Harbor:

```sh
MAKA_HARNESS_AB_OUT_DIR=/path/to/out \
MAKA_HARNESS_AB_TASKS_ROOT=/path/to/terminal-bench-2.1-tasks \
MAKA_HARNESS_AB_RUN_ID=glm-5.2-harness-ab \
MAKA_HARNESS_AB_LIMIT=40 \
MAKA_HARNESS_AB_DRY_RUN=1 \
node packages/headless/harbor/run-harness-ab.mjs
```

For a live run, remove `MAKA_HARNESS_AB_DRY_RUN` and set `MAKA_HARNESS_AB_KEY_FILE` to a credential file outside git. Maka reads it in its host-side cell; OpenCode receives only a short-lived host proxy capability, never the provider key or key-file path. Resume with the same output directory and run id; changing `MAKA_HARNESS_AB_LIMIT` from `40` to `89` runs only missing cells. The immutable manifest rejects other configuration changes.

Outputs are `harness-ab-report.json`, `.csv`, and `.md`. They report Pass@1 and cache-aware API-equivalent cost separately; they do not claim fixed-plan spend or publish results.

## Exit code

`maka eval run` exits non-zero on an **infrastructure** failure (invalid
spec, refused backend, a run that crashed before producing a result). A run
that completed and merely **failed its verification** is valid benchmark data
and exits 0.

## Legacy compatibility

`maka-headless` remains a deprecated compatibility binary and prints a warning;
new documentation and automation must use `maka eval`.
