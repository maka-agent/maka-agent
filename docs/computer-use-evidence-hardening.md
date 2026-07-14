# Computer Use Evidence Hardening

This follow-up makes real-model reports fail closed as evidence.

## Unified Report Boundary

Every direct or Desktop report passes through one schema-driven sanitizer.
Only validated attribution, terminal state, action summaries, synthetic fixture
state, assertion results, and allowlisted dispatch evidence survive.

Prompts, screenshots, coordinates, typed text, raw UI content, arbitrary trace
strings, provider bodies, and outer exception messages are excluded.

## Qualification

A real provider matrix cell requires:

- schema version 1 and `real-runtime` evidence;
- matching provider, model, scenario, producer, and live transport;
- launcher status `pass` and terminal `complete/end_turn`;
- successful allowed actions bound to the owned fixture;
- minimum and maximum per-action counts plus the total action budget;
- canonical expected-state and forbidden-effect assertions;
- AX or semantic dispatch evidence for mutation scenarios.

Missing evidence is invalid or inconclusive, never a pass.

## Runtime Guard

Real-model mode requires an explicit policy. It enforces exact fixture app
selectors, observation ownership for later semantic actions, per-action counts,
and the total count before dispatch.

Scenarios with dedicated runners or unavailable execution capabilities fail
closed in the ordinary launcher.

## Fixture Safety

Partial fixture construction destroys already-created windows. Replacement
scenarios enumerate surviving windows rather than stale scenario declarations.
