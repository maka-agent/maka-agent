# Computer Use Harness Boundary

## Decision

Provider model loops and host execution are separate contracts.

The default model-facing surface is the provider-neutral `maka_computer`
function tool. Claude, GPT, Kimi, and MiniMax receive the same schema through
their normal function-calling transport. Provider-native Computer Use tools are
compatibility implementations, not the desktop mainline.

## Maka Sky Contract

The first shared surface follows the observed Sky lifecycle:

```text
list_apps
  -> observe(app, window_id, include_screenshot)
  -> click_element / set_value
  -> settle in the host executor
  -> fresh observation
```

An element action must reference the `observation_id` and `element_id` returned
by `observe`. Observation identities are session/turn scoped and one-shot:
replay, cross-turn use, or an unknown element fails closed.

Coordinate actions remain temporarily available for compatibility, but the
semantic path is preferred. The backend PR strengthens observation identity
with persistent Window/frame binding; the provider-neutral tool schema remains
unchanged when that lands.

The production Sky behavior fixtures establish two important rules:

- an AX diff can contain a real changed element, but it reports
  accessibility/focus changes rather than arbitrary application business-state
  effects. Another real action changed the fixture oracle while the AX diff
  remained unchanged, so a diff is evidence but never the sole success oracle;
- every normal step starts from a fresh full observation, performs one action,
  settles, and obtains fresh state before continuing.

The final Codex lab semantic matrix passed 12 real scenarios: full state,
visible AX diff, button click, set value, type text, select text, checkbox,
secondary action, scroll, modal, stale-element recovery, and ambiguous
same-name selection. Separate real runs passed coordinate click, drag, and
`press_key`. These are reference behavior results, not proof that Maka already
implements the same behavior.

Stale element handling is identity preserving rather than index preserving. An
old index may execute only when the host can uniquely refetch the same logical
element. Missing or ambiguous matches require re-observation. The acceptance
oracle must prove that the intended target changed and every inserted or
same-name wrong target remained untouched.

Same-name matches are not resolved by selecting the first element. The model or
harness must provide an explicit occurrence, and the postcondition must prove
that the selected occurrence received the effect.

Coordinate click, drag, and scroll bind to the immediately preceding
screenshot. The observed Codex screenshot is a window/app-local JPEG, not a
default desktop atlas. A coordinate action therefore carries the exact
`observation_id` and `screenshot_id`; a later screenshot, another window, or an
atlas with a different origin invalidates the coordinate.

User intervention, stale elements, ambiguous apps, blocked URLs, and screen
locking therefore move the harness into a re-observe or terminal state rather
than permitting a best-effort action.

`userIntervened` is reserved for physical user-input evidence or the native
intervention state machine. It must not be inferred from an unrelated dynamic
label, timer, progress indicator, DOM mutation, or whole-window AX/content
fingerprint change. Such changes are tolerated when target identity and the
bound transform remain valid; a changed target becomes stale or is uniquely
refetched.

## Production Sky Evidence Update

The pinned synthetic-app run now contains a provenance-checked 15-scenario
semantic matrix covering full state, AX diff, element click, set value, type
text, key navigation, select text, checkbox, secondary AX action, scroll,
modal, stale-element refetch, duplicate-name disambiguation, coordinate click,
and drag.

These results narrow the contract:

- stale element indices are not automatically invalid. The native service may
  continue only when it can uniquely refetch the same semantic element;
  missing or ambiguous matches require re-observation;
- `user_intervened` is an explicit physical-input/session state, not a label for
  arbitrary AX or DOM content changes;
- coordinate and drag actions belong to the immediately preceding app/window
  screenshot. A desktop atlas is one possible capture surface, not the universal
  coordinate contract;
- transport success is not effect success. A later scroll sequence fixture
  records a successful production call whose business oracle did not change, so
  every action still needs a fresh postcondition and action-specific verifier;
- screenshot pixels, AX full state, AX diff, and business-state verification
  are separate evidence channels and must not be collapsed into one hash.

Provider harnesses own:

- provider wire protocol and continuation state;
- screenshot preprocessing and model coordinate space;
- model action parsing, action budgets, and retries;
- safety-check routing into Maka permission events;
- model, tool, and display latency reporting.
- evidence labeling and redaction for provider reports.

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

## Evidence Contract

Computer Use results must state what they prove:

- `real-runtime`: a real provider model and production Maka runtime ran against
  a controlled fixture with fresh post-action verification;
- `hermetic-protocol`: fake transports or sockets proved framing, parsing,
  ordering, policy, and fail-closed behavior without touching real apps;
- `static-contract`: source, schema, or binary inspection proved that a contract
  exists, but did not execute it.

Only `real-runtime` reports may satisfy a provider matrix cell marked `real`.
Reports must not persist prompts, credentials, screenshot bytes, AX text, or raw
provider responses. Mock and static evidence remain useful, but never inherit an
unqualified "works" result.

## Model Content Boundary

Screenshot pixels, AX text, window titles, page content, and application messages
are untrusted model inputs. Provider harnesses must keep system and user intent
outside that content channel, reject unsupported action semantics, freeze action
parameters before asynchronous policy work, and re-observe after unexpected
navigation or state changes.

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
- L1: one owned window and one action bound to `observation_id`, Window/frame,
  and the immediately preceding app/window-local screenshot. Require fresh
  post-action state, an independent business oracle, and duplicate rejection.
- L2: set value, type/select text, secondary action, coordinate click, scroll,
  drag, `press_key`, and modal transitions. Require target-bound keyboard
  ownership and explicit screenshot/crop coordinate spaces.
- L3: multiple windows, explicit occurrence selection, occlusion, stale frames,
  and target-epoch invalidation. Unique stale refetch is allowed only with
  identity preservation and a zero wrong-target oracle.
- L4: concurrent user input, focus/cursor sentinel, negative display origins,
  and mixed display scales. Unrelated dynamic content must not synthesize
  `userIntervened`.
- L5: provider matrix with one report schema.

L1 and above require explicit forbidden-effects assertions. L3 and above require
window/frame identity from the execution layer.

The hermetic contract runner in `scripts/cu-maka-sky-contract.mjs` evaluates
these evidence traces without dispatching pointer or keyboard input. Its
checked-in Codex reference fixture records which requirements came from real
Codex lab evidence; it does not import private screenshots, AX text, prompts,
or tool arguments.
