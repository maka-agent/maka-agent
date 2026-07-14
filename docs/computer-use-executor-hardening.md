# Computer Use Executor Hardening

This note records the post-merge review of PR #893 against the current
`cua-driver` executor and the local Codex Computer Use reverse-engineering
evidence.

## Target Identity Consolidation

The follow-up review of PRs #930-#933 exposed four variants of the same root
cause: target identity was inferred from mutable content or local indexes
instead of being carried through observation, dispatch, and readback as one
driver-owned identity.

Evidence:

- coordinate freshness used one window-wide fingerprint, so removing dynamic
  labels and values also removed the identity of the actionable control at the
  source coordinate;
- Electron page validation covered only the semantic left/right/double-click
  branch, leaving middle-click, triple-click, scroll, and unknown-process pixel
  fallback outside the boundary;
- native keyboard ownership came from the pre-click coordinate snapshot and
  re-resolved by role/label/value, which could select a different AX node;
- Electron text used a document-global incrementing token installed through a
  different helper path from readback, so reload and session reuse were not
  fenced.

The consolidated implementation:

- keeps the window fingerprint structural, while Runtime binds the smallest
  actionable source element's role, label, value, frame, and stable
  `nodeIdentity` into the action fingerprint; backend re-resolution must match
  every field or return `target_changed`;
- validates Electron page identity before every compatibility pointer fallback
  and refuses pixel fallback when process classification is `unknown`;
- establishes native keyboard ownership only from the stable AX node focused
  after the click, requires that node to contain the resolved click point, and
  uses the same identity for resolution, `set_value`, and readback;
- installs and reads the Electron element helper through one bootstrap, with
  tokens leased to Maka session, session generation, document fingerprint, and
  navigation generation; reload invalidates the lease before insertion;
- does not reinterpret snapshot-local `element_token` or role/label/value as a
  stable identity. `CuaDriverStableNodeAdapter` is the fail-closed integration
  contract for the future driver interface.

Remaining driver dependency:

- pinned `cua-driver` must expose stable AX node identity operations for
  snapshot identification, focused-node capture, and identity re-resolution.
  Until the host supplies that adapter, actionable coordinate validation and
  native text ownership refuse to claim stable-node success. Existing semantic
  AX actions continue to use their separately reviewed fresh-snapshot contract.

## Fixed In This Follow-Up

- Semantic refetch now requires one unique role/label/value candidate and then
  verifies that its frame, depth, and value still match the observed control.
  A same-label replacement or ambiguous candidate set fails closed.
- Native content fingerprints include label and value, so a control changing
  meaning in the same structural slot invalidates coordinate actions.
- Window screenshots use the same compression threshold and 8 MiB cap as
  desktop screenshots.
- Unconsumed observations are bounded to 16 per session and evicted FIFO.
- Keyboard ownership is invalidated when the bound PID or window no longer
  matches the click-established target.
- Delivered but unverifiable Electron pointer actions and delivered text writes
  preserve `outcome_unknown` instead of becoming retryable `capture_failed`
  results.
- `select_text` and `secondary_action` fail closed because the pinned driver
  registry does not expose their claimed tools.

## Deliberately Not Changed

- Coordinate click, scroll, drag, and key dispatch remain disabled by default.
  Re-enabling the compatibility CGEvent path would restore the physical-input
  interference found during real-machine testing.
- The physical-input callback remains optional at this executor layer because
  semantic AX/CDP operations are also used by non-Desktop hosts. Desktop wiring
  must supply the guard before advertising concurrent-user safety.
- The process-wide operation queue remains global. Maka currently owns one
  action-child stdio connection, and the fresh-snapshot/action pair must remain
  atomic across that shared connection. The Codex native service supports
  concurrency through separate connections while serializing one connection
  and one application instance. Removing the queue without introducing
  separate service connections broke the existing ordering contract.

## Remaining Work

- If cross-session concurrency becomes necessary, create isolated driver
  connections or per-target service instances and preserve snapshot/action
  transactions explicitly.
- Initial `observeApp` failures cannot return the full typed capture result
  through the current observation-only interface. The backend still enforces
  the screenshot cap, but the Runtime interface needs a result-bearing
  observation contract to preserve `sensitivity_blocked` end to end.
- Continue real-provider model-loop testing with coordinate actions fail closed
  until an isolated native event executor exists.

## Verification

The focused `@maka/computer-use` suite passes 111 tests, including semantic
replacement, registry mismatch, observation eviction, window compression,
shared-client ordering, lifecycle error, and keyboard-target regression cases.
