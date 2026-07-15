# Session Task Ledger Lifecycle

This document defines the lifecycle and persistence contract for the task ledger
attached to an interactive session. It is distinct from the Headless `TaskRun`
record: the ledger tracks model-visible work items inside a session, while a
`TaskRun` records a complete benchmark or automation execution.

## Scope

Maka has a session-scoped task ledger with `task_create`, `task_update`,
`task_list`, `task_get`, `task-events.jsonl`, `tasks.json`, and turn-tail prompt
injection. The implementation keeps lifecycle validation, event replay, storage
projection, tool access, and recovery classification on one contract.

Non-goals:

- no workflow engine;
- no multi-agent assignment;
- no cron or automation scheduling;
- no project-management UI;
- no replacement for `AgentRun`, `RuntimeEvent`, filesystem, git, test, or tool
  evidence.

Task status is advisory control state. It must not override real filesystem,
git, test, verifier, scorer, or tool evidence.

## Task Status

Task statuses are:

- `pending`: declared but not started.
- `in_progress`: actively being worked on.
- `blocked`: cannot continue without external input, dependency, permission, or
  prerequisite repair.
- `completed`: finished with evidence.
- `failed`: attempted and ended unsuccessfully with a reason.
- `cancelled`: intentionally stopped and should not resume automatically.

Allowed transitions:

```text
pending -> in_progress
pending -> cancelled

in_progress -> blocked
in_progress -> completed
in_progress -> failed
in_progress -> cancelled

blocked -> in_progress
blocked -> cancelled
blocked -> failed

failed -> pending
failed -> cancelled

completed -> in_progress   only with explicitReopen: true
cancelled -> pending       only with explicitReopen: true
```

## Evidence

New updates into these states require evidence:

- `blocked` requires `blockedReason`.
- `failed` requires `failureReason`.
- `completed` requires `completionEvidence`.

Evidence is compact text. Later work can replace or supplement it
with first-class run, tool-call, artifact, verifier, or scorer references.

Legacy completed or cancelled tasks that predate this contract may still be
read from `tasks.json`. New updates must satisfy the evidence rules.

## Resume Trust

The source-backed type includes a conservative `resumeTrust` classifier:

- `trusted`: durable evidence is intact.
- `needs_revalidation`: state may still be correct, but related external truth
  should be checked again.
- `stale`: task was active when the session or run was interrupted.
- `repaired`: recovery logic changed the projected state.
- `untrusted`: ledger, references, or state are corrupt or missing.

The type and pure classifier are source-backed. `resumeTrust` is a system
diagnostic and is not injected into the model-visible task ledger until recovery
logic owns the value.

Recovery/read-model classification uses the conservative classifier:

- `in_progress` tasks are `stale`.
- tasks with missing required evidence are `needs_revalidation`.
- corrupt ledgers, invalid projections, or missing references are `untrusted`.
- repaired projections are `repaired`.

## Tool Surface

The model-facing tools are:

- `task_create`
- `task_update`
- `task_list`
- `task_get`

They are pure local session-state tools and do not imply subagent assignment or
workflow dispatch. `MAKA_TASK_LEDGER_TOOLS=false` disables registration. Legacy
PascalCase aliases are not advertised and require an explicit compatibility
flag in main-process wiring.

## Debug and UI Read Model

The model-visible task ledger remains compact and omits `resumeTrust`, including
both the turn-tail injection and `task_list` / `task_get` tool results. Debug,
export, and trace/read-model surfaces may include task summaries with
`resumeTrust`, reasons, evidence, and refs. UI exposure remains lightweight:
current task, blocked reason, and completion evidence summaries only.
