# 02 — Alma autoCompact: three trigger sites + three-tier fallback

> Source-grounded against `~/Downloads/alma-re/readable/main.js`.
> Round-2 [`02-send-response-flow-WIP.md`](../alma-deep-dive-yuejing-round-2/02-send-response-flow-WIP.md)
> mentioned autoCompact in passing ("auto-compact in prepareStep")
> but never traced. This note covers the full pipeline: when it
> triggers, what summarizes, how it persists, and what happens
> when summarization fails.

## Settings shape

`chat.autoCompact` is documented in the api-spec template
(`main.js:65422`, surfaced in the AppSettings TypeScript type):

```typescript
autoCompact: {
  enabled: boolean;
  threshold: number;        // 60-95 (percentage)
  keepRecentMessages: number;  // 2-20 (conversational turns)
  summaryModel?: string;    // "providerId:modelId"
}
```

Notable: `keepRecentMessages` counts **user-message turns**, not
individual messages. A turn is user message + assistant reply +
tool calls.

`summaryModel` is OPTIONAL — falls back to `toolModel.model`, then
to thread's `defaultModel`. So users can use a cheaper model for
summarization than for generation.

## Three trigger sites

### 1. Pre-request check (`main.js:62150-62330+`)

Runs BEFORE the model is called for each new user turn. Reads
the last assistant message's `metadata.usage`, computes:

```
percent = (estimatedCurrentTokens / contextWindow) * 100
isOverflow = percent >= threshold (default 80)
```

The "estimated current tokens" calculation has three branches:
- **Last assistant was a compaction summary** (`metadata.is
  CompactionSummary` or `isCompactionIndicator`): use ONLY current
  request size, not last assistant's reported tokens. Avoids
  treating the just-compacted state as "still huge."
- **Last assistant has usage**: use `WE(inputTokens, outputTokens,
  cacheReadTokens)` — which is `inputTokens + outputTokens` plus
  `cacheReadTokens` IF `cacheReadTokens > inputTokens` (a prompt-
  caching adjustment).
- **No usage available**: fallback to `BE(systemPrompt,
  messages) / contextWindow` ratio.

This is the **proactive** trigger — compact before sending, not
after the model complains.

### 2. Mid-stream `prepareStep` callback (`main.js:62997-63095`)

`prepareStep` is the AI SDK hook called between tool-calling
steps within a single user turn. After each step:

```js
const isOverflow = zE(
  { inputTokens, outputTokens, cacheReadTokens },
  contextWindow,
  modelMaxOutputTokens
);
if (isOverflow) {
  // log + telemetry: 'context_compaction_started'
  const result = await ZE(messages, 0, {
    targetTokenLimit: Math.floor(0.6 * contextWindow),
    keepRecentMessages: Math.max(2, settings.keepRecentMessages || 4),
    model: summaryModel,
  });
  if (result) {
    step.messages = result.messages;  // hand back compacted messages
    Xt = true; Yt = true;             // global "did compact" flags
  }
}
```

`ZE` is the **streaming-context variant** of the compactor (uses
AI SDK message format with `tool-call`/`tool-result` parts vs the
in-DB shape with `parts[]`). Same idea, different message
serialization.

If `ZE` throws, fallback at `main.js:63081-63093` truncates the
oldest messages — keeps last `keepRecentMessages` user-message
turns, no LLM call, no summary. Better than letting the agent
loop crash on next overflow.

### 3. Manual via REST API `POST /api/threads/:id/compact`
(`main.js:51585`, handler at `main.js:57742-57841`)

User clicks "Compact" in the thread menu, sends this. Differences
from auto:
- **Validates minimum 2 messages** — refuses below.
- **Threshold not checked** — user asked, just do it.
- **Reserved minimum keepRecent of 1** — even small threads keep
  at least one recent turn.
- **Same `KE` (in-DB shape) compactor** as the pre-request path
  uses.
- **Manual endpoint blocks until summary returns** vs streaming
  paths that race against the next request.

## Token budgets

`main.js:49989-50001`:

```js
const jE = 32e3;  // Reserved output budget (32k tokens)

function WE(input, output, cacheRead) {
  // Caching-aware: if cacheReadTokens > inputTokens, add cache
  return (cacheRead ?? 0) > 0 && cacheRead > input
    ? input + cacheRead + output
    : input + output;
}

function zE(usage, contextWindow, modelMaxOutput, enabled = true) {
  return enabled
    && contextWindow > 0
    && WE(usage.inputTokens, usage.outputTokens, usage.cacheReadTokens)
       > contextWindow - (Math.min(modelMaxOutput ?? jE, jE) || jE);
}
```

**`jE = 32000` is the output reserve floor**. Even if the model
reports 64k max output, alma reserves only 32k. Models that
report `maxOutputTokens` smaller than 32k use the smaller value
(`Math.min`). The reserve is subtracted from the context window
BEFORE the threshold percentage check — so for a 128k model with
default 80% threshold, the actual ceiling is:

```
allowedInput = (128000 - 32000) * 0.8 = 76800 tokens
```

Not 102400 (`128000 * 0.8`). This is the "we need room for the
output" mental model baked in.

`targetTokenLimit` in all 3 trigger sites is `Math.floor(0.6 *
contextWindow)` — compaction aims for 60% utilization after,
not 80%. Gives headroom for the immediate next turn so we don't
immediately re-trigger.

## `keepRecentMessages` semantics — user-message-counted

`main.js:50030-50036`:

```js
function YE(messages, n) {
  if (n <= 0 || messages.length === 0) return messages.length;
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user" && ++count >= n) return i;
  }
  return 0;
}
```

Walks backwards from the end, counting user messages. Returns
the INDEX where you should split. So a 50-message thread with
many assistant + tool-result messages between user turns and
`keepRecentMessages = 4` keeps the last 4 user turns INTERLEAVED
with all their assistant/tool messages.

This is the right granularity: a single user request might
spawn 10 tool calls. Counting raw messages would split the
turn mid-flight.

## Three-tier fallback hierarchy

### Tier 1: LLM summary via `KE` (pre-request + manual)

`main.js:50071-50171`. The "happy path":
1. Split messages at `YE(messages, keepRecentMessages)`.
2. Serialize the OLD half into role-tagged transcript (`USER:`
   / `ASSISTANT:` blocks; tool calls become `[Tool Call: name]`;
   tool results truncated to 500 chars `[Tool Result: …]`).
3. Call `se({ model: summaryModel, system: GE, prompt: transcript })`.
4. Wrap returned summary in:
   ```
   <context_summary>
   ${summary}
   </context_summary>

   *[This is an auto-generated summary of earlier conversation.
   The detailed messages have been compacted to save context space.]*
   ```
5. Replace OLD half with that synthetic user message + a synthetic
   assistant ack: `"Understood. I have reviewed the conversation
   summary and will continue from here."` (`main.js:50057-50069`,
   `metadata.isCompactionSummary: true`).

Return shape: `{summary, compactedMessages, originalTokenCount,
compactedTokenCount, compactedMessageCount, compactedMessageIds,
summaryMessage, success: true}`.

If `se({…})` throws OR returns empty: `success: false`, error
preserved, original messages returned unchanged (caller must
fall through).

### Tier 2: Hard truncation via `QE`

`main.js:50172-50210`. When LLM summary fails OR returns 0
savings:
1. Same `YE` split.
2. Drop old half entirely.
3. Insert truncation NOTICE:
   ```
   *[Earlier messages (${count} messages) have been removed to
   save context space. Recent conversation continues below.]*
   ```
4. Same synthetic assistant ack.

No LLM call. Always saves tokens. Always succeeds (assuming
there's old half to remove). Returns same shape but with
`summary: ""`.

### Tier 3: Emergency truncate-only (in prepareStep)

`main.js:63081-63093`. When tier 1 (`ZE`) throws inside
prepareStep AND there's no caller to fall through to tier 2:

```js
const t = YE(messages, Math.max(settings.keepRecentMessages || 4, 1));
if (t > 0) {
  step.messages = messages.slice(t);  // just slice, no notice, no ack
  Xt = true; Yt = true;
  return step;
}
```

Just slice. No notice. No summary. Let the model figure it out
from context. This is the "we have to make progress" escape
hatch.

## Anti-loop guard at the pre-request site

`main.js:62221-62230`:

```js
if (isLastAssistantCompactionSummary) {
  const percent = (estimatedCurrentTokens / contextWindow) * 100;
  isOverflow = percent >= threshold;
  if (!isOverflow) console.log(
    "[AutoCompact] Skipping pre-request check: last assistant " +
    "message is already a compaction summary"
  );
}
```

Without this: every turn after a compaction would re-trigger
compaction on the just-compacted state. The guard checks ONLY
the current request size (not the post-compaction context size),
so consecutive small queries after a compaction don't loop.

## Ineffective-compaction detection

`main.js:62274-62297`:

```js
if (result.success && result.compactedMessageCount > 0) {
  const saved = result.originalTokenCount - result.compactedTokenCount;
  if (saved > 0) {
    messages = result.compactedMessages;
  } else {
    // Summary made things BIGGER. Fall to QE truncation.
    const tier2 = QE(messages, systemPrompt, 1);  // 1 = keep only 1 user turn
    if (tier2.compactedMessageCount > 0
        && tier2.originalTokenCount - tier2.compactedTokenCount > 0) {
      messages = tier2.compactedMessages;
    } else {
      // Even tier 2 can't help. Give up, send original.
    }
  }
}
```

The summary CAN make things bigger if the conversation was
already concise — the wrapper markup + ack message + system
prompt adds tokens. The check catches this and falls back to
hard truncation with `keepRecentMessages = 1` (aggressive).

## Summarizer prompt design

`main.js:50002-50003` (the `GE` constant) — the system prompt
for the summarizer. Highlights:

> Requirements:
> 1. Preserve key decisions, code changes, file modifications, and important context
> 2. Keep track of any ongoing tasks, objectives, or goals
> 3. Note any important user preferences, constraints, or requirements mentioned
> 4. Include specific technical details: file names, function names, variable names, error messages, paths
> 5. Summarize tool call results - focus on what was accomplished, not the raw output
> 6. Be concise but comprehensive - this summary will replace the original messages
> 7. **DO NOT preserve transient error states as facts** (e.g.
>    "API key is invalid", "service is down"). These are
>    temporary and should NOT be carried forward. Only preserve
>    the resolution if the error was actually fixed.

The structured markdown skeleton:
```
## Conversation Summary

### Objective
[What the user is trying to accomplish]

### Progress
[What has been done so far - specific files, features, bugs]

### Key Details
[File paths, function names, configuration values, error messages
 with resolutions, important decisions and why]

### Context
[User preferences, constraints, background]

### Pending
[Unfinished tasks, open questions, next steps]
```

Point 7 is the non-obvious one — a naive summarizer would
faithfully preserve "User noted the API was down at 14:32" as a
fact, then carry that forward for hours after the API recovers.
Explicitly forbidding this avoids the "ghost error" trap.

## Pre-existing summary stripping

`main.js:50005-50013`:

```js
const qE = /<(context_from_earlier_conversation|context_summary)>\s*([\s\S]*?)\s*<\/\1>/gi;

function HE(text) {
  return text.replace(qE, (_, _tagName, inner) => (inner || "").trim())
             .slice(0, 4000)  // cap at 4k chars
             + (text.length > 4000 ? "\n...[truncated for compaction]" : "");
}
```

When messages contain `<context_summary>…</context_summary>`
from a PREVIOUS auto-compact, the serializer unwraps the tag and
keeps the inner content. Without this, repeated compactions
would create nested summary blocks, accumulating wrapper text.

The 4000-char cap per message ensures a single huge user message
doesn't dominate the prompt sent to the summarizer.

## Telemetry events

Broadcast via WebSocket (round-4 [`01-rest-api-operator-agent.md`](./01-rest-api-operator-agent.md)):

| Event | When | Payload |
|---|---|---|
| `context_compaction_started` | Before LLM summary call | `{threadId, messageCount, duringMultiTurn}` |
| `context_compacted` | After successful compaction | `{threadId, compactedMessageCount, originalTokens, compactedTokens, success, duringMultiTurn}` |
| `context_usage_update` | After successful compaction | `{threadId, usagePercent, totalTokens, contextWindow}` |

Renderer can show a "compacting…" toast and a context-usage
progress bar.

## Persistence

After compaction, `persistCompactionResult` (manual path) /
`qt(...)` (prepareStep path) writes to DB:

```js
{
  success: true,
  summary: <string>,
  compactedMessageCount: <number>,
  compactedMessageIds: [<id>, ...],
  originalTokenCount: <number>,
  compactedTokenCount: <number>,
  compactedMessages: [],  // empty — the actual replacement
                           //          messages are in the
                           //          synthetic summary message
                           //          stored separately
}
```

Old messages are NOT deleted — they're MARKED as compacted via
`compactedMessageIds`. The renderer can still display them
collapsed ("…earlier messages compacted, click to expand").

This is the right design: model sees compacted (saves tokens),
user can scroll back (preserves history).

## What Maka has today

Maka's compaction is in `@maka/runtime/auto-compact.ts` but only
triggers on a single threshold (no separate summary model, no
prepareStep callback, no anti-loop guard). The 3-tier fallback
hierarchy doesn't exist — failure means "just send original and
hope."

## Ranked Maka improvements

1. **Add the `summaryModel` setting separate from chat model.**
   Users want cheap summarization (haiku-tier) of an
   expensive-model thread. Settings shape is trivial; the model
   resolution code already exists in Maka's provider system.

2. **prepareStep mid-turn compaction.** Without it, a tool-heavy
   turn (search 5 docs → fetch 5 pages → write code) can OOM
   the context mid-step. The prepareStep callback is the right
   AI-SDK hook.

3. **Anti-loop guard.** The `isCompactionSummary` metadata flag
   + skip-pre-request-check pattern is essential — without it,
   the post-compact state will compact again on the next turn.
   Bug seed if you ship prepareStep without this.

4. **Output token reserve (32k floor).** Without reserving for
   output, the model crashes mid-stream when the response
   exceeds remaining window. The `jE = 32000` floor is the
   right default.

5. **Three-tier fallback (LLM → hard truncate → emergency
   slice).** Robustness matters more than summary quality for
   the auto path. The model HAS to make progress; let summary
   quality degrade gracefully.

## Open questions for future rounds

- Does the persistence column (`compactedMessageIds`) get used
  by the renderer to render a "compacted" affordance, or is it
  purely server-side accounting? The spec hints at a renderer
  expansion UI but I didn't trace.
- The `<context_summary>` stripping at `HE` only handles
  alma-generated tags. What if the user pasted markup that
  happens to contain that tag literally? Probably a very small
  failure mode but worth confirming.
- The summarizer uses `se({...})` (not the streaming text path).
  Does it respect proxy settings, retry settings, etc., or is
  it a simpler one-shot call? If simpler, it could hang on a
  flaky network — does it have a timeout?

## Cross-refs

- Round 2: [`02-send-response-flow-WIP.md`](../alma-deep-dive-yuejing-round-2/02-send-response-flow-WIP.md)
  — pre-request and prepareStep are inside the streamText
  pipeline traced there.
- Round 3: [`02-output-safety-modes.md`](../alma-deep-dive-yuejing-round-3/02-output-safety-modes.md)
  — the per-tool budget caps (Bash 3.8k, MCP 2.6k, etc.) limit
  per-message growth; autoCompact is the next-level intervention
  when those caps aren't enough.
- Round 4: [`01-rest-api-operator-agent.md`](./01-rest-api-operator-agent.md)
  — the `/api/threads/:id/compact` route documented there is
  the manual trigger site for this system.
