# Expert Teams (star orchestrator→worker)

Expert teams let a **lead** persona fan a task out to specialist **member** experts,
each running as a tool-scoped child agent, then synthesize their results. It is the
star topology reverse-engineered from WorkBuddy's `team` experts and QoderWork's
sub-agent pipelines (see [expert-team-implementation.md](archive/expert-team-implementation.md)),
rebuilt entirely on Maka's existing child-agent machinery — no new orchestration
engine, no mesh mailbox, no shared task board.

## Model

- **Capability archetype** — one of the built-in agent profiles (`local_read`,
  `web_research`, `implementation`) in [`agent-catalog.ts`](../packages/runtime/src/agent-catalog.ts).
  It fixes the tool set, permission mode, category policy, and workspace contract.
- **Expert** (`ExpertDefinition`) — a persona that runs *under* an archetype. It may
  **narrow** (never widen) the archetype's tools to a subset. So an expert can never
  exceed the policy of the archetype it runs under — this is stricter than either
  competitor and keeps Maka's permission-safety invariant.
- **Expert team** (`ExpertTeamDefinition`) — a lead persona (runs as the main session)
  plus N dispatchable members. Members never talk to each other; all coordination goes
  through the lead.

Definitions live in [`expert-catalog.ts`](../packages/runtime/src/expert-catalog.ts).
Each member materializes into an ordinary `AgentDefinition` with a deterministic id
`expert:<teamId>:<memberId>`, so the existing child-turn machinery (tool scoping,
permission gating, worktree fail-closed) runs it unchanged, and a spawn resolves
statelessly from the id alone.

## Runtime flow

1. A session labeled `mode:expert-team:<teamId>` (constant `EXPERT_TEAM_LABEL_PREFIX`
   in [`@maka/core`](../packages/core/src/expert-team.ts)) activates:
   - the **lead system-prompt fragment** (`buildExpertTeamLeadSystemPromptFragment`) —
     the orchestrator persona, the member roster, the dispatch protocol, and the
     fan-in discipline; slotted into the desktop system prompt next to Deep Research.
   - the **`expert_dispatch` tool** (`buildExpertDispatchTool`) — a team-bound tool
     whose `member` param is a closed enum of the team's members.
2. The lead calls `expert_dispatch({ member, task })`. To run members concurrently it
   emits several calls in one turn — the runtime executes concurrent child spawns
   (distinct child turns, no shared mutex; bounded by `MAX_ACTIVE_SUBAGENT_TOOLS_PER_TURN`).
3. Each dispatch resolves the member's materialized `AgentDefinition` and spawns it via
   the same `spawnChildAgent` capability `agent_spawn` uses. The child gets the member's
   scoped tools + composed system prompt; a read-only archetype means the member
   physically cannot write.
4. **Fan-in** is the child result's bounded `summary` plus `artifactIds` pointers —
   members return digests, not raw payloads. The lead synthesizes one ranked result.

Members never receive `expert_dispatch` (child turns are gated in the backend factory),
so there are no nested teams.

## Definition resolution

`spawnChildAgent` / `startChildTurn` resolve a spec id through
`requireResolvedAgentDefinition` (`getBuiltinAgentDefinition(id) ?? getExpertAgentDefinition(id)`),
so a child id can be a built-in agent or an expert member. Built-in ids keep their
original error messages; unknown expert ids get an expert-specific error.

## Built-in team

**Code Review Team** (`code-review`) — a read-only review crew (all `local_read`,
tools `Read`/`Glob`/`Grep`), so it runs within current capabilities (no worktree
executor needed):

- lead: scopes the change, dispatches reviewers, merges into one ranked review.
- `correctness-reviewer` — logic errors, edge cases, races, broken invariants.
- `simplification-reviewer` — duplication, dead code, reuse opportunities.
- `test-coverage-reviewer` — untested paths and missing cases.

## Starting a team session

The feature is reachable through a main-process IPC / preload bridge:

```ts
// list the built-in teams (id, name, description, members)
const { teams } = await window.maka.expertTeam.list();

// start a team session; creates a session labeled mode:expert-team:<teamId>
// in read-only (explore) mode and optionally sends the first message
const result = await window.maka.expertTeam.start({ teamId: 'code-review', prompt: 'Review the current diff.' });
// → { ok: true, sessionId } | { ok: false, reason: 'unknown_team' | 'setup_required' | 'send_failed', ... }
```

Any session carrying the label is a fully functional team lead — the label is the only
special state.

## Scope / follow-ups

Shipped: the runtime engine (catalog, resolver, dispatch tool, lead fragment), desktop
prompt + tool wiring, the start/list IPC + preload + typings, and unit tests across
core / runtime / desktop-main.

Deliberately deferred (documented, not built): a renderer team-picker panel; mesh
"Agent Teams" (member↔member `SendMessage`, shared self-claiming task board);
worktree-isolated writing members (fail-closed today); a remote expert marketplace;
and the digital-colleague / IM / cloud layer.
