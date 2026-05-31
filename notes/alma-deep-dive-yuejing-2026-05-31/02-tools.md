# 02 — Tool Runtime: Registration, Permission, Streaming, Multimodal

**TL;DR.** Yetone has 35 tools wrapped by a single `mu()` telemetry shim, with approval baked into Bash via `lh()` and streaming context plumbed by AsyncLocalStorage. Maka has 6 builtin tools with proper out-of-band permission, async-queue streaming, and tool-output deltas — architecturally cleaner. The borrowable items are at the *individual tool* level: hash-line Edit, two-stage screenshot (thumb + full-res), `experimental_toToolResultContent` multimodal hook, ToolSearch as a semantic-search tool, and the auto-promote-to-background pattern for long-running Bash.

---

## 1. Registry comparison

### Yetone (`main.js:28954-29000`)

```js
const vw = fu({
  Bash, BashOutput, KillShell,
  Read, Write,
  get Edit() { return yh() ? Hm : jm; },     // gated by fh flag (classic vs hash-line)
  Glob, Grep,
  Task, TaskOutput, Skill, ToolSearch,
  WebSearch, WebFetch,
  BrowserOpen/Click/Type/Screenshot/Read/ReadDom/Back/Forward/Reload/Eval/Close,
  ChromeRelay*  (12 variants),
  widgetReadme, widgetRenderer, pieChart, barChart,
  AttemptCompletion, SlashCommand,
});
```

35 tools registered. Plus three more outside `vw` (thread-create, thread-delete, prompt-app management — `main.js:29023+`). MCP and plugin tools are merged at the agent loop entry by sanitized name (`serverName__toolName`, `pluginId.toolName`).

`fu()` (`main.js:18214`) wraps every `execute` with `mu(name, bound)` — the telemetry middleware.

### Maka (`packages/runtime/src/builtin-tools.ts`)

```ts
function buildBuiltinTools(): MakaTool[] {
  return [
    { name: 'Bash',  permissionRequired: true,  impl: ... },
    { name: 'Read',  permissionRequired: false, impl: ... },
    { name: 'Write', permissionRequired: true,  impl: ... },
    { name: 'Edit',  permissionRequired: true,  impl: ... },
    { name: 'Glob',  permissionRequired: false, impl: ... },
    { name: 'Grep',  permissionRequired: false, impl: ... },
  ];
}
```

6 builtins. No registry singleton — tools are passed into `AiSdkBackend` per session. No equivalent of `mu()` because telemetry is a separate `recordToolInvocation` callback.

The wrap layer lives in `wrapToolExecute()` (`ai-sdk-backend.ts:531-793`) and does: tool_call message append → start event → permission evaluate → impl → tool_result message append → result event → telemetry → artifact recording.

---

## 2. Tool definition shape

Both use Vercel AI SDK's `tool({ description, inputSchema, execute })` underneath. Yetone has:

```js
re({                                  // re = imported `tool`
  description: string,
  inputSchema: ie(zodSchema),         // ie = imported `zodSchema`
  outputSchema?: ie(...),
  execute: async (args) => { ... },
  experimental_toToolResultContent?: (output) => Array<{type, text|data, mimeType}>,
  toModelOutput?: (output) => { type: "content", value: [...] },
})
```

Maka's `MakaTool` (`ai-sdk-backend.ts:100-121`) adds:

- `permissionRequired: boolean` — skip the engine if false.
- `displayName?: string` — UI label.
- `categoryHint?: ToolCategory` — for the permission engine.

No `experimental_toToolResultContent`, no `toModelOutput`.

**Borrowable B-TOOLS-01**: Add `toModelOutput?: (impl_return) => ToolResultContent` on `MakaTool`. Wire it in `wrapToolExecute` between `tool.impl(...)` and `coerceResultContent(result)` (`ai-sdk-backend.ts:653-665`). Estimate: S.

---

## 3. Approval architecture

### Yetone — inline in Bash only

`main.js:19345` `lh()`:

```js
async function lh(e) {
  if (process.env.ALMA_HEADLESS === "1") return {
    approved: process.env.ALMA_TOOL_APPROVAL !== "deny",
    action: process.env.ALMA_TOOL_APPROVAL === "deny" ? "deny" : "allow_once",
  };
  // auto-approve when:
  //   settings.security.autoApproveToolRequests === true
  //   metadata.isSubagent === true
  //   source ∈ {telegram, discord, feishu, cron, heartbeat}
  //   thread is mapped to telegram/discord/feishu
  //   thread is a cron thread (title startsWith "⏰ Cron:")
  // else: IPC "tool-approval-dialog-respond" → waits for user click
}
```

Response actions: `allow_once | allow_always | deny | deny_with_reason | timeout | no-window`. The `approvalDecision` object `{ action, reason, decidedAt }` is persisted onto the tool part state so the UI can replay it.

**Only Bash calls `lh()`.** Write, Edit, ChromeRelay*, BrowserEval, etc. trust the model. The justification is "the parent chat session has already approved Alma at install time."

### Maka — proper park/resume

`packages/runtime/src/permission-engine.ts` is cleaner:

- `evaluate()` returns `{kind: 'allow'|'block'|'prompt', ...}` (`permission-engine.ts:127-187`).
- `'prompt'` returns a `parked: Promise<PermissionResponse>` that the caller awaits.
- `recordResponse()` routes a user reply to the parked promise.
- Per-turn `remembered: Set<string>` for `rememberForTurn: true` decisions.
- `endTurn()` rejects all still-parked requests as `user_stop`.

Maka's `wrapToolExecute` at `ai-sdk-backend.ts:574-635` pauses the watchdog while awaiting the parked promise.

**Architecturally Maka is ahead.** The only borrow worth considering:

**B-TOOLS-02**: Context-aware auto-bypass policies. The Yetone bypasses (`isSubagent`, bot platform, cron, headless) are reasonable defaults. Today Maka's `PermissionMode` is a single dimension; consider extending to a `bypassWhen: { isSubagent?, source?, cronJob? }` knob. Estimate: S in `permission-engine.ts` + `preToolUse()` in `@maka/core/permission`.

**B-TOOLS-03**: Persist the `approvalDecision` onto the tool_result message so the UI can replay user reasoning. Yetone caches it in a local `E` map (`main.js:63125`) and re-injects on every stream update so the UI never flickers back to "pending" (`main.js:63184`). Maka writes a `PermissionDecisionMessage` (`ai-sdk-backend.ts:607-617`) — this is *better*. No borrow needed for the persistence itself, but: check that the renderer reads the decision on every tool-part re-emit and doesn't show "Pending" on replay.

---

## 4. Streaming context: tool output deltas

### Yetone (`main.js:22736, 23039`)

`Hp(threadId, ctx)` stores a per-thread callbacks object. Bash uses:

```js
onStream: (e, t, s) => n.broadcastBashStream(o, e, t, s)
```

Two callbacks:
- `broadcastBashStream` → `message_delta` with `type: tool_output_streaming` (`main.js:63129`).
- `broadcastBashPartUpdate` → if `approvalDecision` is in the payload, structurally clone into a local `E` map *and* splice onto the persisted part directly (`main.js:63146-63182`).

Lookup is by AsyncLocalStorage (`pu.getContext().threadId`); single-active-thread fallback if context is lost.

### Maka (`packages/runtime/src/tool-output-delta.ts`)

`createToolOutputDeltaEmitter()` (`ai-sdk-backend.ts:644-651`) gives each tool an `emit(stream, chunk)` and a `flush()`. Wired through `MakaToolContext.emitOutput`. The emitter pushes `tool_output_delta` events into the AsyncEventQueue.

**Architecturally Maka is cleaner.** No AsyncLocalStorage trickery; the context is passed explicitly. No borrow.

---

## 5. Per-tool borrowable patterns

### 5.1 Bash auto-promote to background after 60s

`main.js:23369-23523`. **3-tier kill timer**:

1. **Idle watchdog**: if no output for 90s, SIGTERM + 5s SIGKILL grace ("waiting for interactive input" message).
2. **User `timeout` param**: SIGTERM + 5s SIGKILL.
3. **Auto-promote**: after 60s, the still-running process is *silently* promoted to a background shell (`bash_id` returned to the model). "Unique to Alma — Claude Code's Bash kills, Alma keeps it alive" (per `02-tools.md §1`).

Plus per-stream byte cap `Up = 256 KiB` (truncates with `stdoutTruncated`/`stderrTruncated` flags).

Maka's `runStreamingShell` (`builtin-tools.ts:155-231`) is simpler: single `options.timeout` kills with no grace and no promotion. Has `BASH_MAX_OUTPUT_BYTES = 10 * 1024 * 1024` (10 MB).

**B-TOOLS-04**: Borrow the **auto-promote-to-background** pattern. Long-running `pnpm test` should not be locked into the foreground. Implement: at 60s elapsed, return `{bash_id, status: 'background'}` synthetically and keep the child alive in a registry. Add a `BashOutput` tool to poll it. Estimate: M (~120 LOC plus a new `BashOutput` tool).

### 5.2 PR auto-detection from Bash output

`main.js:23541-23588`. If exit 0 and stdout/stderr contains `https://github.com/.../pull/<n>`, fetch PR info via `sm(workspaceCwd, prNumber)` and persist `{prNumber, prUrl, prState, prBaseBranch}` onto the workspace row.

Maka has no workspaces with persistent state of this kind, but the *pattern* is interesting: side-channel data extraction from tool output.

**B-TOOLS-05**: Optional. Probably wait until Maka has a workspace-management story.

### 5.3 ENV plumbed into Bash spawn

`main.js:23350-23365`:

```js
env = { ...Fp(),                              // PATH-restored login env from $SHELL -lc env
        CI: "1",
        DEBIAN_FRONTEND: "noninteractive",
        ALMA_THREAD_ID: <currentThreadId>,
        ALMA_CHAT_ID:   <channelMappingId>,
        RTK_DB_PATH:    <retoolKitDbPath>,
}
```

**No PTY.** `stdin` is closed immediately. So `vim`/`htop` will error.

Maka's `runStreamingShell` (`builtin-tools.ts:155-231`) spawns with `{ cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'] }` — no env injection at all, inherits the parent process environment.

**B-TOOLS-06**: Inject `MAKA_SESSION_ID`, `MAKA_TURN_ID`, `MAKA_WORKSPACE` into the env so user scripts (especially in skills) can route correctly. Also borrow `CI: "1"` and `DEBIAN_FRONTEND: "noninteractive"` defaults to silence interactive prompts. Estimate: S.

### 5.4 Read tool: image branch via macOS `sips`

`main.js:24058`. The image branch shells out to `/usr/bin/sips` for dimension probe and resize → JPEG quality 80, longest side 1600px. Returns base64. `experimental_toToolResultContent` (per the AI SDK) converts to `{type: "image", data: base64, mimeType: "image/jpeg"}` for the model.

Maka's `Read` (`builtin-tools.ts:52-68`) returns `{ content: string }` only. No image path.

**B-TOOLS-07**: Add image branch with multimodal output. macOS sips is one option but cross-platform we'd want `sharp` or `jimp`. Estimate: M (image deps + `toModelOutput` hook from B-TOOLS-01).

### 5.5 Two-stage screenshot pattern

`main.js:28677-28741` (ChromeRelayScreenshot):

> Returns a resized preview for model context and saves full resolution to disk. Use this only when visual layout or images matter.

Model sees a 1024px-wide JPEG thumbnail in chat context; full-resolution JPEG goes to `os.tmpdir()/alma-chrome-screenshot-full-<ts>.jpg` and the path is in the result so a follow-up Bash can re-read it.

**B-TOOLS-08**: When Maka eventually has a screenshot tool (e.g. from a future Computer Use integration), borrow this two-stage pattern. Avoids context-window blowup from full-res screenshots. Estimate: S (pattern, not implementation).

### 5.6 Edit tool: bottom-up sort + dedup

`main.js:24379-24400` (in the hash-line Edit `Hm`):

- **Dedup pass**: edits keyed by `(op, line(s), payload)` are deduplicated.
- **Bottom-up application**: edits sorted by `sortLine DESC, precedence` so later edits don't shift earlier indices.
- **Range trim heuristics**: for `replace` with `end`, if the last `lines[]` entry duplicates the line *after* the range, drop it (and emit a warning). Same for the leading line. Defensive against the model accidentally repeating boundary lines.

Maka's `Edit` (`builtin-tools.ts:82-103`) is single-edit only.

**B-TOOLS-09**: Add multi-edit batch mode. Borrow the bottom-up sort even if we don't add hash-line IDs. Estimate: M (new input schema variant: `edits: Array<{old_string, new_string}>`).

### 5.7 `Skill` tool — return raw markdown

`main.js:24631`. The `Skill` tool returns a *single string* (not an object) — the skill's full markdown content with an injected preamble that fixes the working directory.

This pattern is *exactly* the right move for Maka's skills surface. Today, `skills.ts` injects the skill content into the system prompt (`MAX_SKILLS_PROMPT_CHARS = 18000`), which doesn't scale.

**B-TOOLS-10**: Move skills out of the system prompt into a `Skill` tool that loads on demand. The `loadSkillInstructions` function in `apps/desktop/src/main/skills.ts` already does the heavy lifting. Estimate: M. See `03-prompts-and-skills.md` for the full plan.

### 5.8 `ToolSearch` — semantic tool discovery

`main.js:26302-26472` (full text in `~/Downloads/alma-re/docs/02-tools.md §12`).

```js
ng = re({
  description: "Search and discover available tools using semantic search…",
  inputSchema: ie(Qf),      // { query, type: "all"|"builtin"|"mcp"|"plugin", limit }
  outputSchema: ie(eg),
  execute: async ({ query, type = "all", limit = 20 }) => {
    // 1. Enumerate MCP tools + plugin tools + builtin (Object.keys(vw) - "ToolSearch")
    // 2. Compute cache key: `${type}|${candidateSetHash}|${query}|${candidateSetHash}`
    // 3. Vf cache check (30-min TTL)
    // 4. Resolve "tool model" (settings.memory.toolModel or fallback) → fd(provider, modelId)
    // 5. Build prompt listing all tools with [builtin]/[MCP:server]/[plugin:id] prefixes
    //    + canned one-liner descriptions for built-ins (tg @ main.js:26283)
    // 6. Ask via generateText: return JSON {"tools": [id], "reasoning": "..."}
    // 7. Parse, dedup, slice, return enriched entries
  },
});
```

The model calls this when it needs a capability it doesn't have. The `prepareStep` triad (see `01-agent-loop.md §3.1`) reads the result and merges the tool IDs into `activeTools` for subsequent steps.

**Key insight**: the `tg` table (`main.js:26283-26301`) has *one-liner hints* used in the search-model's prompt, separate from each tool's full description. Keeps the search prompt small.

**B-TOOLS-11**: Implement `ToolSearch` as a Maka tool. Pre-req: `prepareStep` (B-LOOP-03). Estimate: M (semantic-search implementation; can use a tiny model or even a cheap embedding-cosine pass). Risk: medium — needs a fallback when the tool model is unavailable.

### 5.9 Sentinel tools as protocol signals

`main.js:28903-28925` — `widgetRenderer`, `pieChart`, `barChart` all execute as `() => ({rendered:true})`. The frontend scans the tool-part stream and renders the `html` (or chart data) directly into a sandboxed iframe. **The tool call IS the render directive.**

`main.js:26492-26508` — `AttemptCompletion` literally returns `{success:true, result:e}`. The UI watches for this tool name in the stream and renders a "completion card" with the optional command as a runnable button.

**B-TOOLS-12**: Adopt the sentinel-tool pattern for future Maka renderers (mermaid, charts, custom widgets). Estimate: S per tool.

### 5.10 `widgetReadme` — progressive disclosure of style guides

`main.js:28877-28906`. The tool returns 10-40 KB of style guide based on the `modules: ["art"|"mockup"|"interactive"|"chart"|"diagram"]` selector. The base system prompt only knows "this tool exists for when you intend to render visuals." The actual style guide loads on demand.

This is the same pattern as `Skill`, just for design guidance instead of behavior.

**B-TOOLS-13**: When Maka has charting/diagramming, use this pattern. Don't put style guides in the base system prompt.

---

## 6. MCP integration (out of scope for Maka right now)

Per `~/Downloads/alma-re/docs/02-tools.md §MCP tools`: MCP is **not registered into `vw`**. The merge happens in the chat handler at `main.js:61222`:

```js
const M = Tf.getAllTools()
  .filter((e) => O.has(e.serverName))
  .map((e) => ({
    id: bf(e.serverName, e.tool.name),  // sanitized "serverName__toolName"
    name: e.tool.name,
    description: e.tool.description || e.tool.name,
    serverName: e.serverName,
  }));
```

ID format (`main.js:25201-25202`): `yf` replaces non-alphanumeric in serverName with `--`, `wf` does the same for tool name and squashes `_+`. So `computer-use` server's `screenshot` tool becomes `computer_use__screenshot`.

The 3 transports + OAuth 2.1 PKCE are in `~/Downloads/alma-re/docs/09-mcp.md`. For Maka this is future work; not urgent.

---

## 7. Subagents via `Task` tool

`main.js:22272-22478`. Three execution modes:

1. **Harness mode** (`handoff.harness.enabled === true`): Planner → Generator → Evaluator with 6 SQLite tables (`agent_missions`, `agent_runs`, `agent_handoffs`, `mission_sprints`, `sprint_contracts`, `sprint_evaluations`). Foreground only.
2. **Background**: `sp(taskRow, ...)` starts and returns `{status: "running"}` immediately.
3. **Foreground**: `op(taskRow, ...)` awaits, returns final result.

`op` (`main.js:21508`) is the subagent runner that *itself* calls `streamText`:

```js
h = ae({
  model: l,              // resolved subagent model OR parent's model
  system: r,             // subagent-type prompt + managed_agent_profile + managed_agent_catalog
  messages: [{ role: "user", content: e.prompt }],
  tools: n,              // per-subagent-type whitelist (Hh / Bh)
  stopWhen: ce(o),       // step cap
  abortSignal: c,
});
```

Subagent stream is consumed by `readUIMessageStream` and forwarded via `subagent_message_added` / `subagent_message_delta` / `subagent_message_completed` events on the parent broadcast channel. The string final result (`p.text`) is the value the parent's Task tool call observes.

Subagent types (`main.js:22136`):
- `general-purpose` `(Tools: *)`
- `statusline-setup` `(Tools: Read, Edit)`
- `Explore` `(Tools: All)` — fast codebase explorer
- `Plan` — software architect (returns design docs)
- `alma-guide` — answers about the Alma app itself
- `alma-operator` — reads/writes Alma config
- `coder` `(Tools: Bash, Glob, Grep, Read, Edit, Write, Skill)`

Maka has `apps/desktop/src/main/explore-agent-tool.ts` and `MAX_ACTIVE_SUBAGENT_TOOLS_PER_TURN = 5` (`ai-sdk-backend.ts:154`). Good guardrail; Yetone has nothing like this.

**B-TOOLS-14**: When extending subagents, borrow the **per-type tool whitelist** pattern. A `Plan` subagent doesn't need Bash; a `coder` doesn't need WebSearch. Today the explore tool gets a single hardcoded list. Estimate: S to extend; M if we add multiple subagent types.

**B-TOOLS-15**: Borrow `pu` AsyncLocalStorage's role: thread-context propagation across `await` boundaries. Maka passes context explicitly which is mostly fine, but if we ever add deeply-nested tool calls, AsyncLocalStorage with explicit-fallback (Yetone's `pu.getContext().threadId` falls back to "the only active thread") would be useful.

---

## 8. The `mu()` telemetry wrap

`main.js:18214`:

```js
function fu(e) {
  const t = {};
  for (const [n, o] of Object.entries(e)) {
    const e = o;
    o && typeof o === "object" && "execute" in e && typeof e.execute === "function"
      ? (t[n] = { ...o, execute: mu(n, e.execute.bind(o)) })
      : (t[n] = o);
  }
  return t;
}
```

Per `~/Downloads/alma-re/docs/00-GAP-ANALYSIS.md`, `mu` is **NOT** PostHog telemetry — it's the *Plugin hook lifecycle wrapper* that emits `tool.willExecute`/`tool.didExecute` hooks. The naming is misleading.

Maka has nothing equivalent (no plugin lifecycle yet). When/if plugins land, the wrap pattern is reasonable but the cleaner version would be inside `wrapToolExecute` (which is where Maka already has the seam).

---

## 9. Summary of borrowable items in this doc

| ID | Mechanic | Cite | Maka file | Scope | Risk |
|---|---|---|---|---|---|
| B-TOOLS-01 | `toModelOutput` multimodal hook | `main.js:24058, 27865, 28677-28741` | `ai-sdk-backend.ts:100-121, 653-665`, `builtin-tools.ts` | S | low |
| B-TOOLS-02 | Context-aware permission auto-bypass | `main.js:19345-19400` | `permission-engine.ts`, `@maka/core/permission` | S | low |
| B-TOOLS-03 | Approval decision UI replay invariant (verify Maka already does this) | `main.js:63125, 63184` | renderer side | — | — |
| B-TOOLS-04 | Bash auto-promote to background after 60s + BashOutput tool | `main.js:23274, 23369-23523` | `builtin-tools.ts`, new `BashOutput` tool | M | med |
| B-TOOLS-05 | PR auto-detection from Bash output | `main.js:23541-23588` | future workspace work | — | — |
| B-TOOLS-06 | Inject session env into Bash spawn | `main.js:23350-23365` | `builtin-tools.ts:165-169` | S | low |
| B-TOOLS-07 | Read tool image branch with multimodal output | `main.js:24058` | `builtin-tools.ts:52-68` | M | low |
| B-TOOLS-08 | Two-stage screenshot (thumb + full-res) | `main.js:28677-28741` | future screenshot tool | — | — |
| B-TOOLS-09 | Edit multi-edit batch with bottom-up sort | `main.js:24379-24400` | `builtin-tools.ts:82-103` | M | low |
| B-TOOLS-10 | `Skill` tool returning raw markdown on demand | `main.js:24631-24684` | new tool, `skills.ts` already has `loadSkillInstructions` | M | low |
| B-TOOLS-11 | `ToolSearch` semantic discovery | `main.js:26302-26472` | new tool + `prepareStep` (B-LOOP-03) | M | med |
| B-TOOLS-12 | Sentinel tools as protocol signals | `main.js:28903-28925` | future widget renderers | S | low |
| B-TOOLS-13 | `widgetReadme` progressive disclosure | `main.js:28877-28906` | future visual tooling | — | — |
| B-TOOLS-14 | Per-subagent-type tool whitelists | `main.js:22136` | `explore-agent-tool.ts` | S | low |
| B-TOOLS-15 | AsyncLocalStorage thread context (optional) | `main.js:22272-22478` | `ai-sdk-backend.ts` | M | med |
