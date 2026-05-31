# 01 — Agent Loop: Yetone's app vs Maka's AiSdkBackend

**TL;DR.** Both apps wrap `streamText`. Yetone's loop adds three things Maka doesn't have: (1) a `prepareStep` triad that does dynamic ToolSearch activation, AttemptCompletion reminders, and in-loop AutoCompact; (2) a two-clock watchdog system (60s inactivity reset from *inside* tools + a 4-hour total ceiling); (3) cache-marker placement for Anthropic prompt caching. Maka has things Yetone doesn't: a proper park/resume permission engine, an event-driven async queue, JSONL session persistence, and explicit error classification. The eight borrows below all fit cleanly into `packages/runtime/src/ai-sdk-backend.ts` without disrupting the existing architecture.

---

## 1. Source-of-truth comparison

| Concern | Yetone (main.js) | Maka (`packages/runtime/src/ai-sdk-backend.ts`) |
|---|---|---|
| Bundle line count | 74,182 (whole app) | 1,177 (AiSdkBackend only) |
| SDK entry | `import { streamText as ae } from "ai"` (`main.js:88-101`) | `const { streamText, stepCountIs } = ai` (`ai-sdk-backend.ts:307-313`) |
| Main loop location | `f = async () => { … }` (`main.js:62100-64007`) | `async *send()` (`ai-sdk-backend.ts:262-525`) |
| Inner stream consumer | `for await (const t of G)` over `nk(le({stream:m.toUIMessageStream()}))` (`main.js:63272-63449`) | `for await (const chunk of result.fullStream)` (`ai-sdk-backend.ts:373-382`) |
| Step cap | `stopWhen: s` where `s = ({steps}) => steps.length >= 100 + (Yt?1:0)` (`main.js:62915-62917`) | `stopWhen: stepCountIs(this.maxSteps)`, default 50 (`ai-sdk-backend.ts:255, 369`) |
| Outer retry envelope | `y()` at `main.js:64068-64313` — 3 buckets (empty stream / retryable / token limit) | none — errors bubble through a single try/catch (`ai-sdk-backend.ts:468-498`) |
| Watchdog | Two-clock: `nk()` inactivity + hard 4h (`main.js:50289-50335, 63260`) | `StreamWatchdog` connect+idle (`stream-watchdog.ts:30-112`) |
| Permission flow | per-tool inline (`lh()` only called from Bash), `approvalDecision` stamped on part metadata | proper park/resume `PermissionEngine` (241 ln, `permission-engine.ts`) — better than Yetone |
| System prompt | Assembled into a string array of 2 system messages (split at `"SYSTEM INFO"`) with `wk()` cache markers (`main.js:50582-50620, 62807-62830`) | Single string from `resolveSystemPrompt()` (`ai-sdk-backend.ts:368`), no cache markers |
| Compaction | Two functions: pre-flight `KE()` (UI form) + in-loop `ZE()` (model form) (`main.js:50071, 50211`) | none |
| Tool-result multimodal | `experimental_toToolResultContent` (`main.js:24058, 27865, 28677`) | none |

---

## 2. Outer entry shape (`f` vs `send()`)

Yetone's `f = async () => { … }` opens at `~/Downloads/alma-re/readable/main.js:62100`. Per `~/Downloads/alma-re/docs/01-agent-loop.md §1`, the locals at entry are:

- `e` = threadId
- `t` = `providerId:modelId`
- `o` = options bag
- `ne` = tool registry filtered subset
- `oe` = initial `activeTools` whitelist
- `Et` = providerOptions (assembled L62478-62620)
- `d` = `AbortController`
- `u` = captured error (settable from many places)

Maka's send() entry (`ai-sdk-backend.ts:262`) is structurally similar but:
- No `oe` (initial activeTools) — every tool is exposed every step.
- No `Et` providerOptions — `streamText({ model, messages, tools, system, stopWhen, abortSignal })` is *all* we pass.
- The abort controller is at `this.abortController = new AbortController()` (L266).

### Borrowable

**B-LOOP-01: `oe` initial `activeTools` whitelist** — let the caller pass a small subset for cheap models. Today Maka passes everything (1 line at L358). Estimate: S.

**B-LOOP-02: providerOptions surface** — at minimum, opt into Anthropic ephemeral cache_control and OpenAI `promptCacheKey: sessionId` when the provider is `api.openai.com` (per `main.js:62528-62540`). Estimate: S. See §5.

---

## 3. The `prepareStep` triad (Yetone-only)

Three responsibilities, all in `~/Downloads/alma-re/readable/main.js:62944-63096`. Per-step closure that returns `{activeTools?, messages?}`.

### 3.1 Dynamic `ToolSearch` activation

`main.js:62947-62968`:

```js
if (n > 0 && oe && ne) {
  const lastStep = t[t.length - 1];
  if (lastStep?.toolCalls) {
    for (const tc of lastStep.toolCalls) {
      if (tc.toolName === "ToolSearch" && lastStep.toolResults) {
        const tr = lastStep.toolResults.find(r => r.toolCallId === tc.toolCallId);
        if (tr?.output?.tools && Array.isArray(tr.output.tools)) {
          for (const tool of tr.output.tools) {
            if (tool.id && ne[tool.id]) Ht.add(tool.id);
          }
        }
      }
    }
  }
  if (Ht.size > 0) {
    const enabled = new Set(oe);
    for (const t of Ht) enabled.add(t);
    s.activeTools = Array.from(enabled);
  }
}
```

After `ToolSearch` returns, the model can call newly-discovered tools the next step. `Ht` is per-turn (re-created at L62895). Persistence across turns happens at L61582-61600 — message history is scanned for completed `ToolSearch` results.

**B-LOOP-03**: Implement this in Maka's AiSdkBackend by hoisting `activeTools` into a mutable `Set` and adding a `prepareStep` hook (Vercel AI SDK supports it natively). Pre-req: §3 of the tools note — add a `ToolSearch` tool. Estimate: M (touches `wrapToolExecute` for the per-step recompute + new tool impl).

### 3.2 AttemptCompletion reminder injection

`main.js:62970-62997`. Gemini-specific. State:

- `Ot` (L62855) — sticky "has done some tool work" flag
- `Ct` (L62853) — reminder count (max 3)
- `xt` (L62839) — `y.toLowerCase().includes("gemini") && !mt`

When Gemini has used tools but hasn't called `AttemptCompletion`, every subsequent step gets a fresh reminder appended to the message list. There's *also* a post-stream variant at L63503-63545 that fires after the for-await ends.

**B-LOOP-04**: Borrow only if/when Maka adds Gemini text models. Estimate: S, but blocked by a Gemini text-model integration.

### 3.3 In-loop AutoCompact

`main.js:62998-63095`. Guarded by `st?.enabled && rt && it && !Xt && lastStepHasUsage`. Overflow check is `zE()`:

```js
zE(usage, contextWindow, outputReserve, enabled = true) =
  enabled
  && contextWindow > 0
  && WE(usage.inputTokens, usage.outputTokens, usage.cacheReadTokens)
     > contextWindow - Math.min(outputReserve ?? jE, jE);
```

with `jE = 32000` (max output reserve, hard cap). `WE` is cache-aware:

```js
WE(e, t, n) = (n > e ? e + n + t : e + t);
```

i.e. if cacheRead > input (Anthropic-style), the canonical "this turn's full input" is `cacheRead + input + output`, else `input + output`. This handles Anthropic billing where `input` excludes the cached portion.

On overflow, `ZE` runs (L50211): split messages at `YE()` (the N-th user message from the end, counting *user turns* not raw messages), dump older ones into the conversation, ask the configured summary model for a `<context_summary>...` block, prepend two user messages (`summary` + `system-reminder reminding it to continue the latest user objective up to 1200 chars`) onto the kept tail.

**B-LOOP-05**: Borrow. Even just the *predictor* (`zE` + `WE`) without the summarizer is useful — we can broadcast "approaching limit" warnings to the renderer before crashing. Estimate: M (overflow predictor: S; full compaction including the summary subprocess: M).

---

## 4. The outer retry envelope (`y()` at main.js:64068-64313)

Yetone wraps `f()` with three retry buckets:

```js
const y = async () => {
  for (; g < 3; ) {
    try {
      return void (p ? await bh(p, f) : await f());
    } catch (b) {
      if (b.message === "LLM_EMPTY_STREAM") { g++; await sleep(500); continue; }
      if (b instanceof Error && rk(b))      { g++; await sleep(1000*2**(g-1)); continue; }
      if (b.message === "TOKEN_LIMIT_ERROR" && !l) {
        l = true;
        // Resolve summary model, run KE compaction, fall back to QE truncation
        // On success: c = compacted; u = null; continue;
        // On failure: broadcast generation_error and return.
      }
      throw b;
    }
  }
};
```

Three buckets:
1. **Empty-stream** — 500ms gap, no backoff. Counted toward `g < 3`.
2. **Retryable** (`rk(b)` = rate limit / 5xx / transient network / stream inactivity) — exponential backoff `1000 * 2 ** (g-1)`. Counted.
3. **Token-limit** — once per turn (single-shot `l` guard). Compacts via `KE()` + `QE()` fallback, retries with the compacted messages, does *not* count toward `g`.

Maka's outer handler (`ai-sdk-backend.ts:468-498`) classifies via `classifyError(err)` and emits a single `error` event. No retries, no token-limit compaction.

**B-LOOP-06**: Borrow the three buckets, but as a *separate retry layer in `SessionManager` or a wrapping adapter*, not inside AiSdkBackend (which should stay deterministic for testability). Estimate: M.

The `rk()` retryable predicate logic is interesting: per the comment around `main.js:64157-64273`, it covers rate-limit responses, 5xx, transient network errors, *and stream-inactivity timeouts*. Maka already has `classifyError` (`ai-sdk-backend.ts:470`). The borrow is the retry policy *around* it.

---

## 5. Cache-marker placement (`wk` and provider options)

The single biggest cost-saver for Anthropic. From `~/Downloads/alma-re/readable/main.js:50566-50620`:

```js
fk = {
  anthropic:        { cacheControl:         { type: "ephemeral" } },
  openrouter:       { cacheControl:         { type: "ephemeral" } },
  bedrock:          { cachePoint:           { type: "default"   } },
  openaiCompatible: { cache_control:        { type: "ephemeral" } },
  copilot:          { copilot_cache_control:{ type: "ephemeral" } },
};
gk = ["anthropic", "bedrock"];

wk(messages, providerType) {
  // finds first 2 system messages + last 2 non-system messages
  // stamps providerOptions: fk[providerType] on each
}
```

Call site at `main.js:62807-62830`: `ut = wk(ut, _t)`. The system message construction *also splits at the `"SYSTEM INFO"` line* for Anthropic/Bedrock so the stable bulk and the per-platform tail become two cacheable parts. Log: `[PromptCache] Applied cache markers for ${_t} provider (system: ${$t.length} part(s), messages: last 2 marked)`.

Per `~/Downloads/alma-re/docs/01-agent-loop.md §19 insight 8`: "Cache markers stamped on exactly 4 messages. Combined with the SYSTEM INFO splitter, you get 4 cacheable Anthropic breakpoints (the SDK's max)."

Maka does nothing. Per `ai-sdk-backend.ts:354-371` the streamText call passes only `{ model, messages, tools, activeTools, experimental_repairToolCall, system, stopWhen, abortSignal }`.

**B-LOOP-07**: Add `wk`-equivalent. The minimal version:

```ts
// Pseudocode inside send(), after building messages
if (providerType === 'anthropic' || providerType === 'openrouter') {
  // Split system if it contains a stable/volatile boundary marker, then stamp first 2 + last 2
  applyCacheMarkers(messages, providerType);
}
```

Estimate: S-M. Risk: low — this is a no-op at provider level if not supported. Big payoff for any Maka user on Anthropic Sonnet/Haiku.

### 5.1 Other provider options worth borrowing

From `main.js:62478-62620`:

- **`promptCacheKey: threadId`** — only for `api.openai.com` (`main.js:62528-62540`). Custom OpenAI-compatible providers (Together, Groq, vLLM) **don't** get the cache key — they break on it.
- **Anthropic reasoning** — `Et.anthropic = { thinking: { type: "enabled", budgetTokens: vt(wt) } }` where `vt(wt)` maps `low/medium/high/xhigh` → numbers (`main.js:62463-62476`).
- **Google `safetySettings: [4 categories OFF]`** — for the companion product. Probably not applicable to Maka's defaults.
- **GPT-5 specific**: `store: false, include: ["reasoning.encrypted_content"], reasoningSummary: "auto"` (`main.js:62555-62565`) — necessary so subsequent turns can replay encrypted reasoning without re-paying.
- **`maxOutputTokens: undefined` for OpenAI/Copilot/GPT** (`main.js:62888`) — sidesteps Responses API truncation.

**B-LOOP-08**: Build a `providerOptionsBuilder(connection, modelId, capabilities)` helper. Estimate: S per provider, total M for all five.

---

## 6. Watchdog reset from inside tools (`f.current`)

`main.js:63113` declares `const f = { current: null }`. Anywhere in the codebase that does work for this thread can call `f.current?.()` to reset the inactivity watchdog clock:

- `prepareStep` first line (`main.js:62945`) — every step boundary.
- `broadcastBashStream` callback (`main.js:63130`) — live tool output.
- `broadcastBashPartUpdate` callback (`main.js:63147`) — tool state change.
- `broadcastSubagentEvent` (`main.js:63120`) — subagent activity.
- `vr(() => { f.current?.() })` (`main.js:63267`) — registered global beat.

The setter is wired by `nk()` (L50318-50321) and unset in `finally`.

Maka's `StreamWatchdog.markActivity()` (`stream-watchdog.ts:64-69`) is *only* called from the for-await loop at `ai-sdk-backend.ts:375`:

```ts
for await (const chunk of result.fullStream) {
  if (this.aborted) break;
  watchdog.markActivity();
  this.handleStreamChunk(...);
}
```

This means **a long-running Bash that streams every 10s will not reset the 120s watchdog** because the SDK doesn't emit a stream event until the tool returns. A 5-minute `pnpm test` would trigger an idle timeout.

**B-LOOP-09**: Thread a reset ref into `MakaToolContext`. Today's `MakaToolContext` (`ai-sdk-backend.ts:123-131`):

```ts
export interface MakaToolContext {
  sessionId: string;
  turnId: string;
  cwd: string;
  toolCallId: string;
  abortSignal: AbortSignal;
  emitOutput: (stream: ToolOutputStream, chunk: string) => void;
}
```

Add `markActivity?: () => void`. `runStreamingShell` (`builtin-tools.ts:155-231`) calls it inside `append()`. Plumb the ref through `wrapToolExecute` so it points at the active watchdog. Estimate: S.

---

## 7. The async queue + materializer (Maka has this, Yetone doesn't)

Maka's `AsyncEventQueue` (`packages/runtime/src/async-queue.ts`) + the producer/consumer pattern in `send()` (`ai-sdk-backend.ts:262-525`) is structurally cleaner than Yetone's "captured error in closure scope" pattern. Specifically:

- Yetone's `onError: ({error: e}) => { u = e; }` (`main.js:62932`) is a closure-scoped error capture, then evaluated after the for-await drains.
- Maka's queue lets the producer push `{type:'error', ...}` events independent of the for-await drain, and the consumer iterates `for await (const ev of queue) yield ev`.

This is a *better* design for downstream consumers (no need to special-case `onError`). No borrow needed.

---

## 8. Other notable Yetone-only mechanics

### 8.1 `keepRecentMessages` counts user turns, not raw messages

`main.js:50030` — `YE` walks backward, only increments on `role === "user"`. So `keepRecentMessages: 4` keeps the last *4 user prompts and all the assistant/tool turns between them*. Much more aggressive than naïve N-last; preserves full reasoning trails.

Maka has no compaction yet, but when we add it: borrow this. Estimate: S.

### 8.2 `isCompactionIndicator` rendering vs SDK injection

`main.js:58412-58420, 60695-60707` — the persisted UI compaction indicator (`🗜️ Context Compacted`) is *replaced inline* when building model messages for the next turn, becoming `<context_from_earlier_conversation>{summary}</context_from_earlier_conversation>`. So the SDK never sees the literal indicator text — it sees the summary.

Maka's `materializePriorMessages()` (`ai-sdk-backend.ts:327`) doesn't do anything like this yet. Worth borrowing when we add compaction.

### 8.3 `HE()` strips summary tags before re-summarizing

`main.js:50006-50013` — regex `qE` strips `<context_summary>` and `<context_from_earlier_conversation>` before re-summarization. Prevents summary-of-summary recursion bloat when the same conversation gets compacted twice.

### 8.4 Cache-aware token sum

Per §3.3 above: `WE` distinguishes Anthropic cacheRead semantics. Without this, autoCompact would never trigger on long Anthropic conversations because the input field is small.

### 8.5 The `experimental_repairToolCall` hook

`ai-sdk-backend.ts:359-367` already uses `experimental_repairToolCall`. Yetone doesn't. So Maka is *ahead* here — Yetone has no repair path. (Yetone's `hermesToolMiddleware` wrap at `main.js:165, 56582-56590` solves a slightly different problem: making OS models that emit XML look like function-calling models.)

### 8.6 The empty-stream detection

`main.js:63460-63478` — if `B === 0` (no for-await iterations) and not aborted, throw `LLM_EMPTY_STREAM`. The outer `y()` catches this and retries up to 3 times with 500ms gap.

Maka silently completes with `assistantText.length === 0` in this case (`ai-sdk-backend.ts:392-401`). The `step-cap reached` grace text fires only when `finishReason === 'tool-calls'`. An *actual* empty stream (zero deltas) gets no grace and no retry.

**B-LOOP-10**: Detect zero-event streams; surface a retry. Estimate: S.

---

## 9. Summary of borrowable items in this doc

Mapped to entries in `07-borrowable-checklist.md`:

| ID | Mechanic | Cite | Maka file | Scope | Risk |
|---|---|---|---|---|---|
| B-LOOP-01 | Initial `activeTools` subset whitelist | `main.js:61582-61630` | `ai-sdk-backend.ts:358` | S | low |
| B-LOOP-02 | Anthropic cache_control providerOptions | `main.js:50566-50620, 62807-62830` | `ai-sdk-backend.ts` send() | S | low |
| B-LOOP-03 | `prepareStep` ToolSearch dynamic activation | `main.js:62947-62968` | `ai-sdk-backend.ts`, new ToolSearch tool | M | med (testability) |
| B-LOOP-04 | AttemptCompletion reminder (Gemini) | `main.js:62970-62997` | conditional on Gemini integration | S | low |
| B-LOOP-05 | AutoCompact predictor + compactor | `main.js:49994, 50211, 62998-63095` | new file `runtime/src/auto-compact.ts` | M | med |
| B-LOOP-06 | Outer retry envelope (3 buckets) | `main.js:64068-64313` | new wrapping adapter or `session-manager.ts` | M | med (retry storms) |
| B-LOOP-07 | `wk()` cache markers + SYSTEM INFO split | `main.js:50582-50620, 62807-62830` | `ai-sdk-backend.ts` system prompt build | S | low |
| B-LOOP-08 | providerOptionsBuilder (5 providers) | `main.js:62478-62620` | new `runtime/src/provider-options.ts` | M | low |
| B-LOOP-09 | `markActivity` ref in MakaToolContext | `main.js:63113, 50318-50321` | `ai-sdk-backend.ts:123-131`, `builtin-tools.ts:155` | S | low |
| B-LOOP-10 | Empty-stream detection | `main.js:63460-63478` | `ai-sdk-backend.ts:392` | S | low |

---

## 10. Non-borrowable items (kept for completeness)

These are real mechanics but either don't fit Maka's architecture or are net-negative:

- **`mu()` telemetry wrap (`main.js:18214`)** — Maka uses an explicit `recordToolInvocation` callback. Cleaner.
- **Approval baked into Bash via `lh()`** — Maka's separate `PermissionEngine` is strictly better.
- **No `onFinish` callback usage** — Yetone pulls final state via `ik(promise, 5000)` racing a 5-second deadline (`main.js:63492-63607`). Maka uses `await result.usage` and `await result.finishReason.catch(() => 'stop')` (`ai-sdk-backend.ts:434, 460`) which is cleaner.
- **`Vt = !1` single-exit flag (`main.js:63595`)** — clever vanilla-JS pattern. Maka's queue+iterator design doesn't need it.
- **`Mt = !!ne && Object.keys(ne).length > 0` toggles Hermes wrap (`main.js:62914`)** — Maka doesn't need OS-model XML parsing.
