# 03 — Alma Hummingbird: Quick Chat screen-context capture

> Source-grounded against `~/Downloads/alma-re/readable/main.js`.
> Round-4 [`07-websocket-sync.md`](../alma-deep-dive-yuejing-round-4/07-websocket-sync.md)
> saw `hummingbirdContext` as a mystery field on `generate_response`
> WS messages but didn't trace it. This note covers the full
> pipeline: what Hummingbird captures, when it captures, how it
> injects into the prompt, and what the model is taught to do
> with it.

## TL;DR

**Hummingbird is "what's on screen right now" snapshot for Quick
Chat.** When the user invokes Maka's hypothetical Quick Chat
(global keyboard shortcut), alma captures three things:
1. The frontmost app (name + bundle id + window title + URL).
2. The user's text selection (the highlighted text — most likely
   referent of "this", "it", "that").
3. The macOS Accessibility tree of the focused window (raw
   visible content).

These get wrapped in XML-ish tags and injected into the agent's
prompt, with explicit guidance on how to use them.

Result: "what does this mean?" pointing at a screenshot, or "fix
this code" highlighting a chunk in VS Code — works WITHOUT
explicit copy-paste. The agent already knows what's on screen.

## Where it lives in the request flow

`main.js:59134` and `59167` — the `/ws/threads` WebSocket
`generate_response` payload includes `hummingbirdContext`:

```typescript
{type: "generate_response", data: {
  …,
  fromQuickChat,             // true when invoked from Quick Chat
  hummingbirdContext,        // optional pre-captured context
  …
}}
```

The renderer can OPTIONALLY pre-capture and ship the snapshot
in the WS message. If absent, the main process captures FRESHLY
(next section).

## Fresh capture fallback

`main.js:60790-60878` is the capture pipeline, triggered when:
- `fromQuickChat: true`
- `settings.general.quickChatInjectScreenContext !== false`
  (defaults to true)
- macOS only (early `process.platform !== "darwin"` return)

Three-step capture with a TOTAL 300ms timeout budget:

```js
async function captureScreenContext({timeoutMs = 300, maxChars = 5000}) {
  if (process.platform !== "darwin") return null;
  const startedAt = Date.now();
  const remaining = () => Math.max(20, timeoutMs - (Date.now() - startedAt));

  // Step 1: which app is frontmost? (200ms cap)
  const front = await $T({ timeoutMs: Math.min(200, remaining()) });
  if (!front) return null;

  // Step 2: AX tree traversal of focused window (remaining budget)
  let traversal = null;
  if (front.pid) {
    traversal = await xT(front.pid, {
      timeoutMs: remaining(),
      maxChars,                                            // 5k chars cap
      bundleId: front.bundleId,
      url: front.url,
    });
  }

  // Step 3: classify source
  const content = traversal?.content ?? "";
  const truncated = traversal?.truncated ?? false;
  const source =
    traversal?.source === "ax" && content.length > 0
      ? (front.url ? "browser" : "ax")
      : front.url ? "browser"
      : traversal ? "partial"
      : "empty";

  return {
    app: {name, bundleId, pid},
    windowTitle, url,
    selectedText: front.focusedElement?.textSelection ?? "",
    text: content,
    truncated, source,
    permissionDenied: front.permissionDenied,
    durationMs: Date.now() - startedAt,
  };
}
```

Notable details:
- **Hard 300ms total timeout.** Quick Chat must FEEL instant; a
  hung AX query can't block the agent loop. `remaining()` recomputes
  budget after step 1.
- **`maxChars: 5000` on the AX traversal.** Big enough for an
  article view, small enough that the prompt doesn't bloat.
- **Source classification** (`ax`/`browser`/`partial`/`empty`)
  tells the model how much to trust the snapshot — see prompt
  guidance below.
- **`permissionDenied` flagged separately.** If macOS Accessibility
  permissions aren't granted, the snapshot has `frontApp` only.
  The renderer can prompt the user to grant.

## Prompt injection

`main.js:62807` is the guidance block injected when
`hummingbirdContext` is present:

> ## `<hummingbird_context_guidance>`
>
> QuickChat messages may be prefixed with LittleBird-style XML
> tags capturing what was on the user's screen the moment they
> summoned you. Read but do not echo them back.
>
> - `<front-app name="..." bundle-id="..." window="..."
>   url="..."/>`: which app was frontmost and the active window
>   title / URL. Use to ground the scene.
> - `<text-selection>...</text-selection>`: text the user had
>   HIGHLIGHTED at summon time. Treat this as the most likely
>   target of their question — it's almost always what "this",
>   "it", "that" refers to. Quote short spans when confirming
>   you're looking at the right thing.
> - `<context>...raw AX-tree dump...</context>`: everything else
>   visible in the focused window. Noisy and may contain UI
>   chrome. Use only when the user's question can't be answered
>   from the front-app attrs or text selection alone.
>
> Priority for resolving pronouns / deictic references:
> text-selection > front-app window+url > context dump > nothing.
>
> Never:
> - Quote the entire context block back to the user.
> - Mention these tags as "tags" or "XML" — refer to what they
>   describe ("your Chrome window", "the highlighted text").
> - Assume the captured snapshot is current after tool calls; if
>   you navigate / edit / scroll via tools, the snapshot becomes
>   stale.
>
> `</hummingbird_context_guidance>`

Six teaching moves in this prompt:

1. **"LittleBird-style"** — names the tag dialect so the model
   doesn't get confused if it sees similar but distinct tags
   from other systems.
2. **Explicit prioritization for deictic resolution.** "this"
   means `<text-selection>` first, then `<front-app>` window
   title, then the broader AX dump. A clear ladder.
3. **"Read but do not echo"** — prevents the model from leaking
   the context block to the user as if it were the user's
   question.
4. **"Quote short spans when confirming"** — the bridge between
   "I know what you're pointing at" and "let me make sure":
   echo a brief slice so the user knows the AI got it right.
5. **Refer-by-description, not by tag-name.** "your Chrome
   window" not "the front-app element." User-facing language.
6. **Staleness rule.** The snapshot is a freeze-frame; tool
   calls invalidate it. Without this, the model might cite
   text that's no longer there after a `Browser.click()`.

The 6th rule is the most subtle and the most failure-prone if
omitted.

## Cooperation with renderer pre-capture

Why does the renderer get a chance to pre-capture if the main
process can capture fresh? Two reasons:

1. **Latency**: the renderer can capture WHILE the user is
   typing their Quick Chat message — the AX tree is computed
   before the WS message is even sent. Main process capture
   adds the 300ms after submission.
2. **Privacy / scope**: the renderer may want to apply user-
   level filters (e.g., redact known sensitive apps) BEFORE
   transmitting. Main process capture is unfiltered.

If renderer-supplied: `s.frontApp || s.traversal` short-circuits
the fresh capture. The `CT()` formatter (called both paths)
ensures consistent XML shape regardless of source.

## Settings gate

`main.js:60794`:

```js
if (settings?.general?.quickChatInjectScreenContext !== false) {
  // …capture and inject
}
```

Defaults ON. To disable, user sets
`general.quickChatInjectScreenContext: false` via the operator
agent (round-4 01) or Settings UI. Privacy/perf escape hatch.

## Source classification → prompt confidence

The `source` field is a tell of capture quality:

| `source` | Meaning | Prompt impact |
|---|---|---|
| `ax` | Successful AX traversal, content present | Full `<context>` block injected |
| `browser` | Browser tab — URL is best context | `url` attr used heavily; `<context>` may be reduced |
| `partial` | AX traversal returned but no content | front-app attrs only |
| `empty` | Couldn't read anything | Just app name in `<front-app>` |

This lets the model RIGHT-SIZE its confidence. An `empty` capture
shouldn't make the model claim it saw the user's screen — but
it CAN say "I see you have Notes open" from the front-app attrs.

## Permission-denied handling

`permissionDenied` propagates through. The frontApp may still
have basic info (name, bundle id) via NSWorkspace which doesn't
require Accessibility permissions, but the AX tree traversal
fails. Source becomes `empty` or `partial`. The renderer should
surface a "Grant Accessibility access in System Settings"
prompt — this isn't traced here.

## Cross-system parallel: LittleBird

The prompt explicitly says "LittleBird-style XML tags." Cross-
referencing — LittleBird is Apple's internal codename for some
of the macOS 15 / Apple Intelligence screen-context features.
Alma uses the same naming convention so that if the model has
seen LittleBird-style markup elsewhere (in training data, in
external skills, in Anthropic's system prompts), the dialect
is consistent.

This is the "**stand on existing conventions**" pattern — don't
invent your own XML tag names if a similar industry pattern
exists.

## What Maka has today

Maka has no Quick Chat global hotkey, no screen-context capture,
no AX tree integration.

Computer Use (round-2 [`01-computer-use.md`](../alma-deep-dive-yuejing-round-2/01-computer-use.md))
is the opposite direction: agent → screen actions. Hummingbird
is screen → agent context. Different surfaces, complementary.

## Ranked Maka improvements

1. **Adopt the LittleBird-style XML tag dialect.** Whenever
   Maka adds ANY screen-context injection (selection, app,
   URL, etc.), use the same tag names. Cross-system consistency
   means model behavior carries over.

2. **Text-selection-first priority for deictic resolution.**
   Even without full AX tree capture, if the user highlights
   text in any input and then triggers Maka, "this"/"that"
   should default to the highlighted text. The pattern is
   transferable.

3. **Explicit "do not echo, do not mention tags as tags"
   instructions.** When you inject structured context into a
   prompt, the model defaults to quoting back. The two-line
   prohibition prevents this entirely. Cheap, high-impact.

4. **Source classification with prompt-confidence dial.** The
   `ax`/`browser`/`partial`/`empty` ladder is generalizable.
   Any "did this capture work?" boolean is too binary; a 4-way
   classification lets the model right-size confidence.

5. **Staleness rule in the prompt.** Whenever you inject a
   point-in-time snapshot into the prompt, explicitly say "if
   tool calls modify the world, this snapshot becomes stale."
   Without this, models will cite stale snapshots after
   Browser.click(), Bash modifications, etc.

## Open questions for future rounds

- Where exactly is `CT()` defined? The formatter that produces
  the final XML block from the typed input. Probably
  straightforward but worth confirming the exact tag
  structure shipped to the model.
- Is there a Windows / Linux capture path, or just macOS? The
  early `process.platform !== "darwin"` return suggests
  macOS-only today. Round-5 candidate.
- The 300ms total timeout is shared across two AX calls. If the
  first runs slow, the second gets a much smaller budget. Does
  the second call have a minimum floor or can it get 0ms?
- LittleBird is an Apple Intelligence convention. Does alma's
  AX-tree traversal share ANY code with Apple's API (e.g.,
  the System Information AX framework), or is it a pure
  reimplementation from `osascript` / `axutil`?

## Cross-refs

- Round 2: [`01-computer-use.md`](../alma-deep-dive-yuejing-round-2/01-computer-use.md)
  — the inverse direction (agent → screen). Both depend on
  macOS Accessibility permissions; share the same enable flow.
- Round 4: [`01-rest-api-operator-agent.md`](../alma-deep-dive-yuejing-round-4/01-rest-api-operator-agent.md)
  — `quickChatInjectScreenContext` toggle lives in
  `settings.general` which the operator agent can curl.
- Round 4: [`07-websocket-sync.md`](../alma-deep-dive-yuejing-round-4/07-websocket-sync.md)
  — `hummingbirdContext` is a field on the `generate_response`
  WS message shape.
