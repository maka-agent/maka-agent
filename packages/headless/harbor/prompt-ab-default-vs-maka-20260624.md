# Prompt A/B: Maka baseline vs opencode default

Date: 2026-06-24

## Result

- Decision: discard (`held_in_within_noise`)
- Baseline: Maka benchmark baseline prompt (`sha256:507bf4a8325b8f5c5728944089dfc04dbfa8829dc638ee678320ad8cc0932ebc`)
- Candidate: opencode `default.txt` (`sha256:67609ac94869f523a2f770610e69c6b34be0e415c70c3956bbe79970a2f8da12`)
- Samples: 8 held-in tasks + 4 held-out tasks, 3 reps each
- Concurrency calibration: tested 1, 2, and 4; recommended 4
- Run health: 81 completed task events, 0 infra failures, 0 plumbing failures
- Total recorded model cost: $0.183818

## Metrics

- Held-in pass/eligible rate: baseline 23/24 = 0.9583, candidate 22/24 = 0.9167, noise band 0.1379
- Held-out pass/eligible rate: baseline 9/12 = 0.75, candidate 9/12 = 0.75, noise band 0.3135
- Paired held-in: 1 win, 2 losses, 21 ties, 0 missing
- Paired held-out: 0 wins, 0 losses, 12 ties, 0 missing
- Paired overall: 1 win, 2 losses, 33 ties, 0 missing

## Paired Deltas

- Candidate win: `openssl-selfsigned-cert#r2`
- Candidate losses: `kv-store-grpc#r0`, `kv-store-grpc#r1`

## Task Sample

Held-in:

- `log-summary-date-ranges`
- `modernize-scientific-stack`
- `git-leak-recovery`
- `fix-git`
- `kv-store-grpc`
- `nginx-request-logging`
- `fix-code-vulnerability`
- `openssl-selfsigned-cert`

Held-out:

- `portfolio-optimization`
- `mteb-retrieve`
- `git-multibranch`
- `constraints-scheduling`

## Notes

- This is a concrete fixed-prompt A/B run, not an RSI optimization round.
- The candidate was the opencode `default.txt` prompt copied from a local opencode checkout.
- The initial broader sample exposed Harbor runtime risk from long Docker cleanup on some tasks, so this committed result uses a bounded, previously completed task sample and a 6-minute per-Harbor-job timeout.
- Raw controller WAL, job directories, runtime events, and prompt copies were left in local run storage and are intentionally not committed.
