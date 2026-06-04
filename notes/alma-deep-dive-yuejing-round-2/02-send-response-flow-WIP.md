# 02 — Send → response end-to-end flow (WIP, WAWQAQ msg c7e170c4 priority)

> WAWQAQ re-scoped the goal: trace exactly how alma takes a "user
> clicked send" event through to "model returned a complete message"
> on screen. This note pins what I've already located so the next
> round can continue without re-finding the entry points.

## Status

WIP. Entry points and the main agent loop set-up captured below;
deeper traces (per-provider transport, tool dispatch, message
finalize, renderer paint) pending next round.

## Entry points already located

### Renderer composer → IPC

Alma's renderer sits in `app/out/main/index.js` (the packaged bundle,
NOT in `readable/main.js`). Round 2 is reading `readable/main.js`
which is the *unpacked but de-obfuscated* main process. The composer
itself lives in `chunks/*-renderer.js`. Round 3 should add that to
the read window.

### Main-process agent loop (the one this note traces)

Five `streamText` (imported as `ae`) call sites found in
`readable/main.js`:

| Line | Site | What it drives |
|---|---|---|
| 21190 | `f = ae({...})` | Internal preview / utility |
| 21406 | `h = ae({...})` | Internal preview / utility |
| 54895 | `const { textStream: n } = ae({...})` | Streaming completion (likely subagent or smoke) |
| 56912 | `const r = ae({ model: p, messages: n, tools: f })` | Quick chat / single-turn |
| **63112** | `const m = ae(r)` | **Main chat agent loop** — the one to trace |

Line 63112 is inside the chat handler that processes a renderer-side
send. The setup right before/after the streamText call:

- `pu.setContext({ threadId, messageId, source })` — telemetry /
  observability context (alma uses Sentry-shaped APIs based on the
  `setContext` signature).
- `ap()` — likely starts a generation timer (alma has a
  `generationTimerResetRefs` map keyed by threadId; line 63114
  `this.generationTimerResetRefs.set(e, f)`).
- `const m = ae(r)` — kicks off the stream. `r` is the full streamText
  options object built earlier in the same function — includes
  `model`, `messages`, `tools`, `prepareStep`, `experimental_*` flags,
  and auto-compact callback.
- `hp(e, v)` — registers per-thread subagent broadcast hooks.
- `Hp(e, { broadcastBashStream, broadcastBashPartUpdate })` — wires
  Bash tool output streaming so terminal tools can push deltas back to
  the renderer as they happen.
- `broadcastThreadSync("message_delta", { messageId, threadId, deltas })`
  — central IPC fan-out function. Every streaming UI update goes
  through this single method.

### auto-compact in prepareStep

Line 63060-63095 implements alma's compaction policy inside the
`prepareStep` callback of streamText. The pattern:

1. Try real compaction (LLM-driven summary of older messages,
   preserving the most recent N).
2. On compaction failure, fall back to *hard truncation* via
   `YE(o, Math.max(st.keepRecentMessages || 4, 1))`.
3. Mutate `s.messages` in place so the next step continues with the
   compacted set.
4. Log to console at every step (`[AutoCompact:prepareStep]` prefix).

Critical observation: alma keeps a global `Xt` / `Yt` boolean (lines
63088-63089) signalling "we compacted this turn" so downstream code
(UI, telemetry) can render a compaction indicator. Maka has a
similar `compactedTokenCount` / `originalTokenCount` shape — round 3
should diff Maka's compaction path against alma's three-step
behaviour (try LLM → fallback truncate → flag global).

### broadcast surface

`this.broadcastThreadSync("message_delta", ...)` is the single egress
point from main → renderer for in-stream updates. Two
delta types observed so far:

- `{ type: "tool_output_streaming", messageId, threadId, seq, partIndex,
   toolCallId, stream }` — Bash output line-by-line
- `{ type: "part_update", messageId, threadId, seq, partIndex,
   toolCallId, updates }` — generic part state change (e.g. approval
   decision)

The `seq` field is monotonic per turn (alma increments `T` at lines
63135/63172). The renderer presumably uses this for out-of-order
detection.

## Comparison with Maka — first read

Maka's send path goes:

1. Composer `submit()` → `props.onSend(text)` → `runtime.sendMessage`
2. `runtime.sendMessage` (in `ai-sdk-backend.ts`) builds messages,
   calls `streamText` (AI SDK), iterates the result
3. Each delta forwarded via `streamEvents(sessionId, iterator, turnId)`
4. `sessions:changed` events broadcast to renderer
5. Renderer updates message list on `message-appended` reason

Symptoms WAWQAQ reported:
- Codex OAuth登录 → 测试连接 失败 (429 rate limit error from
  Anthropic-style endpoint)
- "Codex oauth 对话又不成功"
- "Claude 测试连接但是用不了"

The 429 with `rate_limit_error` suggests the request DOES authenticate
(otherwise 401). The model is probably refusing requests because:
- Maka is using a Claude Code subscription cloak path that Anthropic
  rate-limits aggressively when called from non-claude-cli UAs OR
- Maka is hitting the wrong endpoint for OpenAI Codex (chatgpt.com/
  backend-api/codex/responses vs api.openai.com/v1/responses) OR
- Maka is missing a required header that alma includes

Round 3 priority: trace alma's exact request body + headers for both
Claude OAuth and OpenAI Codex OAuth, diff against Maka's current
`subscription-auth.ts` / `claude-subscription-service.ts` /
`codex-subscription-service.ts` output, and ship the fix.

## Round-3 to-do (pinned)

1. Read alma `readable/main.js` lines around the second / third
   `streamText` site at 56912 (quick chat) — likely closest to Maka's
   `quickChat.start` path
2. Find alma's `getModel(provider)` factory for `claude-subscription`
   and `codex-subscription` — what UA / headers / beta strings does
   it set on outbound requests?
3. Open Maka's current `packages/runtime/src/subscription-auth.ts`
   and `model-fetcher.ts` and diff against alma's identical surface
4. If diff is non-trivial, ship a runtime PR (not just notes) that
   makes the OAuth-backed send path actually work — same pattern as
   round 1's PR-OAUTH-SUBSCRIPTION-0, but now covering Codex +
   Cursor + Antigravity that xuan / kenji left half-wired.

## Why this is the right priority

WAWQAQ has been blocked on the *primary product flow* — click send,
get a response — through every OAuth-related round so far. Until
this works for at least one OAuth provider end-to-end (Claude OR
Codex), every other UI polish PR is dressing on a model that doesn't
actually run. Round 3 has to be this trace + the runtime PR, not
more notes.
