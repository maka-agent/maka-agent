# 02 — Alma Sprint Harness: Planner → Generator → Evaluator autonomous build loop

> Source-grounded against `~/Downloads/alma-re/readable/main.js`.
> Round-2 [`07-subagent-orchestration.md`](../alma-deep-dive-yuejing-round-2/07-subagent-orchestration.md)
> mentioned harness mode in the Task tool description but never
> traced it. This note covers the full pipeline triggered by
> `handoff.harness.enabled: true`: planner produces a sprint plan
> with verifiable criteria, generator builds each sprint, and a
> SEPARATE evaluator agent adversarially verifies.

## Why a harness

Single-shot code generation collapses on multi-feature requests:
the agent loses the thread, declares premature victory, or
generates code that "looks right" but doesn't run. The Task
tool's system prompt at `main.js:22269` is explicit about
**when** to use harness:

> When the user asks you to **build a complete application,
> feature, or multi-component system** — NOT a simple code
> change or single file edit — you should automatically enable
> the sprint harness by setting `handoff.harness.enabled: true`.
> The harness orchestrates a Planner → Generator → Evaluator
> loop that produces higher-quality results for complex work.
>
> **When NOT to use harness:**
> - Simple code changes, bug fixes, single-file edits
> - Research or exploration tasks
> - Quick questions or configuration changes

The user does NOT see "harness" terminology in the UI. The
internal-only mention is `IMPORTANT: When using the sprint
harness (option 3), do NOT mention "harness", "sprints",
"contracts", or "evaluator" to the user. These are internal
implementation details.`

## 4 DB tables

`main.js:336-410` declares the harness schema:

```typescript
agent_missions: {
  …
  harnessMode: text("harness_mode"),        // 'sprint-harness' when active
  currentSprintId: text("current_sprint_id"),
  currentPhase: text(...)                    // 'planning'|'building'|'evaluating'|...
  maxIterations: int(...)                    // default 5 — per-sprint retry cap
  specArtifactPath: text(...)
}

agent_runs: {
  …
  harnessRole: text("harness_role").$type(), // 'planner'|'generator'|'evaluator'
  sprintId: text("sprint_id"),
}

mission_sprints: {
  id, missionId, sprintNumber, title, description,
  agentId,                                   // assigned specialist
  status: 'pending'|'building'|'evaluating'|'passed'|'failed',
}

sprint_contracts: {
  id, sprintId,
  version: int (default 1),                  // contract evolution if negotiated
  criteria: text,                            // JSON [{id, description, threshold, weight}]
  negotiationLog: text?,
  status: 'draft'|'accepted'|...,
}

sprint_evaluations: {
  id, sprintId, contractId,
  attemptNumber: int (default 1),
  generatorRunId, evaluatorRunId,
  grades: text,                              // JSON [{criterionId, passed, score, feedback}]
  overallPassed: int (default 0),
  feedbackSummary: text?,
}
```

The split:
- **mission_sprints** = WHAT to build (one row per sprint)
- **sprint_contracts** = HOW TO TELL IT'S DONE (acceptance criteria with thresholds)
- **sprint_evaluations** = ATTEMPTS at completion (multiple per sprint until passed or max attempts)

## Filesystem artifact layout

Beyond the DB, harness writes a structured workspace:

```
{missionDir}/
├── spec.md                          # planner's human-readable spec
├── sprints.json                     # planner's machine-readable sprint plan
└── sprints/
    └── sprint-N/
        ├── generator-output.md      # generator's final report (per attempt)
        └── evaluation-M.json        # evaluator's grades (per attempt)
        └── evaluation.json          # canonical (latest) evaluation
```

`spec.md` is **explicitly for human review** — `main.js:22037`
formats the planner's markdown summary and stores it as the
mission's `specArtifactPath`. `sprints.json` is the contract
the generator + evaluator agree on.

## Phase 1 — Planner

Triggered at `main.js:22002-22066`. The planner is a
`subagentType: "Plan"` (round-2 07's Plan specialist) +
`agentProfileId: "planner"` + `harnessRole: "planner"`.

Prompt skeleton (`main.js:22012`):

> You are a strategic product planner. Your job is to take a
> user's brief and produce a comprehensive product specification
> with a sprint plan.
>
> ## Instructions
> 1. Analyze the brief and identify all features, requirements,
>    and implicit needs.
> 2. Design a high-level technical architecture (stack choices,
>    data flow, key components).
> 3. Break the work into 3-10 focused sprints, ordered by
>    dependency and priority.
> 4. Each sprint should be a self-contained increment that can
>    be built and tested independently.
> 5. Look for opportunities to weave AI-powered features into
>    the product where they add genuine value.
> 6. You may use Glob and Read to explore the existing codebase,
>    and WebSearch/WebFetch for external research if needed.

The output MUST be a **JSON array of sprint objects** at
`{missionDir}/sprints.json`. Each sprint has an `agent_id` field
assigning the best-fit specialist, plus a `criteria` array:

```json
{
  "number": 1,
  "title": "Short sprint title",
  "description": "What this sprint delivers and why it comes at this position",
  "agent_id": "developer",
  "criteria": [
    {
      "id": "c1",
      "description": "Concrete, testable acceptance criterion",
      "threshold": 80,
      "weight": 2
    }
  ]
}
```

Criteria rules (verbatim from prompt):
- 3-7 criteria per sprint
- Each must be verifiable with tools (shell commands, file
  reads, HTTP requests)
- Focus on observable behavior, not implementation details
- Threshold: minimum score (0-100) to pass. Use 70-80 for most
  criteria.

If the planner doesn't write `sprints.json`, harness throws and
the mission fails. `main.js:22029-22031`:

```js
throw new Error(
  `Planner did not write sprints.json to ${i}. Ensure the planner agent uses the Write tool.`,
);
```

After parse, the planner-output sprints are written into the DB
via `createMissionSprint` (one row per item).

## Phase 2 — Generator

`main.js:21745-21767`. Generator is `subagentType: "coder"` +
`harnessRole: "generator"` + `agentProfileId: <sprint.agentId or
"developer">`. So if the planner assigned `agent_id:
"designer"`, the generator runs as the designer specialist.

For each sprint, generator runs up to `maxIterationsPerSprint`
attempts (default 5). The generator output goes to
`{missionDir}/sprints/sprint-N/generator-output.md` (per
attempt).

If `c.success === false`, harness throws:

```js
throw new Error(
  `Generator failed on Sprint ${t.sprintNumber} attempt ${o}: ${c.error}`,
);
```

But success at the agent-loop level doesn't mean "sprint
passed" — that's evaluator's call.

## Phase 3 — Evaluator (the adversarial pass)

`main.js:21769-21900`. Evaluator is `subagentType:
"general-purpose"` + `harnessRole: "evaluator"` +
`agentProfileId: "evaluator"`. **Deliberately a DIFFERENT
specialist from the generator** — the prompt at
`main.js:21786-21810` is unusually emphatic:

> You are SEPARATE from the generator that built this. Your job
> is to be constructively critical.
> Models tend to over-praise their own work — you exist to
> provide an honest, evidence-based assessment.
> Do NOT trust claims from the generator output. Verify
> everything yourself.
>
> ## Evaluation Process
> For EACH criterion:
> 1. Read the relevant code, files, or configuration
> 2. Run at least one verification command (test, curl, grep, etc.)
> 3. Document what you found as concrete evidence
> 4. Score from 0-100 based on completeness and correctness
> 5. Mark as passed ONLY if score >= threshold
>
> ## Rules
> - Empty evidence = automatic FAIL (score 0)
> - "Looks like it works" without a command = FAIL
> - Partial implementation = partial score (proportional to
>   completeness)
> - A criterion either passes its threshold or it fails — no
>   rounding up
> - If you cannot verify a criterion (e.g., server not running),
>   score it 0 and explain why

The rules forbid the most common evaluator failure modes:
- **"Looks like it works"** → must run a command.
- **Empty evidence** → automatic 0.
- **No rounding up** → 79 with threshold 80 = fail.

Output is a JSON file at
`{missionDir}/sprints/sprint-N/evaluation-M.json`:

```json
{
  "grades": [
    { "criterionId": "c1", "passed": true, "score": 90,
      "feedback": "Evidence: ran npm test, 12 tests passed" },
    { "criterionId": "c2", "passed": false, "score": 30,
      "feedback": "Evidence: /api/posts returns 404" }
  ],
  "overallPassed": false,
  "feedbackSummary": "1-3 sentence summary of what needs to change"
}
```

`overallPassed` defaults to `grades.every(g => g.passed)` if not
provided. The harness reads this file, persists into
`sprint_evaluations`, and either:
- All passed → sprint succeeds, move to next sprint
- Some failed → retry generator with the feedback (up to
  `maxIterationsPerSprint`)

If evaluator didn't write the file at all
(`main.js:21879-21886`), all criteria default to `passed: false`
with feedback "Evaluator did not write evaluation file." Sprint
fails immediately, not retried. Hard failure.

## Phase 4 — Outer loop + halt-on-fail

`main.js:22068-22082`:

```js
for (const sprint of sprints) {
  if (abortSignal.aborted) break;
  const result = await Ip(mission, sprint, sprint.rawCriteria, maxIter, signal);
  results.push({sprint, ...result});
  if (!result.passed) {
    vp(mission, "failed",
       `Sprint ${sprint.sprintNumber} failed after ${result.attempts} attempts. Halting.`);
    break;
  }
}
```

**Halt on first failed sprint.** Don't try sprint 3 if sprint 2
couldn't pass after 5 attempts — likely upstream architecture is
wrong, continuing would compound errors.

## Per-sprint retry inner loop

`Ip` at line earlier — for each sprint:

```
for attempt in 1..maxIterationsPerSprint:
  generator-output = generator(sprint, attempt, previous_feedback?)
  if !generator.success:
    write attempt failure log
    continue (or hard-fail depending on error type)
  evaluation = evaluator(sprint, attempt, generator-output)
  if evaluation.overallPassed:
    mark sprint passed
    return {passed: true, attempts: attempt}
sprint.status = "failed"
return {passed: false, attempts: maxIter}
```

The retry feeds the previous evaluator's feedback BACK into the
generator on the next attempt. Round-trip the failed criteria so
generator knows what to fix.

## `writeBack` modes — how output threads back into the parent

`main.js:1738-1742`:

```js
"artifact" === e?.writeBack ||
"decision" === e?.writeBack ||
"patch" === e?.writeBack ||
"summary" === e?.writeBack
  ? e.writeBack
```

Four `writeBack` modes for what the harness sends back to the
calling agent (the one that invoked Task with harness):

| Mode | Meaning |
|---|---|
| `artifact` | "Output is in `{missionDir}/`" — parent points user there |
| `patch` | Diff to apply to parent's workspace |
| `summary` | Just a text summary, no files |
| `decision` | Yes/no answer — used when harness is used as a complex evaluator |

Sprint Harness typically uses `artifact` (the example in the
Task tool description shows this). The parent agent then says
"Built a blog system — see {missionDir}/spec.md and code."

## Anti-pattern handling

`main.js:21984`:

```js
return (To.updateMissionSprint(t.id, { status: "failed" }),
  { passed: false, attempts: o });
```

When a sprint can't pass after max attempts, the row is marked
failed and the harness reports back to the user. The DB
persists the failed state — user can manually inspect
`{missionDir}/sprints/sprint-N/evaluation-*.json` to see what
the last attempts looked like.

## What Maka has today

Maka has no harness mode. Task subagents are single-shot. No
mission tracking. No sprint contracts. No evaluator.

## Ranked Maka improvements

1. **Steal the evaluator-is-separate pattern even without
   full harness.** When the agent claims "tests pass", spawn
   a fresh subagent to actually run them. The "models
   over-praise their own work" principle applies universally
   — adversarial verification is the quality lever.

2. **Acceptance criteria with thresholds at task creation.**
   Even outside the harness, "tell the agent what GOOD looks
   like" is a huge lift. `criteria: [{description, threshold,
   weight}]` is a 5-field convention any agent can carry.

3. **Halt on first failed phase.** Compounding errors across
   sprints is the trap of multi-step generation. The Sprint
   Harness "stop after first failure" rule transfers to any
   pipeline.

4. **Per-attempt artifacts + retry-with-feedback.** The
   `generator-output.md` per attempt + feedback-into-next-
   prompt pattern is the AUTOPILOT version of how a human
   debugs. Cheap to implement, big behavior payoff.

5. **`writeBack` mode discipline.** When Maka adds subagent
   delegation, deciding UPFRONT whether the output is a patch
   (apply to parent) vs artifact (point user) vs summary (text
   only) avoids the "wait, what do I do with this?" parent
   confusion.

## Open questions for future rounds

- The `sprint_contracts.negotiationLog` column hints that
  criteria can be NEGOTIATED — by whom? Generator pushing
  back? User editing mid-build? Not surfaced in this trace.
- `sprint_contracts.version` defaults to 1 and is an int —
  what bumps it? Re-planning after a failed sprint?
- The planner is allowed to use Glob/Read on the existing
  codebase. Does it have safety rails — can it Glob the user's
  whole home directory, or is it workspace-scoped?
- `maxIterationsPerSprint: 5` is the default. Does the user
  see this and can they adjust? Mission failures cost API
  budget — letting users tune the retry cap matters.

## Cross-refs

- Round 2: [`07-subagent-orchestration.md`](../alma-deep-dive-yuejing-round-2/07-subagent-orchestration.md)
  — the Task tool subagent system harness uses. The 7
  specialist roster + `coder`/`Plan` types here.
- Round 3: [`04-permissions-runtime-risk.md`](../alma-deep-dive-yuejing-round-3/04-permissions-runtime-risk.md)
  — harness sprints spawn subagents whose tool calls hit
  bypass channel 2 (`metadata.isSubagent` autoApprove).
- Round 4: [`05-workspace-switching.md`](../alma-deep-dive-yuejing-round-4/05-workspace-switching.md)
  — `autoWorktree` workspaces are a natural pair: each sprint
  on its own worktree, easy to discard if failed.
- Round 5: [`01-acp-bridge.md`](./01-acp-bridge.md) — generator
  could be running ACP (Claude Code / Codex) as the coder
  agent. The same harness + ACP combo is alma's flagship.
