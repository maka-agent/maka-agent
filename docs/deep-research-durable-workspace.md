# Deep Research durable workspace

This contract is an independent, minimal reproduction of the central systems
idea in [FS-Researcher: Test-Time Scaling for Long-Horizon Research Tasks with
File-System-Based Agents](https://arxiv.org/abs/2602.01566) (Zhu et al., ACL
2026). It supports the Deep Research direction tracked in
[issue #566](https://github.com/maka-agent/maka-agent/issues/566).

The reproduction uses the paper's high-level two-stage method:

1. Build a durable knowledge base by archiving raw sources before derived
   evidence notes.
2. Write an outline, source-backed sections, and a final report from that
   durable workspace.

No source code, prompts, or documentation are copied from the paper's reference
repository. The Maka implementation is built independently on Maka's existing
event-ledger and Artifact Store contracts.

## Scope

This slice adds a bounded, inspectable research workspace. It provides:

- an append-only Deep Research event ledger;
- restart-safe projection of objective, scope, stage, round, artifacts,
  checklist, bounded research steps, report sections, checkpoints, and
  completion;
- app-owned Markdown artifacts for raw sources, evidence notes, outlines,
  report sections, the final report, and implementation handoff;
- chunked, integrity-checked artifact reads so a resumed model can recover
  evidence bodies by id without rereading the original source;
- visible Desktop progress for checklist state, inspected files/symbols/URLs,
  worker runs, blockers, artifact counts, and report draft state;
- direct source-artifact references for every derived artifact;
- root-session tools that are available only when the session has the
  `mode:deep_research` label;
- completion invariants that require settled checklist items, all required
  report sections, an archived source, a final report, and a structured
  handoff.

Search-provider selection, browser automation, ranking, automatic citation
formatting, and long-running scheduling remain separate concerns. The workspace
records local and web substeps but does not silently broaden their permissions.

## Authority and data flow

The research event ledger is the authority for workflow state and
relationships. The Artifact Store is the authority for large bodies. The
existing Task Ledger remains the authority for tasks; checkpoints only link to
task ids.

```text
Deep Research root session
        |
        +-- deep_research_* tools
                |
                +-- sessions/<session>/deep-research/events.jsonl
                |      objective, checklist, steps, sections, refs, completion
                |
                +-- artifacts/
                       raw sources, notes, outline, sections, report, handoff
```

Every mutation includes available run, turn, and tool-call references. The
event is projected and validated before it is appended. Corrupt JSONL fails
closed instead of returning a partial workspace.

## Tool protocol

The root Deep Research agent follows this sequence:

1. `deep_research_start`
2. `deep_research_save_artifact` with `role=source` for each important raw
   source and its inspectable locator
3. derived evidence artifacts with direct `source_artifact_ids`
4. `deep_research_record_step` after each bounded local or web substep,
   recording roots/queries, ignored paths, stopping condition, inspected refs,
   worker ids, evidence, and blockers
5. `deep_research_update_checklist` as each required area progresses
6. `deep_research_checkpoint` after meaningful rounds and before compaction
7. `deep_research_status` after interruption or restart, followed by
   `deep_research_read_artifact` for only the evidence bodies needed to resume
8. five source-backed report sections, each explicitly drafted or completed
9. final `role=report` and `role=handoff` artifacts
10. `deep_research_complete` with implementation tasks, recommended issues
    and/or pull requests, and verification commands

Mutation retries are idempotent by tool-call id. Exact replays return the
existing projection; reusing the same tool-call id with different start,
artifact, checklist, step, checkpoint, or completion input fails closed.
Save-artifact ids also derive from session, turn, and tool-call ids. If ledger
validation fails after an artifact body was created, the artifact is rolled
back.

## Read-only implementation handoff

Completion does not change the research session's permission mode. The Desktop
surface states that the original session remains read-only and offers an
explicit **continue in a new task** action. That action:

1. creates a normal, unlabeled task;
2. builds a bounded prompt from the structured handoff and provenance ids;
3. fills the composer without sending it; and
4. asks the implementation task to inspect current code and present a plan
   before modifying project files.

The user therefore chooses the mode transition and still reviews the seeded
prompt before any model call or project write.

## Safety boundary

Deep Research still uses the `explore` permission profile. The new tools are a
narrow exception for writes into Maka-owned state only. They do not expose a
general filesystem path and cannot edit the user's project. Ordinary sessions
and child agents do not receive these tools.

Status and artifact text are secret-redacted and strip forged workspace
envelope tags before they are returned to the model. Artifact reads verify
session ownership, live state, source type, and the SHA-256 hash recorded in the
ledger.

## Verification

The focused tests cover:

- happy-path two-stage projection and completion;
- rejection of evidence without archived source references;
- monotonic rounds and stages;
- checklist evidence and completion gates;
- bounded local/web steps with inspected refs, worker ids, and stopping
  conditions;
- required report-section and structured-handoff gates;
- restart recovery from append-only JSONL;
- idempotent checkpoint and completion retries;
- rejection of conflicting input under a replayed tool-call id;
- integrity-checked chunked artifact recovery;
- corrupt-ledger fail-closed behavior;
- runtime schema checks, retry idempotency, and safe status rendering;
- Desktop root-session label gating, live progress IPC/UI wiring, server-rendered
  progress component coverage, and explicit read-only-to-implementation handoff.

Run:

```sh
npm --workspace @maka/core test
npm --workspace @maka/storage test
npm --workspace @maka/runtime test
npm --workspace @maka/desktop test
```
