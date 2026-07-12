# Computer Use Harness Boundary

## Decision

Provider model loops and host execution are separate contracts.

Provider harnesses own:

- provider wire protocol and continuation state;
- screenshot preprocessing and model coordinate space;
- model action parsing, action budgets, and retries;
- safety-check routing into Maka permission events;
- model, tool, and display latency reporting.

The host execution layer owns:

- app/window identity;
- screenshot or frame identity;
- stale-state rejection;
- background delivery and focus safety;
- real pointer protection;
- target-bound keyboard ownership;
- action effect evidence and postcondition verification.

## Codex Reference

The bundled Codex Computer Use runtime confirms this split:

- model-facing Computer Use is a deferred `node_repl` function tool, not the
  public Responses `computer_call` protocol;
- model code calls an app-scoped semantic API;
- each action targets a `Window { app, id }`;
- coordinate click, drag, and scroll can carry a `screenshotId`;
- the service rejects stale elements and cached screenshot mismatches;
- actions are serialized through one native transport;
- actions are followed by a fresh state read after UI settling;
- physical user intervention is a first-class stop reason.

Maka should adopt these execution invariants without copying Codex's proprietary
transport or replacing Maka's stronger `path / effect / verified` evidence.

## PR Boundary

The model-loop PR may fail closed when a harness detects target occlusion, but
it must not implement a second window-targeting backend.

The backend PR must add persistent window and frame binding. A coordinate must
never be reinterpreted against the highest-z window at dispatch time when it was
grounded from another window's observation.

Until that backend contract lands, real model E2E scenarios that can dispatch
pointer or keyboard actions must use an owned-target guard and stop before
dispatch when the target is occluded.

## E2E Levels

- L0: observation only; session/events/latency; no state mutation.
- L1: one owned window and one pointer action.
- L2: controls, scrolling, dragging, and verified text input.
- L3: multiple windows, occlusion, stale frames, and target-epoch invalidation.
- L4: concurrent user input, focus/cursor sentinel, and multiple displays.
- L5: provider matrix with one report schema.

L1 and above require explicit forbidden-effects assertions. L3 and above require
window/frame identity from the execution layer.
