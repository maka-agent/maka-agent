# 01 — Reference app thread title auto-generation

> Source-grounded against `~/Downloads/reference-source/readable/main.js`.
> Round-4 [`03-memory-recall.md`](../reference app-deep-dive-yuejing-round-4/03-memory-recall.md)
> mentioned title generation as a downstream consumer of the
> tool model. This note traces the full pipeline — short,
> bounded, but a clean example of "background async work that
> the UI feels live."

## Where it fires

After the first agent turn completes on a new thread (no
explicit user title set), `generateThreadTitle(threadId,
messages)` kicks off. It runs ASYNC alongside the next user
turn — the user can already start typing while a title
appears in the sidebar.

## The 4-message window

`main.js:59855-59861`:

```js
const conversationText = messages
  .slice(0, 4)                                     // first 4 messages
  .map(m => {
    const text = this.extractTextFromUIMessage(m);
    return `${m.role}: ${text.substring(0, 500)}`; // 500 chars per message
  })
  .join("\n\n");
```

Why 4 × 500? At most:
- system message (if present) — usually short
- user's first turn
- assistant's first turn
- user's second turn (or assistant's first tool result)

So you get ENOUGH context to title even a multi-step
interaction (e.g., "fix the bug" → assistant explains → user
confirms direction → assistant fixes). 2000 chars total ≈ 600
tokens — cheap.

The 500-char per-message cap matters: tool results can be
huge. Without the cap, a single shell command output could
swamp the title prompt with stack traces.

## The tool model

```js
const o = await Pl();                              // effective tool model
if (!o.model) return null;                          // no model → no title
const s = wd(o.model);                              // parse "providerId:modelId"
const { providerId, modelId } = s;
const a = await fd(providerId, modelId);            // create AI SDK model
```

Three observations:

### `Pl()` resolves the EFFECTIVE tool model

Title generation doesn't use the user's chat model (potentially
GPT-4 or Claude Opus, ~$$). It uses the **toolModel**
(`settings.toolModel.model` or `settings.memory.toolModel`).
This is the cheap-and-fast slot.

`Pl()` is the "effective tool model" resolver — it cascades
through settings to find a configured tool model, or auto-
detects a cheap default. If nothing's configured AND no
auto-detect succeeds, title gen silently bails (returns null).

The "silent bail" is the right call: the user shouldn't see a
"can't generate title" toast on every new thread; they should
just see the default `New Chat` title (or whatever fallback
the renderer shows).

### `isAutoDetected` flag logged for debug

`main.js:59849`:

```js
console.log(`[TitleGen] Generating title for thread ${e} using ${o.model} (auto-detected: ${o.isAutoDetected})`);
```

When `isAutoDetected: true`, reference app picked the model without
explicit user config. Worth logging because "wrong model
picked" is a common user complaint.

### Provider availability checked

`fd(providerId, modelId)` returns null if the provider's
disabled, not authenticated, or unknown. Title gen bails
gracefully here too.

## The prompt

`main.js:59870-59871`:

```
You are a helpful assistant that generates concise, descriptive
titles for chat conversations.
Generate a short title (3-8 words) that captures the main topic
or purpose of the conversation.
The title should be clear and informative, not generic.
IMPORTANT: The title MUST be in the same language as the user's
message. If the user writes in Chinese, respond with a Chinese
title. If the user writes in Japanese, respond with a Japanese
title. If the user writes in English, respond with an English
title. And so on for any other language.
Do NOT use quotes around the title.
Do NOT include any explanation, just output the title directly.
```

Five teaching moves:

1. **Length range** "3-8 words." Concrete is better than
   "concise." Models follow numbers better than adjectives.
2. **"Not generic"** — counter-conditions against "Question
   about X" / "Discussion of Y" defaults.
3. **Language matching** — REPEATED with examples. Same idea
   reference app teaches the bots (round-4 04) but the IMPORTANT prefix
   tells the model this is non-negotiable.
4. **"Do NOT use quotes"** — forbids common model behavior of
   wrapping output in `"..."`. Belt-and-braces: the response
   trim at line 59883 also strips leading/trailing quotes.
5. **"Do NOT include any explanation"** — forbids preamble
   ("Here's a title for your conversation:"). Without this,
   model often pads with conversational fluff.

The quotes-strip + length-validation combine to **never let a
bad title corrupt the DB**.

## Validation

`main.js:59883-59903`:

```js
const title = response.text.trim().replace(/^["']|["']$/g, "");
if (title && title.length > 0 && title.length <= 100) {
  To.updateThread(threadId, { title });
  this.broadcastThreadSync("title_generated", {id, title, isGeneratingTitle: false});
  return title;
}
// Invalid → don't update, just clear the loading flag
this.broadcastThreadSync("title_generating", {id, isGeneratingTitle: false});
return null;
```

Two-stage cleanup:
- Strip wrapping quotes (model sometimes adds `"...."` despite
  the prompt rule).
- Validate length: > 0 AND ≤ 100 chars. Anything else is
  rejected silently.

100-char cap = ~25 words. Far more than 3-8 the prompt asked
for. The slop tolerance lets occasional verbosity through; the
hard cap prevents a runaway "title" that includes the entire
conversation summary.

## Three-broadcast UX sequence

The function emits THREE `broadcastThreadSync` calls:

| Event | When | Payload |
|---|---|---|
| `title_generating` | Before LLM call | `{id, isGeneratingTitle: true}` |
| `title_generated` | On success | `{id, title, isGeneratingTitle: false}` |
| `title_generating` (cleared) | On failure or validation reject | `{id, isGeneratingTitle: false}` |

So the renderer can:
1. Show a "Generating title…" shimmer in the sidebar.
2. Replace with the new title on success.
3. Quietly revert to `New Chat` if generation failed.

The shimmer-to-title transition is a small thing but a clear
UX upgrade over "title pops in 2 seconds later with no
warning."

Cross-ref round-4 [`07-websocket-sync.md`](../reference app-deep-dive-yuejing-round-4/07-websocket-sync.md)
— these events flow over `/ws/threads`.

## Failure handling

`main.js:59905-59914`:

```js
catch (error) {
  const elapsedSec = ((Pt.now() - n) / 1e3).toFixed(2);
  console.error(`[TitleGen] Title generation failed after ${elapsedSec}s:`, error);
  this.broadcastThreadSync("title_generating", {id, isGeneratingTitle: false});
  return null;
}
```

Catches ALL errors — model 5xx, network timeout, parser
failure, etc. Logs with duration (useful for diagnosing
"why is title generation slow?"). The broadcast clears the
spinner so the UI doesn't get stuck.

Thread keeps its default title; user can manually rename later.
Cross-ref round-5 [`06-telemetry-sentry.md`](../reference app-deep-dive-yuejing-round-5/06-telemetry-sentry.md)
— Sentry would capture this if it's a thrown unhandled
exception, but the `try/catch` wraps it before that triggers.

## Duration logging

Every checkpoint logs `((Pt.now() - n) / 1e3).toFixed(2)`
seconds since start. This is reference app's lightweight perf telemetry
in `[TitleGen]` namespaced logs. Without Sentry traces (round-5
06 noted only 10% sampled), `[TitleGen]` console logs are the
local truth.

## What Maka has today

Maka has no automatic title generation. New threads stay
`New Chat` until renamed. This is a missing UX touch.

## Ranked Maka improvements

1. **Adopt the toolModel-not-chatModel pattern.** Title gen
   should NEVER use the user's chat model. Always use a
   cheaper tool model. This rule applies to memory query
   rewriting (round-4 03), autoCompact summary (round-4 02),
   skill extraction (round-3 01) too.

2. **First-4 messages × 500 chars** is a great default
   context window for ANY auto-summarization pipeline. The
   per-message cap matters because tool results can dominate.

3. **3-broadcast UX (generating / success / silent-fail).**
   The shimmer-to-title transition is a small but visible UX
   upgrade. Easy to forget the silent-fail clearing event.

4. **Length validation > 0 AND ≤ 100 chars.** Belt-and-
   braces validation prevents a runaway "title" from
   corrupting the DB. Cap tolerates verbosity but rejects
   pathological output.

5. **Quote-strip + "Do NOT use quotes" prompt rule together.**
   Models add quotes despite being told not to. Belt-and-
   braces.

## Open questions for future rounds

- Does title generation cancel if the user MANUALLY renames
  the thread before the LLM responds? Race condition risk:
  user renames → 2s later LLM auto-title overwrites.
- Is title generation triggered on FIRST turn only, or also
  on subsequent turns if user clears the title? The function
  signature suggests it's stateful per call.
- The `extractTextFromUIMessage` helper isn't traced here.
  It probably handles tool_result + multimodal parts; worth
  confirming for thoroughness.
- `Pl()` cascades for the effective tool model. What's the
  exact order? `settings.toolModel.model` → fallback to
  `chat.defaultModel` (probably not, that defeats the cheap-
  model purpose) → auto-detect? Round-5 had loose mention.

## Cross-refs

- Round 4: [`03-memory-recall.md`](../reference app-deep-dive-yuejing-round-4/03-memory-recall.md)
  — query rewriting uses the same toolModel cascade.
- Round 4: [`02-auto-compact.md`](../reference app-deep-dive-yuejing-round-4/02-auto-compact.md)
  — summaryModel falls back to toolModel just like this.
- Round 4: [`07-websocket-sync.md`](../reference app-deep-dive-yuejing-round-4/07-websocket-sync.md)
  — the 3 broadcast events live on `/ws/threads`.
- Round 5: [`07-provider-abstraction.md`](../reference app-deep-dive-yuejing-round-5/07-provider-abstraction.md)
  — `fd(providerId, modelId)` goes through `hd()` factory to
  resolve the AI SDK model.
