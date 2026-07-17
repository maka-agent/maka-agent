# Expert Teams (lead/member collaboration)

Expert teams let a **lead** persona fan a task out to specialist **member** experts,
each running as a tool-scoped child agent, then synthesize their results. The runtime
keeps the lead as the final adjudicator while adding a bounded, durable mailbox and
atomic self-claim over Maka's existing Task Ledger. It is rebuilt on Maka's existing
child-agent machinery rather than introducing a second orchestration engine (see
[expert-team-implementation.md](archive/expert-team-implementation.md)).

## Model

- **Capability archetype** — one of the built-in agent profiles (`local_read`,
  `web_research`, `implementation`) in [`agent-catalog.ts`](../packages/runtime/src/agent-catalog.ts).
  It fixes the tool set, permission mode, category policy, and workspace contract.
- **Expert** (`ExpertDefinition`) — a persona that runs *under* an archetype. It may
  **narrow** (never widen) the archetype's tools to a subset. So an expert can never
  exceed the policy of the archetype it runs under — this is stricter than either
  competitor and keeps Maka's permission-safety invariant.
- **Expert team** (`ExpertTeamDefinition`) — a lead persona (runs as the main session)
  plus N dispatchable members. Members can exchange bounded direct messages and
  broadcasts within one team run. They may claim one eligible shared Task Ledger item
  atomically, but the lead retains completion and result-adjudication authority.

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
   scoped capability tools plus `team_message`, `team_inbox`, `team_task_list`, and
   `team_task_claim`; a read-only archetype still cannot write files or use the network.
4. Messages are appended to `sessions/<sessionId>/agent-mailbox.jsonl`, scoped by team
   and parent lead `AgentRun`. Sender `AgentRun`/turn attribution comes from trusted
   runtime context; named recipients resolve through the trusted team roster to stable
   role addresses. Cursor reads make polling bounded and deterministic.
5. A member may use `team_task_claim` to atomically claim one pending/blocked task
   owned by the current parent lead `AgentRun`. Tasks from ordinary or older lead runs
   are not discoverable or claimable. Conflicting claims fail closed; members receive
   no general task mutation or completion tool.
6. **Fan-in** is the child result's bounded `summary` plus `artifactIds` pointers —
   members return digests, not raw payloads. The lead synthesizes one ranked result.
   A completed child outcome leaves its claimed task `in_progress` as evidence for lead
   review; failed, cancelled, and permission-waiting outcomes settle through the existing
   Task Ledger outcome contract.

Members never receive `expert_dispatch` (child turns are gated in the backend factory),
so there are no nested teams.

### Role mailbox and cursor semantics

Direct-message recipients are role addresses within one parent lead `AgentRun`, not
individual child invocations. The lead uses the stable `lead` address; each member uses
its deterministic `expert:<teamId>:<memberId>` agent id. Repeated or concurrent
dispatches of the same member therefore share one role mailbox. This supports durable
handoff between invocations, but it is not an invocation-private channel.

`team_inbox` cursors are caller-owned. The store does not persist a read cursor for a
role or child invocation: callers pass the last observed `nextSeq` back as `after_seq`.
A fresh invocation that omits `after_seq` reads the role's available history from the
start of the current lead run, including direct messages observed by an earlier
invocation of that member. A new parent lead `AgentRun` starts a separate mailbox scope.
Use distinct expert member roles when work requires separate direct-message inboxes.

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

Shipped in the collaboration slice: a durable per-session/team-run mailbox, bounded
role-addressed direct messages and broadcasts, trusted sender AgentRun/Turn
attribution, caller-owned inbox cursors, and atomic
self-claim of one eligible shared Task Ledger item per child turn. Mailbox history is
reloaded from its append-only log after process restart; corruption fails closed, and
new lead runs do not silently inherit messages from an older run.

Deliberately deferred (documented, not built): automatic message wake/injection (members
poll `team_inbox`); detached or cross-machine member lifecycles; a renderer team-picker
panel; worktree-isolated writing members (fail-closed today); a remote expert marketplace;
and the digital-colleague / IM / cloud layer.
