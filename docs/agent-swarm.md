# Agent Swarm

Agent Swarm is Maka's bounded foreground fan-out for independent child work. The
main Agent plans the batch, calls `agent_swarm` once, waits for every settled
item, and remains responsible for semantic synthesis.

It is intentionally a structured-concurrency convenience over existing child
`AgentRun`s, not a workflow runtime:

- every started item is an ordinary child `AgentRun`;
- the parent tool result is an ordered projection over those child facts;
- there is no `SwarmRun`, second event ledger, checkpoint, or background owner;
- child toolsets exclude `agent_swarm`, so batches cannot nest.

## Choosing the execution model

| Need | Prefer | Why |
| --- | --- | --- |
| One small task or tightly coupled reasoning | Main Agent directly | Delegation overhead would exceed the useful parallelism. |
| One specialist result, or the next task depends on the previous result | `agent_spawn` sequentially | The dependency is explicit and each result can refine the next prompt. |
| Several finite, independent items with one final synthesis | `agent_swarm` | Bounded worker-pool execution, stable ordered results, and isolated failures. |
| Durable ownership, task claiming, or worker communication | Agent Team | Members have roles, mailbox collaboration, and Task Ledger coordination. |
| DAG dependencies, retries, resume, dynamic expansion, or distributed execution | Rive | Workflow state and recovery need a durable orchestration authority. |

The main Agent should call Swarm deliberately. The runtime does not infer that a
request is parallelizable and does not automatically fan work out.

## Contract

One call accepts `1..32` items. Local concurrency defaults to `3` and is capped
at `5`. The entire input is validated before any child starts. Results retain
input order even when children finish out of order.

Three separate concurrency boundaries remain observable:

1. **Subagent tool admission** limits how many subagent tool calls the model may
   open in one turn.
2. **Local Swarm concurrency** limits workers claimed inside one batch.
3. **Shared child-run permits** cap real child executions across
   `agent_spawn`, `expert_dispatch`, and `agent_swarm`.

Partial child failure does not erase successful siblings. Parent cancellation
signals active children, prevents locally queued items from starting, joins
active work, and returns explicit cancelled rows for both started and
never-started items.

## Presentation and evidence

Desktop and CLI project the same settled `agent_swarm` result:

- aggregate status and completed/failed/cancelled counts;
- bounded per-item summaries;
- child status, profile, duration, failure class, and artifact count;
- real child `runId` and `turnId` references for inspection.

The presentation never copies child prompts, tool arguments, or raw child tool
output. Desktop summaries are bounded per row, the card is scroll-bounded, and
CLI output has per-item and aggregate character caps.

Tool telemetry stores only a bounded result summary: result kind/status, item
counts, started count, and artifact count. Run trace events reuse the existing
parent `AgentRun` diagnostic stream and identify these boundaries with stable
data fields:

| Evidence | Trace data |
| --- | --- |
| Tool-call admission rejection | `boundary: subagent_tool_admission` |
| Local item queued or started | `swarmStage: item_queued` / `item_started`, `boundary: local_swarm_concurrency` |
| Waiting for shared capacity | `boundary: shared_child_run_permit`, `stage: waiting` |
| Real child execution | `boundary: child_run_execution`, `stage: started` / `completed` |
| Settled batch | `swarmStage: batch_completed` plus the aggregate projection |

These are diagnostic projections only. Child `AgentRun`s and their artifact
references remain the lifecycle and evidence authority.

## Example: review fan-out and synthesis

For a cross-cutting change, the main Agent can create independent review items:

```ts
agent_swarm({
  items: [
    {
      item_id: "runtime",
      profile: "local_read",
      task: "Review concurrency and cancellation invariants."
    },
    {
      item_id: "presentation",
      profile: "local_read",
      task: "Review bounded UI and CLI result presentation."
    },
    {
      item_id: "tests",
      profile: "local_read",
      task: "Review regression coverage and identify missing cases."
    }
  ],
  max_concurrency: 3
})
```

After the batch settles, the main Agent should compare the three summaries,
inspect referenced child runs when evidence conflicts, deduplicate overlapping
findings, rank them by severity, and produce one coherent review. Swarm owns
finite execution and settlement; the main Agent owns judgment.
