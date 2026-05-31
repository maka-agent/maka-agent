# 08 — Extended topics (MCP, prompt apps, time-driven, ACP, embeddings, bash sandbox)

> Sixth pass through the alma reverse-engineering output. Covers topics that
> notes 00-07 only mentioned in passing. Sources for every citation:
>
> - `~/Downloads/alma-re/docs/<NN>-*.md` (the alma re-eng docs themselves)
> - `~/Downloads/alma-re/readable/main.js` (74,182 lines, prettified)
>
> Maka paths are absolute under
> `/Users/jakevin/.slock/agents/7938a367-9890-464e-96f3-76954e837850/workspace/maka/`.

---

## TL;DR

1. **MCP**. alma is a full MCP **client** with three transports
   (stdio / streamable HTTP / SSE) + OAuth 2.1 + PKCE + DCR + safeStorage
   tokens. Config lives in `~/.config/alma/mcp.json`; per-server tokens in
   SQLite. Maka has zero MCP today. Top borrow: the JSON-config + tool-name
   prefix (`server__tool`) + JSON-Schema→Zod converter pattern.
2. **Prompt apps**. SQLite-backed packaged-prompt-with-form-schema. Launches
   its own BrowserWindow, model + tool + reasoning override, optional
   `expectsImageResult` retry loop (≤10 retries), optional global hotkey.
   `{{var}}` and full-width `｛｛var｝｝` interpolation. Maka has no equivalent
   — closest is the in-flight quick-chat affordance.
3. **Time-driven**. Heartbeat + Cron + ActivityRecorder fire on timers and
   inject `generate_response` envelopes back over a local WebSocket so
   scheduled work flows through the same code path as inbound chat. Cron jobs
   are AI cron — each tick spawns a fresh thread, lets the agent work, sends
   result to Telegram/Discord, then archives the thread. Maka has nothing
   wake-the-agent-on-a-schedule.
4. **ACP**. alma drives external coding agents (Claude Code, Codex CLI,
   Gemini, OpenCode) via Agent Client Protocol (JSON-RPC over stdio). Has a
   `ToolProxyHost` TCP server that lets the sub-agent reach back into alma's
   host tools as if they were MCP. Maka has no sub-agent dispatch protocol.
5. **Embeddings**. sqlite-vec virtual table + dispatcher across OpenAI /
   Google / local ONNX (Transformers.js, 4 bundled Xenova models). Two-pass
   dedup (write-time LLM duplicate check + nightly 4-layer sleep cycle).
   Maka has no embeddings, no recall, just transparent re-read of
   MEMORY.md.
6. **Bash sandbox**. There isn't one. alma's defense is regex pre-filter +
   LLM "security analyzer" + user approval modal + cached `allow_always`
   keys. Past that: `spawn("/bin/bash", ["-l", "-c", cmd])` as the user
   with full network and disk. Maka uses the same `spawn(shell:true)` pattern
   but lacks the analyzer, idle watchdog, auto-promote, and env injection.

Top 5 borrow candidates (full list at end):

- **B-SBX-01** — workspace-relative redirection re-classifier (turn risky
  `>file` into low-risk when target is inside workspace).
- **B-TIME-01** — cron-style scheduled agent ticks via the same chat path
  (one code path for "user asked" and "timer fired").
- **B-MCP-01** — JSON config (`mcp.json`) + per-server prefixed tool names
  + JSON-Schema→Zod converter. Ship even before transports.
- **B-PAPP-01** — Prompt-App row format with placeholder schema and
  `expectsImageResult` retry loop.
- **B-SBX-04** — Bash auto-promote-to-background after 60s + idle watchdog
  with explanatory kill message.

---

## 1. MCP (Model Context Protocol)

### 1.1 alma's design

- **Imports**, `main.js:179-193`: SDK pulled from
  `@modelcontextprotocol/sdk` with three transports (`StdioClientTransport`,
  `StreamableHTTPClientTransport`, `SSEClientTransport`) plus
  `Client`, `auth`, `OAuthError` family. WebSocket transport from the SDK
  is deliberately not imported. Cited in
  `~/Downloads/alma-re/docs/09-mcp.md §1`.
- **Source of truth at runtime**: file
  `~/.config/alma/mcp.json` (Claude-Desktop-compatible shape:
  `{ mcpServers: { name: { command, args, env } | { url, headers, transport } } }`).
  `main.js:25212-25225` defines `configPath`; predicates `jn` (`"command" in e`)
  and `Wn` (`"url" in e`) discriminate the union at
  `main.js:611-616`. REST endpoints under `/api/mcp-servers/*` proxy onto
  the JSON file (`main.js:66560-66742`).
- **SQLite tables**: `mcp_servers` (legacy, mostly for `registry_id`) and
  `mcp_oauth_tokens` (real credential store), `main.js:617-657`. The OAuth
  table dropped its FK to `mcp_servers` via a one-time migration at
  `main.js:2784-2826` so server renames don't cascade-delete tokens.
- **Token storage**: tokens + refresh + client_secret + code_verifier
  encrypted via Electron `safeStorage.encryptString(s).toString("base64")`
  with a plain-base64 fallback on Linux without libsecret
  (`main.js:24730-24739`). Cited `~/Downloads/alma-re/docs/09-mcp.md §3`.
- **Lifecycle** (`main.js:25212-25535`): singleton `Tf` extends
  `EventEmitter` and owns `Map<name, ServerInstance>`. Per-server:
  `client.connect(transport)` raced against 30s (remote) / 60s (stdio)
  timeout; `listTools` raced against 15s; `callTool` raced against
  **600,000 ms (10 minutes)** at `main.js:25519`. Stderr ring buffer keeps
  last 10 lines per stdio server and prepends them to error messages
  (`main.js:25226`). **No auto-restart** — server stays dead until user
  hits Reconnect (REST: `POST /api/mcp-client/reconnect/:name`).
- **Tool naming** (`main.js:25186-25203`):
  `<dns-safe-server-name>__<safe-tool-name>` with double-underscore
  separator. Functions: `yf` (DNS-safe), `wf` (safe-tool), `bf` (combine).
- **JSON-Schema → Zod** conversion at `main.js:25642-25676`. Walks `type`
  to produce `z.string`/`z.number`/`z.boolean`/`z.array`/`z.object`/`z.null`.
  Drops `oneOf`/`anyOf`/`allOf`, `pattern`, `format`,
  `minimum`/`maximum`, `additionalProperties` — lossy by design.
- **OAuth flow** (`main.js:24878-25185`): app-level manager `gf` opens a
  local HTTP listener at `http://127.0.0.1:<port>/mcp/oauth/callback` (port
  fixed up after Express binds, default guess 23001). PKCE code_verifier
  persisted to DB so flow survives an app restart. `clientMetadata` sent
  during DCR identifies as `{ client_name: "Alma Desktop",
  token_endpoint_auth_method: "none", grant_types:["authorization_code",
  "refresh_token"], response_types:["code"] }`. Periodic refresh every
  5 minutes for tokens within 600s of expiry (`main.js:24890`). Per
  `~/Downloads/alma-re/docs/09-mcp.md §5`.
- **MCP tools merged into `streamText`** at `main.js:56757` via
  `Tf.getMCPToolSet()` + `Tf.getMCPResourceToolSet()` (the two synthetic
  resource tools `mcp_list_resources` / `mcp_read_resource`).
- **MCP bypass of approval dialog**: `ih(input)` at `main.js:19228-19253`
  has no `case "mcp"` branch — MCP tool calls execute the moment the LLM
  decides to call them, no per-call gate (only the up-front selection of
  which tools are exposed). Doc §11.
- **For ACP sessions** (`main.js:19740-19757`): alma forwards a declarative
  list of MCP server configs to the spawned coding agent so the agent
  spawns its own MCP clients, instead of multiplexing through alma.

### 1.2 Why it exists

MCP is the de facto inter-tool protocol that lets users plug in third-party
tool servers without recompiling alma. The JSON-file-as-source-of-truth
matches Claude Desktop's `claude_desktop_config.json` so users can copy
configs over. OAuth + DCR is what makes Linear / GitHub / Notion MCP
servers usable without prompting the user for an API key.

### 1.3 What Maka has today

- None. Grep for `mcp`/`@modelcontextprotocol` across
  `apps/desktop/src/` and `packages/` returns only doc references and a
  test fixture in `apps/desktop/src/main/__tests__/maka-uri.test.ts`. No
  client, no transport, no config file, no tool registration.
- Maka's tool registry lives in
  `packages/runtime/src/builtin-tools.ts:24-153` — a hard-coded array of
  five MakaTool entries (Bash / Read / Write / Edit / Grep) returned by
  `buildBuiltinTools()`. There is no extension point for externally-defined
  tools beyond `ExploreAgent` in `apps/desktop/src/main/explore-agent-tool.ts`.
- The closest analog to the alma OAuth manager is in
  `apps/desktop/src/main/oauth/` which handles provider-account OAuth
  (Anthropic / OpenAI subscriptions) — not MCP DCR.

### 1.4 Borrowable items

- **B-MCP-01** *(Tier 1)* — Ship the JSON-config + tool-name prefix
  pattern first, without any transport. A new file
  `packages/runtime/src/mcp/config.ts` reads
  `~/.config/maka/mcp.json` with the alma schema (Claude-Desktop-compatible
  so users can paste configs). A `packages/runtime/src/mcp/tool-name.ts`
  exports `dnsSafeServer(name)`, `safeTool(name)`, and
  `prefixedToolId(server, tool)` matching `main.js:25186-25203`. Even
  before transports, this lets external test rigs feed mock MCP tool sets
  through `MakaTool`. Scope: S. Risk: low.
- **B-MCP-02** *(Tier 1)* — Lift the JSON-Schema → Zod converter from
  `main.js:25642-25676` into
  `packages/runtime/src/mcp/json-schema-to-zod.ts`. Even if we never wire
  MCP, this is reusable for plugin tools and OpenAPI imports. Scope: S.
- **B-MCP-03** *(Tier 2)* — Stdio transport only: implement
  `packages/runtime/src/mcp/stdio-client.ts` wrapping
  `child_process.spawn(command, args, { env })` with newline-delimited
  JSON-RPC framing. Reuse the alma timeout matrix (60s connect / 15s
  listTools / 10-min callTool). Add stderr ring buffer (last 10 lines) for
  error context. Skip the HTTP/SSE transports and OAuth entirely in v1.
  Scope: M. Risk: med (process lifetime).
- **B-MCP-04** *(Tier 3)* — Tool-call permission gate. Unlike alma, route
  MCP calls through Maka's `PermissionEngine`
  (`packages/runtime/src/permission-engine.ts`) with `categoryHint:
  'mcp-external'` and a per-server `mcp:<server>:tool:<tool>` policy key.
  alma deliberately bypasses approval at `main.js:19228-19253`; we should
  not. Scope: S.
- **B-MCP-05** *(Tier 4)* — Streamable HTTP transport with SSE fallback,
  mirroring `main.js:25460-25512`. Add OAuth/PKCE/DCR if a paying user
  asks for Linear or GitHub MCP. Tokens via `safeStorage` (already used
  for provider keys in `apps/desktop/src/main/credential-store.ts`).
  Scope: L. Risk: med.

---

## 2. Prompt apps

### 2.1 alma's design

- **Storage**: SQLite table `prompt_apps`, Drizzle model `bn` at
  `main.js:223-248`. After v2-v8 migrations (`main.js:2189-2227`) the
  shape carries `name, description, icon, promptTemplate,
  placeholders (JSON), model, tools (JSON, or AUTO_TOOL_SELECTION
  sentinel), reasoningEffort, expectsImageResult, isIncognito, enabled,
  shortcut, windowWidth, windowHeight, fontSize, sortOrder`. Cited
  `~/Downloads/alma-re/docs/18-prompt-apps.md §1.2`.
- **Execution history**: separate `prompt_app_executions` table
  (`main.js:473-487`) holds `inputValues, generatedPrompt, attachmentCount,
  threadId, promptAppId`. Every Generate click writes a row.
- **Placeholder types** (`index-DabP8x52.js:48290-48299`):
  `text | textarea | select | number | checkbox | date | image | file`.
  Each placeholder has `id, name, type, label, placeholder, required,
  defaultValue` plus type-specific `options[] / min / max / accept /
  multiple`.
- **Template language**: regex
  `/(?:\{\{|｛｛)\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:\}\}|｝｝)/g` at
  `index-DabP8x52.js:48311`. Both ASCII `{{var}}` and CJK full-width
  `｛｛var｝｝` braces accepted. Server-side substitution at
  `main.js:66490-66518` coerces booleans to `"Yes"`/`"No"`. No
  conditionals, no loops, no partials.
- **Runner window** (`prompt-app-runner.html` + IPC at
  `main.js:72075-72117`): separate `BrowserWindow`, dimensions from the
  row (`windowWidth || 520`, `windowHeight || 680`), titlebar style
  `hiddenInset` on macOS, dark bg `#1a1a2e` elsewhere. Row identity passed
  via `webContents.id` → `SS` map, not via URL.
- **Preload bridge** (`preload.js:70-83`):
  `window.promptAppRunner = { open, close, getPromptApp,
  navigateToThread, saveWindowSize, registerShortcut, unregisterShortcut }`.
- **Generate flow** (per `prompt-app-runner-B-CoSHlI.js:412`):
  `POST /api/prompt-apps/:id/execute` server-side expands template and
  creates the `chat_threads` row with `promptAppId = id`. Server does NOT
  start generation. The runner then calls
  `newChatThreadManager.generateResponse(threadId, model, {role:"user",
  parts}, {tools, reasoningEffort})` itself. Two-step handshake is
  intentional so HTTP-only clients can drive it.
- **`expectsImageResult` retry**
  (`prompt-app-runner-B-CoSHlI.js:264`): after `generation_completed`,
  if no `image/*` file part is in the assistant reply, re-call
  `generateResponse` with `retryOfMessageId` so it replaces the previous
  attempt. Cap `MAX_IMAGE_RETRIES = 10`. This is the killer feature for
  Nano-Banana-style image apps that sometimes drop the image.
- **Global hotkey** (`main.js:72918-72988`): `pA(promptAppId,
  {name, shortcut})` registers an Electron `globalShortcut`. Re-registering
  for the same id unregisters first. Format: standard Electron accelerator
  (`"Cmd+Shift+J"`).
- **What it is NOT**: no CLI surface (`alma prompt-app run` doesn't
  exist), no filesystem backing (only SQLite rows), no bundled default
  apps, no internal usage by title-gen/compaction. Per
  `~/Downloads/alma-re/docs/18-prompt-apps.md §1.11-1.13`.

### 2.2 Why it exists

Three different things share UI real estate but solve different problems.
A **Prompt App** is a saved prompt + Zod-like form + window chrome + model
preset + tool whitelist all in one row — meant for repeated workflows like
"generate a Twitter image with these props" or "draft a release note from
this diff". A plain **Prompt** is a snippet inserted into the composer
(no form, no autonomy). A **Skill** is a filesystem markdown that the LLM
discovers via the `Skill` tool. The split is intentional: prompt apps are
user-launched mini-applications; skills are LLM-pulled reference content.

### 2.3 What Maka has today

- No prompt-app concept. Search across `apps/desktop/src` + `packages/`
  for `prompt.app|PromptApp|placeholder` returns only UI references in
  `apps/desktop/src/renderer/settings/SettingsModal.tsx` (settings keys
  unrelated to prompt-apps).
- The closest analogous feature is Quick Chat in
  `apps/desktop/src/main/quick-chat.ts` — a global hotkey opens a small
  composer window. But there's no template, no form schema, no model
  override, no execution history.
- Maka does ship a single-prompt skill mechanism through
  `apps/desktop/src/main/skills.ts:42-58` (`MAX_SKILLS_IN_PROMPT = 12`,
  `MAX_SKILL_BODY_CHARS = 4000`, bundled office skills). This is closer to
  alma's "skills" than "prompt apps".

### 2.4 Borrowable items

- **B-PAPP-01** *(Tier 2)* — Adopt the prompt-app row format as a new
  `packages/core/src/prompt-apps.ts` data type. Schema: `name, icon,
  promptTemplate, placeholders[], model, tools, reasoningEffort,
  expectsImageResult, isIncognito, enabled, shortcut, windowWidth,
  windowHeight`. Persist in the same Maka store that the session manager
  uses. Scope: M.
- **B-PAPP-02** *(Tier 2)* — Implement the
  `parseTemplatePlaceholders` regex + substitution helper. Accept both
  ASCII and full-width braces; coerce booleans to `"Yes"`/`"No"`; live-sync
  new `{{vars}}` into placeholders on edit. Scope: S.
- **B-PAPP-03** *(Tier 2)* — Promote Maka's existing Quick Chat window
  (`quick-chat.ts`) to a generic mini-runner window. Reuse the runner
  shell for any prompt-app and pass the row identity via
  `webContents.id` → map keyed lookup (mirrors alma's `SS` map at
  `main.js:72104`). Scope: M.
- **B-PAPP-04** *(Tier 3)* — `expectsImageResult` retry loop. New session
  option `retryUntilImage?: { maxAttempts: number }` on the runtime input;
  loop on `complete` event if no `imagePart` part appeared. Scope: S.
  Pre-req: B-TOOLS-07 (multimodal output already on the checklist).
- **B-PAPP-05** *(Tier 3)* — Global hotkey registry per prompt-app, using
  Electron's `globalShortcut.register`. One Map<promptAppId, accelerator>
  so re-registering overwrites cleanly. Scope: S. Pair with
  `apps/desktop/src/main/main.ts` window manager.
- **B-PAPP-06** *(Tier 4)* — Execution-history table (separate from the
  general session log) keyed by `promptAppId`. UI: history drawer with
  "Re-run with same inputs". Mirrors alma's `prompt_app_executions` at
  `main.js:473-487`. Scope: S.

---

## 3. Time-driven subsystems (reminders / sleep / wake)

### 3.1 alma's design

- **Singletons constructed during Express startup**: `HeartbeatService`
  (`hv`), `CronService` (`wv`), `ThreadArchiver`,
  `ActivityRecorderService` (`Mv`). Each is given the local API port and
  opens a WebSocket to `ws://127.0.0.1:<port>/ws/threads`. Per
  `~/Downloads/alma-re/docs/19-time-driven.md §1`.
- **The trick**: when a timer fires, the service does **not** call
  internal generate-response code — it sends a `generate_response`
  envelope over the local WebSocket. The chat engine treats it as a normal
  inbound turn (the same code path that handles Telegram). Tagged
  `source: "heartbeat"|"cron"`.
- **Cron storage** at `~/.config/alma/cron/jobs.json` and `runs.json`.
  Migration code at `main.js:43238-43316` (`[CronService] Migrated…
  jobs from SQLite`) copies the legacy SQLite tables to JSON on first
  boot, then never reads SQLite again. `runs.json` auto-pruned to last 100
  per job.
- **Schedule types**: `at` (one-shot, `setTimeout`), `every` (recurring,
  `setInterval`), `cron` (croner with `protect: true`). Croner timezone
  auto-populated from `Intl.DateTimeFormat().resolvedOptions().timeZone`.
- **Execution modes** (the AI cron feature):
  - **Isolated** (default): creates a brand-new thread titled
    `⏰ Cron: <name>`, tagged `metadata: { isCron: true }`. Tracks active
    generation in `Map<jobId, {threadId, startedAt, retryCount}>`. Up to
    3 retries on `generation_error` with `5_000 * (retryCount+1)` ms
    backoff; each retry spawns a new `⏰ Cron: <name> (Retry N)` thread.
  - **Main session**: injects a user message into an existing thread (the
    heartbeat thread by default): `text:
    [System Event - CronJob "<name>"]: <prompt>`.
- **Delivery to Telegram/Discord**: `setSendToTelegram` callback wired in
  by the server (`main.js` ~ §2.8). `handleIsolatedJobResponse` polls
  `thread.isGenerating` every 2s, force-resets after 120s, then extracts
  the last assistant message and applies a long Chinese-and-English
  regex skip-list (`/no.?output/i`, `/不提醒/`, `/没有(新|更新)/`, etc.).
  If no skip match, truncate at 4000 chars and send.
- **Stuck-generation cleanup** every 60s: any active isolated generation
  older than 10 minutes is force-cleaned; any `⏰ Cron:`-titled thread
  with stale `isGenerating: true` is reset. Pre-flight check in
  `executeJob`: if an existing generation is already 480s old, send
  `stop_generation` and start fresh.
- **HeartbeatService** (`hv`, per `~/Downloads/alma-re/docs/19-time-driven.md
  §3`): periodic poke every `intervalMinutes` (default 30). Reads
  `~/.config/alma/HEARTBEAT.md`, composes a multi-section prompt
  (HEARTBEAT.md content + group patrol block + base-emotion-refresh
  block + diary block + travel block + task-review block), injects into
  the single persistent `💓 Heartbeat` thread. Magic sentinel
  `HEARTBEAT_OK` suppresses display. The 4-hour user-inactivity
  watchdog actually lives **as text instructions in HEARTBEAT.md**, not
  as a separate timer.
- **Fatigue / sleep state machine** lives in
  `out/main/chunks/fatigueService-CwrveHp6.js` (lazy-loaded chunk,
  imported at `main.js:34827, 61894`). Persists to
  `~/.config/alma/fatigue.json`. Continuous decay (0.8/min idle) + 1.5
  accrual per chat message + hour-of-day boost (+30 at 1-6 AM, +15 at
  11pm-8am, +8 at 1pm siesta window). Four levels: `awake / tired /
  sleepy / sleeping`. Auto-wake after 2h sleep during 08:00-22:00.
  `getFatigueStatus()` returns a `prompt` block that the agent-loop
  concatenates into the system prompt every turn.
- **Generation watchdog** in the chat-completions handler: `setTimeout`
  for 14_400_000 ms (4 hours) calls `abortController.abort()`. Hard cap
  on a single generation.
- **Startup recovery**: `resetStuckGenerations()` walks threads, resets
  `isGenerating`, identifies threads updated in last 30 min with
  in-flight tool calls, and 10s after boot POSTs a synthetic user
  message to `/api/chat/completions` with `source: "recovery"`. This is
  the closest thing to a self-resume feature.

### 3.2 Why it exists

Two reasons:

1. **Agent-as-roommate**. alma is positioning itself as a long-running
   "companion" agent that has its own schedule, mood, and chores. The
   fatigue state + heartbeat + cron + diary cycle together make the
   agent feel less like a stateless chatbot and more like something
   with continuity. The text-only `HEARTBEAT_OK` reply is part of the
   "less is more" rule: if nothing needs the user, say nothing.
2. **One code path** for scheduled work and inbound messages. By routing
   cron through the same WebSocket the chat engine listens on, alma
   doesn't have to duplicate model-call plumbing, retry handling, or
   tool dispatch. A scheduler that talks JSON over a localhost socket
   is much easier to test than one that calls into private internals.

### 3.3 What Maka has today

- No timer-driven LLM invocation. Grep across
  `packages/runtime/src/` for `cron|schedul|reminder|heartbeat|sleep|wake|
  fatigue` returns only watchdog/timeout code in
  `packages/runtime/src/stream-watchdog.ts` (LLM stream connect/idle
  timeouts) and small test helpers. No scheduler service.
- `packages/runtime/src/stream-watchdog.ts:1-90` carries
  `DEFAULT_STREAM_CONNECT_TIMEOUT_MS = 30_000` and
  `DEFAULT_STREAM_IDLE_TIMEOUT_MS = 120_000` plus a clean
  `start/markActivity/pause/resume/stop` lifecycle. The right home for a
  long-form generation watchdog if we ever add one.
- Maka's `packages/core/src/plan-reminders.ts` exists as a placeholder
  but is **not** a recurring scheduler; it's a single-turn helper.
- Bots: `packages/runtime/src/bots/*` use polling loops (e.g.
  `wechat-bridge.ts`, `discord-bridge.ts`, `telegram` references in
  test fixtures), but those are inbound-only — there is no outbound
  scheduled push.

### 3.4 Borrowable items

- **B-TIME-01** *(Tier 1)* — Adopt the "scheduled tick injects a
  `user_message` envelope via the same path that bots use" pattern. A new
  file `packages/runtime/src/scheduler/cron-service.ts` reads jobs from
  `~/.config/maka/cron/jobs.json` and on tick calls
  `SessionManager.appendUserMessage(...)` with `source: "cron"`. No need
  for a WebSocket — directly invoke the in-process API. Scope: M. Risk:
  med (timezone / overlap-protection). Pair with `croner` dep.
- **B-TIME-02** *(Tier 2)* — Two execution modes: `isolated` creates a
  fresh session named `Cron: <jobName>` with `isCron: true` metadata;
  `main` injects into an existing session. Mirrors alma's
  `executeIsolated` / `executeMainSession` design. Use Maka's
  existing `createSession` from
  `packages/runtime/src/session-manager.ts:128+`. Scope: S.
- **B-TIME-03** *(Tier 2)* — Cron-stuck-generation cleanup timer
  (60s interval) that resets sessions with stale `isGenerating: true`
  on cron-flagged sessions. Mirrors `cleanupStuckGenerations()` at
  `main.js`. Skip alma's 480s pre-flight kill for v1 — too aggressive.
  Scope: S.
- **B-TIME-04** *(Tier 3)* — "Delivery skip" regex list for cron
  outputs. Catches `/no.?output/i`, `/nothing.to.(send|report)/i`,
  `/no.?update/i` etc. so the agent can decide not to spam the user.
  Apply when the cron job has a `deliverTo` channel. Scope: S.
- **B-TIME-05** *(Tier 3)* — 4-hour single-generation hard cap. Extend
  `packages/runtime/src/stream-watchdog.ts` with a
  `DEFAULT_STREAM_HARD_CAP_MS = 14_400_000` mode that fires
  `abortController.abort()` regardless of activity. Today Maka has no
  hard cap — a runaway tool loop can stream indefinitely. Scope: S.
- **B-TIME-06** *(Tier 4)* — Startup-recovery pass: on
  `SessionManager.init()`, scan sessions for `status === 'streaming'`
  with no active turn, reset to `idle`. If the last assistant message
  has tool parts in `running` state, emit a synthetic user message
  `[System: app was restarted; previous generation interrupted; …]`.
  Scope: M. Risk: med (false-resume on edited sessions).
- **B-TIME-07** *(Deferred, only if Maka adopts companion-mode)* —
  fatigue/sleep state machine with persistent `~/.config/maka/fatigue.json`
  and prompt-injection of `getFatigueStatus().prompt`. Useful only if
  Maka positions as a long-running companion. Otherwise out of scope.

---

## 4. ACP (Agent Communication Protocol)

### 4.1 alma's design

- **Protocol**: JSON-RPC 2.0 over child-process stdio, newline-delimited.
  Three roles: alma is the **client**; an external coding agent
  (claude-code-acp, codex-acp, gemini, opencode, pi) is the **agent**.
  Per `~/Downloads/alma-re/docs/20-acp.md §1`.
- **Method names seen**: `initialize`, `authenticate`, `session/new`,
  `session/load`, `session/prompt`, `session/cancel`, `session/set_mode`,
  `session/set_config_option`, `unstable_setSessionModel` (client →
  agent); `session/update`, `session/request_permission`,
  `fs/read_text_file`, `fs/write_text_file`, `terminal/*` (agent →
  client). `~/Downloads/alma-re/docs/20-acp.md §1` (method table).
- **`acpx` launcher** (`acpx@0.1.15`, vendored): standalone npm CLI that
  speaks ACP for a chosen backend. Registry at
  `acpx/dist/cli.js:14-20`:
  `{ codex: "npx @zed-industries/codex-acp", claude: "npx -y
  @zed-industries/claude-agent-acp", gemini: "gemini", opencode:
  "npx -y opencode-ai acp", pi: "npx pi-acp" }`. Default agent:
  `codex`.
- **Path resolution** (`main.js:20597-20615`, function `Jh`): walks
  vendored `node_modules/.bin/acpx` → mise → `~/.local/bin` →
  `/usr/local/bin` → `/opt/homebrew/bin` → shell `which acpx`. Same
  shape for `claude` at `main.js:20616` (function `Vh`).
- **Three execution paths for the `coder` subagent**
  (`main.js:20983-21488`, function `Qh`):
  1. **Built-in** — in-process `streamText` with alma's tools
     (Read/Edit/Write/Bash/Grep/Glob/Skill/WebSearch/WebFetch).
  2. **Direct Claude Code** (`Kh`, `main.js:20632`) — spawns
     `claude -p --verbose --output-format stream-json --max-turns 50
     --dangerously-skip-permissions --no-session-persistence` (or
     `acpx --format json --approve-all ... claude exec --file -`).
  3. **ACP provider** — `createACPProvider({...})` → AI SDK
     `streamText({ model: provider.languageModel(), tools:
     provider.tools })`. Provider opens stdio JSON-RPC to whatever
     `acpCommand` is configured.
- **ToolProxyHost** (`@mcpc-tech/acp-ai-provider/index.mjs:152-`): when
  the parent passes `tools` to `streamText`, the provider opens a local
  **TCP server** on a random port and pushes an
  `{ type: "stdio", name: "acp-tool-proxy", command: "node", args: ["-e",
  RUNTIME_CODE], env: { ACP_TOOL_PROXY_PORT } }` MCP server entry into
  `session/new` mcpServers. The child agent, on session open, spawns
  this "MCP server" — actually a node-e shim that TCP-dials back to
  alma's host. So the ACP child can directly use the parent's host
  tools (Read/Edit/Bash). Doc §6.
- **`acp.acp_provider_agent_dynamic_tool`**: because AI-SDK needs to
  know about every tool ahead of time but the ACP child can invent
  tools, the provider exposes one dynamic tool with schema
  `{ toolCallId, toolName, args }`. When the child calls a tool the
  parent doesn't know, the provider emits `tool-call` with
  `toolName = "acp.acp_provider_agent_dynamic_tool"` and renderer
  unwraps to `tool-<actualName>`. Doc §6.
- **Env injection for the spawned child** (`main.js:21084-21156`):
  alma reverse-shims the LLM API. For `claude-code-acp` linked to an
  OpenAI provider, set
  `ANTHROPIC_BASE_URL=http://localhost:${WhPort}/anthropic-proxy/${providerId}`
  so the child speaks Anthropic Messages API to alma's local server,
  which forwards to OpenAI. For `codex-acp` linked to Copilot, set
  `OPENAI_BASE_URL=http://localhost:${WhPort}/proxy/${linkedProviderId}`
  and `OPENAI_API_KEY` from the GitHub token manager.
- **MCP forwarding via ACP** (`main.js:19740-19757`): alma builds a
  declarative list of its enabled MCP servers and pushes them into
  `session.mcpServers` so the child spawns them itself. Each stdio MCP
  server fork-spawns per ACP session. Doc §7.
- **Permission posture**: `acpx --approve-all` and Claude Code
  `--dangerously-skip-permissions` mean the child agent's tool calls
  bypass alma's modal. Doc §4 explicitly flags this as risky.

### 4.2 Why it exists

alma wants users to bring whatever coding agent they already use
(Claude Code subscription, Codex CLI, Gemini CLI) and still get unified
chat + memory + workspace state. ACP is Zed's protocol for exactly this
host-vs-agent split. The ToolProxyHost trick is what makes a Codex
session feel like it has Read/Edit/Bash with the *parent's* workspace
permissions, not Codex's own. It's a clever way to delegate the LLM-call
plumbing while keeping the host in charge of "what tools exist."

### 4.3 What Maka has today

- No ACP. Grep across the repo for `acp|@zed-industries` returns only
  `apps/desktop/src/main/oauth/cloaked-request.ts` (a name collision
  involving `actor`) and a `package-lock.json` reference unrelated to
  agents.
- Maka does have an **ExploreAgent** sub-tool at
  `apps/desktop/src/main/explore-agent-tool.ts` (read-only filesystem
  exploration) but it's in-process and shares the parent's model — not
  an external-agent dispatch protocol.
- The closest analog is the model-factory abstraction in
  `packages/runtime/src/model-factory.ts` which maps connections to
  AI-SDK language models. To plug in an ACP provider Maka would
  implement a new `LanguageModelV2` adapter, similar to
  `acp-ai-provider`'s `ACPLanguageModel`.

### 4.4 Borrowable items

- **B-ACP-01** *(Tier 4, far future)* — A minimal ACP client wrapping
  `child_process.spawn(command, args, { env, stdio: ["pipe", "pipe",
  "inherit"] })` with newline-delimited JSON-RPC framing. New file
  `packages/runtime/src/acp/client.ts`. Implements `initialize`,
  `session/new`, `session/prompt`, `session/cancel`, plus the
  notification fan-out (`session/update` → ai-sdk stream parts). Scope:
  L. Risk: med-high (spec compliance).
- **B-ACP-02** *(Tier 4)* — Path-resolution helper mirroring
  `main.js:20597-20615`: vendored → mise → `~/.local/bin` →
  `/usr/local/bin` → `/opt/homebrew/bin` → `which`. Reusable for finding
  any external binary; lift into `packages/runtime/src/binary-locator.ts`.
  Scope: S.
- **B-ACP-03** *(Tier 4)* — ToolProxyHost-style host-tool bridge. Boot a
  local TCP server in main process; spawn `node -e <shim>` as a fake MCP
  server with `ACP_TOOL_PROXY_PORT` env; shim TCP-dials back to
  `MakaTool` impls. This is the single most powerful idea in ACP — it
  lets *any* coding-agent CLI use the host's tools without recompiling
  the CLI. Scope: M. Pre-req: B-MCP-03 (stdio MCP) so we have the
  framing already. Risk: med.
- **B-ACP-04** *(Tier 4)* — Env-injection reverse-shim. Even without
  ACP, `apps/desktop/src/main/officecli-env.ts` already proves Maka can
  inject env into child processes. The pattern of
  `ANTHROPIC_BASE_URL=http://localhost:${makaPort}/proxy/${providerId}`
  is reusable for any "use my LLM key but speak a different protocol"
  scenario (e.g. let a user's vanilla `claude` CLI talk to Maka's
  bring-your-own-key Anthropic provider). Scope: M. Pre-req: a local
  HTTP server in Maka, which we don't have today.
- **B-ACP-05** *(Deferred)* — `unstable_setSessionModel`-style "swap
  the LLM mid-session" affordance. Useful only if Maka ever supports
  hot-swapping model providers within one turn. Defer.

---

## 5. Embeddings & memory consolidation

### 5.1 alma's design

- **Schema** (`main.js:542, 985, 988, 994, 997`):
  - `memories` (id, content, metadata JSON, thread_id, message_id,
    user_id, created_at, updated_at)
  - `memory_embeddings` (vec0 virtual table, FLOAT[1536] at boot,
    rebuilt to whatever the active provider returns on first insert via
    `ensureVectorTableDimensions`, `main.js:1043`)
  - `memory_archive` (soft-deleted memories with `archived_reason`,
    `archived_by`, `merged_into`)
  - `memory_sleep_runs` (per-run aggregates: examined, archived_exact,
    archived_expired, archived_similarity, archived_llm, input_tokens,
    output_tokens, status)
  - `memory_metadata` (key/value, currently only
    `embedding_model = <providerId:modelId>`)
- **Embedding provider selection** (`main.js:16791` for tool layer,
  `64838` for chat layer): priority order — explicit
  `settings.memory.embeddingModel` of form `providerId:modelId` (with
  `__local__` short-circuit) → fallback chain (enabled OpenAI →
  aihubmix → openrouter → google → custom). Default model:
  `text-embedding-3-small`. Dispatcher
  `co.generateEmbedding(text, providerSpec)` at `main.js:1173`.
- **No retries, no batching, no queue** in the embedding layer. One
  HTTP request per call. Per `~/Downloads/alma-re/docs/22-embeddings.md
  §2`.
- **Local ONNX models** (`main.js:17494, 17528-17667`): four bundled
  Xenova models (all 384-D): `all-MiniLM-L6-v2`,
  `bge-small-en-v1.5`, `multilingual-e5-small`,
  `paraphrase-multilingual-MiniLM-L12-v2`. Cached in
  `app.getPath("userData") + "/embedding-models"`. CPU only (no CoreML,
  no Metal). Loaded via `@huggingface/transformers`
  `pipeline("feature-extraction", hfId, { progress_callback })`. Throttled
  500ms progress events to renderer.
- **Generation triggers**:
  1. **After every assistant turn** (the dominant path, `main.js:63869`):
     fires-and-forgets `summarizeAndStoreMemories(threadId, messages,
     providerSpec, model, lastMessageId)`. Considers only last 4
     messages. LLM extracts JSON `[{operation:"add"|"delete", content,
     durability}]`. Each add → embed → `addMemoryWithLLMDedup`. Each
     delete → embed query → top-10 search → LLM disambiguates which
     indices match. Guarded by `thread.isIncognito`,
     `settings.memory.enabled && autoSummarize`.
  2. **Direct creation** via `POST /api/memories` (`main.js:64913`).
  3. **Auto-recall for context** before each user turn
     (`main.js:61333`): embed last user message (optionally rewritten by
     LLM), top-N vec search above `similarityThreshold` (default 0.1).
     Format with `ao()` (`main.js:830`) into `## Relevant Memories`
     block prepended to system message. **Read-mutates**:
     `searchMemories` (`main.js:1326-1379`) bumps `accessCount` and
     `lastAccessedAt` on every hit, which feeds the sleep cycle's
     "survivor" scoring.
  4. **Sleep cycle synthesis** — LLM-merged memories embedded with same
     provider and inserted via `co.addMemory()`.
  5. **Activity OCR frames** (`main.js:46628, table at 1940`) — separate
     pipeline, hardcoded to `multilingual-e5-small`, raw Float32 BLOB +
     partial index on null embeddings, JS-side cosine search over last
     5000 frames.
- **`addMemoryWithLLMDedup`** (`main.js:1265`): every newly-extracted
  memory is searched (top-5 above 0.3), passed to LLM
  `{ "isDuplicate": bool, "duplicateOf"?: N }`, skipped on duplicate.
  Settings: `candidateLimit` (5), `candidateThreshold` (0.3).
- **Sleep cycle** (`main.js:16906, runSleepCycle at 17045`):
  - Default schedule: `dailyTime: "03:00"` local. Backoff after 3
    consecutive same-day failures.
  - **Layer 1a**: exact duplicates (NFC + whitespace normalize, group,
    pick survivor by `ro()` score that +100k bonuses userId-namespaced
    rows).
  - **Layer 1b**: expired temporary memories (`durability ===
    "temporary"` AND `expiresAt < now` OR `now - createdAt > ttlDays &&
    accessCount === 0`).
  - **Layer 2**: similarity clustering. All-pairs cosine in JS
    (O(n²)), edges above `llmMergeLow = 0.75`, union-find. Yields to
    event loop every 64 iterations. Cluster size cap 50. Max edge ≥
    `similarityMergeThreshold = 0.95` → mechanical merge; otherwise
    Layer 3.
  - **Layer 3**: LLM consolidation. Cluster batched at `llmBatchSize =
    20`. System prompt (`$d`, `main.js:17480`) instructs zero info
    loss; output JSON `{delete:[...], synthesize:[{content, durability}]}`.
    Safety: refuses to delete the whole cluster with no synthesis.
  - **Layer 4**: purge `memory_archive` rows older than
    `archiveRetentionDays = 30`.
- **Provider switching**: lazy fixup in `ensureVectorTableDimensions`
  (`main.js:1043`) — no-op when table has rows. Explicit
  `POST /api/memories/rebuild` (`main.js:1079`) drops + recreates vec
  table at the new dimension, then re-embeds every memory in parallel
  batches of 10.

### 5.2 Why it exists

The chat-time write-dedup + nightly sleep cycle together compensate for
the fact that LLM-extracted memories have a lot of overlap — same fact
phrased four different ways across four conversations. Without
consolidation the recall context grows past the "5 relevant memories"
limit and quality degrades. The four-layer split (exact → expired →
similarity-mechanical → similarity-LLM → archive purge) is the recipe.
sqlite-vec with dynamic dimension is the right backend because nobody
wants to ship onnxruntime-node *and* sqlite-vec *and* an external vector
DB.

### 5.3 What Maka has today

- No embeddings. Grep across the workspace for
  `embedding|sqlite-vec|@huggingface|onnxruntime` returns only
  `SettingsModal.tsx`, `local-memory.ts` (one mention in comments),
  `memory.ts`, the core index, and a test.
- `packages/core/src/local-memory.ts:1-78` defines V0.1 as
  *"transparent local MEMORY.md contract"*, explicitly stating:
  *"V0.1 describes one user-visible Markdown file. It does not implement
  hidden durable memory, extraction, embeddings, recall, or agent
  tools."* This is the deliberate scope today.
- Maka re-reads MEMORY.md every turn (per `04-memory.md §6.3` in this
  notes set) and prepends it to the system prompt. No durable index, no
  recall heuristics, no sleep cycle.
- The data structure is per `local-memory.ts:18-78`:
  `LocalMemoryEntryPreview { id, origin, status, title, content,
  createdAt, updatedAt, tags, decayTtlMs }`. `decayTtlMs` foreshadows
  alma's `temporary` durability but isn't used yet.

### 5.4 Borrowable items

- **B-EMB-01** *(Tier 3 — only when Maka opts in to durable memory)* —
  sqlite-vec virtual table at
  `~/.config/maka/memory.sqlite`. Use the
  `ensureVectorTableDimensions` lazy-fixup pattern (`main.js:1043`)
  with explicit `rebuildEmbeddings` API for provider switches. Scope: M.
- **B-EMB-02** *(Tier 3)* — Local-only embedding pipeline via
  `@huggingface/transformers`. Bundle one model only:
  `multilingual-e5-small` (384-D, ~118 MB, covers CJK which Maka's
  bots already target). Cache at `app.getPath("userData") +
  "/embedding-models"`. Mirror the progress event throttle (500ms) at
  `main.js:17595`. Scope: M. Risk: med (bundle size, ORT/wasm
  compatibility).
- **B-EMB-03** *(Tier 3)* — `addMemoryWithLLMDedup` write-time dedup.
  Before persisting a new memory, search top-5 above
  `candidateThreshold = 0.3`, pass cluster to tool model
  `{ isDuplicate, duplicateOf?, reason? }`, skip on duplicate. Scope: S.
  Pre-req: a tool-model concept (already on the checklist as
  B-PROMPT-04).
- **B-EMB-04** *(Tier 4)* — Nightly four-layer sleep cycle. Schedule
  via the same B-TIME-01 scheduler. Layer 1a (exact-dup), 1b (TTL
  expiry), 2 (similarity merge ≥0.95 mechanical), 3 (LLM Layer-3
  consolidation with `$d` prompt verbatim from `main.js:17480`), 4
  (archive purge). Critical safety: refuse to delete entire cluster
  with no synthesis (mirrors alma's check). Scope: L. Pre-req: EMB-01
  + B-TIME-01 + tool-model.
- **B-EMB-05** *(Tier 3)* — Memory metadata JSON shape with
  `importance`, `accessCount`, `lastAccessedAt`, `durability:
  "permanent"|"temporary"`, `expiresAt`, `source`, `tags`. Add to
  `packages/core/src/local-memory.ts` even before durable memory ships;
  forwards-compatible with V0.1's parser. Scope: S.
- **B-EMB-06** *(Tier 4)* — Read-mutates `searchMemories` that bumps
  `accessCount` and `lastAccessedAt` per hit. This is what makes the
  sleep cycle's "important memories survive" heuristic possible. Scope:
  S once EMB-01 exists.

---

## 6. Bash sandboxing model (and why alma calls it that)

### 6.1 alma's design

- **There is no sandbox**. Per `~/Downloads/alma-re/docs/23-bash-sandbox.md
  §11`: a full-text search for `@anthropic-ai/sandbox-runtime`,
  `sandbox-runtime`, `SandboxRuntime` in `main.js` returns zero matches.
  Past the approval modal, `spawn("/bin/bash", ["-l", "-c", cmd])` runs
  as the user with full network, filesystem, and credential access.
- **Defense in layers**:
  1. Local regex pre-filter (`main.js:22743-22850`):
     - `Jp` (safe-list, 51 patterns): `ls`, `pwd`, `cat`, `wc`, `du`,
       `df`, `stat`, `git status|log|diff|branch|show|remote -v`,
       `npm list|ls`, `node --version|-v`, etc.
     - `Vp` (deny-list / require-permission, 27 patterns): `rm`,
       `sudo`, `su`, `>` and `>>`, `chmod`, `chown`, `kill*`, `git
       push|commit|add|checkout|merge|rebase|reset`, `npm install`,
       `pnpm i`, `pip install`, `brew install`, `apt install`.
     - `Kp` (might-modify-files, superset of `Vp`): includes `mv`,
       `cp`, `mkdir`, `rmdir`, `touch`, `ln`, `sed -i`, `perl -i`, build
       tools, archive extractors.
  2. **Workspace-relative redirection rule** (`em(cmd, workspace)`,
     `main.js:22856`): parses every shell redirection target, expands
     `~`, rejects `$` / command substitutions, normalizes paths, and
     **if all redirection targets resolve inside the workspace**,
     reclassifies the command as `low risk, no permission`. So
     `echo "hello" > out.txt` doesn't ping the user when `out.txt` is in
     the workspace.
  3. LLM security analyzer (`main.js:23097`): when regex is inconclusive,
     calls `await se({ model: <tool-model>, system: nm(language), prompt:
     "Analyze this bash command: ${cmd}", abortSignal: 10s })`. Expects
     JSON `{ needsPermission, description, riskLevel, mightModifyFiles }`.
     Fails closed (default to `medium`/`needsPermission: true`).
  4. Approval modal via `lh()` (`main.js:19345`) with bypasses:
     `settings.security.autoApproveToolRequests`, `metadata.isSubagent`,
     `metadata.source ∈ {telegram*, discord, feishu, cron, heartbeat}`,
     thread mapped to a bot channel, `ALMA_HEADLESS=1` env var, or a
     cached `allow_always` key matches.
  5. Cached `allow_always` policy keys (`main.js:19228-19253`,
     function `ih`): two keys per Bash request —
     `bash:thread:<id>:command:<exact command>` and
     `bash:thread:<id>:all`. Stored in JS `Set` `th`, process-lifetime
     only.
- **Spawn details**:
  - Shell `$SHELL` (fallback `/bin/bash`) as `-l -c` login shell so
    `.zprofile` / `.bash_profile` sources. `main.js:22605-22623`.
  - **Env augmentation** (`Fp`, `main.js:22624`): prepends user/bundled
    bins and discovered toolchain shims (NVM via `~/.nvm/alias/default`,
    Volta, asdf, mise, proto, fnm, cargo, go). Sets `ALMA_API_URL` if
    Express running, `CI=1`, `DEBIAN_FRONTEND=noninteractive`. Per-call
    foreground adds `ALMA_THREAD_ID`, optional `ALMA_CHAT_ID` if thread
    is bridged, optional `RTK_DB_PATH` if command rewritten through
    `rtk` (`Wd()`, `main.js:17817`).
  - **Three concurrent watchdogs** on foreground (`main.js:23389-23407`):
    1. User-specified `timeout` (max 600,000 ms, default 120,000), SIGTERM
       then SIGKILL after 5s.
    2. **Idle watchdog**: every 10s, if no stdout/stderr for >90s, mark
       idle, SIGTERM, SIGKILL 5s later. `exitCode=125`, stderr appended:
       `[alma] Process killed: no output for 90s (likely waiting for
       interactive input that cannot be provided)`.
    3. **Auto-promote to background** at `autoPromoteMs = 60000`:
       hot-swap into `BackgroundShell` entry; foreground promise
       resolves immediately with `{ background: true, bash_id }`; data
       handlers re-bound onto the new accumulator. Description rewritten
       to `[auto-promoted to background after 60s]`.
  - **Streaming** to renderer (`main.js:23331`): 50ms coalescing flush
    via `setTimeout`. `partIndex: -1` is the "live streaming"
    sentinel.
  - **Truncation tiers** (per doc §10):
    - 200,000 chars per stream in background buffer (`jp`,
      `main.js:22704`).
    - 1500 chars / 120 lines tail-truncation in tool-result
      compaction (`eu` profile, `main.js:17942`).
    - 50,000 chars per output for storage (`pk`, `main.js:50461`,
      with exemption only for `tool-computer-use__` prefix).
- **`Wd()` rtk rewrite** (`main.js:17817`): if first non-assignment token
  is in `Bd = {git, npm, pnpm, yarn, bun, cargo, grep, rg, find, fd, ls,
  tree, cat, tsc, eslint, vitest, jest, pytest, curl, wget, docker, pip}`
  AND no shell metachars in command AND `rtk` binary found, prefixes
  command with `<rtkPath>/rtk `. `rtk` is alma's tracking helper that
  logs dev-tool invocations to `<userDataDir>/alma/rtk-tracking.db`.

### 6.2 Why "sandbox-that-isn't"

The chapter title is the punchline: every LLM-coding tool brands their
shell access "sandboxed" but the reality is regex + LLM judgement + user
approval + cached policy. alma's contribution is making the speed-bump
**actually useful** — workspace-relative redirection reclassification
is a real UX win, the idle watchdog rescues hung `read -p` calls, and the
auto-promote-to-background means the LLM can keep working while
`pnpm test` runs. The trade-off is explicit: prompt + approval, not
isolation.

### 6.3 What Maka has today

- `packages/runtime/src/builtin-tools.ts:24-50` defines Maka's Bash
  tool. Permission-required goes through
  `packages/runtime/src/permission-engine.ts:98+`.
- **Spawn impl** at `packages/runtime/src/builtin-tools.ts:155-231`
  (`runStreamingShell`): `spawn(command, { cwd, shell: true,
  stdio: ['ignore', 'pipe', 'pipe'] })`. Default timeout 120,000 ms (max
  600,000 ms per Zod schema). Output capped at
  `BASH_MAX_OUTPUT_BYTES = 10 MB`. Streams via `emitOutput` callback to
  the backend. Aborts on `AbortSignal`.
- **No env injection beyond inherited** — no `MAKA_THREAD_ID`, no
  `MAKA_API_URL`, no `CI=1`, no PATH augmentation. Grep across the repo
  for `MAKA_THREAD|MAKA_API|ALMA_THREAD` confirms zero references. The
  bundled office helpers do have `apps/desktop/src/main/officecli-env.ts`
  but it's specific to the office-cli child process, not the Bash tool.
- **No security analyzer**. No regex pre-filter, no LLM "is this
  dangerous" classifier. All permission-required tools go through the
  same `PermissionEngine` flow regardless of command content.
- **No workspace-relative re-classifier**. A `> out.txt` and a `>
  /etc/passwd` go through the same modal.
- **No idle watchdog**. A hanging `read -p` will run until the 120s
  global timeout.
- **No auto-promote to background**. Long-running `pnpm test` blocks
  the entire turn until timeout.
- **Existing watchdog** (`packages/runtime/src/stream-watchdog.ts:30-90`)
  is for the LLM stream, not tool processes. Could be a model for the
  Bash idle watchdog.
- **No `BashOutput` / `KillShell` tool pair**. Background shells are
  not a concept Maka exposes today.

### 6.4 Borrowable items

- **B-SBX-01** *(Tier 1)* — Workspace-relative redirection
  re-classifier. Port `em(cmd, workspace)` from `main.js:22856` into
  `packages/runtime/src/bash-analyzer.ts`. Parses redirection targets
  (`>`, `>>`), expands `~`, rejects `$`/`` ` ``/`~user` substitutions,
  normalizes, checks each target is inside `cwd`. When all targets
  resolve inside workspace, return `{ category: 'safe' }` instead of
  prompting. **Highest-ROI security UX win in this whole pass** —
  removes ~50% of approval prompts in real coding sessions without
  loosening trust. Scope: S. Risk: low (deterministic parser).
- **B-SBX-02** *(Tier 2)* — Two-stage analyzer (regex first, LLM
  second). Ship `Jp` (safe-list) and `Vp` (deny-list) from
  `main.js:22743-22850` verbatim into `bash-analyzer.ts`. Safe-match +
  no deny-match → `{ category: 'safe' }`. Deny-match → `{ category:
  'risky' }`. Inconclusive → fall through to LLM analyzer with the
  `nm(language)` system prompt at `main.js:22882-22885` (use Maka's
  tool model from B-PROMPT-04). Scope: M. Pre-req: B-PROMPT-04.
- **B-SBX-03** *(Tier 2)* — Bash idle watchdog. In
  `runStreamingShell` (`packages/runtime/src/builtin-tools.ts:155-231`),
  reset a 90s timer on every stdout/stderr chunk; on expiry SIGTERM
  (then SIGKILL 5s later). On kill, append to stderr:
  `[maka] Process killed: no output for 90s (likely waiting for
  interactive input that cannot be provided)`. Sets exit code 125 so the
  LLM can distinguish from a normal failure. Scope: S. Risk: low.
- **B-SBX-04** *(Tier 1)* — Auto-promote-to-background after 60s. New
  `BackgroundShellRegistry` in
  `packages/runtime/src/background-shells.ts`. Add `BashOutput` and
  `KillShell` tools (mirrors `~/Downloads/alma-re/docs/23-bash-sandbox.md
  §8`). Critical for long-running `pnpm test`, `pnpm dev`, build
  commands — without it, every long task blocks the entire turn. Pairs
  with the existing checklist B-TOOLS-04. Scope: M. Risk: med (process
  lifetime).
- **B-SBX-05** *(Tier 1)* — Env injection. Mirror `Fp()` at
  `main.js:22624-22701`: prepend bundled bin + discovered toolchain bins
  (NVM, Volta, asdf, mise, fnm, cargo, go), set `CI=1`,
  `DEBIAN_FRONTEND=noninteractive`, `MAKA_API_URL` (only if Maka ever
  exposes a local HTTP server), per-call `MAKA_SESSION_ID`,
  `MAKA_CHAT_ID` (if bot-bridged). This is the same as the existing
  checklist item B-TOOLS-06 — kept here for cross-reference. Scope: S.
- **B-SBX-06** *(Tier 3)* — Cached `allow_always` policy keys keyed
  exactly like `ih(input)` at `main.js:19228-19253`: per-session-and-command
  (`bash:session:<id>:command:<cmd>`) and per-session-all
  (`bash:session:<id>:all`). Today `packages/runtime/src/permission-engine.ts:39-50`
  has a per-turn `remembered` Set but does not persist across turns
  inside a session. Extend it. Scope: S. Risk: low.
- **B-SBX-07** *(Tier 3)* — Three-tier output truncation. Background
  buffer 200 KB (mirror `jp` at `main.js:22704`). Tool-result tail
  compaction at 1500 chars / 120 lines (mirror `eu` profile). Storage
  truncation at 50 KB per output. Today Maka caps at 10 MB total but
  doesn't tier-truncate. Scope: S.
- **B-SBX-08** *(Tier 4)* — `Wd()` rtk-style tool-call telemetry. If
  Maka grows a tracking story, the pattern of *transparent command
  rewrite when it matches an allow-list and the helper binary exists*
  is worth borrowing. Today Maka has no equivalent; deferrable. Scope:
  M.

---

## Top 5 borrowable items (across all 6 topics)

These are the highest-ROI items in this pass, ranked by impact-per-day
of work. They complement the existing 40-item checklist in
`07-borrowable-checklist.md`.

| Rank | ID | Scope | Why first |
|------|----|-------|-----------|
| 1 | **B-SBX-01** workspace-relative redirection re-classifier | S | Removes the single most common "annoying approval prompt" (writing to a file in cwd). Deterministic parser, no LLM call, no behavior change for un-safe targets. Direct port of `main.js:22856`. |
| 2 | **B-TIME-01** cron-style scheduled agent ticks | M | Unlocks a whole category of features (reminders, periodic chores, AI cron). Architecture is clean: same `appendUserMessage` path that bots already use. No new model plumbing. |
| 3 | **B-MCP-01** JSON config + tool-name prefix + JSON-Schema→Zod | S | Even before any transport, lays the groundwork for any future MCP server, plugin tool, or external tool registry. The `server__tool` namespacing pattern is a one-day lift that pays off forever. |
| 4 | **B-PAPP-01** prompt-app row format + placeholder schema | M | Maka's Quick Chat is one feature-step away from being a real prompt-app runner. Adopting the row format (with `expectsImageResult` retry + form schema) lets us ship power-user templates without inventing a new abstraction. |
| 5 | **B-SBX-04** Bash auto-promote-to-background + `BashOutput` | M | Today every long-running command (build, test, dev server) blocks the turn until 120s timeout. Adding background promotion lets the LLM start a build, do other things, then check back. Matches alma's `main.js:23389-23407` design. |

Honorable mentions:

- **B-SBX-03** idle watchdog with kill-explanation — same-day win.
- **B-MCP-02** lifted JSON-Schema→Zod converter — reusable for plugins
  even without MCP.
- **B-TIME-05** 4-hour single-generation hard cap — defense against
  runaway tool loops, would only take a day on top of the existing
  StreamWatchdog.

---

## Appendix: alma source citations index

| Subsystem | `main.js` lines |
|----|----|
| MCP SDK imports | 179-193 |
| MCP config predicates (stdio/url) | 611-616 |
| MCP DB schemas | 617-657 |
| MCP FK-removal migration | 2784-2839 |
| `safeStorage` encrypt/decrypt | 24730-24739 |
| OAuth shim `ff` | 24740-24877 |
| OAuth manager `gf` | 24878-25185 |
| Tool-name sanitization + prefix | 25186-25203 |
| `mcpClientManager` (`Tf`) | 25212-25882 |
| `startServer` + stdio + remote transport | 25280-25513 |
| `callTool` (10-min timeout) | 25514-25521 |
| `getMCPToolSet` | 25536-25641 |
| `jsonSchemaToZod` | 25642-25676 |
| MCP express routes | 53201-53311 |
| MCP REST handlers | 66560-66742 |
| ACP forwarding to subagent | 19740-19757 |
| `prompt_apps` Drizzle schema | 223-248 |
| `prompt_app_executions` schema | 473-487 |
| Prompt-app migrations | 2189-2227 |
| Prompt-app CRUD | 4436-4579 |
| `executePromptApp` substitution | 66490-66518 |
| Prompt-app runner-open IPC | 72075-72142 |
| Prompt-app global hotkey `pA` | 72918-72988 |
| `SlashCommand` tool (`lf`) | 24648-24722 |
| `cf` command table (`/pwd`, `/ls`, `/cat`, `/todo`) | 24654-24683 |
| `prompt-app-runner-B-CoSHlI.js` (runner React) | n/a (renderer chunk) |
| Cron jobs.json migration | 43238-43316 |
| Heartbeat / Cron / ActivityRecorder init | per `19-time-driven.md §1` |
| Fatigue chunk loader | 34827, 61894 |
| Generation 4-hour watchdog | per `19-time-driven.md §7.1` |
| ACP provider schema fields | 462-467 |
| `dh` session manager | 19464-19911 |
| ACP MCP-server forwarding shape | 19740-19757 |
| `Jh` (`getAcpxPath`) | 20597-20615 |
| `Vh` (`getClaudeCodePath`) | 20616-20631 |
| `Kh` direct Claude Code spawn | 20632-20982 |
| `Qh` coder router | 20983-21488 |
| `op`/`sp`/`ep`/`tp` task lifecycle | 21490-21554 |
| Subagent tool whitelists `zh` | 20411-20459 |
| Subagent system prompts `Gh` | 20460-20474 |
| `memories` table | 542 (model), 985 (CREATE) |
| `memory_embeddings` vec0 table | 988 |
| `ensureVectorTableDimensions` | 1043 |
| `rebuildEmbeddings` | 1079 |
| `co.generateEmbedding` dispatcher | 1173 |
| `addMemoryWithLLMDedup` | 1265 |
| `searchMemories` (read-mutates) | 1326-1379 |
| Embedding provider selection | 16791, 64838 |
| Sleep service `_d`/singleton `xd` | 16906, 17481 |
| `runSleepCycle` | 17045 |
| Sleep Layer-3 system prompt `$d` | 17480 |
| Activity OCR table | 1940 |
| Activity OCR embedder `sT` | 46628 |
| Bash regex safe-list `Jp` | 22743-22797 |
| Bash regex deny-list `Vp` | 22798-22827 |
| Bash might-modify `Kp`/`Qp` | 22828-22854 |
| Workspace-relative redirection `em` | 22856 |
| Bash analyzer prompt `nm` | 22882-22885 |
| Bash schema `am` / output `dm` | 22971-22996 |
| Bash tool `hm` | 22997-23603 |
| Bash background spawn | 23274 |
| Bash foreground spawn + 3 timers | 23369-23523 |
| Bash env injection (`Fp`) | 22624-22701 |
| `Wd` rtk rewrite + `Bd` allow-list | 17792-17832 |
| Tool-result compaction profiles | 17897-17982 |
| `ih`/`ah`/`ch`/`lh` approval queue | 19228-19463 |
| `BashOutput` `Zm` | 24557 |
| `KillShell` `nf` | 24603 |
| `stopGeneration` kills all foreground bash | 59439-59458 |
