# 07 — Reference app subagent orchestration (Task / TaskOutput / harness)

> Source-grounded against `~/Downloads/reference-source/readable/main.js`.
> Round 2 of yuejing's deep-dive. Cross-refs round-2
> [`06-tool-routing.md`](./06-tool-routing.md) — the same `Task` tool
> is the dispatch point both routers funnel into.

## Punchline

Reference app's subagent system is **not** just "spawn an agent and wait." It
has SIX distinct dimensions Maka should converge to:

1. Two dispatch modes: `subagent_type` (raw lane) vs `agent_id`
   (managed specialist profile).
2. A built-in roster of 7 named specialists.
3. Resume-by-id (full prior context preserved).
4. Foreground + background execution + TaskOutput for retrieval.
5. **Sprint harness mode**: an automatic Planner → Generator →
   Evaluator loop for complex builds.
6. Structured handoff packet (goal / deliverable / constraints /
   writeBack).

The full Task tool description is ~5,000 chars at
`main.js:22269` — it's a *training* document, not just a tool
schema. The verbose examples teach the calling model HOW to pick
between modes.

## 1. Dispatch modes

`main.js:22269` (Task tool description):

> You can invoke agents in two ways:
> - `subagent_type`: pick a raw execution lane such as coder or Plan
> - `agent_id`: pick a managed specialist profile configured in Reference app;
>   the runtime maps it to the right execution lane and injects the
>   role brief

The `agent_id` route is the user-extensible layer. Users can
configure new specialists with their own `focus`, `delegatesTo`,
and `executionMode` (visible at `main.js:20335-20367` where the
agent registry is described to the model). The runtime maps the
profile to one of the raw lanes.

## 2. Built-in specialist roster

From `main.js:22269`:

| Subagent type | Purpose | Tools |
|---|---|---|
| `general-purpose` | Multi-step research, multi-step tasks | * (all) |
| `statusline-setup` | Configure macOS status line | Read, Edit |
| `Explore` | Codebase search (`quick`/`medium`/`very thorough` thoroughness) | All |
| `Plan` | Software architect — design implementation plans | All |
| `app-guide` | Answer questions about Reference app itself | Glob, Grep, Read, WebFetch, WebSearch |
| `coder` | Write/fix/refactor code | Bash, Glob, Grep, Read, Edit, Write, Skill |
| `app-operator` | Read/modify Reference app config (settings, providers, models) via local API | Bash, Read |

Notice `app-guide` and `app-operator` are **self-referential** —
agents that read/modify the host app's own state. This is how reference app
exposes "set my theme to dark" or "what's my current model?" as
natural-language operations. Maka has no equivalent; the renderer
side handles these directly via Settings UI.

## 3. Resume pattern

`main.js:22269`:

> Agents can be resumed using the `resume` parameter by passing the
> agent ID from a previous invocation. When resumed, the agent
> continues with its full previous context preserved.

Useful when the same agent will be poked multiple times in a
conversation — e.g., `app-guide` answering follow-ups. The agent
record includes its full prior context, so the calling model can
write concise follow-ups instead of re-describing everything.

## 4. Foreground vs background

> You can optionally run agents in the background using the
> `run_in_background` parameter. … you will need to use TaskOutput
> to retrieve its results once it's done. You can continue to work
> while background agents run.

This pairs cleanly with the
[`05-bash-tool-family.md`](./05-bash-tool-family.md) Bash
background pattern — same `run_in_background` semantics for tools
and for entire agents. The pre-loop selector (round-2
[`06-tool-routing.md`](./06-tool-routing.md)) is taught to pair
`Task` with `TaskOutput` always.

## 5. Sprint harness mode

This was the biggest find on this dive. From `main.js:22269`:

> When the user asks you to **build a complete application, feature,
> or multi-component system** — NOT a simple code change or single
> file edit — you should automatically enable the sprint harness by
> setting `handoff.harness.enabled: true`. The harness orchestrates
> a Planner → Generator → Evaluator loop that produces higher-
> quality results for complex work.

Activation heuristics (the model is taught to recognize them):
- User says "build me a …", "create an app that …", "make a …
  system"
- The request involves 3+ features or touches multiple files
- The work would naturally decompose into multiple sprints

Hard rules:
- "The user does NOT need to know about harness, sprints, or
  contracts — these are internal implementation details."
- When harness is enabled, NEVER `run_in_background: true` — the
  user must see the long-running orchestration stream live.

Maka has nothing like this. The closest is xuan's "task plan"
flow, but it's user-visible and one-shot. The reference app harness is an
**implicit** loop the calling agent activates when it senses the
task is large enough.

## 6. Handoff packet shape

Two examples from `main.js:22269`:

```json
// Simple delegation
{
  "agent_id": "developer",
  "description": "Fix login bug",
  "prompt": "Fix the login button that doesn't respond on click.",
  "handoff": {
    "goal": "Fix the login button click handler.",
    "deliverable": "Working login button with proper event binding.",
    "writeBack": "patch"
  }
}

// Complex build (harness auto-activated)
{
  "agent_id": "product-manager",
  "description": "Build blog system",
  "prompt": "Build a blog system with markdown support, comments, and RSS feeds.",
  "handoff": {
    "goal": "Build a complete blog system.",
    "deliverable": "A working blog application with all requested features.",
    "constraints": ["MVP first", "Clean architecture"],
    "writeBack": "artifact",
    "harness": { "enabled": true }
  }
}
```

Fields:
- `goal`: what the subagent should accomplish
- `deliverable`: shape of the expected output
- `constraints`: optional list of guardrails
- `writeBack`: how the parent should incorporate the result (`patch`
  for a code diff, `artifact` for a standalone build, …)
- `harness.enabled`: flip for complex multi-sprint work

The Task tool description explicitly warns:

> handoff must be literal JSON. Never emit placeholder syntax like
> `<parameter name="goal">…</parameter>`, and never wrap arrays
> such as constraints in quotes.

This is a hard-won lesson from training — the model HAS been
trained to recognize the `<parameter>` syntax from some other
context, and reference app has to anti-prompt it explicitly.

## What Maka does today

Maka has subagent plumbing but no harness layer:
- A subagent registry exists (`packages/runtime/src/agents/`).
- Renderer surfaces TaskCreate / TaskUpdate / TaskList as Maka tools
  for tracking todo state — different from reference app's Task (which
  spawns an agent).
- No `resume`, no `run_in_background`, no harness.

Ranked Maka improvements:

1. **Adopt reference app's Task / TaskOutput / TaskStop tool family.** This
   is the single biggest architectural delta. Currently Maka's
   agents only ever run foreground and can't be parallelized via
   the model — they'd have to be spawned by user actions.

2. **Add resume-by-id.** Useful even before harness lands. The
   model writes "investigate the issue we discussed earlier" and
   the registry pulls the prior context.

3. **Build the handoff packet shape into the renderer's agent
   start UI.** Even if not exposed to the model, having
   goal/deliverable/constraints as first-class structured fields
   makes user-spawned agents clearer.

4. **Add `app-guide`-equivalent specialist.** A "Maka guide"
   subagent that answers "how do I configure X?" by reading
   Settings + the Maka docs. Easy ROI; only needs Read+Grep+Glob.

5. **Defer harness mode**. It's a deep capability that pays off
   once Maka is doing legitimate code-generation work. Until then,
   adding the planner→generator→evaluator loop is over-engineering.

## Cross-refs

- Round 1: [`01-agent-loop.md`](../reference app-deep-dive-yuejing-2026-05-31/01-agent-loop.md)
  for the streamText main loop the subagents run inside.
- Round 2: [`05-bash-tool-family.md`](./05-bash-tool-family.md) —
  same `run_in_background` semantics for tools.
- Round 2: [`06-tool-routing.md`](./06-tool-routing.md) — the
  pre-loop selector teaches Task+TaskOutput as a mandatory pair.
