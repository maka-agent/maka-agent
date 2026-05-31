# 00 — Overview & Map of the Yetone Desktop Client Reverse Notes

**TL;DR.** The reference repo at `~/Downloads/alma-re/` is a 38-doc + 1 prettified `main.js` (74,182 lines) study of Yetone's closed-source AI companion desktop app v0.0.798. The bundle is a single Electron main process around the Vercel AI SDK `streamText`, augmented with: a 35-tool registry (Claude Code style), 33 bundled Anthropic-format skills, sqlite-vec memory, a Markdown "soul tree" at `~/.config/alma/`, four IM bridges (Telegram/Discord/Feishu/WeChat), a Swift Computer-Use daemon over a Unix socket, and a Chrome MV3 extension over WebSocket. Highest-leverage borrowing targets for Maka are: (1) the `prepareStep` triad — dynamic `ToolSearch` activation + AttemptCompletion reminder + in-loop AutoCompact, (2) the per-tool `experimental_toToolResultContent` multimodal hook, (3) cache-marker placement for Anthropic prompt caching, (4) the per-thread inactivity watchdog reset (`f.current`), and (5) `widgetReadme`'s progressive-disclosure pattern for huge style guides.

---

## 1. What the app actually is

Per `~/Downloads/alma-re/README.md` and `STUDY-GUIDE.md` §一:

- One Electron main process (`app/out/main/index.js`, ~74K prettified lines at `~/Downloads/alma-re/readable/main.js`).
- A preload that bridges 30 namespaces + 144 IPC handlers to 8 HTML renderer entries.
- Vercel AI SDK `streamText` for the chat agent (44 LLM call sites across the bundle).
- `better-sqlite3` + Drizzle (typed query builder only, raw `CREATE TABLE` DDL) at `~/Library/Application Support/alma/chat_threads.db` — 49 logical tables incl. `sqlite-vec` `memory_embeddings` and `messages_fts`.
- Markdown "soul tree" at `~/.config/alma/` (SOUL.md / USER.md / MEMORY.md / HEARTBEAT.md / diary / people / chats / groups / selfies / skills / plugins).
- macOS Swift `AlmaComputerUse.app` daemon over `~/Library/Application Support/Alma/computer-use.sock` for AX + CGEvent control.
- MV3 Chrome extension that connects back to `ws://127.0.0.1:23001/ws/browser-relay` and drives the user's real Chrome via the DevTools protocol.
- Local Express HTTP server on `:23001` (238 routes + 11 WebSocket paths) — the universal "skill ↔ agent ↔ UI gateway".
- A separate `alma` CLI binary (Bun-compiled, ~150 sub-commands) that is how skills reach the running app — every skill calls `alma foo` which translates to `http://localhost:23001/api/...`.

The product positioning is two-headed: a Claude-Code-style engineering agent + an AI girlfriend / companion. Maka shares only the first hemisphere; the second one (SOUL.md persona evolution, NSFW selfie SOUL config, AntiBub group identity defense) is mostly out of scope for Maka but the underlying mechanisms (per-actor state files, drip-fed self-mutation, cron heartbeats, fatigue model) are still architecturally interesting.

---

## 2. Repository layout in `~/Downloads/alma-re/`

```
alma-re/
├── README.md                            # 70-line intro, layout, license, learning paths
├── STUDY-GUIDE.md                       # First-pass overview (superseded by docs/00-INDEX.md, still useful for grep targets)
├── app/                                 # Original packaged Electron shape (out/main/index.js, out/preload, out/renderer)
├── readable/
│   ├── main.js                          # Prettier-formatted main bundle, 74,182 lines
│   └── preload.js                       # 544-line preload bridge
└── docs/                                # 38 deep-dive Markdown notes, ~55,409 lines, 2.6 MB
    ├── 00-INDEX.md                      # Master index + reading paths
    ├── 00-GAP-ANALYSIS.md               # Cross-doc corrections + 35 surprise findings
    ├── 01-agent-loop.md                 # streamText, prepareStep triad, AutoCompact
    ├── 02-tools.md                      # 35-tool registry, approval, streaming, redaction
    ├── 03-prompts.md ★                  # 47 prompt sites verbatim, largest gold mine (1930 lines)
    ├── 04-skills.md                     # 33 bundled SKILL.md packages walkthrough
    ├── 05-express-api.md                # 238-route HTTP gateway, security audit
    ├── 06-computer-use.md               # Swift daemon, NDJSON over UDS, AX + CGEvent
    ├── 07-chrome-extension.md           # MV3 + WebSocket + CDP fan-out
    ├── 08-memory.md ★                   # SQLite + sqlite-vec + soul tree + sleep loop
    ├── 09-mcp.md                        # 3 transports + OAuth 2.1 PKCE
    ├── 10-cli-tui.md                    # 74-verb CLI + Ink TUI
    ├── 11-providers.md                  # 17 provider types + reasoning + claude-subscription impersonation
    ├── 12-renderer.md                   # 8 HTML / 30 preload namespaces / 144 IPC
    ├── 13-aux.md                        # Activity Recorder, Sentry, acpx, updater
    ├── 14-browser-engines.md            # PinchTab (hidden Electron) vs ChromeRelay (real Chrome)
    ├── 15-renderer-chunks.md            # 384 build chunks decoded
    ├── 16-bots.md                       # Telegram / Discord / Feishu / WeChat bridges
    ├── 17-workspaces-git.md             # auto-worktree + gh CLI + .alma-snapshots/
    ├── 18-prompt-apps.md                # {{var}} and ｛｛var｝｝ templates
    ├── 19-time-driven.md                # Cron / Heartbeat / Fatigue / Missions / Cloud sync
    ├── 20-acp.md                        # JSON-RPC 2.0 + ToolProxyHost
    ├── 21-skill-install.md              # skillflag + zip-slip safety
    ├── 22-embeddings.md ★               # 4 triggers, 4-layer sleep cycle
    ├── 23-bash-sandbox.md               # 51 safe + 27 dangerous regex + rtk token compressor
    ├── 24-telemetry.md                  # PostHog 13 events, Sentry, updater
    ├── 25-native-modules.md             # 22 .node bindings + Swift + uv + rtk
    ├── 26-image-gen.md                  # 3 provider branches, silent ref-image drop bug
    ├── 27-video-analysis.md             # Gemini Files API via CLI, not main.js
    ├── 28-audio-pipelines.md            # TTS 3 fallback + Whisper 4 entries
    ├── 29-selfie-consistency.md         # "algorithm" = 5 random JPEGs
    ├── 30-plugins.md                    # Plugins vs Skills, zero shared paths
    ├── 31-llm-calls.md ★                # All 44 LLM call sites (38 generateText, 4 streamText, 0 generateObject)
    ├── 32-companion-state.md            # Travel / People / Emotion / SOUL state
    ├── 33-hooks-cookies.md              # mu() lifecycle + unidirectional cookie sync
    ├── 34-onboarding-tcc.md             # 30-sec cinematic onboarding + 7×Space easter egg
    ├── 35-tui-modules.md                # 22 TUI modules, 4 themes, Kitty graphics
    ├── 36-api-spec.md                   # Hardcoded 10 KB template literal self-describing the REST API
    └── 37-small-tools.md                # WebFetch / Glob / Grep / Read / Write / Edit deep dive
```

There are also Wave 4 (38-45) and Wave 5 (46-67) docs covering verbatim code extracts, deep telegram/discord/feishu, hooks/cookies, notification tricks, etc. For this audit we leaned on 00-INDEX, 01, 02, 03, 04, 08, 12, 15, 16, 21 (per the brief) and skimmed the rest only when a borrow-target needed verification.

---

## 3. Top-of-tree mental model

The "soul of the system" diagram (from 00-INDEX.md §三波后的核心心智模型):

```
                ┌────────────────────────────────────────────────────────────┐
                │ Electron main process — out/main/index.js, 74K lines       │
                │  • Vercel AI SDK streamText (one main call + 4 ancillary)  │
                │  • Express :23001 — 238 routes, mostly token-less          │
                │  • WebSocketServer — 11 paths; only /ws/browser-relay      │
                │    requires a token                                        │
                │  • SQLite (better-sqlite3) + sqlite-vec, 49 tables, schema │
                │    version 6 with FTS5 (jieba CJK tokenizer)               │
                │  • 17 provider types via @ai-sdk/* + claude-subscription   │
                │    (Pro account impersonation by UA + ephemeral cache_ctrl)│
                │  • MCP client (3 transports + OAuth 2.1 PKCE)              │
                │  • Hooks bus `Pd` — 7 event names × (plugin layer + shell  │
                │    layer)                                                   │
                └─┬─────────┬───────────┬────────────┬────────────┬─────────┘
                  │         │           │            │            │
                  ▼         ▼           ▼            ▼            ▼
            Renderer    Bundled      AlmaCU       Chrome       alma CLI
            (Electron)  Skills (33)  Swift        Extension    (~74 verbs)
            multi-      + Plugins(8) daemon       MV3 SW       + Ink TUI
            window      + Artifacts  unix socket  WS + CDP     (22 modules)
            (8 HTML)    (Bun)        NDJSON                    + Bun (55 MB)
                                                                  │
                                                                  ▼
                                                      ┌───────────────────┐
                                                      │ ~/.config/alma/   │
                                                      │   SOUL.md/USER.md │
                                                      │   MEMORY.md/...   │
                                                      │   chats/groups/   │
                                                      │   selfies/skills/ │
                                                      │   cron/missions/  │
                                                      └───────────────────┘
```

Design slogan (from README): **"SQLite is data, Markdown is identity, Bash is the universal interface, LLM is the orchestrator."**

For Maka, the analogue is:

```
                ┌─────────────────────────────────────────────────────────┐
                │ Electron main — apps/desktop/src/main/main.ts (2722 ln) │
                │  • @maka/runtime AiSdkBackend (1177 ln) wraps ai-sdk    │
                │  • PermissionEngine (241 ln) — policy + parked promise  │
                │  • StreamWatchdog (119 ln) — connect+idle two-phase     │
                │  • SessionManager (717 ln) — turn lineage + branching   │
                │  • LocalMemoryService — transparent MEMORY.md           │
                │  • Bot bridges: WeChat / Discord / DingTalk / QQ        │
                └─────────────────────────────────────────────────────────┘
```

There is no Express gateway, no skill CLI translation layer, no separate daemon, no MV3 extension. The skill surface in Maka is just `skills.ts` parsing `<workspace>/skills/<id>/SKILL.md` directly. That's a *much* smaller blast radius and a feature when it comes to security review — but a lot of the borrowable patterns below are about the borrowed mechanics, not the surface.

---

## 4. Top 10 architectural decisions worth borrowing

Ranked by ROI for Maka, with citations and a one-line scope estimate (full checklist with risk notes is in `07-borrowable-checklist.md`).

### 4.1 The `prepareStep` triad

Citation: `~/Downloads/alma-re/readable/main.js:62944-63096`; analysis at `~/Downloads/alma-re/docs/01-agent-loop.md §7`.

Three orthogonal jobs run before every step of the chat loop, returning an updated `{activeTools?, messages?}`:

1. **Dynamic `ToolSearch` activation** (L62947-62968): if the previous step called `ToolSearch`, take the tool IDs out of its result and add them to `activeTools` for all subsequent steps. The set is per-turn (`Ht = new Set()` at L62895) but is *also* pre-populated from history scans at L61582-61600 so multi-turn discovery is sticky.
2. **AttemptCompletion reminder** (L62970-62997): for Gemini text models that won't naturally stop, inject `<system-reminder>` until they call `AttemptCompletion`, max 3 times per turn (`Nt = 3`).
3. **In-loop AutoCompact** (L62998-63095): if `zE()` predicts overflow on the next call, compact the message stack with `ZE()` and feed the rewritten array back via `s.messages`. Bonus +1 step grant via `Yt = true`.

For Maka, today's `packages/runtime/src/ai-sdk-backend.ts:354-371` only sets a flat `activeTools: this.input.tools.map(...)` and `stopWhen: stepCountIs(this.maxSteps)`. None of the three responsibilities exist. Borrowing #1 alone is a real unlock for "dynamic tool fan-out" — let small models start with `Read/Glob/Grep/Bash` plus `ToolSearch`, then progressively widen. Estimate: M (touches `ai-sdk-backend.ts` `wrapToolExecute` + new `ToolSearch` impl). See `01-agent-loop.md` and `02-tools.md` in this note set.

### 4.2 `experimental_toToolResultContent` multimodal hook

Citation: `~/Downloads/alma-re/readable/main.js:24058` (Read), `27865` (BrowserScreenshot), `28677-28741` (ChromeRelayScreenshot); `02-tools.md §17-27`.

The Vercel AI SDK exposes a per-tool hook that converts a tool's return value back into chat parts (text + image). Yetone uses it to return a 1024-pixel JPEG thumb to the model while saving the full-res screenshot to `os.tmpdir()` for later inspection. The model sees both the text caption and the multimodal image data.

In Maka, `packages/runtime/src/builtin-tools.ts:52-68` Read just returns `{ content }`. We have no image-aware tool today. Borrowing this is a prerequisite for any future Computer-Use or web-browsing tool. Estimate: S (define a `toModelOutput` field on `MakaTool` and wire it through `wrapToolExecute`'s return path).

### 4.3 Cache-marker placement for Anthropic prompt caching

Citation: `~/Downloads/alma-re/readable/main.js:50582-50620` (`wk()` helper) and `62807-62830` (callsite); `01-agent-loop.md §2`.

Yetone stamps `providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } }` on exactly 4 messages: the first 2 system messages and the last 2 non-system messages. The system prompt is also split at the `"SYSTEM INFO"` line so the stable bulk and the per-platform tail become two separately cacheable parts. Log marker: `"[PromptCache] Applied cache markers for ${provider}..."`.

Maka's `packages/runtime/src/ai-sdk-backend.ts` doesn't pass any `providerOptions` to `streamText` and therefore gets zero cache hits on Anthropic. With the way our system prompt is assembled in `resolveSystemPrompt()` (which merges Skills + AGENTS.md), the bulk of every turn's tokens are cacheable. Adding `wk()`-style markers is probably the highest-ROI single change in this whole note set for users on Anthropic. Estimate: S (`ai-sdk-backend.ts` `pump` function, ~20 lines added).

### 4.4 Per-thread inactivity watchdog reset (`f.current`)

Citation: `~/Downloads/alma-re/readable/main.js:50289-50335` (`nk()` watchdog generator), `63113` (closure init), `62945, 63130, 63147, 63120, 63267` (resetters); `01-agent-loop.md §11`.

The watchdog has *two* clocks: a 60s (180s for image, 300s for ACP, 600s for tool execution) stream-inactivity timer that can be reset from anywhere via `f.current?.()`, and a hard 4-hour total-generation timer (L63260, `144e5 ms = 4h`). Anyone in the codebase that does work for this thread can call `f.current?.()` — `prepareStep` first line, the Bash streaming callback, the broadcast tool-state callback, the subagent event broadcaster, plus a global "beat" registered via `vr()`.

Maka's `StreamWatchdog` (`packages/runtime/src/stream-watchdog.ts`) is closer than I expected — it has connect + idle phases and exposes `pause()` / `resume()` for permission waits (used by `wrapToolExecute` at L595-597). What's missing is the `markActivity()` *from inside tool implementations* — a long-running Bash that streams output every 10s will not reset the 120s watchdog because no SDK event lands. Borrow: thread `markActivity` (or a closure ref like `f.current`) through `MakaToolContext` so `runStreamingShell` calls it on every chunk. Estimate: S.

### 4.5 Progressive disclosure via `widgetReadme`

Citation: `~/Downloads/alma-re/readable/main.js:28877-28906`; `02-tools.md §40`.

`widgetReadme(modules: ["art"|"mockup"|"interactive"|"chart"|"diagram"])` returns 10–40 KB of style guide that doesn't live in the system prompt. The model calls it on demand the first time it intends to render visuals. Same pattern as `Skill` tool returning skill.content on demand.

For Maka, when we eventually add chart/diagram/widget rendering this is the canonical way to keep the base system prompt small while still shipping a tight style guide. Estimate: M (new tool + curated guideline strings).

### 4.6 SOUL.md / USER.md / MEMORY.md as triple "Markdown is identity" pattern

Citation: `~/Downloads/alma-re/docs/03-prompts.md §2-§4`, `08-memory.md §7`, prompt assembly at `main.js:61711, 61679, 61741, 61897-62141`.

Yetone stores three classes of long-term identity in user-editable Markdown:

- **SOUL.md**: AI's own self-concept; only the `## Evolved Traits` section is append-only by the AI via `alma soul append-trait`.
- **USER.md**: owner's profile, with YAML frontmatter holding cross-platform IDs.
- **MEMORY.md**: long-form free-text memory companion to SQLite.

Maka already has the right instinct here — `apps/desktop/src/main/local-memory-service.ts` exposes a transparent `<workspace>/memory/MEMORY.md`. What's missing is the *prompt-side discipline*: the three files are unconditionally injected with a clear "what each does" header (`USER PROFILE...`, `SOUL...`, `SECURITY RULES (HIGHEST PRIORITY)`), and the AI is *taught* (via prompt) how and when to mutate them. See `04-memory.md` for the comparison.

Estimate: S to M (mostly prompt + a small append-trait skill).

### 4.7 The `Skill` tool as on-demand instruction loader

Citation: `~/Downloads/alma-re/readable/main.js:24627-24684`; `02-tools.md §11`, `04-skills.md`.

Only skill name + one-line description go in the system prompt. The full SKILL.md content is loaded only when the model invokes the `Skill` tool. The execute returns a *single string* (not an object) — the skill's full Markdown with an injected preamble that fixes the working directory. The "two-stage prompting" is fully hands-off for the model: it just calls a tool.

Maka's current skills (`apps/desktop/src/main/skills.ts`) are loaded as system-prompt fragments (up to `MAX_SKILLS_PROMPT_CHARS = 18000`). Switching to the Yetone pattern would let us scale to 60+ skills without bloating the prompt. Estimate: M (new tool + `loadSkillInstructions` already exists in `skills.ts`).

### 4.8 The harness mode (Planner → Generator → Evaluator)

Citation: `~/Downloads/alma-re/readable/main.js:22272-22478` (Task tool execute), `21900-ish` (mission orchestrator); `02-tools.md §9`, `08-memory.md §3.5`.

When `handoff.harness.enabled === true`, the Task tool routes to a Planner→Generator→Evaluator loop persisted in 6 SQLite tables: `agent_missions`, `agent_runs`, `agent_handoffs`, `mission_sprints`, `sprint_contracts`, `sprint_evaluations`. Per-mission `spec_artifact_path` writes a sidecar markdown under `~/.config/alma/missions/`.

Maka has nothing equivalent today. This is a heavyweight borrow (L) but the *schema design* alone (especially `UNIQUE idx_agent_missions_thread_root` for idempotent `getOrCreateAgentMission`) is worth borrowing if we ever do multi-sprint work.

### 4.9 Bottom-up `Edit` operations with hash-line IDs

Citation: `~/Downloads/alma-re/readable/main.js:24254-24506` (Hm = hash-line Edit) and `24131-24252` (jm = classic search/replace); `02-tools.md §6`.

Yetone gates two completely different `Edit` tools behind `yh()`. The hash-line variant uses 2-char MD5 hashes from a 16-char alphabet `"ZPMQVRWSNKTXJBYH"` (Z, P, M, Q, V, R, W, S, N, K, T, X, J, B, Y, H — all uppercase). Read prefixes each line with `LINE#ID:` so subsequent Edit calls reference `pos: "12#PK"`. The hash verification (`Sm()`) catches drift and rerenders updated hashes on mismatch (`Im` HashlineMismatchError).

For Maka, today's Edit (`packages/runtime/src/builtin-tools.ts:82-103`) is uniqueness-checked search/replace. Borrowing the hash-line variant is overkill for now but the *bottom-up sort* (edits sorted DESC by line so earlier indices don't shift) is a strict bug fix for multi-edit batches. Estimate: M for hash-line, S for bottom-up sort.

### 4.10 Approval auto-bypass policy in `lh()`

Citation: `~/Downloads/alma-re/readable/main.js:19345-19400`; `02-tools.md §0 (Approval architecture)`.

`lh()` auto-approves when *any* of: `settings.security.autoApproveToolRequests === true`, `metadata.isSubagent === true`, source ∈ {telegram, discord, feishu, cron, heartbeat}, thread is mapped to a chat platform, thread title startsWith `"⏰ Cron:"`. Also supports `ALMA_HEADLESS=1` with `ALMA_TOOL_APPROVAL=allow|deny`.

Maka's `PermissionEngine` doesn't have any of these context-aware bypasses. The "subagent + cron + bot + headless" carve-outs map cleanly to Maka concepts (we already have `permissionMode`). Estimate: S (a few well-named conditions in `permissionEngine.evaluate`).

---

## 5. Doc-to-topic map (which file covers what)

For "I need to know X" navigation:

| Topic | Primary doc |
|---|---|
| Agent loop (streamText, retries, watchdog) | `~/Downloads/alma-re/docs/01-agent-loop.md` |
| Tool registry, approval gate, streaming hooks | `~/Downloads/alma-re/docs/02-tools.md` |
| All 47 prompt sites verbatim | `~/Downloads/alma-re/docs/03-prompts.md` |
| 33 bundled SKILL.md packages | `~/Downloads/alma-re/docs/04-skills.md` |
| 238 Express routes (security audit) | `~/Downloads/alma-re/docs/05-express-api.md` and `~/Downloads/alma-re/docs/51-express-handlers.md` |
| Computer Use over UDS | `~/Downloads/alma-re/docs/06-computer-use.md` |
| Chrome MV3 + CDP relay | `~/Downloads/alma-re/docs/07-chrome-extension.md` |
| SQLite + sqlite-vec + soul tree | `~/Downloads/alma-re/docs/08-memory.md` |
| MCP integration (3 transports, OAuth) | `~/Downloads/alma-re/docs/09-mcp.md` |
| `alma` CLI verbs + Ink TUI | `~/Downloads/alma-re/docs/10-cli-tui.md` |
| 17 provider types + reasoning | `~/Downloads/alma-re/docs/11-providers.md` |
| Multi-window architecture, IPC bridge | `~/Downloads/alma-re/docs/12-renderer.md` |
| Activity Recorder, Sentry, updater | `~/Downloads/alma-re/docs/13-aux.md` |
| PinchTab vs ChromeRelay engines | `~/Downloads/alma-re/docs/14-browser-engines.md` |
| 384 renderer chunks decoded | `~/Downloads/alma-re/docs/15-renderer-chunks.md` |
| Telegram / Discord / Feishu / WeChat | `~/Downloads/alma-re/docs/16-bots.md` |
| auto-worktree + `.alma-snapshots/` | `~/Downloads/alma-re/docs/17-workspaces-git.md` |
| Prompt apps + slash commands | `~/Downloads/alma-re/docs/18-prompt-apps.md` |
| Cron / heartbeat / fatigue | `~/Downloads/alma-re/docs/19-time-driven.md` |
| ACP coding-agent subagents | `~/Downloads/alma-re/docs/20-acp.md` |
| Skill install + skillflag CLI | `~/Downloads/alma-re/docs/21-skill-install.md` |
| Embeddings, sleep loop | `~/Downloads/alma-re/docs/22-embeddings.md` |
| Bash safe/dangerous regex | `~/Downloads/alma-re/docs/23-bash-sandbox.md` |
| Telemetry / Sentry / auto-update | `~/Downloads/alma-re/docs/24-telemetry.md` |
| Native modules | `~/Downloads/alma-re/docs/25-native-modules.md` |
| Plugins system | `~/Downloads/alma-re/docs/30-plugins.md` |
| All 44 LLM call sites | `~/Downloads/alma-re/docs/31-llm-calls.md` |
| Companion state machines | `~/Downloads/alma-re/docs/32-companion-state.md` |
| Hooks + cookies | `~/Downloads/alma-re/docs/33-hooks-cookies.md` |
| TUI walkthrough | `~/Downloads/alma-re/docs/35-tui-modules.md` |
| Renderer entry points | `~/Downloads/alma-re/docs/53-renderer-entries.md` |
| Boot sequence | `~/Downloads/alma-re/docs/49-boot-sequence.md` |
| Settings tree | `~/Downloads/alma-re/docs/50-settings-tree.md` |
| Cross-doc corrections | `~/Downloads/alma-re/docs/00-GAP-ANALYSIS.md` |

---

## 6. Reading order for the Maka audit lens

If a Maka contributor is short on time:

1. **`01-agent-loop.md`** (this note set) — the highest-density single read. Covers the streamText surface, prepareStep triad, error/retry envelope, watchdog wiring.
2. **`07-borrowable-checklist.md`** (this note set) — the prioritized hit list. Skip directly here if you want to plan a sprint.
3. **`02-tools.md`** (this note set) — the multimodal hook and the `widgetReadme` / `Skill` progressive-disclosure pattern.
4. **`04-memory.md`** (this note set) — only ~30% applies (no SQLite migration), but the conceptual model is gold.
5. The original `~/Downloads/alma-re/docs/01-agent-loop.md §19` "Key insights & non-obvious tricks" — 20 numbered insights, all citable.

---

## 7. Hard constraints worth recording

These are *not* borrowing opportunities; they're hazards or anti-patterns surfaced by the gap analysis:

- **`/api/chrome-relay/eval` is REST without a token** — any local process can run JS in any tab the user has opened. We do not have an equivalent in Maka and should not introduce one.
- **`/api/voice/send` shell-injects `chatId` into `execSync curl`** — Maka's `wechat-bridge.ts` uses `fetch` + `JSON.stringify` and is correct.
- **Sentry without opt-out** — Maka should keep telemetry opt-in.
- **Plugin secrets stored as plaintext JSON** (no keychain).
- **`/api/skills/install` is unauthenticated and skillflag has documented zip-slip safety only inside `extract.js`** — anyone on `localhost:23001` could install arbitrary skills. The fix is to require auth.
- **`acpx --approve-all` is on by default** — child Claude/Codex sub-agents run with zero gating.
- **`maxOutputTokens` is *deliberately* unset for OpenAI Copilot GPT models** to sidestep the Responses API ceiling (`main.js:62888`). This is a real and reasonable workaround; Maka should consider the same conditional.
- **Bundled skill override is asymmetric** — `~/.codex/skills/` and project `.alma/skills/` can override a bundled name; `~/.config/alma/skills/` and `~/.claude/skills/` *cannot*. This is per `docs/21-skill-install.md §1` and is probably a bug, not an intentional design. If Maka mirrors this, mirror the symmetric version.

---

## 8. Files in this note set

- `00-OVERVIEW.md` (this file)
- `01-agent-loop.md` — streamText loop comparison
- `02-tools.md` — tool registry + permission + streaming
- `03-prompts-and-skills.md` — prompt assembly + skill loading + install
- `04-memory.md` — SQLite, sleep loop, vs Maka's transparent MEMORY.md
- `05-renderer-and-ux.md` — 8-window renderer, IPC bridge, settings UX
- `06-bots-and-integrations.md` — Telegram / Discord / Feishu / WeChat
- `07-borrowable-checklist.md` — prioritized list with citations, scope, risk

The final report (returned to the calling agent) will summarize the top 5 borrows.
