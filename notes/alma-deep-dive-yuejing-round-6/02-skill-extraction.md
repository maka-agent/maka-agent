# 02 — Alma skill extraction: the self-evolution meta-loop

> Source-grounded against `~/Downloads/alma-re/readable/main.js`.
> Round-3 [`01-skills-system.md`](../alma-deep-dive-yuejing-round-3/01-skills-system.md)
> mentioned skill extraction as the meta-loop where alma watches
> its own conversations and codifies them as future skills. The
> prompt was excerpted there. This note traces the trigger logic,
> the double-gate (cumulative + delta), and the condense-then-
> emphasize context shape.

## When it fires

`analyzeAndExtractSkill(threadId, messageId)` (`main.js:59931-
60100+`) runs ASYNC after each agent turn that crosses certain
thresholds. Two gates must both pass:

### Gate 1 — Cumulative tool-call floor

```js
let total = 0;
for (const msg of messages) {
  if (msg.message.parts) {
    for (const part of msg.message.parts) {
      if (part.type === "tool-invocation") total++;
    }
  }
}
if (total < settings.minToolCalls) return; // default minToolCalls: 5
```

A conversation needs ≥5 cumulative tool calls (configurable via
`skillExtraction.minToolCalls`) before extraction is even
considered. Rationale: a workflow worth codifying USES tools —
single Q&A doesn't qualify.

### Gate 2 — Since-last-analysis delta

```js
let lastAnalyzedAt = 0;
for (const msg of messages) {
  if (msg.metadata?.skillExtractionAnalyzed
      && msg.metadata.skillExtractionToolCallCount) {
    lastAnalyzedAt = Math.max(lastAnalyzedAt, msg.metadata.skillExtractionToolCallCount);
  }
}
const delta = total - lastAnalyzedAt;
if (lastAnalyzedAt > 0 && delta < settings.minToolCalls) return;
```

If we ALREADY analyzed at tool-call count N (e.g., 5), we won't
re-analyze until at least 5 MORE tool calls happen (i.e., at
≥10). Prevents the same conversation re-running extraction every
turn after the threshold trips.

The `lastAnalyzedAt` watermark is stored per-message via
`metadata.skillExtractionAnalyzed` + `skillExtractionToolCallCount`.
So extraction state is durable: app restart preserves "we
checked this thread at tool count N."

## Two settings, both with defaults

`main.js:59917-59930`:

```js
const defaults = { enabled: true, minToolCalls: 5 };
return {
  enabled: settings.skillExtraction?.enabled ?? true,
  minToolCalls: settings.skillExtraction?.minToolCalls ?? 5,
};
```

So extraction is ON by default. Privacy escape hatches:
- `enabled: false` disables globally.
- Incognito threads (`main.js:59937-59938`) skip — cross-ref
  round-4 [`03-memory-recall.md`](../alma-deep-dive-yuejing-round-4/03-memory-recall.md)
  pattern of "isIncognito short-circuits every learning-related
  subsystem."

## Context shape: condense-old + show-recent

The conversation context fed to the analyzer (`main.js:59976-
60029`) is **asymmetric**:

```
## Earlier Context (N messages, condensed)
User: <300 chars max>
Assistant: <300 chars max>
[Tool: bash]
...

---

## Recent Conversation (8 messages)
**User:** <3000 chars max>
**Assistant:** <3000 chars max>
**Tool:** bash
...
```

Split point: **last 8 messages get full treatment, earlier get
condensed**.

| Region | Per-message char cap | Format |
|---|---|---|
| Earlier context | 300 | Plain `User: …` / `Assistant: …` / `[Tool: name]` |
| Recent conversation (last 8) | 3000 | Bold-prefixed `**User:**` / `**Assistant:**` / `**Tool:**` |

Total cap: 18000 chars (`main.js:60026-60028`). If the assembled
context exceeds 18k chars, hard truncate with `...(truncated)`.

The asymmetry tells the analyzer **what matters now vs what
matters as background**. Skill workflows usually crystallize at
the END of a successful task — emphasizing the final 8 messages
biases the analyzer toward the "this is the pattern" state.

The bold markdown prefix on the recent section is another
attention cue. Models trained on markdown weight bold-prefixed
content higher.

## Same toolModel pattern as title generation

`main.js:60030-60050` uses identical resolution to title gen
(round-6 [`01-title-generation.md`](./01-title-generation.md)):
- `Pl()` resolves effective tool model.
- `wd(model)` parses `providerId:modelId`.
- `fd(providerId, modelId)` instantiates AI SDK model.
- Silent bail if anything missing.

This is the **third pipeline** (after title gen + memory recall)
using the cheap-and-fast tool model. The architectural lesson:
auxiliary AI pipelines should NEVER use the user's chat model.

## Existing-skills injection

`main.js:60055-60064`:

```js
const allSkills = Yu.getAllSkills();
const existingSkillsBlock =
  allSkills.length > 0
    ? allSkills.map(s => `- ${s.name}: ${s.description}`).join("\n")
    : "(none)";
const systemPrompt = EXTRACTION_PROMPT_TEMPLATE.replace(
  "{existingSkills}", existingSkillsBlock
);
```

The analyzer sees ALL existing skills (`name: description` lines)
in its system prompt. Reason: avoid duplicating capabilities.
The prompt explicitly says:

> If the conversation's workflow overlaps with an existing
> skill, either skip extraction or suggest updating the
> existing one:

Output JSON includes `existingSkillToUpdate: "name" | null` — so
the analyzer can recommend MERGING into an existing skill rather
than creating duplicates. Whether alma actually wires up "update
existing" vs "create new" downstream isn't traced here — both
paths must exist for the field to matter.

## Output JSON contract

`main.js:60067-60083`:

```js
const responseText = (await se({model, system, prompt})).text;
const match = responseText.match(/\{[\s\S]*\}/);  // grab first {...}
if (!match) return null;
const parsed = JSON.parse(match[0]);
return parsed;  // {worthy, skillName, skillDescription, reasoning, existingSkillToUpdate}
```

**JSON salvage pattern**: regex-extract the first `{...}` block
from the model's text response. This tolerates models that wrap
the JSON in markdown code fences or add preamble — common
behavior even when forbidden by prompt.

If no `{...}` exists, return null (extraction fails gracefully).
If JSON parse fails, log + return null.

## Worthy=false path

`main.js:60091-60098`:

```js
if (!result || !result.worthy) {
  console.log(`[SkillExtraction] Not worthy: ${result?.reasoning || "analysis failed"}`);
  progressCallback({stage: "skipped", message: "No reusable patterns found"});
  To.updateMessageMetadata(messageId, watermark);
  return;
}
```

Even when extraction is "not worthy":
1. Log the analyzer's reasoning (debug breadcrumb).
2. Broadcast `skill_extraction_progress` with `stage: "skipped"`
   for the UI.
3. **Stamp the watermark on the message** — `skillExtractionAnalyzed
   = true` and the tool-call count. So gate 2 has a baseline
   for the next re-check.

Critically: the watermark stamps on BOTH worthy AND not-worthy
paths. Otherwise a never-going-to-be-worthy thread would re-run
extraction every turn forever.

## Broadcast events

`main.js:59961-59969`:

```js
const progressCallback = (n) => {
  this.broadcastThreadSync("skill_extraction_progress", {
    threadId, messageId,
    stage: n.stage,           // "analyzing" | "skipped" | other
    message: n.message,
    extractedSkill: n.extractedSkill,
  });
};
```

Renderer can show subtle "analyzing for skill patterns…" hints
without making it the dominant UX. Same `/ws/threads` channel
the rest of the events use (round-4 [`07-websocket-sync.md`](../alma-deep-dive-yuejing-round-4/07-websocket-sync.md)).

## What the prompt teaches

Excerpts from `main.js:60061` (full text was at round-3 01):

> Be VERY selective - most conversations should NOT produce a
> skill.

> EXTRACT when:
> - Multi-step workflow that could be reused
> - Domain-specific procedures with non-obvious steps
> - Tool usage pattern combining multiple tools in a specific way
> - Process the user is likely to repeat
> - Specialized knowledge about a codebase, API, or system

> DO NOT extract when:
> - Simple Q&A or chat
> - One-time situation (e.g., "fix this exact bug")
> - Trivial (1-2 simple steps)
> - Existing skill already covers this adequately
> - Mostly debugging/troubleshooting a specific issue
> - Purely informational

The "VERY selective" is the load-bearing word. Without it
models will gleefully extract every conversation. Repeating the
DO NOT list explicitly counter-conditions common false positives.

## What Maka has today

Maka has no skill system at all (round-3 01 ranked it as a
priority improvement). Even if Maka adds skill loading, the
extraction meta-loop is a separate Phase 2.

## Ranked Maka improvements

1. **Cumulative + delta two-gate trigger.** Even outside skill
   extraction, the pattern generalizes: "run this expensive
   periodic check only when N events accumulated AND ≥N events
   since last check." Examples: auto-save quota tracking,
   memory consolidation, periodic backups.

2. **Condense-old + emphasize-recent context shape.** The
   asymmetric formatting (300 vs 3000 chars, plain vs bold) is
   a generalizable pattern for ANY LLM analyzer that processes
   long conversations. The "where the answer is most likely
   to be" bias helps small models punch above weight.

3. **JSON salvage regex `match(/\{[\s\S]*\}/)`.** When asking
   models for JSON, expect noise. Regex-extract the first
   curly-brace block. Tolerant of code fences, preamble, etc.

4. **Watermark-on-both-paths.** When a periodic check has a
   "no-op" outcome, STILL update the durable watermark.
   Otherwise the no-op outcome re-fires every cycle. Easy to
   miss when implementing.

5. **Existing-skills injection prevents duplicates.** Any
   "create N" pipeline (skills, tasks, custom commands) should
   show the model what already exists. Cost: one DB query.
   Payoff: no duplicate creation.

## Open questions for future rounds

- The actual skill creation path (after `worthy === true`) isn't
  traced — `main.js:60099+` continues but I cut off. Where
  does the new SKILL.md get written? `~/.config/alma/skills/<name>/SKILL.md`
  per round-3 01.
- The `existingSkillToUpdate: "name"` output suggests an update
  path. Does alma diff-merge into the existing SKILL.md, or
  replace? Different impl tradeoffs.
- Settings show `enabled` and `minToolCalls` only. Is the
  18k-char total cap configurable? The 8-message recent
  window? These look like baked-in tuning constants.

## Cross-refs

- Round 3: [`01-skills-system.md`](../alma-deep-dive-yuejing-round-3/01-skills-system.md)
  — the skill loader. This note covers the WRITER side; round-3
  01 covers the READER side.
- Round 4: [`03-memory-recall.md`](../alma-deep-dive-yuejing-round-4/03-memory-recall.md)
  — incognito short-circuit pattern shared with this note.
- Round 4: [`02-auto-compact.md`](../alma-deep-dive-yuejing-round-4/02-auto-compact.md)
  — same family of "auxiliary AI tasks using the tool model
  not the chat model."
- Round 4: [`07-websocket-sync.md`](../alma-deep-dive-yuejing-round-4/07-websocket-sync.md)
  — `skill_extraction_progress` event goes through `/ws/threads`.
- Round 6: [`01-title-generation.md`](./01-title-generation.md)
  — identical tool-model resolution cascade.
