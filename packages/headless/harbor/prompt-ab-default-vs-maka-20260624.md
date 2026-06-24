# Prompt A/B: Maka baseline vs opencode default

Date: 2026-06-24

## Status

The earlier pilot result is superseded. It used an RSI-style held-in/held-out acceptance policy and reported `discard`, which is not the right evaluator for a fixed A/B prompt comparison.

This PR now treats the run as a pure A/B evaluator:

- one `evaluationTasks` set, not held-in/held-out partitions;
- baseline A qualification selects medium tasks where A passes 1/3 or 2/3 reps;
- formal comparison uses fresh A and B reps, so qualification runs are not reused;
- primary statistics are task-level deltas, not 90 independent attempt samples;
- result language is `B better`, `A better`, or `inconclusive`;
- budget exhaustion is reported separately from infrastructure failures.

## Formal Run Shape

- Qualification: run A for 3 reps over the candidate pool and select up to 30 medium tasks.
- Primary A/B: 30 qualified tasks x 3 reps x 2 arms = 180 formal jobs.
- Execution: A/B arms are interleaved by rep to reduce time-of-day/provider/cache drift.
- Default task budget: `MAKA_PROMPT_AB_TASK_BUDGET_SEC=600`.
- Default Harbor watchdog: `MAKA_PROMPT_AB_HARBOR_TIMEOUT_MS=780000`, leaving 3 minutes for Harbor/Docker cleanup after the 10-minute cell budget.

## Timeout Limitation

A 10-minute task budget cannot prove long-horizon prompt gains. If B improves by spending more time exploring, verifying, or repairing, the primary result is only valid as an under-budget comparison. The report must show per-arm timeout counts, and asymmetric timeout rates force an `inconclusive` decision.

Long-horizon sensitivity should be run separately on a smaller hard/near-timeout slice with a 20-30 minute budget and 1-2 reps. Those results should not be mixed into the primary medium-task A/B summary.

## Artifacts

The runner writes local artifacts under `MAKA_PROMPT_AB_OUT_DIR/<runId>/`:

- `prompt-ab-result.json`
- `prompt-ab-report.md`
- controller WAL and per-round TSVs
- Harbor jobs, runtime events, and prompt copies

Raw WAL/job/runtime artifacts remain local and are intentionally not committed.
