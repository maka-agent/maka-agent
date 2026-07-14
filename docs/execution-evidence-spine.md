# Execution Identity and Evidence Spine

Status: Phase 0 contract plus Phase 1 Runtime-to-Task lineage. See [issue #948](https://github.com/maka-agent/maka-agent/issues/948).

Maka already records the facts needed to explain an execution. Runtime Events preserve model and tool interaction facts, AgentRun records operational lifecycle, and Task Events preserve durable task-control decisions. The missing piece is a shared way to reference those facts across subsystem boundaries.

The Execution Identity and Evidence Spine is that reference protocol. It answers:

> Which execution, source-log prefix, workspace revision, and target snapshot support this projection or evidence claim?

It is deliberately not a new event log, trace backend, or source of truth.

## Delivery boundary

Phase 0 added a versioned shared contract in `@maka/core/execution-evidence`, runtime validation, cursor comparison rules, and this ownership audit. At that boundary it did not:

- assign or persist log sequence numbers;
- change Runtime, AgentRun, Session, or TaskRun storage;
- migrate durable data;
- attach evidence references to Self-check, Compaction, or AHE exports;
- add a lineage inspection command.

Defining the contract first prevents each integration from inventing a different meaning for identity, coverage, or freshness.

Phase 1 makes the Runtime-to-Task portion concrete:

- new AgentRun headers persist `invocationId` while legacy headers remain readable;
- every finished headless Runtime invocation appends a `task_attempt_execution_linked` Task Event;
- the event references TaskRun, Attempt, Session, Invocation, AgentRun, Turn, and inclusive Runtime Event coverage;
- one Attempt may link multiple AgentRuns, including the bounded heavy-task repair run;
- `TaskRunProjection.executionLineage` and each `TaskAttempt.executionLineage` expose the replayed links;
- legacy `ResultRecord` imports produce an honest identity-only link when Runtime coverage is unavailable.

Phase 1 still does not add Task Event cursors, evidence freshness, Compaction integration, AHE lineage, or a general inspection command.

## Existing authorities

The spine references existing authorities instead of copying their facts.

| Authority | Identity today | Owns | Does not own |
| --- | --- | --- | --- |
| `RuntimeEvent` | `sessionId`, `invocationId`, `runId`, `turnId`, `id` | Canonical model, tool, runtime-content, and terminal interaction facts | Task scheduling or task-level decisions |
| `AgentRunHeader` and `AgentRunEvent` | `sessionId`, optional legacy-compatible `invocationId`, `runId`, `turnId`, event `id` | Operational run lifecycle, status, model resolution, permission, usage, and run-local checkpoints | A second copy of raw Runtime interaction history |
| `SessionEvent` and stored messages | Session and turn-oriented identifiers | Compatibility and UI/session read models | Canonical Runtime history |
| `TaskEvent` | `taskRunId`, optional event-specific `attemptId`, event `id` | Task lifecycle, attempts, policy decisions, evidence envelopes, permissions, and recovery-visible task state | Raw model messages, Tool Calls, or Tool Results already owned by Runtime Events |
| `TaskRunProjection` | Fold of one `taskRunId` event stream | Current task read model derived from Task Events | Independent facts outside its source Task Events |
| Compaction checkpoints and blocks | Checkpoint/block ids, policy-specific `highWaterName` and `highWaterSeq`, explicit Runtime Event ids | Lossy context projections and the source set required to validate those projections | Replacement of canonical Runtime Events or a universal log cursor |
| Self-check records | Task and check-specific identifiers | Bounded completion claims and supporting task evidence | Executor-owned command, output, artifact, or workspace facts |
| AHE exports | Target snapshot and exported trajectory references | A derived evaluation/evolution evidence package | Authority over the Runtime or Task facts it exports |

This gives Maka two principal append-only evidence lanes:

```text
Runtime Event ledger                       Task Event ledger
session / invocation / AgentRun / turn     TaskRun / attempt
        |                                          |
        +------------- evidence ref ---------------+
                              |
                   workspace + target snapshot
```

Task Events may reference a Runtime trajectory. They must not reproduce it. Projections may summarize either ledger, but their trust comes from source coverage that can be checked against the owning ledger.

## Identity contract

`ExecutionEvidenceRef` separates Runtime and Task identity lanes so similarly named runs cannot be confused:

```ts
interface ExecutionEvidenceRef {
  schemaVersion: 'maka.execution_evidence_ref.v1';
  execution?: {
    sessionId: string;
    invocationId?: string;
    agentRunId?: string;
    turnId?: string;
  };
  task?: {
    taskRunId: string;
    attemptId?: string;
  };
  runtimeCoverage?: ExecutionLogCoverage;
  taskCoverage?: ExecutionLogCoverage;
  workspace?: WorkspaceRevisionRef;
  target?: TargetSnapshotRef;
}
```

`execution.agentRunId` maps to the existing `AgentRunHeader.runId` and `RuntimeEvent.runId`. The longer cross-ledger name is intentional: `agentRunId` and `taskRunId` describe different lifecycles.

The Runtime hierarchy remains:

```text
sessionId > invocationId > agentRunId > turnId
```

`invocationId` is the existing durable Runtime spine. `agentRunId` identifies a concrete execution attempt recorded by AgentRun. Current production paths may assign the same value to both; consumers must not rely on that implementation coincidence.

Only `sessionId` is required inside an execution identity, and only `taskRunId` is required inside a task identity. At least one lane must be present. Optional descendants let readers represent legacy or partial knowledge honestly instead of fabricating identifiers.

## Cursor contract

An ordered cursor has three required coordinates:

```ts
interface ExecutionLogCursor {
  ledger: 'runtime_event' | 'task_event';
  streamId: string;
  sequence: number;
  eventId?: string;
}
```

The semantics are strict:

1. `sequence` is the zero-based append ordinal within one `(ledger, streamId)` pair.
2. Only `sequence` determines order.
3. `eventId` is an optional audit, lookup, and deduplication pointer. It must never determine order.
4. Cursors from different ledgers or streams are incomparable.
5. Different explicit event ids at the same stream position are a conflict, not an ordering result.

The planned stream bindings are:

| Ledger | `streamId` |
| --- | --- |
| `runtime_event` | `execution.agentRunId` |
| `task_event` | `task.taskRunId` |

Phase 0 defines these semantics but does not claim that current stores already persist the ordinal. Existing Runtime Event ids are best-effort unique identifiers, not durable ordered cursors. Existing Compaction `highWaterSeq` values remain policy-local until a later integration explicitly maps them to source-log coverage.

For Phase 1 headless lineage, the persisted AgentRun Runtime Event JSONL is the ordered stream. Mutable partial snapshot files are excluded, while every physical JSONL row—including a lifecycle row that may carry `partial: true`—retains its append position. Those immutable positions are materialized as zero-based cursor sequences. A completed invocation therefore records coverage such as:

```text
TaskRun task-42 / Attempt attempt-2
  -> AgentRun run-a: Runtime Events [0..146]
  -> AgentRun run-b: Runtime Events [0..38]   # bounded repair run
```

The Task Event stores only these references and boundary event ids. Model messages, Tool Calls, Tool Results, and other Runtime facts remain solely in the Runtime Event ledger.

Coverage is an inclusive range within one stream:

```ts
interface ExecutionLogCoverage {
  lowWater?: ExecutionLogCursor;
  highWater: ExecutionLogCursor;
  eventCount?: number;
}
```

`lowWater` may be omitted when only a prefix high water is known. `eventCount` counts observed rows and therefore need not equal the ordinal span when gaps are represented.

## Example

```ts
const evidence = {
  schemaVersion: 'maka.execution_evidence_ref.v1',
  execution: {
    sessionId: 'session-7',
    invocationId: 'invocation-12',
    agentRunId: 'run-12',
    turnId: 'turn-3',
  },
  task: {
    taskRunId: 'task-42',
    attemptId: 'attempt-2',
  },
  runtimeCoverage: {
    lowWater: {
      ledger: 'runtime_event',
      streamId: 'run-12',
      sequence: 100,
      eventId: 'runtime-event-100',
    },
    highWater: {
      ledger: 'runtime_event',
      streamId: 'run-12',
      sequence: 246,
      eventId: 'runtime-event-246',
    },
    eventCount: 147,
  },
  workspace: {
    kind: 'workspace_snapshot',
    ref: 'workspace-19',
    dirty: true,
  },
  target: {
    snapshotId: 'maka-ahe-abc123',
    sourceLabel: 'git:abc123',
  },
} as const;
```

This object says where evidence came from. It does not assert that the evidence is correct, current, or complete. Those judgments require reading the referenced facts and comparing their source high waters with current ledger and workspace state.

## Compatibility rules

- Persisted references must carry `schemaVersion`.
- Readers validate unknown input before trusting identity or cursor fields.
- Missing optional identities mean unknown, not empty and not synthesized.
- Legacy records can remain readable through partial identity lanes.
- A future schema version must use an explicit migration or compatibility reader; it must not silently reinterpret v1 cursor ordering.
- A projection must not claim coverage that its producer cannot prove.

## Deferred integration work

Later phases should extend the contract without changing fact ownership:

1. Materialize stable append ordinals for Task Event streams, including backward-compatible reads.
2. Bind executor-owned Tool Results, artifacts, and workspace observations to evidence references.
3. Bind Self-check to Runtime and Task high waters plus a workspace revision, then define deterministic staleness rules.
4. Map Compaction source coverage to the shared cursor contract while retaining explicit source-event validation.
5. Carry target snapshot and execution lineage through AHE exports.
6. Add human-readable and machine-readable inspection surfaces that expose missing, stale, conflicting, or ambiguous lineage.

The guiding invariant is simple:

> The evidence spine points to facts. It never becomes another place where those facts are rewritten.
