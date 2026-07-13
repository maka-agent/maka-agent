# Maka AHE Evidence Export

Maka can export the baseline evidence files that an external AHE loop needs to
start analysis against a source-backed Maka snapshot. This is a read-only
headless boundary: it does not run AHE, apply patches, or change the desktop
runtime.

## Command

After a headless task run has been recorded in a task-run store:

```sh
maka eval ahe export <taskRunId...> \
  --store <out>/runs \
  --repo <maka-repo-root> \
  --out <evidence-dir> \
  [--run-id <id>] \
  [--source-label <label>] \
  [--harbor-trial-dir <dir>] \
  [--include-events]
```

The command validates the current AHE component map against `--repo`, reads the
requested `TaskRunProjection` rows from the existing store, and writes:

- `target-snapshot.json`: `MakaAheTargetSnapshot` for the current source-backed
  component map.
- `harness-results.json`: `MakaAheHarnessResults` for the selected task runs.
- `trace-index.json`: `MakaAheTraceIndex` pointing at per-run trace exports.
- `traces/<taskRunId>/`: ordinary Maka task-run exports, including
  `task-run.json`, `result.json`, `result.md`, and optional `events.jsonl`.

`--harbor-trial-dir` imports the official verifier/scorer result for the selected run and currently accepts exactly one `taskRunId`. Without the flag, a single-run export also detects the standard Harbor trial layout relative to the task-run store. Otherwise the export preserves local checks as non-authoritative evidence.

## Authority Rules

`official_pass` and `official_fail` are emitted only when Maka has authoritative
official verifier/scorer evidence. Non-authoritative local checks and
self-checks are exported as `self_check_only` or `unscored`; infra, excluded,
and unscored cells stay in separate buckets so AHE cannot confuse advisory
evidence with official benchmark truth.

## API

Programmatic callers can use:

- `buildMakaAheTargetSnapshot`
- `makaAheEvidenceFromTaskRunProjections`
- `writeMakaAheEvidenceExport`
- `validateMakaAheSourceRefs`

These functions live in `@maka/headless/ahe-evidence-export`.
