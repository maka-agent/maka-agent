# 09 — Symbol Recovery: alma `readable/main.js`

> Audit artifact, not a code change. All citations are to
> `~/Downloads/alma-re/readable/main.js:NNNN`. Names like `Xb`, `tv`, `nv`
> are post-minification identifiers in the de-obfuscated bundle; this pass
> maps the ones with the highest signal value (high-frequency, structural)
> to inferred human names based on callsite evidence.

## TL;DR

Mapped ~45 symbols across constants, HTTP helpers, storage paths, logging,
crypto/encoding, and module entry points. The high-signal cluster is the
**WeChat (Weixin) bot** at `main.js:41308–41700+`, where five tightly-related
helpers (`Xb`, `Yb`, `Vb`, `Kb`, `Qb`, `Zb`, `tv`, `nv`, `ov`) implement the
ilink bot URL base, log file, UIN header, credential persistence, and
encrypted-CDN media download. Other big wins: `To` is the central
`DatabaseService` singleton, `Tf` the MCP tool registry, `Ey` the Chrome
extension bridge, `Nl` the provider registry, `Ql` the GitHub Copilot token
service, `Yu` the Skills service, `Ku` the channel-mapping service, and
`co`/`xd` the memory + memory-sleep services.

**Top 5 most-impactful inferences** (callsite line in parens):

1. `Xb` → `ILINK_BASE_URL = "https://ilinkai.weixin.qq.com"` (`main.js:41308`)
2. `To` → `databaseService` (the master SQLite/Drizzle service) (`main.js:5602`)
3. `Tf` → `mcpService` (MCP tools registry singleton) (`main.js:25212`)
4. `Ey` → `chromeExtensionBridge` (WebSocket + CDP proxy) (`main.js:28009`)
5. `Yu` → `skillsService` (personal / project / claude / codex skills) (`main.js:19127`)

---

## 1. Constants & URLs

### `Xb` → `ILINK_BASE_URL`

- **Declared at**: `readable/main.js:41308`
- **Inferred role**: Base URL for the WeChat (Weixin) iLink bot API.
- **Evidence**:
  - `main.js:41308` — `const Xb = "https://ilinkai.weixin.qq.com"`
  - `main.js:41518` — `await tv(\`${Xb}/ilink/bot/get_bot_qrcode?bot_type=3\`)` (QR code endpoint)
  - `main.js:41536` — `\`${Xb}/ilink/bot/get_qrcode_status?qrcode=${...}\`` (login poll)
  - `main.js:41542` — `base_url: e.baseurl || Xb` (fallback)
- **Maka equivalent**: `packages/runtime/src/bots/wechat-bridge.ts` (would hold the same constant if Maka had a Weixin path; currently no equivalent).

### `Yb` → `WEIXIN_C2C_CDN_BASE`

- **Declared at**: `readable/main.js:41309`
- **Inferred role**: CDN host for encrypted Weixin C2C media downloads (images/voice/files attached to messages).
- **Evidence**:
  - `main.js:41309` — `Yb = "https://novac2c.cdn.weixin.qq.com/c2c"`
  - `main.js:41394` — `\`${Yb}/download?encrypted_query_param=...\`` (used inside `ov` / `weixinCdnDownload`)
- **Maka equivalent**: none.

### `Jb` → `WEIXIN_CHANNEL_DEFAULTS`

- **Declared at**: `readable/main.js:41310`
- **Inferred role**: Static channel-version payload for ilink calls.
- **Evidence**:
  - `main.js:41310` — `Jb = { channel_version: "0.1.0" }`
- **Maka equivalent**: none.

### `Mw` → `ARTIFACTS_MODE_PROMPT`

- **Declared at**: `readable/main.js:29566`
- **Inferred role**: The very large multi-KB system-prompt fragment appended when the user is in Artifacts (workspace) mode — covers Vite/Bun guidance, design rules, no-neon palette, etc.
- **Evidence**:
  - `main.js:29566` — `const Mw = "\n## Artifacts Mode - Workspace-Based Development\n..."`
  - `main.js:61982` — `He = \`${He}\\n\\n${Mw}${p ? ... : ""}\`` (appended to system prompt)
- **Maka equivalent**: `packages/runtime/src/artifacts.ts` / `packages/core/src/artifacts.ts` (smaller scope).

### `Dw` → `BUILTIN_TOOL_DESCRIPTIONS`

- **Declared at**: `readable/main.js:29569`
- **Inferred role**: Per-builtin-tool one-line descriptions used by ToolSearch / planner heuristics.
- **Evidence**:
  - `main.js:29570–29593` — keys `Glob`, `Grep`, `Read`, `Edit`, `Write`, `Bash`, `Task`, `Skill`, etc.
- **Maka equivalent**: `packages/runtime/src/builtin-tools.ts`.

### `vw` → `BUILTIN_TOOL_REGISTRY`

- **Declared at**: `readable/main.js:28954`
- **Inferred role**: Map of name → tool implementation for all built-in tools (Bash, Read, Write, Edit, Grep, Glob, Task, Skill, ToolSearch, WebFetch, WebSearch, BrowserOpen…).
- **Evidence**:
  - `main.js:28954` — `vw = fu({ Bash: hm, BashOutput: Zm, Read: Om, Write: Jm, ... })`
  - `main.js:62065` — used to inject `<available_skills>` into prompts (sibling resolution)
  - `main.js:26334` — `Object.keys(vw).filter((e) => "ToolSearch" !== e)` in tool search dedup hash
- **Maka equivalent**: `packages/runtime/src/builtin-tools.ts` (`builtinTools` map).

### `Rl` → `DEFAULT_TOOL_MODELS_BY_PROVIDER`

- **Declared at**: `readable/main.js:15394`
- **Inferred role**: Static list of fallback "tool model" choices per provider (openai → gpt-4o-mini-2024-07-18, anthropic → claude-haiku-4-5-20251001, google → gemini-2.5-flash).
- **Evidence**:
  - `main.js:15394–15412` — declaration
  - `main.js:15451` — `const t = e ? Rl[e] : void 0;` in `Dl()` (auto-detect tool model)
- **Maka equivalent**: `packages/core/src/model-catalog.ts` / `packages/runtime/src/model-factory.ts`.

### `Ml` → `PROVIDER_PRIORITY_ORDER`

- **Declared at**: `readable/main.js:15413`
- **Inferred role**: Ranking order used to pick a default tool-model provider.
- **Evidence**:
  - `main.js:15413` — `Ml = ["openai", "anthropic", "google", "openrouter", "custom", "plugin"]`
  - `main.js:15448` — `.sort((e, t) => Ml.indexOf(e.type) - Ml.indexOf(t.type))`
- **Maka equivalent**: implicit in `packages/core/src/llm-connections.ts`.

### `Ul` → `COPILOT_CLIENT_ID`

- **Declared at**: `readable/main.js:15480`
- **Inferred role**: GitHub OAuth client ID used by Copilot device-code login (`Iv1.b507a08c87ecfe98` is the official VSCode chat client).
- **Evidence**:
  - `main.js:15480` — `Ul = "Iv1.b507a08c87ecfe98"`
  - `main.js:15481` (`Bl`) / `:15482` (`jl`) / `:15483` (`Wl`) / `:15484` (`zl`) / `:15485` (`Gl`) — paired GitHub/Copilot URLs.
- **Maka equivalent**: none (Maka does not ship a Copilot integration).

### `Yl` → `COPILOT_HTTP_HEADERS`

- **Declared at**: `readable/main.js:15489`
- **Inferred role**: Standard HTTP header bag the Copilot service spoofs as VSCode 1.104.1 + copilot-chat 0.26.7.
- **Evidence**:
  - `main.js:15489–15496` — declaration
  - `main.js:15520` — `this.headers = { ...Yl }` (Copilot token service constructor)
- **Maka equivalent**: none.

### `Jl` → `COPILOT_API_HEADERS`

- **Declared at**: `readable/main.js:15497`
- **Inferred role**: Spoofed integration-id headers sent on Copilot API requests.
- **Evidence**:
  - `main.js:15497` — declaration
- **Maka equivalent**: none.

### `Zd` → `OUTPUT_TRUNCATION_DEFAULTS`

- **Declared at**: `readable/main.js:17897`
- **Inferred role**: Per-tool char/line caps + truncation strategies (head / tail / head-tail) for tool outputs (`stdout`, `stderr`, `content`, `markdown`, `elements`, …).
- **Evidence**:
  - `main.js:17897–17941` — full structure with `stringLimits`, `lineLimits`, `strategies`.
  - `main.js:17942` (`eu`), `:17948` (`tu`), `:17954` (`nu`), `:17960` (`ou`) — variant presets (smaller for compaction, larger for markdown/elements).
- **Maka equivalent**: `packages/runtime/src/tool-output-delta.ts` covers a related concern but not identical.

### `Sh` → `BUILTIN_AGENT_PROFILES`

- **Declared at**: `readable/main.js:20034`
- **Inferred role**: Hard-coded list of built-in sub-agent profiles (Designer, Product Manager, Researcher, Developer…) with prompts and delegation rules.
- **Evidence**:
  - `main.js:20035–20053` — Designer entry
  - `main.js:20056+` — Product Manager entry
- **Maka equivalent**: `packages/core/src/explore-agent.ts` is the nearest analogue (Maka exposes far fewer canned profiles).

### `Mn` / `En` / `Tn` / `Pn` / `Dn` / `Ln` / `Fn` / `Un` → Drizzle table descriptors

- **Declared at**: `readable/main.js:528` (`Mn` = `channel_mappings`), `:277` (`En` = `chat_threads`), `:257` (`Tn` = `workspaces`), `:542` (`Pn` = `memories`), `:552` (`Dn` = `memory_archive`), `:567` (`Ln` = `memory_sleep_runs`), `:587` (`Fn` = `model_capabilities_cache`), `:594` (`Un` = `provider_models_cache`).
- **Inferred role**: Drizzle-style `te(<table>, {…columns…})` table objects. These are the database schema. `Mn`, `En`, `Pn` are referenced everywhere in queries.
- **Evidence**:
  - `main.js:4137–4170` — `H(Mn.platform, e), H(Mn.externalChatId, t), …` repeated query construction
  - `main.js:287` — `workspaceId: ne("workspace_id").references(() => Tn.id, ...)` cross-reference between `En` (threads) and `Tn` (workspaces).
- **Maka equivalent**: `packages/storage/src/session-store.ts`, `connection-store.ts`, etc. (Maka uses a different ORM layout).

---

## 2. HTTP helpers

### `tv` → `ilinkGet`

- **Declared at**: `readable/main.js:41350`
- **Inferred role**: Authenticated GET wrapper for the iLink bot API: adds the `X-WECHAT-UIN` header (generated by `Kb`), 15 s `AbortController` timeout, parses JSON.
- **Evidence**:
  - `main.js:41350` — `async function tv(e, t) { … "X-WECHAT-UIN": Kb() … }`
  - `main.js:41518` — `await tv(\`${Xb}/ilink/bot/get_bot_qrcode?bot_type=3\`)`
  - `main.js:41535` — `await tv(\`${Xb}/ilink/bot/get_qrcode_status?qrcode=…\`)`
- **Maka equivalent**: closest is `packages/runtime/src/bots/proxied-fetch.ts`, but Maka has no iLink-specific helper.

### `nv` → `ilinkPostJson`

- **Declared at**: `readable/main.js:41366`
- **Inferred role**: Authenticated POST wrapper for iLink. Adds `Bearer ${bot_token}`, `AuthorizationType: ilink_bot_token`, `X-WECHAT-UIN`, `Content-Type: application/json`. Optionally suppresses logging for the high-frequency `getupdates` long-poll.
- **Evidence**:
  - `main.js:41366` — declaration
  - `main.js:41370` — `i && Vb("[WeixinAPI] POST", t);` (suppress on getupdates)
  - `main.js:41383` — `Vb("[WeixinAPI] POST", t, "->", a.status, c.substring(0, 300));`
- **Maka equivalent**: none.

### `ov` → `weixinCdnDownload`

- **Declared at**: `readable/main.js:41388`
- **Inferred role**: Downloads a Weixin C2C CDN attachment, accepting either a `full_url` or an `encrypt_query_param`. Decrypts with AES-128-ECB using the per-message `aes_key` (hex or base64). Returns a `Buffer`.
- **Evidence**:
  - `main.js:41394` — builds CDN URL from `Yb`
  - `main.js:41408` — `Nt.createDecipheriv("aes-128-ecb", t, null)`
  - `main.js:41420–41429` — logs decrypted byte length + first-4-byte magic.
- **Maka equivalent**: none (Maka has no Weixin CDN integration).

### `Zl` → `copilotAuthedFetch`

- **Declared at**: `readable/main.js:15870`
- **Inferred role**: Returns a fetch-compatible function that injects the per-account Copilot token, classifies the request (model, image, role), and feeds it into the Copilot Kl service. Used as `fetch` override when constructing the Copilot OpenAI client.
- **Evidence**:
  - `main.js:15870` — `function Zl(e, t)`
  - `main.js:15872` — `const s = t ? await Ql.getTokenForAccount(t) : await Ql.getToken()`
- **Maka equivalent**: none.

### `Wg` → `waitForNetworkIdle`

- **Declared at**: `readable/main.js:27505`
- **Inferred role**: Wraps an Electron `BrowserWindow.webContents.session` and resolves when network activity has been quiet for `t` ms (default 15 s). Used to know when a navigated page is "done".
- **Evidence**:
  - `main.js:27505` — `const Wg = (e, t = 15e3) => new Promise((n) => {…onBeforeRequest…onCompleted…onErrorOccurred…})`
- **Maka equivalent**: `packages/runtime/src/stream-watchdog.ts` is the closest concept, though different (LLM stream, not webRequest).

### `Lv` → `chromiumAppleScriptTemplate`

- **Declared at**: `readable/main.js:45552`
- **Inferred role**: Returns an AppleScript snippet (parameterised by app name) that pulls the front-window active-tab URL+title from Chromium-family browsers. Used by the macOS activity recorder.
- **Evidence**:
  - `main.js:45552` — template string
  - `main.js:45554` (`Fv`) — Safari counterpart.
- **Maka equivalent**: none (activity recorder is alma-specific).

---

## 3. Storage helpers

### `Qb` → `weixinStateDir`

- **Declared at**: `readable/main.js:41325`
- **Inferred role**: Returns the per-user directory for Weixin bot state: prefers `app.getPath("userData")/weixin-state`, falls back to `~/.config/alma/weixin-state` when Electron is unavailable.
- **Evidence**:
  - `main.js:41327` — `F.join(n.getPath("userData"), "weixin-state")`
  - `main.js:41334` — `b.readFileSync(F.join(Qb(), "credentials.json"), …)` (used by `Zb`)
  - `main.js:41547` — `const t = Qb(); b.mkdirSync(t, …); b.writeFileSync(F.join(t, "credentials.json"), …)` (write path)
  - `main.js:41584` — `b.readFileSync(F.join(Qb(), "cursor.json"), "utf-8")` (cursor read)
- **Maka equivalent**: would belong in `packages/storage/src/` if Maka shipped a Weixin bot.

### `Zb` → `loadWeixinCredentials`

- **Declared at**: `readable/main.js:41332`
- **Inferred role**: Reads + parses `${Qb()}/credentials.json`. Returns `null` on missing/invalid or missing `bot_token`.
- **Evidence**:
  - `main.js:41332` — declaration
  - `main.js:41506` — `this.credentials = Zb()` in `WeixinBot` constructor (the class is `iv` at `:41488`).
- **Maka equivalent**: none.

### `ev` → `saveWeixinCursor`

- **Declared at**: `readable/main.js:41341`
- **Inferred role**: Persists the long-poll cursor to `${Qb()}/cursor.json`. Called after each successful `getupdates` to support resume across restarts.
- **Evidence**:
  - `main.js:41341` — declaration
- **Maka equivalent**: none.

### `wh` → `getCwd`

- **Declared at**: `readable/main.js:19995`
- **Inferred role**: Returns the current working directory for the active conversation, drawn from an `AsyncLocalStorage` (`hh`) populated per-request, or falls back to a module-level default (`ph`).
- **Evidence**:
  - `main.js:19995` — `return hh.getStore() || ph;`
  - `main.js:20010` — `const n = wh(); return C.resolve(n, t);` in `vh` (path resolver)
  - `main.js:23664` — `cwd: Th(s)` (used for Glob/Grep tool output)
- **Maka equivalent**: `packages/runtime/src/session-manager.ts` exposes per-session cwd context.

### `Th` → `relPath`

- **Declared at**: `readable/main.js:20012`
- **Inferred role**: Returns the path of `e` made relative to the active workspace cwd, or `"."` when identical. Used to keep tool output tidy.
- **Evidence**:
  - `main.js:20013` — `const t = wh(); return C.relative(t, e) || "."`
  - `main.js:23657` — `path: Th(t)` (Glob results)
  - `main.js:23797` — `cwd: Th(m), pattern: e, …` (ripgrep results)
- **Maka equivalent**: scattered helpers in `packages/runtime/src/builtin-tools.ts`.

### `co` → `memoryService`

- **Declared at**: `readable/main.js:850`
- **Inferred role**: Anonymous-class singleton that owns the sqlite-vec extension, rebuild progress, embedding regeneration, and the `memory_vec` table. Initialized from `vo.initialize` (`main.js:1813` — `await co.initialize(e)`).
- **Evidence**:
  - `main.js:850` — class begin (`isReady`, `isRebuilding`, `getRebuildProgress`, `initialize`)
  - `main.js:887` — `[sqlite-vec] Looking for extension: …` (loads the native module)
- **Maka equivalent**: `packages/core/src/memory.ts` + `packages/core/src/local-memory.ts`.

### `xd` → `memorySleepService`

- **Declared at**: `readable/main.js:17481`
- **Inferred role**: Singleton of the memory consolidation "sleep" pass; runs the LLM consolidator with the system prompt at `$d` (`:17479`) and writes to `memory_sleep_runs` / `memory_archive`.
- **Evidence**:
  - `main.js:17481` — `xd = new _d()`
  - `main.js:17488` — exported as `memorySleepService` on the frozen `Cd` module.
  - `main.js:1815` — `const { memorySleepService: e } = await Promise.resolve().then(() => Cd); e.start();`
- **Maka equivalent**: none yet (Maka has no sleep/consolidation worker).

---

## 4. Logging & telemetry

### `Vb` → `weixinLog` (or `weixinBotLog`)

- **Declared at**: `readable/main.js:41311`
- **Inferred role**: Append-only logger for the Weixin bot — writes to `${tmpdir}/alma-logs/weixin-bot-${YYYY-MM-DD}.log` and mirrors to `console.log`. Serializes objects via `JSON.stringify`.
- **Evidence**:
  - `main.js:41311` — declaration (`function Vb(e, ...t)`)
  - `main.js:41396` — `Vb("[WeixinBot] CDN downloading:", n.substring(0, 120));`
  - `main.js:41510` — `Vb("[WeixinBot] Login already in progress")`
  - `main.js:41561` — `Vb("[WeixinBot] Login confirmed, bot:", t.bot_id)`
- **Maka equivalent**: `packages/runtime/src/telemetry/` (general structured logging; Maka has no Weixin-specific log).

### `Cb` → `messageBridgeLog`

- **Declared at**: `readable/main.js:34446`
- **Inferred role**: Mirror logger used by the `MessageBridge` module — writes structured log lines to `/tmp/alma-bridge-debug.log` and also `console.log`s. Same shape as `Vb` but a different file.
- **Evidence**:
  - `main.js:34446` — declaration
  - `main.js:34598` — `Cb(\`[MessageBridge] AI tool reaction: ${f} for tool: ${n}\`)`
  - `main.js:34765` — `Cb(\`[MessageBridge] Sent ${n} to ${e}, messageId: ${t}\`)`
  - `main.js:34817` — `Cb("[MessageBridge] handleMessage called", {...})`
  - `main.js:34871` — `Cb("[MessageBridge] Thread busy, creating new thread.…")`
- **Maka equivalent**: `packages/runtime/src/bots/base-adapter.ts` does structured logging via the standard logger.

### `appendChatLog` (method on the un-named class at `:41296`)

- **Declared at**: `readable/main.js:41296`
- **Inferred role**: Feishu/Lark group chat log writer — per-group per-day text log under `~/.config/alma/groups/feishu_${groupId}_${date}.log`.
- **Evidence**:
  - `main.js:41302` — `l = F.join(i, \`feishu_${e}_${a}.log\`);`
  - `main.js:41303` — `\`[${c}]${r ? ` [msg:${r}]` : ""} ${o ? "[Alma]" : \`[${t}]\`}: …\``
- **Maka equivalent**: per-platform logs in `packages/runtime/src/bots/*-bridge.ts`.

### `Sentry` (`yn`)

- **Declared at**: `readable/main.js:209`
- **Inferred role**: Aliased import of `@sentry/electron/main`.
- **Evidence**:
  - `main.js:209` — `import * as yn from "@sentry/electron/main";`
- **Maka equivalent**: not present (Maka does not ship Sentry).

### `kb` → `pendingReactionExports` / `_b` → `pendingSendVoiceExports`

- **Declared at**: `readable/main.js:34401` (`kb`), `:34431` (`_b`)
- **Inferred role**: Frozen module objects exposing `invokePendingReaction` / `setPendingReactionCallback` and the voice-message equivalents (`Tb`/`Ab` are the module-scoped callback refs, `Eb`/`Ib` the setters).
- **Evidence**:
  - `main.js:34390` — `let Tb = null;`
  - `main.js:34399` — `Tb ? { success: await Tb(e, t), emoji: e } : { success: !1, emoji: e }`
  - `main.js:34420` — `let Ab = null;` mirrors for voice.
- **Maka equivalent**: `packages/runtime/src/bots/*-bridge.ts` reaction APIs (each adapter implements its own).

---

## 5. Crypto / encoding

### `Kb` → `randomWechatUin`

- **Declared at**: `readable/main.js:41321`
- **Inferred role**: Generates a per-request `X-WECHAT-UIN` header value: 4 random bytes → read as little-endian uint32 → decimal string → base64. Re-rolled on every call (no persistence).
- **Evidence**:
  - `main.js:41321` — declaration
  - `main.js:41356` — `headers: { "X-WECHAT-UIN": Kb(), ...t }` (used by `tv`)
  - `main.js:41376` — used by `nv` (POST helper).
- **Maka equivalent**: none.

### `decryptWeixinPayload` (anonymous IIFE inside `ov`)

- **Declared at**: `readable/main.js:41407–41420` (inline)
- **Inferred role**: AES-128-ECB decrypt with the per-message key. Accepts 32-char hex, base64 (16 raw bytes), or 32-char base64-of-hex.
- **Evidence**:
  - `main.js:41408` — `Nt.createDecipheriv("aes-128-ecb", t, null)`
  - `main.js:41413` — `if (/^[0-9a-fA-F]{32}$/.test(e)) return Buffer.from(e, "hex");`
- **Maka equivalent**: none.

### `Nt` (`crypto` module alias)

- **Declared at**: `readable/main.js:169` (`import * as Nt from "crypto";`)
- **Inferred role**: Namespace alias for Node's `crypto`. Source of `randomBytes`, `createHash`, `createDecipheriv`.
- **Evidence**:
  - `main.js:41322` — `Nt.randomBytes(4).readUInt32LE(0)`
  - `main.js:41408` — `Nt.createDecipheriv(...)`
- **Maka equivalent**: Maka uses `node:crypto` directly.

### `Ve` (`node:crypto` alias), `Ke` (`node:crypto` default), `Ot` (`crypto` default)

- **Declared at**: `main.js:131` (`Ve`), `:132` (`Ke`), `:170` (`Ot`).
- **Inferred role**: Multiple aliases of the same module (bundler artefact).
- **Evidence**:
  - `main.js:26338` — `Ke.createHash("sha1").update(JSON.stringify(n))` (tool-search dedup key)
- **Maka equivalent**: `node:crypto`.

### `rv` → `stripMarkdownForTelegram`

- **Declared at**: `readable/main.js:41474`
- **Inferred role**: Removes Markdown decoration (code fences, headings, bold/italic, inline code, links, images) for plain-text Telegram/Weixin output.
- **Evidence**:
  - `main.js:41477–41483` — regex chain removing `^```...`, `^#{1,6} `, `*…*`, `_…_`, backticks, `[text](url)`, `![alt](url)`.
- **Maka equivalent**: `packages/runtime/src/bots/base-adapter.ts` likely has a sibling for Telegram MarkdownV2 escaping.

### `sv` → `mimeTypeFromFilename`

- **Declared at**: `readable/main.js:41439`
- **Inferred role**: Extension → MIME-type table (jpg/png/mp4/pdf/docx/xlsx/zip/…). Default `application/octet-stream`.
- **Evidence**:
  - `main.js:41441–41471` — declaration with explicit map.
- **Maka equivalent**: probably inline in `packages/runtime/src/bots/*-bridge.ts`; Maka tends to reach for the `mime` package.

### `Pw` → `IS_MACOS`

- **Declared at**: `readable/main.js:29568`
- **Inferred role**: `Pw = "darwin" === process.platform`. Used to swap `Bash`-tool description copy.
- **Evidence**:
  - `main.js:29568` — declaration
  - `main.js:29576` — `Bash: Pw ? "Run shell commands … osascript …" : "Run shell commands …"`.
- **Maka equivalent**: scattered checks against `process.platform`.

---

## 6. Module entry points

### `To` → `databaseService`

- **Declared at**: `readable/main.js:5602`
- **Inferred role**: The master SQLite + Drizzle service. Carries `sqlite`, `db`, all CRUD helpers (`getSettings`, `createThread`, `getActiveChannelMapping`, `getWorkspaceById`, `getAllProviders`, `generateId`, `updateAgentMission`, `getAgentRunByTaskId`, …). Used in hundreds of places.
- **Evidence**:
  - `main.js:5602` — `const To = new vo()`
  - `main.js:13413` — `To.getModelCapabilitiesFromCache(e)` (read-through cache)
  - `main.js:15415` — `To.getSettings()` (tool-model resolution)
  - `main.js:19141` — `To.getOrCreateDefaultWorkspace().id`
  - `main.js:19148` — `To.getActiveChannelMapping(e, t, n)`
- **Maka equivalent**: `packages/storage/src/session-store.ts` plus sibling stores — Maka splits this into per-concern repositories.

### `Tf` → `mcpService`

- **Declared at**: `readable/main.js:25212`
- **Inferred role**: MCP-server registry singleton (extends `EventEmitter`/`Gt`). Holds `servers`, owns `~/.config/alma/mcp.json`, manages `initialize`, `refresh`, `startServer`, `getAllTools`, stderr buffering.
- **Evidence**:
  - `main.js:25219` — `this.configPath = F.join(n.getPath("home"), ".config", "alma", "mcp.json")`
  - `main.js:25273` — `await Promise.allSettled(t.map(([e, t]) => this.startServer(e, t)));`
  - `main.js:26309` — `Tf.getAllTools().map(…)` (consumed by `ToolSearch`)
- **Maka equivalent**: Maka does not yet ship MCP support; nothing in `packages/runtime/src/`.

### `Ey` → `chromeExtensionBridge`

- **Declared at**: `readable/main.js:28009`
- **Inferred role**: WebSocket bridge to the Chrome extension; exposes `listTabs`, `createTab`, `navigate`, `screenshot`, `sendCDP`, `onCDPEvent`, `click`, `type`. Used by all `Browser*` tools.
- **Evidence**:
  - `main.js:28009` — `const Ey = new (class { ws = null; pendingRequests = new Map(); … })`
  - `main.js:28069` — `if (!this.ws || this.ws.readyState !== _t.OPEN) return void o(new Error("Chrome extension is not connected"));`
  - `main.js:28607` — `await Ey.listTabs()` (BrowserOpen tool)
  - `main.js:28640` — `Ey.click(e, t)` (BrowserClick tool)
- **Maka equivalent**: Maka has no browser-CDP bridge; the closest concept lives in `apps/` (renderer).

### `Nl` → `pluginProviderRegistry`

- **Declared at**: `readable/main.js:15386` (instance), `:15163` (class `Cl`)
- **Inferred role**: Registry of plugin-installed LLM providers. Tracks `providers`, `initContexts`, `providerInfoCache`, `authCache`. Backs `isAuthenticated`, `getSDKType`, `getSDKConfig`, `list`, `register`, `unregister`.
- **Evidence**:
  - `main.js:15431` — `t = Nl.list()` inside `Dl()` (auto-detect tool model)
  - `main.js:16602` — `return Nl.isPluginProvider(e);`
  - `main.js:16624–16625` — `Nl.getSDKConfig(e)` / `Nl.getSDKType(e)`
- **Maka equivalent**: `packages/core/src/provider-auth.ts` + `connections.ts`.

### `Ql` → `copilotTokenService`

- **Declared at**: `readable/main.js:15869` (instance), `:15510` (class `Kl`)
- **Inferred role**: Multi-account Copilot OAuth/token service. Manages `~/.copilot_accounts/`, encrypted token storage (via Electron `safeStorage`), legacy-token migration, model list TTL cache, `useResponses` toggle per-account.
- **Evidence**:
  - `main.js:15521` — `this.accountsDir = U.join(n.getPath("userData"), ".copilot_accounts")`
  - `main.js:15577` — `saveAccountToken(e, t)` encrypts via `a.encryptString` (Electron safeStorage).
  - `main.js:15872` — `t ? await Ql.getTokenForAccount(t) : await Ql.getToken()` (used inside `Zl`)
  - `main.js:16484` — `(await Ql.isModelUsingResponses(n)) ? s.responses(n) : s.chat(n)`
- **Maka equivalent**: none (Maka does not integrate Copilot).

### `Vl` → `CopilotServiceError`

- **Declared at**: `readable/main.js:15505`
- **Inferred role**: `class Vl extends Error { constructor(e, t) { super(e); this.cause = t; this.name = "CopilotServiceError"; } }`
- **Evidence**:
  - `main.js:15669` — `throw new Vl("Failed to get GitHub authorization info", t)`
  - `main.js:15699` — `throw new Vl("Authorization request expired. Please try again.")`
  - `main.js:15707` — `if (o instanceof Vl) throw o;`
- **Maka equivalent**: none.

### `Yu` → `skillsService`

- **Declared at**: `readable/main.js:19127` (instance), `:18571` (class `Xu`)
- **Inferred role**: Discovers and serves skills from four locations: `~/.config/alma/skills`, `~/.claude/skills`, `~/.codex/skills`, `~/.agents/skills`, plus `~/.claude/plugins`. Imports / deletes / refreshes user skills. Provides `buildSkillsContext` for prompt injection.
- **Evidence**:
  - `main.js:18583–18601` — constructor sets the five paths.
  - `main.js:19084` — `this.parseSkillMd(s)`
  - `main.js:19127` — `const Yu = new Xu();`
  - `main.js:21357` — `const e = Yu.buildSkillsContext();`
  - `main.js:24633` — `let n = Yu.getSkillByName(t);`
- **Maka equivalent**: not yet implemented; Maka has no Skills registry.

### `Ku` → `channelMappingService`

- **Declared at**: `readable/main.js:19202` (instance), `:19146` (class `Vu`)
- **Inferred role**: Maps `(platform, externalChatId, externalUserId)` → internal `threadId`. Backs every bot adapter's "where do replies go" lookup. Wraps the `channel_mappings` table (`Mn`).
- **Evidence**:
  - `main.js:19147` — `getOrCreateMapping(e, t, n, o, s)` (creates a fresh `"Telegram Chat"` thread on miss)
  - `main.js:19172` — `getMappingByThreadId(e)` uses raw SQL.
  - `main.js:19413` — `const t = Ku.getMappingByThreadId(e);`
- **Maka equivalent**: cross-cutting; logic in `packages/runtime/src/bots/bot-registry.ts` + `packages/storage/src/session-store.ts`.

### `Ju` → `getWorkspaceIdForChannel`

- **Declared at**: `readable/main.js:19128`
- **Inferred role**: Resolves the workspace a chat should land in: per-channel mapping → general default → `getOrCreateDefaultWorkspace`.
- **Evidence**:
  - `main.js:19133` — `const s = o?.[e]?.channelWorkspaceMap;`
  - `main.js:19138` — `const r = o?.general?.defaultWorkspaceId;`
- **Maka equivalent**: implicit inside `packages/runtime/src/bots/base-adapter.ts`.

### `iv` → `WeixinBot` (class)

- **Declared at**: `readable/main.js:41488`
- **Inferred role**: The Weixin bot client. Holds `running`, `loggedIn`, `qrUrl`, `qrToken`, `credentials`, `contextTokens`, `pendingMessages`. Static `DEBOUNCE_MS = 1500`, `MEDIA_WAIT_MS = 15_000`. Methods: `startLogin`, `pollLoginStatus`, `start`. Receives messages via the long-poll inside `start`.
- **Evidence**:
  - `main.js:41488–41507` — class header + constructor (loads `Zb()` creds, marks logged in)
  - `main.js:41509` — `startLogin` calls `tv(\`${Xb}/ilink/bot/get_bot_qrcode?bot_type=3\`)`
  - `main.js:41533` — `pollLoginStatus`
  - `main.js:41574` — `async start()` which kicks off the long-poll cursor loop.
- **Maka equivalent**: `packages/runtime/src/bots/wechat-bridge.ts` (different protocol, but the same conceptual seat — a single `*Bot` class managing login state + an event loop).

### `Tp` → `updateMissionPhase`

- **Declared at**: `readable/main.js:21594`
- **Inferred role**: Helper that updates `currentPhase` and `currentSprintId` on the agent mission row.
- **Evidence**:
  - `main.js:21596` — `To.updateAgentMission(e, { currentPhase: t, currentSprintId: n || null });`
- **Maka equivalent**: not explicitly modelled (Maka's `explore-agent.ts` has no concept of a sprint).

### `Sc` → `modelCapabilitiesCache`

- **Declared at**: `readable/main.js:13236`
- **Inferred role**: Module-level in-memory cache `{ data: Record<model, capabilities>, fetchedAt }`. Backed by `model_capabilities_cache` (`Fn`) and refreshed every 10 minutes.
- **Evidence**:
  - `main.js:13289` — `Sc = { data: o, fetchedAt: r };` (initial load)
  - `main.js:13340` — `(Sc && e - Sc.fetchedAt < 6e5) || …` (10-min TTL guard)
  - `main.js:13409` — `if (Sc.data[e]) return Sc.data[e];` (hit path inside `Dc`)
- **Maka equivalent**: `packages/runtime/src/model-fetcher.ts` + `packages/core/src/capabilities.ts`.

### `Dc` → `getModelCapabilities` / `Uc` → `getModelCapabilitiesWithXmlFallback`

- **Declared at**: `readable/main.js:13402` (`Dc`), `:13454` (`Uc`)
- **Inferred role**: `Dc` resolves a model's capability descriptor (function-calling, reasoning, image output, etc.) via regex rules (`Mc`/`Rc`), the cache (`Sc`), or a DB lookup; falls back to `Oc` defaults. `Uc` wraps `Dc` and forces `functionCallingViaXml = true` when native function-calling is unavailable.
- **Evidence**:
  - `main.js:13404` — `for (const { pattern: s, capabilities: r } of Mc) if (s.test(e)) return Pc(e, r);`
  - `main.js:13456` — `return n.functionCalling ? n : { ...n, functionCallingViaXml: !0 };`
- **Maka equivalent**: `packages/core/src/capabilities.ts`.

### `Pl` → `getEffectiveToolModel` / `Dl` → `getAutoDetectedToolModel` / `Ll` → `getMemoryToolModel`

- **Declared at**: `readable/main.js:15414` (`Pl`), `:15424` (`Dl`), `:15458` (`Ll`)
- **Inferred role**: Pick the tool-model: (1) user-pinned in settings `toolModel.model`, else (2) auto-detect by walking the provider priority order (`Ml`) and the default-model table (`Rl`). `Ll` is the memory-pass equivalent (`settings.memory.toolModel`).
- **Evidence**:
  - `main.js:15419` — `if (t.toolModel?.model) return { model: t.toolModel.model, isAutoDetected: !1 };`
  - `main.js:15454` — `return \`${o.id}:${n}\`;` (provider-prefixed model id)
- **Maka equivalent**: `packages/runtime/src/model-factory.ts` + `packages/core/src/settings.ts`.

### `Fl` → `toolModelModule` (frozen export)

- **Declared at**: `readable/main.js:15468`
- **Inferred role**: Frozen module object: `{ getAutoDetectedToolModel: Dl, getEffectiveToolModel: Pl, getMemoryToolModel: Ll }`. The webpack-style namespace export for the tool-model resolver.
- **Evidence**:
  - `main.js:15468–15478` — declaration.
- **Maka equivalent**: ESM-native equivalent in `packages/runtime/src/model-factory.ts`.

### `Sb`/`vb` etc. → tool input schemas

- **Declared at**: `readable/main.js:34376–34418` cluster
- **Inferred role**: Zod schemas for built-in reaction / voice tools (`vb` = reaction input, `Sb` = TTS input). Paired with `xt.object({ success: …, emoji: … })` for outputs and `re({...})` invocations that wire them into the tool registry `vw`.
- **Evidence**:
  - `main.js:34394` — `re({ description: "React to a message…", inputSchema: ie(vb), execute: async ({ emoji: e, messageId: t }) => Tb ? … : … });`
- **Maka equivalent**: `packages/runtime/src/builtin-tools.ts`.

### `$b` → `__filename` (module file), `xb` → `__dirname` (module dir)

- **Declared at**: `readable/main.js:34444–34445`
- **Inferred role**: ESM equivalents of CJS `__filename`/`__dirname`: `$b = Xe(import.meta.url)` (`Xe` = `fileURLToPath`), `xb = U.dirname($b)`.
- **Evidence**:
  - `main.js:34444–34445` — declaration.
- **Maka equivalent**: every Maka package builds the same pair inline.

---

## Appendix: index of names mapped (in order of first appearance)

| Name  | Inferred meaning                                  | Decl. line |
|-------|--------------------------------------------------|-----------:|
| `Nt`  | crypto module alias                               |        169 |
| `Mn`  | `channel_mappings` Drizzle table                  |        528 |
| `Pn`  | `memories` Drizzle table                          |        542 |
| `Dn`  | `memory_archive` Drizzle table                    |        552 |
| `Ln`  | `memory_sleep_runs` Drizzle table                 |        567 |
| `co`  | memoryService (sqlite-vec) singleton              |        850 |
| `Tn`  | `workspaces` Drizzle table                        |        257 |
| `En`  | `chat_threads` Drizzle table                      |        277 |
| `vo`  | DatabaseService class                             |       1785 |
| `To`  | databaseService singleton                         |       5602 |
| `Sc`  | modelCapabilitiesCache (in-memory)                |      13236 |
| `Dc`  | getModelCapabilities                              |      13402 |
| `Uc`  | getModelCapabilitiesWithXmlFallback               |      13454 |
| `Cl`  | PluginProviderRegistry class                      |      15163 |
| `Nl`  | pluginProviderRegistry singleton                  |      15386 |
| `Rl`  | defaultToolModelsByProvider                       |      15394 |
| `Ml`  | providerPriorityOrder                             |      15413 |
| `Pl`  | getEffectiveToolModel                             |      15414 |
| `Dl`  | getAutoDetectedToolModel                          |      15424 |
| `Ll`  | getMemoryToolModel                                |      15458 |
| `Fl`  | toolModelModule (frozen export)                   |      15468 |
| `Ul`  | COPILOT_CLIENT_ID                                 |      15480 |
| `Yl`  | COPILOT_HTTP_HEADERS                              |      15489 |
| `Jl`  | COPILOT_API_HEADERS                               |      15497 |
| `Vl`  | CopilotServiceError                               |      15505 |
| `Kl`  | CopilotTokenService class                         |      15510 |
| `Ql`  | copilotTokenService singleton                     |      15869 |
| `Zl`  | copilotAuthedFetch                                |      15870 |
| `Zd`  | outputTruncationDefaults                          |      17897 |
| `_d`  | MemorySleepService class                          |   ~17480   |
| `xd`  | memorySleepService singleton                      |      17481 |
| `Xu`  | SkillsService class                               |      18571 |
| `Yu`  | skillsService singleton                           |      19127 |
| `Ju`  | getWorkspaceIdForChannel                          |      19128 |
| `Vu`  | ChannelMappingService class                       |      19146 |
| `Ku`  | channelMappingService singleton                   |      19202 |
| `wh`  | getCwd (AsyncLocalStorage-backed)                 |      19995 |
| `Th`  | relPath                                           |      20012 |
| `Sh`  | builtinAgentProfiles                              |      20034 |
| `Tp`  | updateMissionPhase                                |      21594 |
| `Tf`  | mcpService (MCP registry)                         |      25212 |
| `Wg`  | waitForNetworkIdle                                |      27505 |
| `Ey`  | chromeExtensionBridge                             |      28009 |
| `vw`  | builtinToolRegistry                               |      28954 |
| `Mw`  | ARTIFACTS_MODE_PROMPT                             |      29566 |
| `Pw`  | IS_MACOS                                          |      29568 |
| `Dw`  | builtinToolDescriptions                           |      29569 |
| `Tb`  | pendingReactionCallback (mutable)                 |      34390 |
| `Eb`  | setPendingReactionCallback                        |      34391 |
| `Ab`  | pendingSendVoiceCallback (mutable)                |      34420 |
| `Ib`  | setPendingSendVoiceCallback                       |      34421 |
| `Cb`  | messageBridgeLog                                  |      34446 |
| `$b`  | `__filename` for module                           |      34444 |
| `xb`  | `__dirname` for module                            |      34445 |
| `Xb`  | ILINK_BASE_URL                                    |      41308 |
| `Yb`  | WEIXIN_C2C_CDN_BASE                               |      41309 |
| `Jb`  | WEIXIN_CHANNEL_DEFAULTS                           |      41310 |
| `Vb`  | weixinLog                                         |      41311 |
| `Kb`  | randomWechatUin                                   |      41321 |
| `Qb`  | weixinStateDir                                    |      41325 |
| `Zb`  | loadWeixinCredentials                             |      41332 |
| `ev`  | saveWeixinCursor                                  |      41341 |
| `tv`  | ilinkGet                                          |      41350 |
| `nv`  | ilinkPostJson                                     |      41366 |
| `ov`  | weixinCdnDownload                                 |      41388 |
| `sv`  | mimeTypeFromFilename                              |      41439 |
| `rv`  | stripMarkdownForTelegram                          |      41474 |
| `iv`  | WeixinBot class                                   |      41488 |
| `Lv`  | chromiumAppleScriptTemplate                       |      45552 |
| `Fv`  | safariAppleScriptTemplate                         |      45554 |
| `Bv`  | parseJsonOr                                       |      45559 |
| `jv`  | activitySessionFromRow                            |      45567 |

(Drizzle table names are descriptive and the source already exposes them
literally — included here so the table inventory in this audit is
complete.)
