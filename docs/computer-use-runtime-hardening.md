# Computer Use Runtime Hardening

This follow-up addresses lifecycle gaps found during review of PR #892.

## Problems

- `clearSession()` did not create a stop tombstone when no session-state record
  existed yet, so a first queued invocation could activate after cleanup.
- Read-only host actions did not acquire a session lease and could continue
  after `user_stopped`.
- Later lifecycle events could overwrite `blocked_url` or `user_stopped`.

## Root Cause

The Runtime treated observation and mutation leases as the only operations that
needed lifecycle fencing. Cleanup also mutated only an already-created state
record, while terminal transitions shared the same unrestricted transition
helper as recoverable states.

## Fix

- Create the same-turn stop tombstone unconditionally during `clearSession()`.
- Require an observation lease for every host-reading or waiting action.
- Make `blocked_url` and `user_stopped` absorb later lifecycle events.

A new turn still creates a fresh Computer Use session state, preserving the
existing explicit recovery boundary.

## Verification

- `npm --workspace @maka/runtime run typecheck`
- focused Computer Use and session-state tests: 52 passed
- `git diff --check`
