# Computer Use Provider Evidence

This layer defines the evidence contract for real-model Computer Use runs. It
does not claim that any provider has completed a real run.

## Scenario Contract

The scenario library defines:

- an owned Electron fixture;
- the exact user prompt and expected state;
- forbidden effects;
- allowed actions and per-action budgets;
- required execution capabilities;
- deterministic state evaluation.

The fixture helper imports Electron only. It does not import Maka Runtime,
provider transports, or execution backends.

## Report Contract

Reports separate three evidence classes:

- `real-runtime`: a live provider model used the production Maka runtime;
- `hermetic-protocol`: a fake transport proved protocol behavior;
- `static-contract`: source or schema checks only.

Only `real-runtime` can satisfy a provider matrix cell marked `real`.
Policy-bypassed runs remain visibly labeled and cannot become an unqualified
pass.

The sanitizer preserves action types, timing, result codes, aggregate state,
and allowlisted trace fields. It removes coordinates, typed text, raw UI
content, credentials, full URLs, and provider payloads.

## Next Layer

A provider launcher must:

1. pin a scenario from this library;
2. run against the owned fixture and production Computer Use backend;
3. enforce the scenario action budget before dispatch;
4. emit a sanitized `real-runtime` report;
5. let the provider matrix validate fixture state and forbidden effects.

The first run should be `l0-observe-only`, followed by one AX semantic mutation.
