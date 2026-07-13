# Maka AHE Target Protocol

Maka exposes an AHE-facing target contract so AHE can run the outer
self-iteration loop without becoming part of Maka's interactive runtime.
Maka remains the source of truth for runtime events, tool execution,
permissions, artifacts, and official evaluation feedback.

The source-backed TypeScript contract lives in
`packages/headless/src/ahe-target-protocol.ts`. Consumers should use the
`@maka/headless/ahe-target-protocol` subpath after build.

## Protocol Files

AHE should treat these files as the initial file protocol for a Maka target
snapshot and candidate iteration:

- `target-snapshot.json`: a `MakaAheTargetSnapshot` with
  `protocolVersion: "maka.ahe-target.v1"`, the source label, snapshot id, git
  identity when available, and the component map from
  `MAKA_AHE_CURRENT_COMPONENTS`.
- `harness-results.json`: a `MakaAheHarnessResults` object containing per-task
  `MakaAheRunResult` rows. `official_pass` and `official_fail` are valid only
  when `scoreAuthority` is `official_verifier` or `official_scorer`.
- `trace-index.json`: a `MakaAheTraceIndex` that maps every task id to Maka
  runtime-event JSONL, transcript, AgentRun, tool-result, and artifact refs.
- `change-manifest.json`: a `MakaAheChangeManifest` describing the staged
  patch, source-backed components changed, failure evidence, root cause,
  targeted fix, predicted fixes, risk cases, validation dataset, and rollback
  criteria.
- `change-evaluation.json`: a `MakaAheChangeEvaluation` comparing baseline and
  candidate official cells, including transition labels, observed and missed
  predictions, regressions, infra/excluded tasks, and self-check-only tasks.

All refs are opaque file/blob/url refs. The protocol does not require AHE
Python, NexAU, E2B, ADB, tmux, or Rive code in Maka runtime.

## Current Component Map

The first target component map is intentionally current-state only:

- `maka-system-prompt`: desktop prompt and workspace instruction sources.
- `maka-heavy-task-policy`: heavy-task policy and benchmark wrapper
  expectations.
- `maka-tool-contracts`: Maka tool descriptions, input schemas, gating, and
  selected desktop wrappers.
- `maka-context-management`: context budget, tool-result pruning, and semantic
  compaction.
- `maka-permission-policy`: permission modes, pre-tool-use policy, runtime
  enforcement, and dynamic tool availability.
- `maka-runtime-evidence`: canonical runtime events, AgentRun records, and
  runner output. This is evidence rather than an editable harness component.
- `maka-headless-evaluation`: headless result format and Terminal-Bench smoke
  runner protocol.

AHE manifests must use component ids from this map. Future product surfaces can
be added only when they have source-backed contracts.

## Patch Gate

AHE may propose a patch only through `change-manifest.json` with
`patch.applyMode: "staged_patch"`. The manifest must include:

- at least one changed component id;
- failure evidence from baseline traces/results;
- a root-cause statement and targeted fix;
- predicted fixed cases and risk cases;
- a validation dataset with task ids;
- rollback criteria.

Maka validators reject manifests that cite unknown components or omit
falsifiable evidence. When `patch.changedFiles` is supplied, every path must be
a repo-relative POSIX path, must avoid generated/dependency/repository-control
content, and must be listed as a source ref on one of the editable changed
components. Evidence-only components such as `maka-runtime-evidence` cannot be
patched. A self-check can be recorded, but it cannot be reported as
`official_pass` or `official_fail`.

## Evaluation Feedback

Candidate evaluation must compare baseline and candidate cells with official
verifier/scorer authority wherever pass/fail is claimed. The transition matrix
is the feedback AHE should use for the next iteration:

- `fail_to_pass` confirms a fixed baseline failure.
- `pass_to_fail` is a regression and should trigger rollback criteria when it
  matches the manifest.
- `infra_or_excluded` and `selfCheckOnlyTaskIds` are accounting buckets, not
  official success.

The protocol is deliberately file-first. `maka eval ahe export` generates
and validates the source-backed export boundary. Import and candidate-evaluation
CLI workflows remain outside this contract.
