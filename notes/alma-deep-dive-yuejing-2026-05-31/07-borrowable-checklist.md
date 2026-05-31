# 07 — Borrowable Checklist: Prioritized Items with Citations

**TL;DR.** 40 borrowable items across loop / tools / prompts / skills / memory / UX / bots, prioritized by ROI. Highest-ROI items: cache-marker placement for Anthropic (B-LOOP-07), the `Skill` tool to move bodies out of the system prompt (B-SKILL-02), `markActivity` from inside tools (B-LOOP-09), the `prepareStep` ToolSearch activation (B-LOOP-03), and the `toModelOutput` multimodal hook (B-TOOLS-01). Items are ordered by priority within each tier.

---

## Legend

- **Scope**: S (small, ~1 day), M (medium, 2-5 days), L (large, >1 week)
- **Risk**: low / med / high
- **Pre-req**: other item IDs that must land first
- **Status**: open (not started), partial (started/scaffolded), done (already in Maka)

---

## Tier 1: Highest ROI (do first)

These items are direct wins with low risk, citable code, and a clear Maka landing zone.

### #1 B-LOOP-07 — Anthropic cache markers (`wk` + SYSTEM INFO split)

- **Yetone**: `~/Downloads/alma-re/readable/main.js:50582-50620` (`wk()` helper) and `62807-62830` (callsite). Stamps `providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } }` on first 2 system messages + last 2 non-system. System prompt split at `"SYSTEM INFO"` line.
- **Maka**: `packages/runtime/src/ai-sdk-backend.ts:354-371` (no providerOptions today). Build system prompt with a stable/volatile boundary marker; stamp markers via a helper before calling `streamText`.
- **Scope**: S
- **Risk**: low (no-op at provider level if not supported)
- **Pre-req**: none
- **Status**: open
- **Notes**: single biggest cost saver for Anthropic users. Pair with B-LOOP-08 for full provider-options coverage.

### #2 B-SKILL-02 — Move skill bodies into `Skill` tool

- **Yetone**: `~/Downloads/alma-re/readable/main.js:24631-24684` (Skill tool execute). Returns raw markdown with absolute-path preamble; only name + 1-liner in system prompt.
- **Maka**: `apps/desktop/src/main/skills.ts:listInstalledSkills` already has `loadSkillInstructions`. Today bodies are inlined into system prompt (`MAX_SKILLS_PROMPT_CHARS = 18000`). Move out.
- **Scope**: M (new tool + system-prompt change + one-line model nudge)
- **Risk**: med (model may need adjustment period)
- **Pre-req**: none
- **Status**: open

### #3 B-LOOP-09 — `markActivity` ref from inside tools

- **Yetone**: `~/Downloads/alma-re/readable/main.js:50318-50321` (setter in `nk()`), `63113` (closure init), `63130, 63147, 63120, 63267, 62945` (resetters). Long-running tools can reset the inactivity watchdog.
- **Maka**: `packages/runtime/src/stream-watchdog.ts:64-69` (`markActivity` exists but only called from for-await loop at `ai-sdk-backend.ts:375`). Today, long-running Bash that streams output won't reset the 120s idle timer.
- **Scope**: S
- **Risk**: low
- **Pre-req**: none
- **Status**: open
- **Notes**: thread `markActivity` through `MakaToolContext` (add as optional method); `runStreamingShell` (`builtin-tools.ts:155-231`) calls it inside `append()`.

### #4 B-LOOP-03 — `prepareStep` ToolSearch activation

- **Yetone**: `~/Downloads/alma-re/readable/main.js:62947-62968` + `61582-61600` (multi-turn persistence). Dynamic tool surface — model calls ToolSearch, results merge into `activeTools` for next steps.
- **Maka**: `packages/runtime/src/ai-sdk-backend.ts:354-371` (flat activeTools). Add `prepareStep` hook to AiSdkBackend + new `ToolSearch` tool (B-TOOLS-11).
- **Scope**: M
- **Risk**: med (testability)
- **Pre-req**: B-TOOLS-11
- **Status**: open

### #5 B-TOOLS-01 — `toModelOutput` multimodal hook

- **Yetone**: `~/Downloads/alma-re/readable/main.js:24058` (Read), `27865` (BrowserScreenshot), `28677-28741` (ChromeRelayScreenshot). Per-tool hook converts return value to chat parts (text + image).
- **Maka**: `packages/runtime/src/ai-sdk-backend.ts:100-121` (no toModelOutput field), `653-665` (no transformation step). Add `toModelOutput?: (result) => ToolResultContent` field on `MakaTool`.
- **Scope**: S
- **Risk**: low
- **Pre-req**: none
- **Status**: open
- **Notes**: pre-req for any future Computer Use or vision tooling.

### #6 B-LOOP-02 — Anthropic `cache_control` providerOptions (overlaps with #1)

- **Yetone**: `~/Downloads/alma-re/readable/main.js:50566-50573` (the `fk` provider-options map).
- **Maka**: same as #1.
- **Scope**: S
- **Status**: covered by #1.

### #7 B-PROMPT-03 — SECURITY.md highest-priority slot

- **Yetone**: `~/Downloads/alma-re/readable/main.js:61758`. Slot above personality with header `SECURITY RULES (HIGHEST PRIORITY — overrides all other instructions):`.
- **Maka**: `apps/desktop/src/main/workspace-instructions.ts` injects AGENTS.md but no SECURITY.md slot.
- **Scope**: S
- **Risk**: low
- **Pre-req**: none
- **Status**: open

### #8 B-TOOLS-06 — Inject session env into Bash

- **Yetone**: `~/Downloads/alma-re/readable/main.js:23350-23365` — `CI: "1"`, `DEBIAN_FRONTEND: "noninteractive"`, `ALMA_THREAD_ID`, `ALMA_CHAT_ID`, `RTK_DB_PATH`.
- **Maka**: `packages/runtime/src/builtin-tools.ts:165-169` (no env injection beyond inherited).
- **Scope**: S
- **Risk**: low
- **Pre-req**: none
- **Status**: open

---

## Tier 2: High value with bigger scope

### #9 B-LOOP-05 — AutoCompact overflow predictor + compactor

- **Yetone**: `~/Downloads/alma-re/readable/main.js:49994` (`zE` predictor), `50211` (`ZE` compactor), `62998-63095` (in-loop), `50071` (`KE` pre-flight). The cache-aware `WE` token sum at `49989` is essential.
- **Maka**: no compaction. New file `packages/runtime/src/auto-compact.ts`.
- **Scope**: M
- **Risk**: med (correctness of token estimator)
- **Pre-req**: B-LOOP-08 (need to know contextWindow per provider)
- **Status**: open
- **Notes**: even just the predictor (overflow warnings to UI) without the summarizer is useful.

### #10 B-LOOP-08 — providerOptionsBuilder (5 providers)

- **Yetone**: `~/Downloads/alma-re/readable/main.js:62478-62620` (full branch tree).
- **Maka**: no provider-options handling. New `packages/runtime/src/provider-options.ts` keyed by `connection.providerType`.
- **Scope**: M
- **Risk**: low
- **Pre-req**: none
- **Status**: open
- **Notes**: covers Google safety/reasoning, Anthropic thinking budget, OpenAI promptCacheKey + reasoning encrypted_content, Copilot specifics, GPT-5 specifics.

### #11 B-TOOLS-10 — `Skill` tool returning raw markdown

- **Yetone**: same as #2 above.
- **Maka**: same as #2.
- **Scope**: M
- **Status**: same as #2.

### #12 B-TOOLS-04 — Bash auto-promote to background after 60s + `BashOutput` tool

- **Yetone**: `~/Downloads/alma-re/readable/main.js:23274` (background path), `23369-23523` (3-tier kill timer), `24557` (BashOutput tool).
- **Maka**: `packages/runtime/src/builtin-tools.ts:155-231` (no background, no promote). Add background registry (`Bp` equivalent) and new `BashOutput` tool.
- **Scope**: M
- **Risk**: med (process lifetime management)
- **Pre-req**: none
- **Status**: open
- **Notes**: critical for long-running `pnpm test` / `pnpm dev` / build commands.

### #13 B-TOOLS-09 — Edit multi-edit batch with bottom-up sort

- **Yetone**: `~/Downloads/alma-re/readable/main.js:24379-24400`.
- **Maka**: `packages/runtime/src/builtin-tools.ts:82-103` (single-edit only). Add batch mode + dedup + bottom-up sort.
- **Scope**: M
- **Risk**: low
- **Pre-req**: none
- **Status**: open

### #14 B-TOOLS-07 — Read image branch with multimodal output

- **Yetone**: `~/Downloads/alma-re/readable/main.js:24058`.
- **Maka**: `packages/runtime/src/builtin-tools.ts:52-68` (text-only).
- **Scope**: M (image lib + toModelOutput hook)
- **Risk**: low
- **Pre-req**: B-TOOLS-01
- **Status**: open

### #15 B-LOOP-06 — Outer retry envelope (3 buckets)

- **Yetone**: `~/Downloads/alma-re/readable/main.js:64068-64313` (`y()`).
- **Maka**: no automatic retries. Add wrapping adapter or push into `SessionManager`.
- **Scope**: M
- **Risk**: med (retry storms; needs jitter)
- **Pre-req**: none (but pairs well with B-LOOP-05 token-limit bucket)
- **Status**: open

### #16 B-BOT-02 — Channel mapping table

- **Yetone**: `~/Downloads/alma-re/readable/main.js:19147` (`Vu.getOrCreateMapping`); schema at `~/Downloads/alma-re/docs/08-memory.md §3.10`.
- **Maka**: no centralized table. Add `header.channels?` to `SessionHeader` + helper in `runtime/src/bots/`.
- **Scope**: M
- **Risk**: low
- **Pre-req**: none
- **Status**: open

### #17 B-PROMPT-04 — Tool model for micro-decisions

- **Yetone**: 38 `generateText` sites in `~/Downloads/alma-re/docs/31-llm-calls.md` (or `~/Downloads/alma-re/readable/main.js:14860, 32922, 33624, 33776, 33823, 36614, 36664, 38187, 59865`).
- **Maka**: today the user's chat model handles everything. Add `settings.toolModel` and `getToolModel()` helper.
- **Scope**: M
- **Risk**: low
- **Pre-req**: none
- **Status**: open

### #18 B-MEM-06 — Post-turn memory extraction hook

- **Yetone**: `~/Downloads/alma-re/readable/main.js` (search `summarizeAndStoreMemories`); per `01-agent-loop.md §14 step 13`.
- **Maka**: fire-and-forget after `complete` event in `ai-sdk-backend.ts:461-467`.
- **Scope**: M
- **Risk**: low-med (extra LLM calls)
- **Pre-req**: B-PROMPT-04 (use tool model)
- **Status**: open

---

## Tier 3: Targeted improvements

### #19 B-LOOP-01 — Initial `activeTools` whitelist

- **Yetone**: `~/Downloads/alma-re/readable/main.js:61582-61630`.
- **Maka**: `ai-sdk-backend.ts:358` (all tools always active).
- **Scope**: S
- **Risk**: low
- **Pre-req**: none
- **Status**: open

### #20 B-LOOP-10 — Empty-stream detection

- **Yetone**: `~/Downloads/alma-re/readable/main.js:63460-63478`.
- **Maka**: `ai-sdk-backend.ts:392-401` (only handles `finishReason === 'tool-calls'`, not zero events).
- **Scope**: S
- **Risk**: low
- **Pre-req**: none (but pairs with B-LOOP-06)
- **Status**: open

### #21 B-PROMPT-01 — System-prompt split at stable/volatile boundary

- **Yetone**: same callsites as B-LOOP-07.
- **Maka**: `ai-sdk-backend.ts:368` builds single string.
- **Scope**: S
- **Status**: covered by #1.

### #22 B-PROMPT-02 — Date awareness as user-turn `<reminder>`

- **Yetone**: `~/Downloads/alma-re/readable/main.js:61972` reinjects in user turns.
- **Maka**: `ai-sdk-backend.ts:331-333` (`buildUserContent`).
- **Scope**: S
- **Risk**: low
- **Pre-req**: B-LOOP-05 (only matters if we compact)
- **Status**: open

### #23 B-TOOLS-02 — Context-aware permission auto-bypass

- **Yetone**: `~/Downloads/alma-re/readable/main.js:19345-19400`.
- **Maka**: `permission-engine.ts:127-187` (mode is single dimension). Extend `EvaluateInput` with `bypassContext?: { isSubagent?, isCronJob?, channelSource? }`.
- **Scope**: S
- **Risk**: low
- **Pre-req**: none
- **Status**: open

### #24 B-MEM-01 — Append-only `## Auto-recorded` section in MEMORY.md

- **Yetone**: `~/Downloads/alma-re/readable/main.js:61741` (SOUL "Evolved Traits" pattern).
- **Maka**: `@maka/core` memory parser (`parseLocalMemoryMarkdown`).
- **Scope**: S
- **Risk**: low
- **Pre-req**: none
- **Status**: open

### #25 B-BOT-01 — 30s health check per bot

- **Yetone**: `~/Downloads/alma-re/readable/main.js:34696, 37952, 40536`.
- **Maka**: each `packages/runtime/src/bots/*-bridge.ts`.
- **Scope**: S per bot
- **Risk**: med (need exponential backoff)
- **Pre-req**: none
- **Status**: open

### #26 B-BOT-03 — Duplicate-suppression Set+TTL helper

- **Yetone**: `~/Downloads/alma-re/readable/main.js:34612, 36570, 37930`.
- **Maka**: new `packages/runtime/src/bots/dedup.ts` + apply per-bot.
- **Scope**: S helper + M per-bot apply
- **Risk**: low
- **Pre-req**: none
- **Status**: partial (some bots have ad-hoc dedup)

### #27 B-BOT-04 — Owner platform IDs in MEMORY.md frontmatter

- **Yetone**: USER.md format per `~/Downloads/alma-re/docs/08-memory.md §7.3`.
- **Maka**: `@maka/core` memory parser.
- **Scope**: S
- **Risk**: low
- **Pre-req**: B-MEM-01
- **Status**: open

### #28 B-BOT-05 — Per-platform system prompt fragments

- **Yetone**: `~/Downloads/alma-re/readable/main.js:35075, 35107`.
- **Maka**: `SystemPromptContext` (`ai-sdk-backend.ts:220-224`) + content writing.
- **Scope**: S iface + M content
- **Risk**: low
- **Pre-req**: B-BOT-02
- **Status**: open

### #29 B-BOT-06 — `MAKA_CHAT_*` env injection

- **Yetone**: `~/Downloads/alma-re/readable/main.js:23350-23365`.
- **Maka**: `builtin-tools.ts:165-169`.
- **Scope**: S
- **Status**: same as #8 (already covered by B-TOOLS-06).

### #30 B-BOT-09 — "Typing" indicators per bridge

- **Yetone**: per `~/Downloads/alma-re/docs/16-bots.md §10`.
- **Maka**: per-bridge `text_delta` event consumption.
- **Scope**: S per bot
- **Risk**: low
- **Pre-req**: none
- **Status**: open

### #31 B-SKILL-03 — `always-inject: true` opt-in

- **Yetone**: `~/Downloads/alma-re/readable/main.js:18705`.
- **Maka**: `skills.ts` parse + system prompt build.
- **Scope**: S
- **Risk**: low
- **Pre-req**: B-SKILL-02
- **Status**: open

### #32 B-PROMPT-05 — Anti-ChatGPT lint in default prompt

- **Yetone**: `~/Downloads/alma-re/readable/main.js:61712`.
- **Maka**: `workspace-instructions.ts`.
- **Scope**: S
- **Risk**: low (some users may prefer the default ChatGPT cadence)
- **Pre-req**: none
- **Status**: open

### #33 B-UX-01 — `electron-liquid-glass` macOS 26 corner radius

- **Yetone**: `~/Downloads/alma-re/readable/main.js:71598-71628`.
- **Maka**: `apps/desktop/src/main/main.ts` window creation.
- **Scope**: S
- **Risk**: low
- **Pre-req**: none
- **Status**: open

---

## Tier 4: Forward investments (future features)

### #34 B-TOOLS-11 — `ToolSearch` semantic discovery tool

- **Yetone**: `~/Downloads/alma-re/readable/main.js:26302-26472`.
- **Maka**: new tool. Pre-req for B-LOOP-03 (#4).
- **Scope**: M
- **Risk**: med
- **Pre-req**: B-PROMPT-04 (tool model)
- **Status**: open

### #35 B-LOOP-04 — AttemptCompletion reminder

- **Yetone**: `~/Downloads/alma-re/readable/main.js:62970-62997`.
- **Maka**: only matters if Maka adds Gemini text models.
- **Scope**: S
- **Risk**: low
- **Pre-req**: Gemini integration
- **Status**: deferred

### #36 B-UX-02 — `toolApprovalDialog` IPC shape

- **Yetone**: `preload.js` `toolApprovalDialog`.
- **Maka**: `apps/desktop/src/preload/preload.ts`.
- **Scope**: S
- **Risk**: low
- **Pre-req**: none
- **Status**: partial (Maka has its own permission UI)

### #37 B-MEM-03 — `memory/people.md` for contacts

- **Yetone**: `~/Downloads/alma-re/readable/main.js:32950, 33027, 33072`.
- **Maka**: new file when user-attribution lands.
- **Scope**: M
- **Risk**: low
- **Pre-req**: B-MEM-01
- **Status**: open

### #38 B-MEM-08 — UI/model split on compaction indicator

- **Yetone**: `~/Downloads/alma-re/readable/main.js:58412-58420, 60695-60707`.
- **Maka**: part of compaction borrow (B-LOOP-05).
- **Scope**: S
- **Risk**: low
- **Pre-req**: B-LOOP-05
- **Status**: open

### #39 B-BOT-07 — `/v1/chat/completions` OpenAI-compatible endpoint

- **Yetone**: `~/Downloads/alma-re/readable/main.js:56912`.
- **Maka**: new app-side route. Big design decision.
- **Scope**: M
- **Risk**: med (auth)
- **Pre-req**: design decision
- **Status**: deferred

### #40 B-TOOLS-14 — Per-subagent-type tool whitelists

- **Yetone**: `~/Downloads/alma-re/readable/main.js:22136`.
- **Maka**: `apps/desktop/src/main/explore-agent-tool.ts`.
- **Scope**: S to extend; M if adding multiple types
- **Risk**: low
- **Pre-req**: none
- **Status**: partial

---

## Items deliberately NOT borrowed

For cross-reference; do not implement these:

| ID | Reason |
|---|---|
| Yetone's `mu()` telemetry wrap (`main.js:18214`) | Maka uses an explicit `recordToolInvocation` callback. Cleaner. |
| Approval inline in Bash via `lh()` | Maka's separate `PermissionEngine` with parked promises is strictly better. |
| Singleton instance variables (`rS`, `cS`, ...) for windows | Un-discoverable; Maka should have a `WindowRegistry` class. |
| Bot bridges connecting to localhost over WebSocket | Adapters calling SessionManager directly is cleaner. |
| Unauthenticated `/api/*` routes (238 of them) | Maka has no Express; keep it that way. |
| `cleanupLegacyBundledSkills` destructive delete | Per `~/Downloads/alma-re/docs/21-skill-install.md §1`, this silently deletes user-edited copies. |
| Asymmetric skill override (bundled is sticky to some sources but not others) | Per `~/Downloads/alma-re/docs/21-skill-install.md §1.loadSkills`, probably a bug. If we mirror, mirror symmetrically. |
| Stealth web scraping windows (`opacity:0` + anti-detection JS) | Maka should not be in the "drive a stealth browser" business. |
| `acpx --approve-all` default-on | Per `00-GAP-ANALYSIS.md`. Subagents should still gate through permission engine. |
| `/api/chrome-relay/eval` unauthenticated REST | Per `00-GAP-ANALYSIS.md`. Anyone on localhost could run JS in any tab. |
| `execSync curl` with interpolated chatId in `/api/voice/send` | Command injection. |
| Sentry without opt-out | Maka's telemetry should be opt-in. |
| Plugin secrets plaintext JSON | Use Electron `safeStorage` / OS keychain. |

---

## Counts

- **Total items**: 40 (some overlap between layers but counted once each here)
- **By tier**: Tier 1: 8, Tier 2: 10, Tier 3: 15, Tier 4: 7
- **By scope**: S: 24, M: 14, L: 0 (no L items — Yetone's design borrows are mostly mechanic-level, not architecture-level)
- **By risk**: low: 30, med: 10, high: 0

---

## Suggested sprint plan

If a team can land 4-6 items in a sprint, suggested ordering:

**Sprint 1** (highest leverage):
1. B-LOOP-07 (cache markers) — 1d
2. B-LOOP-08 (providerOptionsBuilder) — 2d
3. B-LOOP-09 (markActivity from tools) — 1d
4. B-TOOLS-01 (toModelOutput hook) — 1d
5. B-TOOLS-06 (env injection) — 0.5d
6. B-PROMPT-03 (SECURITY.md slot) — 0.5d

**Sprint 2** (skill system overhaul):
1. B-SKILL-02 (Skill tool) — 3d
2. B-SKILL-03 (always-inject) — 0.5d
3. B-TOOLS-04 (Bash background) — 3d
4. B-LOOP-01 (initial activeTools) — 0.5d

**Sprint 3** (loop polish + bot story):
1. B-LOOP-03 + B-TOOLS-11 (prepareStep + ToolSearch) — 4d
2. B-LOOP-05 (compactor) — 3d
3. B-BOT-01 (health checks) — 1d
4. B-BOT-02 (channel mapping) — 2d

**Sprint 4** (memory + UX polish):
1. B-MEM-01 + B-MEM-06 (auto-record + post-turn extract) — 3d
2. B-PROMPT-04 (tool model) — 1d
3. B-LOOP-06 (retry envelope) — 2d
4. B-UX-01 (liquid glass) — 0.5d

After Sprint 4, the agent loop is comparable to Yetone's with cleaner architecture, the skill system scales beyond 12 entries, and the bot bridges are production-resilient.
